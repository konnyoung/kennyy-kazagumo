const { Router } = require('express');

const router = Router();

const WEBHOOK_URL = process.env.FEEDBACK_WEBHOOK_URL;

// Rate limit: 1 report per user per 60 seconds
const rateLimitMap = new Map();
const RATE_LIMIT_MS = 60_000;

router.post('/report', async (req, res) => {
  if (!WEBHOOK_URL) {
    return res.status(503).json({ error: 'Feedback system not configured' });
  }

  const userId = req.body.userId;
  if (userId) {
    const last = rateLimitMap.get(userId);
    if (last && Date.now() - last < RATE_LIMIT_MS) {
      return res.status(429).json({ error: 'Please wait before sending another report' });
    }
    rateLimitMap.set(userId, Date.now());
  }

  const { category, subject, description, contactAllowed, username } = req.body;

  if (!category || !subject || !description) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (subject.length > 100 || description.length > 2000 || category.length > 50) {
    return res.status(400).json({ error: 'Field too long' });
  }

  const embed = {
    title: '🐛 Bug Report',
    color: 0xe8365d,
    fields: [
      { name: 'Category', value: category, inline: true },
      { name: 'Subject', value: subject, inline: true },
      { name: 'Description', value: description },
    ],
    footer: {
      text: contactAllowed
        ? `✅ Contact allowed | ${username || 'Unknown'} (${userId || '?'})`
        : `❌ No contact | ${username || 'Unknown'} (${userId || '?'})`
    },
    timestamp: new Date().toISOString()
  };

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] })
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to send report' });
    }

    res.json({ success: true });
  } catch {
    res.status(502).json({ error: 'Failed to send report' });
  }
});

module.exports = router;
