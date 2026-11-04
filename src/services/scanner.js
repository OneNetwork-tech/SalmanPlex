'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { Library, MediaItem } = require('../models');
const ffmpeg = require('./ffmpeg');
const metadata = require('./metadata');
const parser = require('../utils/filenameParser');
const { isAllowedForLibrary, mimeFor, SUBTITLE_EXT } = require('../utils/mediaTypes');
const { isInside } = require('../utils/paths');

const KIND_BY_LIBRARY = { movies: 'movie', tv: 'episode', music: 'track', photos: 'photo' };
const MAX_DEPTH = 12;
const PROBE_CONCURRENCY = 4;

const runningScans = new Map(); // libraryId -> Promise

/** Recursively list files under `dir`, skipping hidden entries and symlinks that escape `root`. */
async function walk(root, dir = root, depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('@eaDir')) continue;
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const real = await fs.promises.realpath(full);
        if (!isInside(root, real)) continue;
        const st = await fs.promises.stat(real);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) await walk(root, full, depth + 1, out);
    else if (isFile) out.push(full);
  }
  return out;
}

/** Find sidecar subtitle files: "Movie.srt", "Movie.en.srt", "Movie.English.forced.vtt". */
function findSidecarSubtitles(mediaRel, allFilesRel) {
  const dir = path.dirname(mediaRel);
  const stem = path.basename(mediaRel, path.extname(mediaRel));
  return allFilesRel
    .filter((f) => path.dirname(f) === dir && SUBTITLE_EXT.includes(path.extname(f).toLowerCase()))
    .filter((f) => {
      const subStem = path.basename(f, path.extname(f));
      return subStem === stem || subStem.startsWith(`${stem}.`);
    })
    .map((f, i) => {
      const subStem = path.basename(f, path.extname(f));
      const tag = subStem.slice(stem.length + 1) || null;
      return {
        id: `ext-${i}`,
        source: 'external',
        relativePath: f,
        language: tag ? tag.split('.')[0] : null,
        label: tag || 'External',
      };
    });
}

function buildSubtitleList(sidecars, probed) {
  const embedded = ((probed && probed.embeddedSubtitles) || [])
    .filter((s) => s.textBased)
    .map((s) => ({
      id: `emb-${s.streamIndex}`,
      source: 'embedded',
      streamIndex: s.streamIndex,
      language: s.language,
      label: [s.title, s.language].filter(Boolean).join(' – ') || `Track ${s.ordinal + 1}`,
    }));
  return [...sidecars, ...embedded];
}

function describe(library, relativePath, probed) {
  const kind = KIND_BY_LIBRARY[library.type];
  const tags = (probed && probed.tags) || {};
  let fields;
  if (kind === 'movie') {
    const p = parser.parseMovie(relativePath);
    fields = { title: p.title, year: p.year };
  } else if (kind === 'episode') {
    const p = parser.parseEpisode(relativePath);
    fields = { title: p.title, seriesTitle: p.seriesTitle, seasonNumber: p.seasonNumber, episodeNumber: p.episodeNumber };
  } else if (kind === 'track') {
    const p = parser.parseTrack(relativePath);
    const trackTag = tags.track ? Number.parseInt(String(tags.track).split('/')[0], 10) : null;
    const yearTag = tags.date ? Number.parseInt(String(tags.date).slice(0, 4), 10) : null;
    fields = {
      title: tags.title || p.title,
      artist: tags.artist || tags.album_artist || p.artist,
      album: tags.album || p.album,
      trackNumber: Number.isFinite(trackTag) ? trackTag : p.trackNumber,
      year: Number.isFinite(yearTag) ? yearTag : null,
      genres: tags.genre ? [tags.genre] : null,
    };
  } else {
    const p = parser.parsePhoto(relativePath);
    fields = { title: p.title, album: p.album };
  }
  fields.title = String(fields.title || path.basename(relativePath)).slice(0, 500);
  fields.sortTitle = parser.sortTitle(kind === 'episode' ? `${fields.seriesTitle} ${fields.title}` : fields.title).slice(0, 500);
  return { kind, ...fields };
}

async function mapLimit(items, limit, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      // eslint-disable-next-line no-await-in-loop
      await fn(current);
    }
  });
  await Promise.all(workers);
}

