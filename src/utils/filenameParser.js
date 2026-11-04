'use strict';

const path = require('path');

// Release-group noise commonly found in file names.
const NOISE = /\b(2160p|1080p|720p|480p|4k|uhd|hdr10?|dv|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|web|hdtv|dvdrip|x264|x265|h\.?264|h\.?265|hevc|avc|aac\d?(\.\d)?|ac3|dts(-hd)?|ddp?5\.1|atmos|10bit|remux|proper|repack|extended|unrated|imax)\b.*$/i;

function clean(text) {
  return text
    .replace(/[._]+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripNoise(text) {
  return clean(text.replace(/[._]+/g, ' ').replace(NOISE, ''));
}

/** Sort title without leading articles, case-folded. */
function sortTitle(title) {
  return String(title)
    .replace(/^(the|a|an)\s+/i, '')
    .toLowerCase()
    .trim();
}

/**
 * Parse a movie filename like "The.Matrix.1999.1080p.BluRay.mkv" or "Heat (1995).mp4".
 * Falls back to the parent folder name when the file name is generic.
 */
function parseMovie(relativePath) {
  const ext = path.extname(relativePath);
  let name = path.basename(relativePath, ext);
  const parent = path.basename(path.dirname(relativePath));
  if (/^(movie|video|sample|main|feature)$/i.test(name) && parent && parent !== '.') name = parent;

  // Use the last plausible year so titles containing years ("Blade Runner 2049 (2017)",
  // "1917 (2019)") keep them. A year at the very start is part of the title.
  const re = /[\s._([-]+((?:19|20)\d{2})(?=[\s._)\]-]|$)/g;
  let match;
  let last = null;
  while ((match = re.exec(name)) !== null) last = match;
  if (last && last.index > 0) {
    const title = stripNoise(name.slice(0, last.index));
    if (title) return { title, year: Number(last[1]) };
  }
  return { title: stripNoise(name) || clean(name), year: null };
}

/**
 * Parse a TV episode path. Supports "Show/Season 1/Show - S01E02 - Title.mkv",
 * "Show.S01E02.mkv", "Show 1x02.mkv". Series title falls back to the top folder.
 */
function parseEpisode(relativePath) {
  const ext = path.extname(relativePath);
  const base = path.basename(relativePath, ext);
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const topFolder = parts.length > 1 ? parts[0] : null;

  const m = base.match(/^(.*?)[\s._-]*[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})(?:-?[Ee]\d{1,3})?(.*)$/)
    || base.match(/^(.*?)[\s._-]*(\d{1,2})x(\d{1,3})(.*)$/);

  if (!m) {
    const seasonFolder = parts.find((p) => /^season\s*\d+$/i.test(p));
    const epNum = base.match(/(?:^|\D)(\d{1,3})(?:\D|$)/);
    return {
      seriesTitle: topFolder ? clean(topFolder) : stripNoise(base),
      seasonNumber: seasonFolder ? Number(seasonFolder.match(/\d+/)[0]) : null,
      episodeNumber: epNum ? Number(epNum[1]) : null,
      title: stripNoise(base) || clean(base),
    };
  }

  const [, rawSeries, season, episode, rest] = m;
  const seriesFromName = stripNoise(rawSeries);
  const seriesTitle = (topFolder && !/^season\s*\d+$/i.test(topFolder) ? clean(topFolder).replace(/\s*\((19|20)\d{2}\)$/, '') : '')
    || seriesFromName
    || 'Unknown Series';
  const episodeTitle = stripNoise(rest.replace(/^[\s._-]+/, ''));
  const s = Number(season);
  const e = Number(episode);
  return {
    seriesTitle,
    seasonNumber: s,
    episodeNumber: e,
    title: episodeTitle || `Episode ${e}`,
  };
}

/** Parse "Artist/Album/01 - Title.mp3" when tags are missing. */
function parseTrack(relativePath) {
  const ext = path.extname(relativePath);
  const base = path.basename(relativePath, ext);
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const m = base.match(/^(\d{1,3})[\s._-]+(.*)$/);
  return {
    title: clean(m ? m[2] : base) || base,
    trackNumber: m ? Number(m[1]) : null,
    artist: parts.length >= 3 ? clean(parts[parts.length - 3]) : null,
    album: parts.length >= 2 ? clean(parts[parts.length - 2]) : null,
  };
}

function parsePhoto(relativePath) {
  const ext = path.extname(relativePath);
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  return {
    title: clean(path.basename(relativePath, ext)) || path.basename(relativePath),
    album: parts.length >= 2 ? clean(parts[parts.length - 2]) : null,
  };
}

module.exports = { parseMovie, parseEpisode, parseTrack, parsePhoto, sortTitle, clean };
