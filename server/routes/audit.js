// The admin audit trail.
const express = require('express');
const { requireAdmin, requirePermission } = require('../middleware/requireAdmin');
const { list } = require('../lib/audit');

const router = express.Router();

router.get('/audit', requireAdmin, requirePermission('audit.read'), async (req, res) => {
  try {
    const result = await list({
      limit: Math.min(Number(req.query.limit) || 100, 500),
      subjectId: req.query.subjectId || null,
      action: req.query.action || null,
    });

    res.json({
      // When the durable table is absent the console must say so plainly.
      // Showing an empty list would read as "nothing has happened", which is
      // the opposite of the truth.
      available: result.available,
      entries: result.entries,
      notice: result.available
        ? null
        : 'The audit table is not installed, so actions are only being written to the server log. Run db/001_admin_audit_log.sql for a durable, searchable trail.',
    });
  } catch (err) {
    console.error('[audit:list]', err.message);
    res.status(500).json({ error: 'Could not load the audit trail.' });
  }
});

module.exports = router;
