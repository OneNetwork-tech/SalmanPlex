'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const config = require('../config');
const { User, ROLES } = require('../models');
const { validate } = require('../middleware/validate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler, notFound, badRequest, conflict } = require('../utils/errors');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const idParam = z.object({ id: z.coerce.number().int().positive() });

const createSchema = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
  email: z.string().trim().toLowerCase().email().max(255).optional(),
  password: z.string().min(10).max(200),
  role: z.enum(ROLES).default('viewer'),
});

const updateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255).nullable().optional(),
  password: z.string().min(10).max(200).optional(),
  role: z.enum(ROLES).optional(),
}).refine((v) => Object.keys(v).length > 0, 'Nothing to update');

async function assertNotLastAdmin(user) {
  if (user.role !== 'admin') return;
  const admins = await User.count({ where: { role: 'admin' } });
  if (admins <= 1) throw badRequest('At least one administrator must remain');
}

router.get('/', asyncHandler(async (req, res) => {
  const users = await User.findAll({ order: [['username', 'ASC']] });
  res.json({ data: users });
}));

router.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  if (await User.findOne({ where: { username: req.body.username } })) throw conflict('Username is already taken');
  const user = await User.create({
    username: req.body.username,
    email: req.body.email || null,
    role: req.body.role,
    passwordHash: await bcrypt.hash(req.body.password, config.auth.bcryptRounds),
  });
  res.status(201).json({ data: user });
}));

router.patch('/:id', validate(idParam, 'params'), validate(updateSchema), asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user) throw notFound('User not found');
  const changes = {};
  if (req.body.email !== undefined) changes.email = req.body.email;
  if (req.body.role && req.body.role !== user.role) {
    if (req.body.role !== 'admin') await assertNotLastAdmin(user);
    changes.role = req.body.role;
  }
  if (req.body.password) changes.passwordHash = await bcrypt.hash(req.body.password, config.auth.bcryptRounds);
  // Role or password changes revoke the user's existing sessions.
  if (changes.role || changes.passwordHash) changes.tokenVersion = user.tokenVersion + 1;
  await user.update(changes);
  res.json({ data: user });
}));

router.delete('/:id', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user) throw notFound('User not found');
  if (user.id === req.user.id) throw badRequest('You cannot delete your own account');
  await assertNotLastAdmin(user);
  await user.destroy();
  res.status(204).end();
}));

module.exports = router;
