// DOM helpers. Everything is built with createElement/textContent so that media
// titles, overviews etc. can never inject markup.

import { artFor } from './api.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    // CSSOM assignment is permitted under our CSP; style="" attributes are not.
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function toast(message, type = 'info', ms = 3500) {
  const t = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

export const spinner = () => h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Loading' });

export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  const s = Math.round(seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs) return `${hrs}h ${mins}m`;
  if (mins >= 10) return `${mins}m`;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const hrs = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(hrs ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hrs ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export const KIND_ICON = { movie: '🎬', episode: '📺', track: '🎵', photo: '🖼', show: '📺', album: '💿' };

export function art(src, alt, icon) {
  const box = h('div', { class: 'placeholder', 'aria-hidden': 'true' }, icon || '🎬');
  if (!src) return [box];
  const img = h('img', { src, alt: alt || '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => img.replaceWith(box));
  return [img];
}

export function subtitleFor(item) {
  switch (item.kind) {
    case 'episode': {
      const se = item.seasonNumber != null && item.episodeNumber != null ? `S${item.seasonNumber}·E${item.episodeNumber}` : '';
      return [item.seriesTitle, se].filter(Boolean).join(' · ');
    }
    case 'track': return [item.artist, item.album].filter(Boolean).join(' · ');
    case 'photo': return item.album || '';
    default: return [item.year, item.durationSeconds ? formatDuration(item.durationSeconds) : ''].filter(Boolean).join(' · ');
  }
}

/** Media card for movies/episodes/tracks/photos. */
export function mediaCard(item, { wide = false, href } = {}) {
  const progress = item.progress && !item.progress.completed && item.durationSeconds
    ? Math.min(100, (item.progress.positionSeconds / item.durationSeconds) * 100)
    : 0;
  const useWide = wide || item.kind === 'episode';
  return h('a', { class: `card${useWide ? ' wide' : ''}`, href: href || `#/item/${item.id}`, title: item.title },
    h('div', { class: 'card-art' },
      art(artFor(item, { wide: useWide }), item.title, KIND_ICON[item.kind]),
      item.progress && item.progress.completed ? h('span', { class: 'card-badge', title: 'Watched' }, '✓') : null,
      progress > 1 ? h('div', { class: 'card-progress' }, h('span', { style: `width:${progress.toFixed(1)}%` })) : null),
    h('div', { class: 'card-title' }, item.kind === 'episode' && item.seriesTitle ? item.title : item.title),
    h('div', { class: 'card-sub' }, subtitleFor(item)));
}

export function section(title, content, extra) {
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, title), extra || null),
    content);
}

export function emptyState(text, action) {
  return h('div', { class: 'empty' }, h('p', {}, text), action || null);
}

/** Simple confirm dialog returning a promise<boolean>. */
export function confirmDialog(message, { confirmText = 'Confirm', danger = false, extra } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', {},
      h('p', {}, message),
      extra || null,
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' },
        h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', onclick: () => dlg.close('ok') }, confirmText)));
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok');
      dlg.remove();
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function errorMessage(err) {
  if (err && err.body && Array.isArray(err.body.details) && err.body.details.length) {
    return `${err.message}: ${err.body.details.map((d) => `${d.path ? `${d.path} ` : ''}${d.message}`).join('; ')}`;
  }
  return (err && err.message) || 'Something went wrong';
}
