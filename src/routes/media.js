'use strict';

const fs = require('fs');
const express = require('express');
const { z } = require('zod');
const { Op } = require('sequelize');
const {
  sequelize, Library, MediaItem, WatchProgress, Favorite, MEDIA_KINDS,
} = require('../models');
const { validate } = require('../middleware/validate');
const { requireAuth, requireAdmin, requireMediaAccess, signStreamToken } = require('../middleware/auth');
const ffmpeg = require('../services/ffmpeg');
const metadata = require('../services/metadata');
const thumbnails = require('../services/thumbnails');
const transcoder = require('../services/transcoder');
const { isDirectPlayable } = require('../utils/mediaTypes');
const { resolveMediaFile } = require('../utils/paths');
const { sortTitle } = require('../utils/filenameParser');
const { asyncHandler, notFound, badRequest } = require('../utils/errors');

const router = express.Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

const listQuery = z.object({
  libraryId: z.coerce.number().int().positive().optional(),
  kind: z.enum(MEDIA_KINDS).optional(),
  q: z.string().trim().max(200).optional(),
  genre: z.string().trim().max(100).optional(),
  seriesTitle: z.string().max(512).optional(),
  artist: z.string().max(512).optional(),
  album: z.string().max(512).optional(),
  year: z.coerce.number().int().min(1800).max(3000).optional(),
  sort: z.enum(['title', 'added', 'year', 'rating', 'episode', 'track']).default('title'),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).default(0),
});

const groupQuery = z.object({
  libraryId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(200).optional(),
});

const httpUrl = z.string().trim().url().max(1024).refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');

const updateSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  year: z.number().int().min(1800).max(3000).nullable().optional(),
  overview: z.string().max(10000).nullable().optional(),
  genres: z.array(z.string().trim().min(1).max(100)).max(20).nullable().optional(),
  posterUrl: httpUrl.nullable().optional(),
  backdropUrl: httpUrl.nullable().optional(),
  rating: z.number().min(0).max(10).nullable().optional(),
  seriesTitle: z.string().trim().min(1).max(500).nullable().optional(),
  seasonNumber: z.number().int().min(0).max(1000).nullable().optional(),
  episodeNumber: z.number().int().min(0).max(10000).nullable().optional(),
  artist: z.string().trim().max(500).nullable().optional(),
  album: z.string().trim().max(500).nullable().optional(),
  trackNumber: z.number().int().min(0).max(10000).nullable().optional(),
}).strict();

const progressSchema = z.object({
  positionSeconds: z.number().min(0).max(1e7),
  completed: z.boolean().optional(),
});

const likeOp = () => (sequelize.getDialect() === 'postgres' ? Op.iLike : Op.like);
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function searchClause(q, fields) {
  const pattern = `%${escapeLike(q)}%`;
  return { [Op.or]: fields.map((f) => ({ [f]: { [likeOp()]: pattern } })) };
}

const SORTS = {
  title: [['sortTitle', 'ASC']],
  added: [['createdAt', 'DESC']],
  year: [['year', 'DESC'], ['sortTitle', 'ASC']],
  rating: [['rating', 'DESC'], ['sortTitle', 'ASC']],
  episode: [['seasonNumber', 'ASC'], ['episodeNumber', 'ASC'], ['sortTitle', 'ASC']],
  track: [['album', 'ASC'], ['trackNumber', 'ASC'], ['sortTitle', 'ASC']],
};

function orderFor(sort, order) {
  const base = SORTS[sort];
  if (!order) return [...base, ['id', 'ASC']];
  const dir = order.toUpperCase();
  return [[base[0][0], dir], ...base.slice(1), ['id', 'ASC']];
}