async function doScan(library, { refreshMetadata = false } = {}) {
  const stats = { added: 0, updated: 0, removed: 0, unchanged: 0, failed: 0 };
  const root = await fs.promises.realpath(library.path);
  const absFiles = await walk(root);
  const relFiles = absFiles.map((f) => path.relative(root, f));
  const mediaFiles = relFiles.filter((f) => isAllowedForLibrary(library.type, f));

  const existing = await MediaItem.findAll({ where: { libraryId: library.id } });
  const byPath = new Map(existing.map((i) => [i.relativePath, i]));
  const seen = new Set();

  await mapLimit(mediaFiles, PROBE_CONCURRENCY, async (rel) => {
    seen.add(rel);
    try {
      const abs = path.join(root, rel);
      const st = await fs.promises.stat(abs);
      const current = byPath.get(rel);
      const sidecars = library.type === 'movies' || library.type === 'tv' ? findSidecarSubtitles(rel, relFiles) : [];

      if (current && Number(current.fileSize) === st.size && current.fileMtime
        && current.fileMtime.getTime() === Math.floor(st.mtimeMs)) {
        // File unchanged: refresh sidecar subtitles only (they may be added later).
        const embedded = (current.subtitles || []).filter((s) => s.source === 'embedded');
        const subs = [...sidecars, ...embedded];
        if (JSON.stringify(subs) !== JSON.stringify(current.subtitles || [])) {
          await current.update({ subtitles: subs });
        }
        stats.unchanged += 1;
        return;
      }

      const probed = library.type === 'photos' ? null : await ffmpeg.probe(abs);
      const fields = {
        ...describe(library, rel, probed),
        libraryId: library.id,
        relativePath: rel,
        fileSize: st.size,
        fileMtime: new Date(Math.floor(st.mtimeMs)),
        mimeType: mimeFor(rel),
        container: probed ? probed.container : path.extname(rel).slice(1).toLowerCase(),
        durationSeconds: probed ? probed.durationSeconds : null,
        width: probed ? probed.width : null,
        height: probed ? probed.height : null,
        videoCodec: probed ? probed.videoCodec : null,
        audioCodec: probed ? probed.audioCodec : null,
        bitrate: probed ? probed.bitrate : null,
        subtitles: buildSubtitleList(sidecars, probed),
      };

      if (current) {
        // Keep any metadata fetched from TMDb or edited by an admin.
        if (current.metadataFetchedAt) {
          for (const k of ['title', 'year', 'genres', 'sortTitle']) {
            if (current[k] !== null && current[k] !== undefined) delete fields[k];
          }
        }
        await current.update(fields);
        stats.updated += 1;
      } else {
        await MediaItem.create(fields);
        stats.added += 1;
      }
    } catch (err) {
      stats.failed += 1;
      if (!config.isTest) console.warn(`[scanner] failed to index ${rel}: ${err.message}`);
    }
  });

  const missing = existing.filter((i) => !seen.has(i.relativePath));
  if (missing.length) {
    await MediaItem.destroy({ where: { id: missing.map((i) => i.id) } });
    stats.removed = missing.length;
  }

  if (metadata.enabled()) {
    const where = { libraryId: library.id };
    if (!refreshMetadata) where.metadataFetchedAt = null;
    const pending = await MediaItem.findAll({ where });
    await mapLimit(pending.filter((i) => i.kind === 'movie' || i.kind === 'episode'), 3, async (item) => {
      const found = await metadata.enrich(item);
      const update = { metadataFetchedAt: new Date() };
      if (found) {
        for (const [k, v] of Object.entries(found)) if (v !== undefined && v !== null) update[k] = v;
        if (update.title && item.kind === 'episode') update.sortTitle = parser.sortTitle(`${item.seriesTitle} ${update.title}`);
      }
      await item.update(update);
    });
  }

  return stats;
}

/**
 * Scan a library. Only one scan per library runs at a time; concurrent callers
 * receive the in-flight promise.
 */
function scanLibrary(libraryId, options = {}) {
  if (runningScans.has(libraryId)) return runningScans.get(libraryId);
  const promise = (async () => {
    const library = await Library.findByPk(libraryId);
    if (!library) throw Object.assign(new Error('Library not found'), { status: 404, expose: true });
    await library.update({ scanStatus: 'scanning', scanError: null });
    try {
      const stats = await doScan(library, options);
      await library.update({ scanStatus: 'idle', lastScannedAt: new Date() });
      return stats;
    } catch (err) {
      await library.update({ scanStatus: 'error', scanError: String(err.message).slice(0, 2000) });
      throw err;
    }
  })().finally(() => runningScans.delete(libraryId));
  runningScans.set(libraryId, promise);
  return promise;
}

function isScanning(libraryId) {
  return runningScans.has(libraryId);
}

async function waitForScans() {
  await Promise.allSettled([...runningScans.values()]);
}

module.exports = { scanLibrary, isScanning, waitForScans, walk, describe, findSidecarSubtitles };
