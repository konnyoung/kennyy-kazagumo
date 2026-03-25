/**
 * In-memory session store for per-guild web-player permission management.
 *
 * Each guild has one active session while the bot is playing.
 * The first user to start playback via the web dashboard becomes the admin.
 * The admin can grant/revoke permissions for other members.
 * When the admin leaves the voice channel, admin is automatically transferred
 * to a remaining member (random pick from who is still in the channel).
 */

const DEFAULT_PERMISSIONS = {
  addTracks:     true,  // everyone can add songs by default
  removeTracks:  false,
  controlPlayer: false,
  reorderQueue:  false
};

/**
 * @type {Map<string, { adminId: string|null, users: Map<string, UserEntry> }>}
 * @typedef {{ username: string, avatarUrl: string|null, permissions: object }} UserEntry
 */
const sessions = new Map();

function _getOrCreate(guildId) {
  if (!sessions.has(guildId)) {
    sessions.set(guildId, { adminId: null, users: new Map() });
  }
  return sessions.get(guildId);
}

/**
 * Register (or refresh) a user in the session.
 * Must be called before any permission query for that user.
 */
function registerUser(guildId, userId, username, avatarUrl = null) {
  const session = _getOrCreate(guildId);
  if (!session.users.has(userId)) {
    session.users.set(userId, {
      username: username || 'Unknown',
      avatarUrl: avatarUrl || null,
      permissions: { ...DEFAULT_PERMISSIONS }
    });
  } else {
    const u = session.users.get(userId);
    if (username) u.username = username;
    if (avatarUrl) u.avatarUrl = avatarUrl;
  }
}

/**
 * Set the admin for this guild session, but only if there is none yet.
 * Call this the moment a new player session is created.
 */
function setAdminIfNone(guildId, userId) {
  const session = _getOrCreate(guildId);
  if (!session.adminId) {
    session.adminId = userId;
  }
}

function isAdmin(guildId, userId) {
  return sessions.get(guildId)?.adminId === userId;
}

function getAdminId(guildId) {
  return sessions.get(guildId)?.adminId || null;
}

function getUserPermissions(guildId, userId) {
  const session = sessions.get(guildId);
  if (!session) return { ...DEFAULT_PERMISSIONS };
  const user = session.users.get(userId);
  return user?.permissions ? { ...user.permissions } : { ...DEFAULT_PERMISSIONS };
}

function setUserPermissions(guildId, userId, perms) {
  const session = _getOrCreate(guildId);
  if (!session.users.has(userId)) {
    session.users.set(userId, {
      username: null,
      avatarUrl: null,
      permissions: { ...DEFAULT_PERMISSIONS }
    });
  }
  const user = session.users.get(userId);
  user.permissions = { ...user.permissions, ...perms };
}

/**
 * Returns true if the user has the permission, or if they are the session admin.
 * When no session exists (no player active) all permissions default to allowed,
 * so the very first play action is always permitted.
 */
function hasPermission(guildId, userId, perm) {
  const session = sessions.get(guildId);
  if (!session || !session.adminId) return true; // no session yet — allow everything
  if (isAdmin(guildId, userId)) return true;
  return getUserPermissions(guildId, userId)[perm] === true;
}

/**
 * Transfer admin from one user to another.
 * Returns false if the caller is not the current admin.
 */
function transferAdmin(guildId, fromUserId, toUserId) {
  const session = sessions.get(guildId);
  if (!session || session.adminId !== fromUserId) return false;
  session.adminId = toUserId;
  // Ensure target has an entry
  if (!session.users.has(toUserId)) {
    session.users.set(toUserId, {
      username: null,
      avatarUrl: null,
      permissions: { ...DEFAULT_PERMISSIONS }
    });
  }
  return true;
}

/**
 * Called when a non-bot user leaves the voice channel.
 * If they were the admin, pick the first remaining user to become admin.
 * @param {string} guildId
 * @param {string} userId - the user who left
 * @param {{ id: string, username: string, avatarUrl: string }[]} remainingMembers
 */
function handleUserLeave(guildId, userId, remainingMembers) {
  const session = sessions.get(guildId);
  if (!session || session.adminId !== userId) return;

  if (remainingMembers.length > 0) {
    const newAdmin = remainingMembers[0];
    session.adminId = newAdmin.id;
    if (!session.users.has(newAdmin.id)) {
      session.users.set(newAdmin.id, {
        username: newAdmin.username || null,
        avatarUrl: newAdmin.avatarUrl || null,
        permissions: { ...DEFAULT_PERMISSIONS }
      });
    } else {
      // Update existing entry with fresh data
      const u = session.users.get(newAdmin.id);
      if (newAdmin.username) u.username = newAdmin.username;
      if (newAdmin.avatarUrl) u.avatarUrl = newAdmin.avatarUrl;
    }
  } else {
    session.adminId = null;
  }
}

/**
 * Serialise session data for the API response.
 */
function getSessionData(guildId) {
  const session = sessions.get(guildId);
  if (!session) return { adminId: null, users: [] };

  const users = [];
  for (const [uid, data] of session.users) {
    users.push({
      id: uid,
      username: data.username,
      avatarUrl: data.avatarUrl || null,
      permissions: { ...data.permissions },
      isAdmin: session.adminId === uid
    });
  }
  return { adminId: session.adminId, users };
}

/**
 * Destroy the session when the player is stopped/destroyed.
 */
function clearSession(guildId) {
  sessions.delete(guildId);
}

module.exports = {
  registerUser,
  setAdminIfNone,
  isAdmin,
  getAdminId,
  getUserPermissions,
  setUserPermissions,
  hasPermission,
  transferAdmin,
  handleUserLeave,
  getSessionData,
  clearSession,
  DEFAULT_PERMISSIONS
};