/** Attach the current user's watch progress and favourite flag to items. */
async function decorate(items, userId) {
  if (!items.length) return [];
  const ids = items.map((i) => i.id);
  const [progress, favorites] = await Promise.all([
    WatchProgress.findAll({ where: { userId, mediaItemId: ids } }),
    Favorite.findAll({ where: { userId, mediaItemId: ids }, attributes: ['mediaItemId'] }),
  ]);
  const p = new Map(progress.map((r) => [r.mediaItemId, r]));
  const f = new Set(favorites.map((r) => r.mediaItemId));
  return items.map((item) => {
    const json = item.toJSON();
    const pr = p.get(item.id);
    json.progress = pr ? { positionSeconds: pr.positionSeconds, completed: pr.completed, playCount: pr.playCount, updatedAt: pr.updatedAt } : null;
    json.favorite = f.has(item.id);
    return json;
  });
}

async function loadItem(id) {
  const item = await MediaItem.findByPk(id, { include: [{ model: Library, as: 'library' }] });
  if (!item) throw notFound('Media not found');
  return item;
}

const PLACEHOLDER_GLYPH = { movie: '🎬', episode: '📺', track: '♪', photo: '🖼' };
function placeholderSvg(kind) {
  const square = kind === 'track' || kind === 'photo';
  const [w, hgt] = square ? [400, 400] : [400, 600];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${hgt}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + '<stop offset="0" stop-color="#262a33"/><stop offset="1" stop-color="#181b22"/></linearGradient></defs>'
    + `<rect width="${w}" height="${hgt}" fill="url(#g)"/><text x="50%" y="50%" font-size="120" text-anchor="middle" dominant-baseline="central" fill="#6b7280">${PLACEHOLDER_GLYPH[kind] || '🎬'}</text></svg>`;
}

// --- Thumbnails (image token allowed so <img src> works) ---------------------

router.get('/:id/thumbnail', validate(idParam, 'params'), requireMediaAccess({ allowImageToken: true }), asyncHandler(async (req, res) => {
  const item = await loadItem(req.params.id);
  const width = Math.min(Math.max(Number.parseInt(req.query.w, 10) || 480, 64), 1280);
  const source = await resolveMediaFile(item.library, item.relativePath);
  const thumb = await thumbnails.getThumbnail(item, source, width);
  if (!thumb) {
    if (item.kind === 'photo') {
      res.set('Cache-Control', 'private, max-age=86400');
      return res.sendFile(source, { dotfiles: 'allow', headers: { 'Content-Type': item.mimeType } });
    }
    // Neutral placeholder instead of a 404 so <img> tags don't error.
    res.set('Cache-Control', 'private, max-age=3600');
    return res.type('image/svg+xml').send(placeholderSvg(item.kind));
  }
  res.set('Cache-Control', 'private, max-age=604800');
  return res.sendFile(thumb, { dotfiles: 'allow' });
}));

// Everything below requires a normal API session.
router.use(requireAuth);

router.get('/', validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validQuery;
  const where = {};
  if (q.libraryId) where.libraryId = q.libraryId;
  if (q.kind) where.kind = q.kind;
  if (q.seriesTitle) where.seriesTitle = q.seriesTitle;
  if (q.artist) where.artist = q.artist;
  if (q.album) where.album = q.album;
  if (q.year) where.year = q.year;
  const and = [];
  if (q.q) and.push(searchClause(q.q, ['title', 'seriesTitle', 'artist', 'album', 'overview']));
  if (q.genre) {
    // Genres are a JSON array; match the quoted value in its text form.
    const pattern = `%"${escapeLike(q.genre)}"%`;
    and.push(sequelize.where(sequelize.cast(sequelize.col('genres'), 'text'), { [likeOp()]: pattern }));
  }
  if (and.length) where[Op.and] = and;

  const { rows, count } = await MediaItem.findAndCountAll({
    where,
    order: orderFor(q.sort, q.order),
    limit: q.limit,
    offset: q.offset,
  });
  res.json({ data: await decorate(rows, req.user.id), total: count, limit: q.limit, offset: q.offset });
}));

