'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { User, sequelize } = require('../models');
const { validate } = require('../middleware/validate');
const { requireAuth, signAccessToken, signImageToken } = require('../middleware/auth');
const { asyncHandler, unauthorized, forbidden, conflict } = require('../utils/errors');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.isTest ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

const username = z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'Only letters, digits, _ . - are allowed');
const password = z.string().min(10, 'Password must be at least 10 characters').max(200);

const registerSchema = z.object({
  username,
  email: z.string().trim().toLowerCase().email().max(255).optional(),
  password,
});

const loginSchema = z.object({
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: password,
});

// A dummy hash so login timing does not reveal whether a username exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 4);

function session(user) {
  return { user: user.toJSON(), accessToken: signAccessToken(user), imageToken: signImageToken(user) };
}

// Serialises first-user creation so two concurrent requests cannot both become admin.
let registrationQueue = Promise.resolve();
function serialised(fn) {
  const run = registrationQueue.then(fn, fn);
  registrationQueue = run.catch(() => {});
  return run;
}

router.get('/setup-status', asyncHandler(async (req, res) => {
  const users = await User.count();
  res.json({ needsSetup: users === 0, allowRegistration: users === 0 || config.auth.allowRegistration });
}));

router.post('/register', authLimiter, validate(registerSchema), asyncHandler(async (req, res) => {
  const result = await serialised(() => sequelize.transaction(async (transaction) => {
    const count = await User.count({ transaction });
    if (count > 0 && !config.auth.allowRegistration) {
      throw forbidden('Registration is disabled. Ask an administrator to create an account for you.');
    }
    const taken = await User.findOne({ where: { username: req.body.username }, transaction });
    if (taken) throw conflict('Username is already taken');
    if (req.body.email && await User.findOne({ where: { email: req.body.email }, transaction })) {
      throw conflict('Email is already registered');
    }
    const passwordHash = await bcrypt.hash(req.body.password, config.auth.bcryptRounds);
    return User.create({
      username: req.body.username,
      email: req.body.email || null,
      passwordHash,
      role: count === 0 ? 'admin' : 'viewer',
    }, { transaction });
  }));
  res.status(201).json(session(result));
}));

router.post('/login', authLimiter, validate(loginSchema), asyncHandler(async (req, res) => {
  const ident = req.body.username;
  const where = ident.includes('@') ? { email: ident.toLowerCase() } : { username: ident };
  const user = await User.scope('withPassword').findOne({ where });
  const ok = await bcrypt.compare(req.body.password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Invalid username or password');
  await user.update({ lastLoginAt: new Date() });
  res.json(session(user));
}));

router.get('/me', requireAuth, (req, res) => {
  // Also refreshes the short-lived image token used for <img> thumbnails.
  res.json({ user: req.user.toJSON(), imageToken: signImageToken(req.user) });
});

router.post('/change-password', requireAuth, authLimiter, validate(changePasswordSchema), asyncHandler(async (req, res) => {
  const user = await User.scope('withPassword').findByPk(req.user.id);
  if (!(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) {
    throw unauthorized('Current password is incorrect');
  }
  user.passwordHash = await bcrypt.hash(req.body.newPassword, config.auth.bcryptRounds);
  user.tokenVersion += 1; // revoke every existing session
  await user.save();
  res.json(session(user));
}));

router.post('/logout-all', requireAuth, asyncHandler(async (req, res) => {
  await req.user.increment('tokenVersion');
  res.status(204).end();
}));

module.exports = router;
