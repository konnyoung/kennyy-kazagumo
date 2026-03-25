const readline = require('node:readline');

const PANEL_REFRESH_MS = 1_000;
const MAX_VISIBLE_LOGS = 15; // Quantidade de logs visíveis acima do painel
const HOOKED_CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];

const ANSI = {
  reset: '\x1b[0m',
  blue: '\x1b[34m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m'
};

function startTerminalPanel({ monitor, log = console.log }) {
  if (!monitor || typeof monitor.getSnapshot !== 'function') {
    throw new Error('A lavalink monitor instance with getSnapshot() is required to start the panel.');
  }

  if (!process.stdout.isTTY) {
    log('[Panel] Non-interactive terminal; panel disabled.');
    return null;
  }

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY && !process.stdin.isRaw) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  let stopped = false;
  let logBuffer = []; // Últimos logs para exibir

  const originalConsole = captureConsoleSnapshot();
  hookConsoleMethods();

  const keyListener = (_, key) => {
    if (!key) return;
    if (key.ctrl && key.name === 'c') {
      cleanup();
      process.exit(0);
    }
    // 'c' para limpar logs
    if (key.name === 'c') {
      logBuffer = [];
      render();
    }
  };

  process.stdin.on('keypress', keyListener);

  const interval = setInterval(() => {
    if (stopped) return;
    render();
  }, PANEL_REFRESH_MS);

  function cleanup() {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    process.stdin.off('keypress', keyListener);
    restoreConsoleMethods();
    // Limpa tela e mostra logs finais
    console.clear();
    logBuffer.forEach(entry => {
      originalConsole[entry.method](...entry.args);
    });
    if (process.stdin.isTTY && process.stdin.isRaw) {
      try {
        process.stdin.setRawMode(false);
      } catch (error) {
        // ignore
      }
    }
  }

  function render() {
    if (stopped) return;
    const snapshot = monitor.getSnapshot();
    const panelLines = buildPanelLines(snapshot);
    
    // Limpa tela e redesenha tudo
    console.clear();
    
    // Mostra os últimos logs primeiro
    const visibleLogs = logBuffer.slice(-MAX_VISIBLE_LOGS);
    if (visibleLogs.length > 0) {
      originalConsole.log(`${ANSI.dim}─── Logs (últimos ${visibleLogs.length}) • Pressione "c" para limpar ───${ANSI.reset}`);
      for (const entry of visibleLogs) {
        originalConsole[entry.method](...entry.args);
      }
      originalConsole.log('');
    }
    
    // Desenha o painel abaixo
    originalConsole.log(panelLines.join('\n'));
    originalConsole.log(`\n${ANSI.dim}Ctrl+C para sair${ANSI.reset}`);
  }

  function hookConsoleMethods() {
    for (const method of HOOKED_CONSOLE_METHODS) {
      if (typeof originalConsole[method] !== 'function') continue;
      console[method] = (...args) => {
        // Adiciona timestamp ao log
        const timestamp = new Date().toLocaleTimeString('pt-BR');
        
        // Armazena no buffer (limite de 100 entradas)
        logBuffer.push({ method, args, timestamp });
        if (logBuffer.length > 100) {
          logBuffer.shift();
        }

        if (stopped) {
          return originalConsole[method](...args);
        }
        
        // Não faz nada aqui - o render() vai mostrar os logs
        // Isso evita flickering
      };
    }
  }

  function restoreConsoleMethods() {
    for (const method of HOOKED_CONSOLE_METHODS) {
      if (typeof originalConsole[method] === 'function') {
        console[method] = originalConsole[method];
      }
    }
  }

  render();

  return {
    stop: cleanup
  };
}

function captureConsoleSnapshot() {
  const snapshot = {};
  for (const method of HOOKED_CONSOLE_METHODS) {
    if (typeof console[method] === 'function') {
      snapshot[method] = console[method].bind(console);
    }
  }
  return snapshot;
}