router.get('/recent', asyncHandler(async (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 20, 100);
  const where = { kind: { [Op.in]: ['movie', 'episode', 'track'] } };
  if (req.query.libraryId) where.libraryId = Number.parseInt(req.query.libraryId, 10) || 0;
  const rows = await MediaItem.findAll({ where, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit });
  res.json({ data: await decorate(rows, req.user.id) });
}));

router.get('/continue', asyncHandler(async (req, res) => {
  const progress = await WatchProgress.findAll({
    where: { userId: req.user.id, completed: false, positionSeconds: { [Op.gt]: 5 } },
    order: [['updatedAt', 'DESC']],
    limit: 20,
    include: [{ model: MediaItem, as: 'mediaItem', required: true }],
  });
  res.json({ data: await decorate(progress.map((p) => p.mediaItem), req.user.id) });
}));

router.get('/history', asyncHandler(async (req, res) => {
  const progress = await WatchProgress.findAll({
    where: { userId: req.user.id },
    order: [['updatedAt', 'DESC']],
    limit: Math.min(Number.parseInt(req.query.limit, 10) || 50, 200),
    include: [{ model: MediaItem, as: 'mediaItem', required: true }],
  });
  res.json({ data: await decorate(progress.map((p) => p.mediaItem), req.user.id) });
}));

router.get('/favorites', asyncHandler(async (req, res) => {
  const favs = await Favorite.findAll({
    where: { userId: req.user.id },
    order: [['createdAt', 'DESC']],
    include: [{ model: MediaItem, as: 'mediaItem', required: true }],
  });
  res.json({ data: await decorate(favs.map((f) => f.mediaItem), req.user.id) });
}));

router.get('/genres', asyncHandler(async (req, res) => {
  const where = { genres: { [Op.ne]: null } };
  if (req.query.libraryId) where.libraryId = Number.parseInt(req.query.libraryId, 10) || 0;
  const rows = await MediaItem.findAll({ where, attributes: ['genres'] });
  const set = new Set();
  rows.forEach((r) => (Array.isArray(r.genres) ? r.genres : []).forEach((g) => set.add(g)));
  res.json({ data: [...set].sort((a, b) => a.localeCompare(b)) });
}));

/** TV series grouped from episodes. */
router.get('/shows', validate(groupQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validQuery;
  const where = { kind: 'episode' };
  if (q.libraryId) where.libraryId = q.libraryId;
  if (q.q) Object.assign(where, searchClause(q.q, ['seriesTitle']));
  const rows = await MediaItem.findAll({
    where,
    attributes: [
      'seriesTitle',
      [sequelize.fn('COUNT', sequelize.col('id')), 'episodeCount'],
      [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('season_number'))), 'seasonCount'],
      [sequelize.fn('MIN', sequelize.col('id')), 'firstEpisodeId'],
      [sequelize.fn('MAX', sequelize.col('poster_url')), 'posterUrl'],
      [sequelize.fn('MAX', sequelize.col('overview')), 'overview'],
      [sequelize.fn('MAX', sequelize.col('created_at')), 'lastAddedAt'],
    ],
    group: ['seriesTitle'],
    order: [['seriesTitle', 'ASC']],
    raw: true,
  });
  res.json({
    data: rows.map((r) => ({
      ...r,
      episodeCount: Number(r.episodeCount),
      seasonCount: Number(r.seasonCount),
      firstEpisodeId: Number(r.firstEpisodeId),
    })),
  });
}));

/** Albums grouped from tracks. */
router.get('/albums', validate(groupQuery, 'query'), asyncHandler(async (req, res) => {
  const q = req.validQuery;
  const where = { kind: 'track' };
  if (q.libraryId) where.libraryId = q.libraryId;
  if (q.q) Object.assign(where, searchClause(q.q, ['artist', 'album']));
  const rows = await MediaItem.findAll({
    where,
    attributes: [
      'artist',
      'album',
      [sequelize.fn('COUNT', sequelize.col('id')), 'trackCount'],
      [sequelize.fn('MIN', sequelize.col('id')), 'firstTrackId'],
      [sequelize.fn('MAX', sequelize.col('year')), 'year'],
    ],
    group: ['artist', 'album'],
    order: [['artist', 'ASC'], ['album', 'ASC']],
    raw: true,
  });
  res.json({ data: rows.map((r) => ({ ...r, trackCount: Number(r.trackCount), firstTrackId: Number(r.firstTrackId) })) });
}));

