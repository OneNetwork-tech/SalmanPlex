'use strict';

const config = require('../config');

/**
 * Optional TMDb enrichment. Without TMDB_API_KEY everything is a no-op so the
 * server works fully offline using file names and embedded tags.
 */
function enabled() {
  return Boolean(config.metadata.tmdbApiKey);
}

async function tmdb(pathname, params = {}) {
  const url = new URL(config.metadata.tmdbBaseUrl + pathname);
  const key = config.metadata.tmdbApiKey;
  // Support both v3 API keys (query param) and v4 read access tokens (bearer).
  const headers = { Accept: 'application/json' };
  if (key.length > 40) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  url.searchParams.set('language', config.metadata.tmdbLanguage);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`TMDb ${pathname} responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const image = (p) => (p ? `${config.metadata.tmdbImageBase}${p}` : null);

async function genreMap(kind) {
  const data = await tmdb(`/genre/${kind}/list`);
  return new Map((data.genres || []).map((g) => [g.id, g.name]));
}

const genreCache = {};
async function genresFor(kind, ids = []) {
  if (!genreCache[kind]) genreCache[kind] = genreMap(kind).catch(() => new Map());
  const map = await genreCache[kind];
  return ids.map((id) => map.get(id)).filter(Boolean);
}

async function lookupMovie(title, year) {
  const data = await tmdb('/search/movie', { query: title, year: year || undefined, include_adult: false });
  const hit = (data.results || [])[0];
  if (!hit) return null;
  return {
    tmdbId: hit.id,
    overview: hit.overview || null,
    posterUrl: image(hit.poster_path),
    backdropUrl: image(hit.backdrop_path),
    rating: typeof hit.vote_average === 'number' ? hit.vote_average : null,
    year: hit.release_date ? Number(hit.release_date.slice(0, 4)) || year : year,
    genres: await genresFor('movie', hit.genre_ids),
  };
}

const seriesCache = new Map();
async function lookupSeries(seriesTitle) {
  const key = seriesTitle.toLowerCase();
  if (!seriesCache.has(key)) {
    seriesCache.set(key, (async () => {
      const data = await tmdb('/search/tv', { query: seriesTitle });
      return (data.results || [])[0] || null;
    })().catch(() => null));
  }
  return seriesCache.get(key);
}

async function lookupEpisode(seriesTitle, season, episode) {
  const show = await lookupSeries(seriesTitle);
  if (!show) return null;
  const base = {
    tmdbId: show.id,
    posterUrl: image(show.poster_path),
    backdropUrl: image(show.backdrop_path),
    genres: await genresFor('tv', show.genre_ids),
    rating: typeof show.vote_average === 'number' ? show.vote_average : null,
    overview: show.overview || null,
  };
  if (season === null || season === undefined || episode === null || episode === undefined) return base;
  try {
    const ep = await tmdb(`/tv/${show.id}/season/${season}/episode/${episode}`);
    return {
      ...base,
      title: ep.name || undefined,
      overview: ep.overview || base.overview,
      backdropUrl: image(ep.still_path) || base.backdropUrl,
      year: ep.air_date ? Number(ep.air_date.slice(0, 4)) : undefined,
    };
  } catch {
    return base;
  }
}

/** Fetch metadata for a media item; returns fields to update or null. */
async function enrich(item) {
  if (!enabled()) return null;
  try {
    if (item.kind === 'movie') return await lookupMovie(item.title, item.year);
    if (item.kind === 'episode' && item.seriesTitle) {
      return await lookupEpisode(item.seriesTitle, item.seasonNumber, item.episodeNumber);
    }
  } catch (err) {
    if (!config.isTest) console.warn(`[metadata] ${item.title}: ${err.message}`);
  }
  return null;
}

module.exports = { enabled, enrich };
