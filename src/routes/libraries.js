'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const config = require('../config');
const { Library, MediaItem, LIBRARY_TYPES, sequelize } = require('../models');
const { validate } = require('../middleware/validate');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const scanner = require('../services/scanner');
const { resolveLibraryPath, sanitizeFilename, isInside } = require('../utils/paths');
const { isAllowedForLibrary, SUBTITLE_EXT } = require('../utils/mediaTypes');
const { asyncHandler, notFound, badRequest, conflict } = require('../utils/errors');

const router = express.Router();
router.use(requireAuth);

const idParam = z.object({ id: z.coerce.number().int().positive() });

const createSchema = z.object({
  name: z.string().trim().min(1).max(128),
  type: z.enum(LIBRARY_TYPES),
  path: z.string().trim().min(1).max(1024),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(128),
});

async function withCounts(libraries) {
  const rows = await MediaItem.findAll({
    attributes: ['libraryId', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
    group: ['libraryId'],
    raw: true,
  });
  const counts = new Map(rows.map((r) => [r.libraryId, Number(r.count)]));
  return libraries.map((l) => ({
    ...l.toJSON(),
    itemCount: counts.get(l.id) || 0,
    scanning: scanner.isScanning(l.id),
  }));
}

function publicLibrary(lib, isAdmin) {
  if (isAdmin) return lib;
  const { path: p, scanError, ...rest } = lib;
  return rest;
}

function startScan(libraryId, options) {
  scanner.scanLibrary(libraryId, options).catch((err) => {
    if (!config.isTest) console.error(`[scanner] library ${libraryId} failed: ${err.message}`);
  });
}

router.get('/', asyncHandler(async (req, res) => {
  const libs = await withCounts(await Library.findAll({ order: [['name', 'ASC']] }));
  const isAdmin = req.user.role === 'admin';
  res.json({ data: libs.map((l) => publicLibrary(l, isAdmin)) });
}));

/** Admin folder picker: list sub-directories of a path inside MEDIA_ROOT. */
router.get('/browse', requireAdmin, asyncHandler(async (req, res) => {
  await fs.promises.mkdir(config.media.root, { recursive: true });
  const root = await fs.promises.realpath(config.media.root);
  const requested = typeof req.query.path === 'string' && req.query.path ? req.query.path : '.';
  const dir = await resolveLibraryPath(requested);
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const rel = path.relative(root, dir);
  res.json({ root, path: rel || '.', parent: rel ? path.dirname(rel) : null, directories: dirs });
}));

router.get('/:id', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const lib = await Library.findByPk(req.params.id);
  if (!lib) throw notFound('Library not found');
  const [withCount] = await withCounts([lib]);
  res.json({ data: publicLibrary(withCount, req.user.role === 'admin') });
}));

router.post('/', requireAdmin, validate(createSchema), asyncHandler(async (req, res) => {
  const realPath = await resolveLibraryPath(req.body.path);
  if (await Library.findOne({ where: { path: realPath } })) throw conflict('A library already uses this folder');
  const lib = await Library.create({ name: req.body.name, type: req.body.type, path: realPath });
  startScan(lib.id);
  res.status(201).json({ data: lib });
}));

router.patch('/:id', requireAdmin, validate(idParam, 'params'), validate(updateSchema), asyncHandler(async (req, res) => {
  const lib = await Library.findByPk(req.params.id);
  if (!lib) throw notFound('Library not found');
  await lib.update({ name: req.body.name });
  res.json({ data: lib });
}));

/** Removes the library and its index entries. Files on disk are never touched. */
router.delete('/:id', requireAdmin, validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const lib = await Library.findByPk(req.params.id);
  if (!lib) throw notFound('Library not found');
  if (scanner.isScanning(lib.id)) throw conflict('Library is being scanned; try again when it finishes');
  await sequelize.transaction(async (transaction) => {
    await MediaItem.destroy({ where: { libraryId: lib.id }, transaction });
    await lib.destroy({ transaction });
  });
  res.status(204).end();
}));