router.get('/:id', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const item = await loadItem(req.params.id);
  const [json] = await decorate([item], req.user.id);
  delete json.library;
  json.libraryName = item.library.name;
  json.libraryType = item.library.type;
  if (req.user.role !== 'admin') delete json.relativePath;

  const { ffmpeg: canTranscode } = await ffmpeg.detect();
  const isVideo = item.kind === 'movie' || item.kind === 'episode';
  json.playback = {
    directPlayable: isDirectPlayable(item),
    hls: Boolean(isVideo && canTranscode && item.durationSeconds),
    audioTranscode: Boolean(item.kind === 'track' && canTranscode),
    qualities: isVideo ? transcoder.availableQualities(item).map((q) => q.name) : [],
    subtitles: (item.subtitles || []).map((s) => ({ id: s.id, label: s.label, language: s.language })),
  };

  if (item.kind === 'episode' && item.seriesTitle) {
    const next = await MediaItem.findOne({
      where: {
        libraryId: item.libraryId,
        seriesTitle: item.seriesTitle,
        [Op.or]: [
          { seasonNumber: item.seasonNumber, episodeNumber: { [Op.gt]: item.episodeNumber ?? -1 } },
          { seasonNumber: { [Op.gt]: item.seasonNumber ?? -1 } },
        ],
      },
      order: [['seasonNumber', 'ASC'], ['episodeNumber', 'ASC'], ['id', 'ASC']],
    });
    json.nextItemId = next ? next.id : null;
  } else if (item.kind === 'track' && item.album) {
    const next = await MediaItem.findOne({
      where: {
        libraryId: item.libraryId,
        album: item.album,
        artist: item.artist,
        [Op.or]: [
          { trackNumber: { [Op.gt]: item.trackNumber ?? -1 } },
          { trackNumber: item.trackNumber, id: { [Op.gt]: item.id } },
        ],
      },
      order: [['trackNumber', 'ASC'], ['id', 'ASC']],
    });
    json.nextItemId = next ? next.id : null;
  }
  res.json({ data: json });
}));

/** Issue a stream token and the URLs a player needs. */
router.post('/:id/playback', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const item = await loadItem(req.params.id);
  const token = signStreamToken(req.user, item.id);
  const t = `token=${encodeURIComponent(token)}`;
  const base = `/api/stream/${item.id}`;
  const { ffmpeg: canTranscode } = await ffmpeg.detect();
  const isVideo = item.kind === 'movie' || item.kind === 'episode';
  const progress = await WatchProgress.findOne({ where: { userId: req.user.id, mediaItemId: item.id } });
  res.json({
    data: {
      token,
      mimeType: item.mimeType,
      directPlayable: isDirectPlayable(item),
      directUrl: `${base}/direct?${t}`,
      hlsUrl: isVideo && canTranscode && item.durationSeconds ? `${base}/hls/master.m3u8?${t}` : null,
      audioTranscodeUrl: item.kind === 'track' && canTranscode ? `${base}/audio?${t}` : null,
      subtitles: (item.subtitles || []).map((s) => ({
        id: s.id, label: s.label, language: s.language, url: `${base}/subtitles/${encodeURIComponent(s.id)}.vtt?${t}`,
      })),
      resumePositionSeconds: progress && !progress.completed ? progress.positionSeconds : 0,
      durationSeconds: item.durationSeconds,
    },
  });
}));

