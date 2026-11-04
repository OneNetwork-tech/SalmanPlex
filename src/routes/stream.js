'use strict';

const fs = require('fs');
const express = require('express');
const { z } = require('zod');
const { MediaItem, Library } = require('../models');
const { validate } = require('../middleware/validate');
const { requireMediaAccess } = require('../middleware/auth');
const ffmpeg = require('../services/ffmpeg');
const transcoder = require('../services/transcoder');
const subtitles = require('../services/subtitles');
const { resolveMediaFile } = require('../utils/paths');
const { asyncHandler, notFound, unavailable, badRequest } = require('../utils/errors');

const router = express.Router({ mergeParams: true });

const idParam = z.object({ id: z.coerce.number().int().positive() }).passthrough();

router.use('/:id', validate(idParam, 'params'), requireMediaAccess(), asyncHandler(async (req, res, next) => {
  const item = await MediaItem.findByPk(req.params.id, { include: [{ model: Library, as: 'library' }] });
  if (!item) throw notFound('Media not found');
  req.item = item;
  req.sourcePath = await resolveMediaFile(item.library, item.relativePath);
  res.set('Cache-Control', 'private, no-transform');
  next();
}));

/** Original file with HTTP Range support (seeking, resumable downloads). */
router.get('/:id/direct', (req, res, next) => {
  res.sendFile(req.sourcePath, {
    dotfiles: 'allow',
    acceptRanges: true,
    lastModified: true,
    headers: { 'Content-Type': req.item.mimeType || 'application/octet-stream' },
  }, (err) => {
    if (err && !res.headersSent) next(err);
  });
});

async function requireHls(req) {
  const { item } = req;
  if (item.kind !== 'movie' && item.kind !== 'episode') throw badRequest('HLS is only available for video');
  const { ffmpeg: ok } = await ffmpeg.detect();
  if (!ok) throw unavailable('Transcoding is not available on this server (ffmpeg missing or disabled)');
  if (!item.durationSeconds) throw unavailable('Media duration is unknown; rescan the library with ffprobe installed');
}

const HLS_TYPE = 'application/vnd.apple.mpegurl';

router.get('/:id/hls/master.m3u8', asyncHandler(async (req, res) => {
  await requireHls(req);
  res.type(HLS_TYPE).send(transcoder.masterPlaylist(req.item, req.streamToken));
}));

router.get('/:id/hls/:quality/index.m3u8', asyncHandler(async (req, res) => {
  await requireHls(req);
  if (!transcoder.QUALITIES[req.params.quality]) throw notFound('Unknown quality');
  res.type(HLS_TYPE).send(transcoder.mediaPlaylist(req.item, req.streamToken));
}));

router.get('/:id/hls/:quality/seg_:index.ts', asyncHandler(async (req, res) => {
  await requireHls(req);
  const index = Number.parseInt(req.params.index, 10);
  const file = await transcoder.getSegment(req.item, req.sourcePath, req.params.quality, index);
  res.sendFile(file, { dotfiles: 'allow', headers: { 'Content-Type': 'video/mp2t' } });
}));

/** Progressive MP3 transcode for audio formats browsers can't decode. */
router.get('/:id/audio', asyncHandler(async (req, res) => {
  if (req.item.kind !== 'track') throw badRequest('Audio transcoding is only available for music');
  const { ffmpeg: ok } = await ffmpeg.detect();
  if (!ok) throw unavailable('Transcoding is not available on this server');
  const start = Math.max(Number.parseFloat(req.query.start) || 0, 0);
  const proc = ffmpeg.spawnFfmpeg([
    ...(start ? ['-ss', String(start)] : []),
    '-i', req.sourcePath, '-vn', '-c:a', 'libmp3lame', '-b:a', '256k', '-f', 'mp3', 'pipe:1',
  ], { stdout: 'pipe' });
  res.type('audio/mpeg');
  proc.stdout.pipe(res);
  proc.stderr.resume();
  const stop = () => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  };
  req.on('close', stop);
  proc.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
}));

router.get('/:id/subtitles/:trackId.vtt', asyncHandler(async (req, res) => {
  const track = (req.item.subtitles || []).find((s) => s.id === req.params.trackId);
  if (!track) throw notFound('Subtitle track not found');
  const libraryRoot = await fs.promises.realpath(req.item.library.path);
  const file = await subtitles.getVtt(req.item, track, req.sourcePath, libraryRoot);
  res.sendFile(file, { dotfiles: 'allow', headers: { 'Content-Type': 'text/vtt; charset=utf-8' } });
}));

module.exports = router;
