const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const sessionStore = require('../../utils/sessionStore');

const router = Router();

/**
 * GET /api/permissions/:guildId
 * Returns the full session permission state for this guild.
 */
router.get('/:guildId', requireAuth, (req, res) => {
  const { guildId } = req.params;
  const data = sessionStore.getSessionData(guildId);
  res.json({
    ...data,
    myUserId: req.user.id,
    isAdmin: sessionStore.isAdmin(guildId, req.user.id),
    myPermissions: sessionStore.getUserPermissions(guildId, req.user.id)
  });
});

/**
 * PUT /api/permissions/:guildId/user/:userId
 * Update a single user's permissions. Admin only.
 * Body: { addTracks?, removeTracks?, controlPlayer?, reorderQueue? }
 */
router.put('/:guildId/user/:userId', requireAuth, (req, res) => {
  const { guildId, userId } = req.params;

  if (!sessionStore.isAdmin(guildId, req.user.id)) {
    return res.status(403).json({ error: 'Only the session admin can manage permissions' });
  }
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot change your own permissions' });
  }

  const ALLOWED = ['addTracks', 'removeTracks', 'controlPlayer', 'reorderQueue'];
  const update = {};
  for (const key of ALLOWED) {
    if (typeof req.body[key] === 'boolean') update[key] = req.body[key];
  }

  sessionStore.setUserPermissions(guildId, userId, update);
  res.json({ userId, permissions: sessionStore.getUserPermissions(guildId, userId) });
});

/**
 * POST /api/permissions/:guildId/transfer
 * Transfer admin to another user. Admin only.
 * Body: { toUserId: string }
 */
router.post('/:guildId/transfer', requireAuth, (req, res) => {
  const { guildId } = req.params;
  const { toUserId } = req.body;

  if (!sessionStore.isAdmin(guildId, req.user.id)) {
    return res.status(403).json({ error: 'Only the session admin can transfer the admin role' });
  }
  if (!toUserId || typeof toUserId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid toUserId' });
  }

  const success = sessionStore.transferAdmin(guildId, req.user.id, toUserId);
  if (!success) {
    return res.status(400).json({ error: 'Admin transfer failed' });
  }
  res.json({ success: true, newAdminId: toUserId });
});

module.exports = router;
