// Who am I, and what am I allowed to do?
//
// The console calls this immediately after sign-in and uses the returned
// permission list to decide which navigation and controls to render. That is
// a UX affordance ONLY — every endpoint independently enforces its own
// permission, so hiding a button is never the thing keeping anyone out.
const express = require('express');
const { requireAdmin } = require('../middleware/requireAdmin');
const { ROLES, PERMISSIONS } = require('../lib/roles');

const router = express.Router();

router.get('/me', requireAdmin, (req, res) => {
  res.json({
    admin: {
      id: req.admin.id,
      email: req.admin.email,
      name: req.admin.name,
      role: req.admin.role,
      roleLabel: (ROLES[req.admin.role] || {}).label || req.admin.role,
      permissions: req.admin.permissions,
      viaBootstrap: req.admin.viaBootstrap,
    },
    // Shipped so the console can explain a denial in the operator's language
    // instead of printing a permission slug at them.
    vocabulary: { permissions: PERMISSIONS },
  });
});

module.exports = router;
