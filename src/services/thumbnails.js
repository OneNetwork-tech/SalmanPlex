'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const ffmpeg = require('./ffmpeg');

const inflight = new Map();

function cachePath(item, width) {
  const version = item.fileMtime ? new Date(item.fileMtime).getTime() : 0;
  return path.join(config.media.cacheDir, 'thumbs', `${item.id}-${width}-${version}.jpg`);
}

/**
 * Generate (or reuse) a JPEG thumbnail for a media item. Returns the cached path,
 * or null when no thumbnail can be produced (no ffmpeg, no cover art, …).
 */
async function getThumbnail(item, sourcePath, width = 480) {
  const out = cachePath(item, width);
  const missMarker = `${out}.none`;
  try {
    await fs.promises.access(out);
    return out;
  } catch {
    // not cached yet
  }
  // Remember failures (e.g. a track without cover art) so ffmpeg isn't re-run.
  if (await fs.promises.access(missMarker).then(() => true, () => false)) return null;
  const { ffmpeg: hasFfmpeg } = await ffmpeg.detect();
  if (!hasFfmpeg) return null;

  if (inflight.has(out)) return inflight.get(out);
  const job = (async () => {
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.tmp.jpg`;
    const scale = `scale='min(${width},iw)':-2`;
    let args;
    if (item.kind === 'movie' || item.kind === 'episode') {
      const at = item.durationSeconds ? Math.min(Math.max(item.durationSeconds * 0.1, 1), 300) : 5;
      args = ['-ss', at.toFixed(2), '-i', sourcePath, '-frames:v', '1', '-vf', scale, '-q:v', '4', '-y', tmp];
    } else if (item.kind === 'track') {
      // Embedded album art.
      args = ['-i', sourcePath, '-map', '0:v:0', '-frames:v', '1', '-vf', scale, '-q:v', '4', '-y', tmp];
    } else {
      args = ['-i', sourcePath, '-frames:v', '1', '-vf', scale, '-q:v', '4', '-y', tmp];
    }
    try {
      await ffmpeg.runFfmpeg(args, 30000);
      await fs.promises.rename(tmp, out);
      return out;
    } catch {
      await fs.promises.rm(tmp, { force: true });
      await fs.promises.writeFile(missMarker, '').catch(() => {});
      return null;
    }
  })().finally(() => inflight.delete(out));
  inflight.set(out, job);
  return job;
}

module.exports = { getThumbnail };