router.post('/:id/scan', requireAdmin, validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const lib = await Library.findByPk(req.params.id);
  if (!lib) throw notFound('Library not found');
  const options = { refreshMetadata: req.query.refreshMetadata === 'true' };
  if (req.query.wait === 'true') {
    const stats = await scanner.scanLibrary(lib.id, options);
    return res.json({ data: stats });
  }
  startScan(lib.id, options);
  return res.status(202).json({ message: 'Scan started' });
}));

// --- Uploads -----------------------------------------------------------------

const subfolderSchema = z.string().trim().max(512).regex(/^[^\0]*$/).optional();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, req.uploadDir),
    filename: (req, file, cb) => {
      // Write under a temporary name; it is renamed after validation succeeds.
      cb(null, `.upload-${crypto.randomBytes(8).toString('hex')}`);
    },
  }),
  limits: { fileSize: config.media.maxUploadBytes, files: 20 },
  fileFilter: (req, file, cb) => {
    const name = sanitizeFilename(file.originalname);
    const ext = path.extname(name).toLowerCase();
    const okMedia = isAllowedForLibrary(req.library.type, name);
    const okSubtitle = ['movies', 'tv'].includes(req.library.type) && SUBTITLE_EXT.includes(ext);
    if (!okMedia && !okSubtitle) {
      return cb(Object.assign(new Error(`File type ${ext || '(none)'} is not allowed in a ${req.library.type} library`), { status: 400, expose: true }));
    }
    return cb(null, true);
  },
});

async function prepareUpload(req, res, next) {
  try {
    const lib = await Library.findByPk(req.params.id);
    if (!lib) throw notFound('Library not found');
    const sub = subfolderSchema.parse(req.query.folder || undefined);
    const base = await fs.promises.realpath(lib.path);
    // Drop empty, "." and ".." segments, then sanitise each remaining one.
    const segments = (sub || '').split(/[\\/]/).filter((seg) => seg && seg !== '.' && seg !== '..').map(sanitizeFilename);
    const target = path.resolve(base, ...segments);
    if (!isInside(base, target)) throw badRequest('Upload folder must be inside the library');
    await fs.promises.mkdir(target, { recursive: true });
    req.library = lib;
    req.uploadDir = target;
    next();
  } catch (err) {
    next(err);
  }
}

async function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let i = 0; i < 1000; i += 1) {
    const candidate = i === 0 ? name : `${stem} (${i})${ext}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.access(path.join(dir, candidate));
    } catch {
      return candidate;
    }
  }
  throw conflict('Could not find a free file name');
}

router.post(
  '/:id/upload',
  requireAdmin,
  validate(idParam, 'params'),
  prepareUpload,
  upload.array('files', 20),
  asyncHandler(async (req, res) => {
    const files = req.files || [];
    if (!files.length) throw badRequest('No files were uploaded (use the "files" field)');
    const saved = [];
    try {
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        const finalName = await uniqueName(req.uploadDir, sanitizeFilename(file.originalname));
        // eslint-disable-next-line no-await-in-loop
        await fs.promises.rename(file.path, path.join(req.uploadDir, finalName));
        saved.push(path.relative(req.library.path, path.join(req.uploadDir, finalName)));
      }
    } catch (err) {
      await Promise.all(files.map((f) => fs.promises.rm(f.path, { force: true })));
      throw err;
    }
    startScan(req.library.id);
    res.status(201).json({ data: { files: saved } });
  }),
);

// Clean up temp files if multer rejected part of a multi-file upload.
// eslint-disable-next-line no-unused-vars
router.use(async (err, req, res, next) => {
  if (req.files && req.files.length) {
    await Promise.all(req.files.map((f) => fs.promises.rm(f.path, { force: true })));
  }
  next(err);
});

module.exports = router;
