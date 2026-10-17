var express = require('express');
var router = express.Router();
var authMiddleware = require('./middlewares/auth');
var userRepo = require('../app/db/repos/user');
const { PERMISSIONS, canViewUsers } = require('../app/services/permissions');

/* GET users listing (admin only - requires valid token). */
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    // Deny users who have no admin access at all.
    if (!canViewUsers(req.user.permission)) {
      return res.status(403).json({ status: 'fail', message: 'You do not have permission to view users' });
    }

    const users = await userRepo.all();
    res.json({ status: 'success', users });
  } catch (err) {
    next(err);
  }
});

// Full-access users can change another user's permission level.
router.patch('/:id/permission', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.permission !== PERMISSIONS.FULL_ACC) {
      return res.status(403).json({ status: 'fail', message: 'Only FullAcc users can change permissions' });
    }

    const allowed = Object.values(PERMISSIONS);
    const { permission } = req.body;

    if (!allowed.includes(permission)) {
      return res.status(400).json({ status: 'fail', message: `permission must be one of: ${allowed.join(', ')}` });
    }

    const existing = await userRepo.findBy('id', req.params.id);
    if (!existing) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }

    await userRepo.update(req.params.id, { permission });
    const user = await userRepo.findBy('id', req.params.id);

    return res.json({ status: 'success', user: { id: user.id, name: user.name, phone: user.phone, permission: user.permission } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
