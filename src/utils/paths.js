'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

/** True when `child` equals `parent` or is nested inside it (both must be absolute & normalised). */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve a user-supplied library path to an absolute real path inside MEDIA_ROOT.
 * Relative input is resolved against MEDIA_ROOT. Symlinks are resolved so they
 * cannot be used to escape the media root.
 */
async function resolveLibraryPath(input) {
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\0')) {
    throw Object.assign(new Error('Invalid path'), { status: 400, expose: true });
  }
  const root = await fs.promises.realpath(config.media.root);
  const candidate = path.resolve(root, input.trim());
  let real;
  try {
    real = await fs.promises.realpath(candidate);
  } catch {
    throw Object.assign(new Error('Library path does not exist'), { status: 400, expose: true });
  }
  if (!isInside(root, real)) {
    throw Object.assign(new Error('Library path must be inside the media root'), { status: 400, expose: true });
  }
  const stat = await fs.promises.stat(real);
  if (!stat.isDirectory()) {
    throw Object.assign(new Error('Library path must be a directory'), { status: 400, expose: true });
  }
  return real;
}

/**
 * Resolve a media item's file on disk, re-checking that it is still inside its
 * library (defends against DB tampering and symlink swaps after scanning).
 */
async function resolveMediaFile(library, relativePath) {
  const base = await fs.promises.realpath(library.path);
  const candidate = path.resolve(base, relativePath);
  const real = await fs.promises.realpath(candidate);
  if (!isInside(base, real)) {
    throw Object.assign(new Error('File is outside its library'), { status: 403, expose: true });
  }
  return real;
}

/** Make an uploaded file name safe to write to disk. */
function sanitizeFilename(name) {
  const base = path.basename(String(name || '')).normalize('NFC');
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return cleaned || 'upload';
}

module.exports = { isInside, resolveLibraryPath, resolveMediaFile, sanitizeFilename };
