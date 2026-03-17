const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Constants } = require('shoukaku');
const { getTranslator } = require('./localeHelpers');
const { v2Reply } = require('./embedV2');

const WATCHDOG_INTERVAL_MS = 15_000;
const HEALTHCHECK_INTERVAL_MS = 30_000;
const HEALTHCHECK_TIMEOUT_MS = 8_000;
const NODE_BLACKLIST_MS = 120_000;
const CONNECTED_STATE = Constants?.State?.CONNECTED ?? 1;
const NODE_NOTIFY_TTL_MS = NODE_BLACKLIST_MS;
const HEALTHCHECK_FAIL_THRESHOLD = 3; // Falhas consecutivas antes de marcar offline (aumentado de 2 para 3)
const NODE_RECONNECT_TIMEOUT_MS = 30_000; // Tempo máximo para reconexão antes de destruir players (aumentado para 30s)
const QUICK_RECONNECT_GRACE_MS = 15_000; // Se reconectar em menos de 15s, não notifica usuários

function createLavalinkMonitor({ client, nodeConfigs = [], log = console.log }) {
  if (!client?.kazagumo?.shoukaku) {
    throw new Error('Kazagumo/Shoukaku instance is required before starting the lavalink monitor.');
  }

  const shoukaku = client.kazagumo.shoukaku;
  const nodesByName = new Map();
  nodeConfigs.forEach(cfg => nodesByName.set(cfg.name, cfg));

  const trackedState = new Map();
  nodeConfigs.forEach(cfg => trackedState.set(cfg.name, createDefaultState()));

  // Avoid spamming the same guild when a node flaps.
  const nodeNotifyCache = new Map();
  
  // Armazena timeouts de notificação pendentes (para cancelar se reconectar rápido)
  const pendingNotifications = new Map();

  let watchdogInterval = null;
  let healthInterval = null;
  let watchdogRunning = false;
  let healthRunning = false;

  const readyListener = name => markConnected(name);
  const errorListener = (name, error) =>
    markFailure(name, error?.message ?? String(error)).catch(err => log(`[Failover] ${err.message}`));
  const closeListener = (name, code, reason) =>
    markFailure(name, `Close ${code}${reason ? ` ${reason}` : ''}`).catch(err => log(`[Failover] ${err.message}`));
  const disconnectListener = (name, count) =>
    markFailure(name, `Disconnect #${count ?? 0}`).catch(err => log(`[Failover] ${err.message}`));

  shoukaku.on('ready', readyListener);
  shoukaku.on('error', errorListener);
  shoukaku.on('close', closeListener);
  shoukaku.on('disconnect', disconnectListener);

  function start() {
    if (!watchdogInterval) {
      watchdogInterval = setInterval(() => {
        if (watchdogRunning) return;
        watchdogRunning = true;
        runWatchdog()
          .catch(error => log(`[Failover] Watchdog error: ${error.message}`))
          .finally(() => {
            watchdogRunning = false;
          });
      }, WATCHDOG_INTERVAL_MS);
      if (watchdogInterval.unref) watchdogInterval.unref();
    }

    if (!healthInterval) {
      healthInterval = setInterval(() => {
        if (healthRunning) return;
        healthRunning = true;
        runHealthcheck()
          .catch(error => log(`[Failover] Healthcheck error: ${error.message}`))
          .finally(() => {
            healthRunning = false;
          });
      }, HEALTHCHECK_INTERVAL_MS);
      if (healthInterval.unref) healthInterval.unref();
    }
  }

  function stop() {
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
    if (healthInterval) {
      clearInterval(healthInterval);
      healthInterval = null;
    }
    // Limpa notificações pendentes
    for (const timeout of pendingNotifications.values()) {
      clearTimeout(timeout);
    }
    pendingNotifications.clear();
    
    shoukaku.off('ready', readyListener);
    shoukaku.off('error', errorListener);
    shoukaku.off('close', closeListener);
    shoukaku.off('disconnect', disconnectListener);
  }

  function createDefaultState() {
    return {
      connectedAt: null,
      disconnectedAt: null, // null = desconhecido, não offline
      blacklistUntil: 0,
      lastError: null,
      healthcheckFailures: 0, // Contador de falhas consecutivas
      reconnectingSince: null // Timestamp de quando começou a reconectar
    };
  }

  function getTrackedNames() {
    const names = new Set([...nodesByName.keys()]);
    for (const name of shoukaku.nodes.keys()) {
      names.add(name);
    }
    return Array.from(names.values());
  }

  function getNodeState(name) {
    if (!trackedState.has(name)) {
      trackedState.set(name, createDefaultState());
    }
    return trackedState.get(name);
  }

  function isBlacklisted(name) {
    const entry = getNodeState(name);
    return Boolean(entry.blacklistUntil && entry.blacklistUntil > Date.now());
  }

  function markConnected(name) {
    const snapshot = getNodeState(name);
    // Só define connectedAt se não estava conectado antes
    if (!snapshot.connectedAt) {
      snapshot.connectedAt = Date.now();
    }
    snapshot.disconnectedAt = null;
    snapshot.blacklistUntil = 0;
    snapshot.lastError = null;
    snapshot.healthcheckFailures = 0; // Reset falhas
    snapshot.reconnectingSince = null; // Reset reconexão
    trackedState.set(name, snapshot);
    
    // Cancela notificação pendente se reconectou rapidamente
    cancelPendingNotification(name);
  }

  function cancelPendingNotification(name) {
    const pending = pendingNotifications.get(name);
    if (pending) {
      clearTimeout(pending);
      pendingNotifications.delete(name);
      log(`[Failover] Cancelled notification for ${name} - quick reconnect`);
    }
  }

  async function markFailure(name, reason) {
    const snapshot = getNodeState(name);
    snapshot.connectedAt = null;
    snapshot.disconnectedAt = Date.now();
    snapshot.blacklistUntil = Date.now() + NODE_BLACKLIST_MS;
    snapshot.lastError = reason;
    snapshot.healthcheckFailures = 0; // Reset já que confirmamos offline
    snapshot.reconnectingSince = null;
    trackedState.set(name, snapshot);
    log(`[Failover] Node ${name} marked as offline (${reason}).`);
    
    // Agenda notificação com delay - pode ser cancelada se reconectar rápido
    scheduleNotification(name);
    
    // Migra players imediatamente (destrói para evitar ghost state)
    await migratePlayersFromNode(name);
  }

  function scheduleNotification(name) {
    // Cancela notificação anterior se existir
    cancelPendingNotification(name);
    
    // Agenda nova notificação após o grace period
    const timeout = setTimeout(async () => {
      pendingNotifications.delete(name);
      
      // Verifica se o node ainda está offline antes de notificar
      const node = shoukaku.nodes.get(name);
      if (node?.state === CONNECTED_STATE) {
        log(`[Failover] Skipping notification for ${name} - already reconnected`);
        return;
      }
      
      await notifyPlayersNodeDown(name);
    }, QUICK_RECONNECT_GRACE_MS);
    
    pendingNotifications.set(name, timeout);
  }

  // Incrementa falhas sem marcar offline ainda
  function incrementHealthcheckFailure(name, reason) {
    const snapshot = getNodeState(name);
    snapshot.healthcheckFailures = (snapshot.healthcheckFailures || 0) + 1;
    snapshot.lastError = reason;
    
    // Marca quando começou a reconectar
    if (!snapshot.reconnectingSince) {
      snapshot.reconnectingSince = Date.now();
    }
    
    trackedState.set(name, snapshot);
    return snapshot.healthcheckFailures;
  }

  // Verifica se um node está em reconexão há muito tempo
  function isReconnectingTooLong(name) {
    const snapshot = getNodeState(name);
    if (!snapshot.reconnectingSince) return false;
    return Date.now() - snapshot.reconnectingSince > NODE_RECONNECT_TIMEOUT_MS;
  }

  async function notifyPlayersNodeDown(failedName) {
    const players = Array.from(client.kazagumo.players.values()).filter(player => {
      const nodeName = player?.shoukaku?.node?.name;
      return nodeName === failedName && player.textId;
    });

    if (!players.length) return;

    const notifiedGuilds = new Set();
    for (const player of players) {
      if (notifiedGuilds.has(player.guildId)) continue;
      notifiedGuilds.add(player.guildId);

      const guild = client.guilds.cache.get(player.guildId);
      if (!guild) continue;

      const cacheKey = `${player.guildId}:${failedName}`;
      const lastNotified = nodeNotifyCache.get(cacheKey) || 0;
      if (Date.now() - lastNotified < NODE_NOTIFY_TTL_MS) continue;

      const channel = guild.channels.cache.get(player.textId);
      if (!channel?.isTextBased?.()) continue;

      try {
        const t = await getTranslator(client, player.guildId);

        // Add recover queue button if cache exists
        const hasCache = client.queueCache?.hasCache(player.guildId);
        const extraComponents = [];
        
        if (hasCache) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`resumequeue:${player.guildId}`)
              .setLabel(t('errors.node_down_recover_button') || 'Recover Queue')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('🔄')
          );
          extraComponents.push(row);
        }

        const payload = v2Reply({
          color: 0xff6b6b,
          title: `${process.env.EMOJI_CRY || '<:cry:1453534083983474867>'} ${t('errors.node_down_title')}`,
          description: t('errors.node_down_description'),
          footer: `Node: ${failedName}`,
          timestamp: true,
          components: extraComponents
        });

        await channel.send(payload);
        nodeNotifyCache.set(cacheKey, Date.now());
      } catch (error) {
        log(`[Failover] Failed to notify guild ${player.guildId} about node ${failedName}: ${error.message}`);
      }
    }
  }

  async function migratePlayersFromNode(failedName) {
    const affectedPlayers = Array.from(client.kazagumo.players.values()).filter(player => {
      const nodeName = player?.shoukaku?.node?.name;
      return nodeName === failedName;
    });

    if (!affectedPlayers.length) return;

    // When a node goes down, destroy all affected players to avoid ghost state
    for (const player of affectedPlayers) {
      log(`[Failover] Destroying player ${player.guildId} from failed node ${failedName}.`);
      await destroyPlayerSafe(player);
    }
  }

  function pickAlternativeNode(excludeName) {
    const candidates = Array.from(shoukaku.nodes.values()).filter(node => {
      if (node.name === excludeName) return false;
      if (node.state !== CONNECTED_STATE) return false;
      if (isBlacklisted(node.name)) return false;
      return true;
    });

    if (!candidates.length) return null;
    candidates.sort((a, b) => (a.penalties ?? 0) - (b.penalties ?? 0));
    return candidates[0];
  }

  async function runWatchdog() {
    for (const name of getTrackedNames()) {
      if (isBlacklisted(name)) continue;
      const node = shoukaku.nodes.get(name);
      if (!node) {
        const cfg = nodesByName.get(name);
        if (cfg) {
          log(`[Failover] Re-creating node ${name}.`);
          shoukaku.addNode(cfg);
        }
        continue;
      }

      if (node.state !== CONNECTED_STATE) {
        try {
          node.connect();
          log(`[Failover] Trying to reconnect node ${name}...`);
        } catch (error) {
          log(`[Failover] Failed to reconnect node ${name}: ${error.message}`);
        }
      }
    }
  }

  async function runHealthcheck() {
    const nodes = Array.from(shoukaku.nodes.values());
    for (const node of nodes) {
      // Se já está na blacklist, ignora
      if (isBlacklisted(node.name)) continue;
      
      // Verifica o estado real do Shoukaku primeiro
      if (node.state !== CONNECTED_STATE) {
        // Node não está conectado segundo Shoukaku - incrementa falha
        const failures = incrementHealthcheckFailure(node.name, 'Node state not connected');
        
        // Se está reconectando há muito tempo, destrói players imediatamente
        if (isReconnectingTooLong(node.name)) {
          log(`[Failover] Node ${node.name} reconnecting too long (>${NODE_RECONNECT_TIMEOUT_MS}ms), destroying players...`);
          await destroyPlayersOnNode(node.name);
        }
        
        if (failures >= HEALTHCHECK_FAIL_THRESHOLD) {
          await markFailure(node.name, `Node disconnected (state: ${node.state})`);
        } else {
          log(`[Failover] Node ${node.name} not connected, failure ${failures}/${HEALTHCHECK_FAIL_THRESHOLD}`);
        }
        continue;
      }
      
      // Node está conectado, tenta healthcheck via REST
      try {
        await withTimeout(node.rest.stats(), HEALTHCHECK_TIMEOUT_MS);
        markConnected(node.name);
      } catch (error) {
        const failures = incrementHealthcheckFailure(node.name, `Healthcheck failed: ${error?.message ?? error}`);
        if (failures >= HEALTHCHECK_FAIL_THRESHOLD) {
          await markFailure(node.name, `Healthcheck failed ${failures}x: ${error?.message ?? error}`);
        } else {
          log(`[Failover] Node ${node.name} healthcheck failed, failure ${failures}/${HEALTHCHECK_FAIL_THRESHOLD}`);
        }
      }
    }
  }

  // Destrói players em um node específico sem notificar (usado durante reconexão)
  async function destroyPlayersOnNode(nodeName) {
    const affectedPlayers = Array.from(client.kazagumo.players.values()).filter(player => {
      const playerNodeName = player?.shoukaku?.node?.name;
      return playerNodeName === nodeName;
    });

    if (!affectedPlayers.length) return;

    for (const player of affectedPlayers) {
      log(`[Failover] Force destroying player ${player.guildId} from stale node ${nodeName}.`);
      await destroyPlayerSafe(player);
    }
  }

  function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('stats timeout'));
      }, timeoutMs);

      promise
        .then(result => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  function getSnapshot() {
    const now = Date.now();
    const names = getTrackedNames();
    const { totals, perNode } = collectBotStats();

    const nodes = names.map(name => {
      const state = getNodeState(name);
      const instance = shoukaku.nodes.get(name) ?? null;
      const botStats = perNode.get(name) ?? { players: 0, playing: 0 };
      
      // Determina se está online baseado no estado REAL do Shoukaku
      const isReallyConnected = instance?.state === CONNECTED_STATE;
      
      // Se Shoukaku diz que está conectado, considera online mesmo que nosso tracking diga offline
      let effectiveConnectedAt = state.connectedAt;
      let effectiveDisconnectedAt = state.disconnectedAt;
      
      if (isReallyConnected && !effectiveConnectedAt) {
        // Shoukaku está conectado mas não temos registro - sincroniza
        effectiveConnectedAt = now;
        effectiveDisconnectedAt = null;
        // Atualiza o tracking também
        markConnected(name);
      } else if (!isReallyConnected && !instance && effectiveConnectedAt) {
        // Não existe instância mas achamos que está conectado - corrige
        effectiveConnectedAt = null;
        effectiveDisconnectedAt = effectiveDisconnectedAt || now;
      }
      
      return {
        name,
        state: instance?.state ?? null,
        connectedAt: effectiveConnectedAt,
        disconnectedAt: effectiveDisconnectedAt,
        blacklistUntil: state.blacklistUntil,
        lastError: state.lastError,
        players: botStats.players,
        playingPlayers: botStats.playing,
        healthcheckFailures: state.healthcheckFailures || 0
      };
    });

    return {
      timestamp: now,
      totals,
      nodes
    };
  }

  function collectBotStats() {
    const players = Array.from(client.kazagumo.players.values());
    const perNode = new Map();
    let playing = 0;

    for (const player of players) {
      const nodeName = player?.shoukaku?.node?.name ?? 'unknown';
      if (!perNode.has(nodeName)) {
        perNode.set(nodeName, { players: 0, playing: 0 });
      }
      const entry = perNode.get(nodeName);
      entry.players += 1;
      if (player.playing && !player.paused) {
        entry.playing += 1;
        playing += 1;
      }
    }

    for (const name of getTrackedNames()) {
      if (!perNode.has(name)) {
        perNode.set(name, { players: 0, playing: 0 });
      }
    }

    return {
      totals: {
        players: players.length,
        playing
      },
      perNode
    };
  }

  function getLeastUsedNodeName() {
    const { perNode } = collectBotStats();
    const candidates = [];
    for (const name of getTrackedNames()) {
      if (isBlacklisted(name)) continue;
      const node = shoukaku.nodes.get(name);
      if (!node || node.state !== CONNECTED_STATE) continue;
      const counts = perNode.get(name) ?? { players: 0, playing: 0 };
      candidates.push({
        name,
        players: counts.players,
        playing: counts.playing,
        penalties: node.penalties ?? 0
      });
    }

    if (!candidates.length) return undefined;
    candidates.sort((a, b) => {
      if (a.players !== b.players) return a.players - b.players;
      if (a.playing !== b.playing) return a.playing - b.playing;
      return (a.penalties ?? 0) - (b.penalties ?? 0);
    });

    return candidates[0]?.name;
  }

  // Verifica se um node específico está saudável
  function isNodeHealthy(nodeName) {
    const node = shoukaku.nodes.get(nodeName);
    if (!node) return false;
    if (node.state !== CONNECTED_STATE) return false;
    if (isBlacklisted(nodeName)) return false;
    if (isReconnectingTooLong(nodeName)) return false;
    return true;
  }

  // Verifica se existe pelo menos um node saudável
  function hasHealthyNode() {
    for (const name of getTrackedNames()) {
      if (isNodeHealthy(name)) return true;
    }
    return false;
  }

  return {
    start,
    stop,
    getSnapshot,
    getLeastUsedNodeName,
    isNodeHealthy,
    hasHealthyNode
  };
}

async function destroyPlayerSafe(player) {
  try {
    await player.destroy();
  } catch (error) {
    // ignore destroy errors
  }
}

module.exports = { createLavalinkMonitor };