function buildPanelLines(snapshot) {
  const now = snapshot.timestamp ?? Date.now();
  const totals = snapshot.totals ?? { players: 0, playing: 0 };
  const nodes = snapshot.nodes ?? [];

  const contentLines = [];
  contentLines.push(`Calls totais: ${totals.players}`);
  contentLines.push(`Tocando (total): ${totals.playing}`);
  contentLines.push('Por nó:');

  if (!nodes.length) {
    contentLines.push('Nenhum nó sendo monitorado no momento.');
  } else {
    for (const node of nodes) {
      const icon = getNodeIcon(node.state);
      const uptime = buildUptimeLabel(now, node);
      const stats = `${node.name}: ${icon} calls=${node.players ?? 0} tocando=${node.playingPlayers ?? 0} | ${uptime}`;
      contentLines.push(stats.trim());
    }
  }

  const title = ' Painel de Monitoramento ';
  const minInnerWidth = Math.max(title.length, ...contentLines.map(line => line.length)) + 2;
  const terminalColumns = Number.isFinite(process.stdout.columns) ? process.stdout.columns : 0;
  const fullWidthInner = terminalColumns >= 4 ? terminalColumns - 2 : 0; // 2 border chars
  const innerWidth = Math.max(minInnerWidth, fullWidthInner);
  const header = buildHeader(innerWidth, title);
  const footer = buildFooter(innerWidth);
  const formatted = contentLines.map(line => buildLine(innerWidth, line));

  const panelLines = [header, ...formatted, footer];
  const borderColor = (process.env.PANEL_BORDER_COLOR ?? 'blue').toLowerCase();
  if (borderColor === 'blue') {
    return colorizePanelBorder(panelLines, 'blue');
  }
  return panelLines;
}

function buildHeader(innerWidth, title) {
  const remaining = innerWidth - title.length;
  const left = Math.max(0, Math.floor(remaining / 2));
  const right = Math.max(0, remaining - left);
  return `╭${'─'.repeat(left)}${title}${'─'.repeat(right)}╮`;
}

function buildFooter(innerWidth) {
  return `╰${'─'.repeat(innerWidth)}╯`;
}

function buildLine(innerWidth, content) {
  const text = ` ${content ?? ''}`;
  const padded = text.length >= innerWidth ? text.slice(0, innerWidth) : text.padEnd(innerWidth, ' ');
  return `│${padded}│`;
}

function getNodeIcon(state) {
  if (state === CONNECTED_STATE) return '🟢';
  if (state === 0) return '🟡'; // CONNECTING
  if (state === 2) return '🟠'; // DISCONNECTING  
  if (state === null || state === undefined) return '⚫';
  return '🔴';
}

function buildUptimeLabel(now, node) {
  // Prioriza o estado real do Shoukaku
  const isReallyOnline = node.state === CONNECTED_STATE;
  
  if (isReallyOnline) {
    // Node está online - mostra uptime se temos, senão mostra "online"
    if (node.connectedAt) {
      return `uptime: ${formatDuration(now - node.connectedAt)}`;
    }
    return 'online';
  }
  
  // Node está offline
  if (node.disconnectedAt) {
    return `offline: ${formatDuration(now - node.disconnectedAt)}`;
  }
  
  // Estado desconhecido
  if (node.state === null || node.state === undefined) {
    return 'unknown';
  }
  
  return 'offline';
}

function buildBlacklistLabel(now, node) {
  if (node.blacklistUntil && node.blacklistUntil > now) {
    return ` • blacklist ${formatDuration(node.blacklistUntil - now)}`;
  }
  return '';
}

function colorizePanelBorder(lines, color) {
  const colorCode = color === 'blue' ? ANSI.blue : '';
  if (!colorCode) return lines;

  return lines.map((line) => {
    if (!line) return line;

    // Header/footer: border-only lines.
    if ((line.startsWith('╭') && line.endsWith('╮')) || (line.startsWith('╰') && line.endsWith('╯'))) {
      return `${colorCode}${line}${ANSI.reset}`;
    }

    // Regular panel rows: color only the side borders.
    if (line.startsWith('│') && line.endsWith('│') && line.length >= 2) {
      const middle = line.slice(1, -1);
      return `${colorCode}│${ANSI.reset}${middle}${colorCode}│${ANSI.reset}`;
    }

    return line;
  });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

const CONNECTED_STATE = 1;

module.exports = { startTerminalPanel };
