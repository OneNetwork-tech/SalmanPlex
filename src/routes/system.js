'use strict';

const express = require('express');
const { sequelize, User, Library, MediaItem } = require('../models');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const ffmpeg = require('../services/ffmpeg');
const metadata = require('../services/metadata');
const transcoder = require('../services/transcoder');
const { asyncHandler } = require('../utils/errors');
const pkg = require('../../package.json');

const router = express.Router();

/** Liveness + DB readiness. Public, reveals nothing sensitive. */
router.get('/health', asyncHandler(async (req, res) => {
  try {
    await sequelize.authenticate();
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'unreachable', timestamp: new Date().toISOString() });
  }
}));

router.get('/system/status', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const [users, libraries, items, byKind, tools] = await Promise.all([
    User.count(),
    Library.count(),
    MediaItem.count(),
    MediaItem.findAll({
      attributes: ['kind', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['kind'],
      raw: true,
    }),
    ffmpeg.detect(),
  ]);
  res.json({
    data: {
      version: pkg.version,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      database: sequelize.getDialect(),
      ffmpeg: tools.ffmpeg,
      ffprobe: tools.ffprobe,
      tmdb: metadata.enabled(),
      counts: { users, libraries, items, ...Object.fromEntries(byKind.map((r) => [r.kind, Number(r.count)])) },
      transcodes: transcoder.activeJobs(),
    },
  });
}));

module.exports = router;
