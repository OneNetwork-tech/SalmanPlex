'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const ffmpeg = require('./ffmpeg');

/** Convert SubRip text to WebVTT (pure JS, used when ffmpeg is unavailable). */
function srtToVtt(srt) {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

/**
 * Produce a WebVTT file for a subtitle entry of a media item and return its path.
 * `track` is one element of item.subtitles.
 */
async function getVtt(item, track, mediaPath, libraryRoot) {
  const version = item.fileMtime ? new Date(item.fileMtime).getTime() : 0;
  const out = path.join(config.media.cacheDir, 'subtitles', `${item.id}-${track.id}-${version}.vtt`);
  try {
    await fs.promises.access(out);
    return out;
  } catch {
    // generate below
  }
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;

  if (track.source === 'external') {
    const subPath = path.resolve(libraryRoot, track.relativePath);
    const rel = path.relative(libraryRoot, subPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw Object.assign(new Error('Invalid subtitle path'), { status: 403 });
    if (path.extname(subPath).toLowerCase() === '.vtt') return subPath;
    const text = await fs.promises.readFile(subPath, 'utf8');
    await fs.promises.writeFile(tmp, srtToVtt(text));
  } else {
    const { ffmpeg: hasFfmpeg } = await ffmpeg.detect();
    if (!hasFfmpeg) throw Object.assign(new Error('Subtitle extraction requires ffmpeg'), { status: 503, expose: true });
    await ffmpeg.runFfmpeg(['-i', mediaPath, '-map', `0:${track.streamIndex}`, '-f', 'webvtt', '-y', tmp], 120000);
  }
  await fs.promises.rename(tmp, out);
  return out;
}

module.exports = { getVtt, srtToVtt };