router.put('/:id/progress', validate(idParam, 'params'), validate(progressSchema), asyncHandler(async (req, res) => {
  const item = await MediaItem.findByPk(req.params.id);
  if (!item) throw notFound('Media not found');
  const position = item.durationSeconds ? Math.min(req.body.positionSeconds, item.durationSeconds) : req.body.positionSeconds;
  const autoComplete = item.durationSeconds ? position >= item.durationSeconds * 0.92 : false;
  const completed = req.body.completed ?? autoComplete;

  const result = await sequelize.transaction(async (transaction) => {
    const [row] = await WatchProgress.findOrCreate({
      where: { userId: req.user.id, mediaItemId: item.id },
      defaults: { positionSeconds: 0, completed: false, playCount: 0 },
      transaction,
    });
    const becameCompleted = completed && !row.completed;
    row.positionSeconds = completed ? 0 : position;
    row.completed = completed;
    if (becameCompleted) row.playCount += 1;
    row.changed('updatedAt', true);
    await row.save({ transaction });
    return row;
  });
  res.json({ data: { positionSeconds: result.positionSeconds, completed: result.completed, playCount: result.playCount } });
}));

/** Mark watched / unwatched. */
router.post('/:id/watched', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const item = await MediaItem.findByPk(req.params.id);
  if (!item) throw notFound('Media not found');
  const [row] = await WatchProgress.findOrCreate({
    where: { userId: req.user.id, mediaItemId: item.id },
    defaults: { positionSeconds: 0, completed: false, playCount: 0 },
  });
  if (!row.completed) row.playCount += 1;
  row.completed = true;
  row.positionSeconds = 0;
  await row.save();
  res.json({ data: { completed: true, playCount: row.playCount } });
}));

router.delete('/:id/progress', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  await WatchProgress.destroy({ where: { userId: req.user.id, mediaItemId: req.params.id } });
  res.status(204).end();
}));

router.put('/:id/favorite', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const item = await MediaItem.findByPk(req.params.id);
  if (!item) throw notFound('Media not found');
  await Favorite.findOrCreate({ where: { userId: req.user.id, mediaItemId: item.id } });
  res.json({ data: { favorite: true } });
}));

router.delete('/:id/favorite', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  await Favorite.destroy({ where: { userId: req.user.id, mediaItemId: req.params.id } });
  res.json({ data: { favorite: false } });
}));

// --- Admin -------------------------------------------------------------------

router.patch('/:id', requireAdmin, validate(idParam, 'params'), validate(updateSchema), asyncHandler(async (req, res) => {
  const item = await MediaItem.findByPk(req.params.id);
  if (!item) throw notFound('Media not found');
  const changes = { ...req.body, metadataFetchedAt: new Date() };
  if (changes.title || changes.seriesTitle) {
    const title = changes.title || item.title;
    const series = changes.seriesTitle || item.seriesTitle;
    changes.sortTitle = sortTitle(item.kind === 'episode' ? `${series} ${title}` : title);
  }
  await item.update(changes);
  res.json({ data: item });
}));

router.post('/:id/refresh-metadata', requireAdmin, validate(idParam, 'params'), asyncHandler(async (req, res) => {
  if (!metadata.enabled()) throw badRequest('Set TMDB_API_KEY to enable online metadata');
  const item = await MediaItem.findByPk(req.params.id);
  if (!item) throw notFound('Media not found');
  const found = await metadata.enrich(item);
  const update = { metadataFetchedAt: new Date() };
  if (found) for (const [k, v] of Object.entries(found)) if (v !== undefined && v !== null) update[k] = v;
  await item.update(update);
  res.json({ data: item, matched: Boolean(found) });
}));

router.delete('/:id', requireAdmin, validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const item = await loadItem(req.params.id);
  if (req.query.deleteFile === 'true') {
    const file = await resolveMediaFile(item.library, item.relativePath);
    await fs.promises.rm(file, { force: true });
  }
  await item.destroy();
  res.status(204).end();
}));

module.exports = router;
