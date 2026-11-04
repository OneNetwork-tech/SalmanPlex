import { api, session, artFor, thumbUrl } from './api.js';
import {
  h, clear, toast, spinner, mediaCard, section, emptyState, formatDuration, formatBytes,
  art, confirmDialog, errorMessage, KIND_ICON,
} from './ui.js';
import { audioPlayer } from './player.js';

const PAGE = 60;

export const state = { libraries: [] };

export async function refreshLibraries() {
  const { data } = await api('/libraries');
  state.libraries = data;
  return data;
}

const libById = (id) => state.libraries.find((l) => l.id === Number(id));

// --- Auth ------------------------------------------------------------------

export async function authView(view, { onAuthed }) {
  const { needsSetup, allowRegistration } = await api('/auth/setup-status');
  let mode = needsSetup ? 'setup' : 'login';

  const render = () => {
    const error = h('p', { class: 'error-text', role: 'alert' });
    const isLogin = mode === 'login';
    const form = h('form', { class: 'auth-card', novalidate: true },
      h('span', { class: 'brand' }, 'Salman', h('span', {}, 'Plex')),
      h('p', { class: 'muted' }, mode === 'setup'
        ? 'Welcome! Create the administrator account to get started.'
        : isLogin ? 'Sign in to your media server' : 'Create an account'),
      h('div', { class: 'field' }, h('label', { for: 'f-user' }, isLogin ? 'Username or email' : 'Username'),
        h('input', { id: 'f-user', name: 'username', required: true, autocomplete: 'username', autofocus: true })),
      !isLogin ? h('div', { class: 'field' }, h('label', { for: 'f-email' }, 'Email (optional)'),
        h('input', { id: 'f-email', name: 'email', type: 'email', autocomplete: 'email' })) : null,
      h('div', { class: 'field' }, h('label', { for: 'f-pass' }, 'Password'),
        h('input', {
          id: 'f-pass', name: 'password', type: 'password', required: true, minlength: isLogin ? null : 10,
          autocomplete: isLogin ? 'current-password' : 'new-password',
        })),
      !isLogin ? h('p', { class: 'small muted' }, 'At least 10 characters.') : null,
      error,
      h('button', { class: 'btn btn-primary', type: 'submit' }, isLogin ? 'Sign in' : 'Create account'),
      mode !== 'setup' && allowRegistration
        ? h('p', { class: 'small' }, h('a', {
          href: '#', onclick: (e) => { e.preventDefault(); mode = isLogin ? 'register' : 'login'; render(); },
        }, isLogin ? 'Need an account? Register' : 'Have an account? Sign in'))
        : null);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = { username: fd.get('username'), password: fd.get('password') };
      if (!isLogin && fd.get('email')) body.email = fd.get('email');
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const res = await api(isLogin ? '/auth/login' : '/auth/register', { method: 'POST', body });
        session.set(res);
        onAuthed();
      } catch (err) {
        error.textContent = errorMessage(err);
      } finally {
        btn.disabled = false;
      }
    });
    clear(view, h('div', { class: 'auth-wrap' }, form));
  };
  render();
}

// --- Home ------------------------------------------------------------------

export async function homeView(view) {
  clear(view, spinner());
  const [cont, recent] = await Promise.all([api('/media/continue'), api('/media/recent', { query: { limit: 24 } })]);
  const parts = [];
  if (!state.libraries.length) {
    parts.push(emptyState(
      session.isAdmin ? 'No libraries yet. Add a folder of movies, shows, music or photos to get started.' : 'No libraries have been shared yet.',
      session.isAdmin ? h('a', { class: 'btn btn-primary', href: '#/admin' }, 'Add a library') : null,
    ));
  }
  if (cont.data.length) parts.push(section('Continue watching', h('div', { class: 'shelf wide' }, cont.data.map((i) => mediaCard(i, { wide: true, href: `#/play/${i.id}` })))));
  if (recent.data.length) parts.push(section('Recently added', h('div', { class: 'shelf' }, recent.data.map((i) => mediaCard(i)))));

  const perLibrary = await Promise.all(state.libraries.map(async (lib) => {
    if (lib.type === 'tv') {
      const { data } = await api('/media/shows', { query: { libraryId: lib.id } });
      return [lib, data.slice(0, 20).map(showCard)];
    }
    if (lib.type === 'music') {
      const { data } = await api('/media/albums', { query: { libraryId: lib.id } });
      return [lib, data.slice(0, 20).map(albumCard)];
    }
    const { data } = await api('/media', { query: { libraryId: lib.id, sort: 'added', limit: 20 } });
    return [lib, data.map((i) => mediaCard(i))];
  }));
  perLibrary.forEach(([lib, cards]) => {
    if (cards.length) {
      parts.push(section(lib.name, h('div', { class: `shelf${lib.type === 'photos' ? ' square' : ''}` }, cards),
        h('a', { class: 'small muted', href: `#/library/${lib.id}` }, 'See all →')));
    }
  });
  clear(view, h('h1', {}, `Welcome back, ${session.user.username}`), parts);
}

function showCard(show) {
  const href = `#/show/${encodeURIComponent(show.seriesTitle)}`;
  return h('a', { class: 'card', href, title: show.seriesTitle },
    h('div', { class: 'card-art' }, art(show.posterUrl || thumbUrl(show.firstEpisodeId, 400), show.seriesTitle, KIND_ICON.show)),
    h('div', { class: 'card-title' }, show.seriesTitle),
    h('div', { class: 'card-sub' }, `${show.seasonCount || 1} season${show.seasonCount === 1 ? '' : 's'} · ${show.episodeCount} episodes`));
}

function albumCard(album) {
  const href = `#/album/${encodeURIComponent(album.artist || '')}/${encodeURIComponent(album.album || '')}`;
  return h('a', { class: 'card', href, title: album.album || 'Unknown album' },
    h('div', { class: 'card-art', style: 'aspect-ratio:1' }, art(thumbUrl(album.firstTrackId, 400), album.album, KIND_ICON.album)),
    h('div', { class: 'card-title' }, album.album || 'Unknown album'),
    h('div', { class: 'card-sub' }, [album.artist || 'Unknown artist', album.year].filter(Boolean).join(' · ')));
}

// --- Library ---------------------------------------------------------------

export async function libraryView(view, id, query) {
  if (!state.libraries.length) await refreshLibraries();
  const lib = libById(id);
  if (!lib) {
    clear(view, emptyState('Library not found'));
    return;
  }
  const header = h('div', { class: 'section-head' }, h('h1', {}, lib.name), h('span', { class: 'pill' }, `${lib.itemCount} items`));

  if (lib.type === 'tv' || lib.type === 'music') {
    clear(view, header, spinner());
    const filter = h('input', { type: 'search', placeholder: `Filter ${lib.type === 'tv' ? 'shows' : 'albums'}…`, value: query.get('q') || '' });
    const grid = h('div', { class: `grid${lib.type === 'music' ? ' square' : ''}` });
    const load = async () => {
      const endpoint = lib.type === 'tv' ? '/media/shows' : '/media/albums';
      const { data } = await api(endpoint, { query: { libraryId: lib.id, q: filter.value } });
      clear(grid, data.length ? data.map(lib.type === 'tv' ? showCard : albumCard) : emptyState('Nothing here yet.'));
    };
    let t;
    filter.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    await load();
    clear(view, header, h('div', { class: 'toolbar' }, filter), grid);
    return;
  }

  const sort = h('select', { 'aria-label': 'Sort' },
    h('option', { value: 'title' }, 'Title'),
    h('option', { value: 'added' }, 'Recently added'),
    lib.type === 'movies' ? h('option', { value: 'year' }, 'Release year') : null,
    lib.type === 'movies' ? h('option', { value: 'rating' }, 'Rating') : null);
  sort.value = query.get('sort') || (lib.type === 'photos' ? 'added' : 'title');
  const genre = h('select', { 'aria-label': 'Genre', hidden: lib.type !== 'movies' }, h('option', { value: '' }, 'All genres'));
  const filter = h('input', { type: 'search', placeholder: 'Filter…' });
  const grid = h('div', { class: `grid${lib.type === 'photos' ? ' square' : ''}` });
  const more = h('div', { class: 'load-more' });
  let offset = 0;
  let items = [];

  if (lib.type === 'movies') {
    api('/media/genres', { query: { libraryId: lib.id } }).then(({ data }) => {
      data.forEach((g) => genre.append(h('option', { value: g }, g)));
    }).catch(() => {});
  }

  const load = async (reset) => {
    if (reset) {
      offset = 0;
      items = [];
      clear(grid, spinner());
    }
    const res = await api('/media', {
      query: { libraryId: lib.id, sort: sort.value, q: filter.value, genre: genre.value, limit: PAGE, offset },
    });
    if (reset) clear(grid);
    items = items.concat(res.data);
    offset += res.data.length;
    if (lib.type === 'photos') {
      res.data.forEach((p) => {
        const i = items.indexOf(p);
        grid.append(h('a', { class: 'card', href: '#', onclick: (e) => { e.preventDefault(); lightbox(items, i); } },
          h('div', { class: 'card-art' }, art(thumbUrl(p, 400), p.title, KIND_ICON.photo))));
      });
    } else {
      res.data.forEach((i) => grid.append(mediaCard(i)));
    }
    if (!items.length) clear(grid, emptyState('No items match.'));
    clear(more, offset < res.total ? h('button', { class: 'btn', type: 'button', onclick: () => load(false) }, `Load more (${res.total - offset} left)`) : null);
  };
  let t;
  filter.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load(true), 250); });
  sort.addEventListener('change', () => load(true));
  genre.addEventListener('change', () => load(true));

  clear(view, header, h('div', { class: 'toolbar' }, filter, sort, genre), grid, more);
  await load(true);
}

function lightbox(items, index) {
  let i = index;
  const img = h('img', { alt: '' });
  const caption = h('div', { class: 'lb-caption' });
  const show = () => {
    const p = items[i];
    img.src = `/api/media/${p.id}/thumbnail?w=1280&token=${encodeURIComponent(session.imageToken)}`;
    img.alt = p.title;
    caption.textContent = `${p.title} (${i + 1}/${items.length})`;
  };
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const step = (d) => { i = (i + d + items.length) % items.length; show(); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  };
  const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true' },
    img, caption,
    h('button', { class: 'icon-btn lb-close', type: 'button', 'aria-label': 'Close', onclick: close }, '✕'),
    h('button', { class: 'icon-btn lb-prev', type: 'button', 'aria-label': 'Previous', onclick: () => step(-1) }, '‹'),
    h('button', { class: 'icon-btn lb-next', type: 'button', 'aria-label': 'Next', onclick: () => step(1) }, '›'));
  document.addEventListener('keydown', onKey);
  document.body.append(box);
  show();
}

// --- TV show ---------------------------------------------------------------

export async function showView(view, seriesTitle) {
  clear(view, spinner());
  const res = await api('/media', { query: { seriesTitle, kind: 'episode', sort: 'episode', limit: 200 } });
  let episodes = res.data;
  // Fetch remaining pages for very long series.
  while (episodes.length < res.total) {
    // eslint-disable-next-line no-await-in-loop
    const page = await api('/media', { query: { seriesTitle, kind: 'episode', sort: 'episode', limit: 200, offset: episodes.length } });
    if (!page.data.length) break;
    episodes = episodes.concat(page.data);
  }
  if (!episodes.length) {
    clear(view, emptyState('Show not found'));
    return;
  }
  const seasons = [...new Set(episodes.map((e) => e.seasonNumber ?? 0))].sort((a, b) => a - b);
  const first = episodes[0];
  const nextUp = episodes.find((e) => !(e.progress && e.progress.completed)) || first;
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const list = h('div', { class: 'list' });

  const renderSeason = (s) => {
    [...tabs.children].forEach((b) => b.classList.toggle('active', b.dataset.season === String(s)));
    clear(list, episodes.filter((e) => (e.seasonNumber ?? 0) === s).map((e) => {
      const pct = e.progress && !e.progress.completed && e.durationSeconds ? (e.progress.positionSeconds / e.durationSeconds) * 100 : 0;
      return h('a', { class: 'list-row', href: `#/item/${e.id}` },
        h('div', { class: 'num' }, e.episodeNumber ?? ''),
        h('div', { class: 'thumb' }, art(e.backdropUrl || thumbUrl(e, 320), e.title, '📺'),
          pct > 1 ? h('div', { class: 'card-progress' }, h('span', { style: `width:${pct.toFixed(1)}%` })) : null),
        h('div', { class: 'grow' },
          h('div', { class: 'title' }, e.title, e.progress && e.progress.completed ? h('span', { class: 'watched' }, ' ✓') : null),
          e.overview ? h('div', { class: 'overview-line' }, e.overview) : null),
        h('div', { class: 'muted small' }, formatDuration(e.durationSeconds)));
    }));
  };
  seasons.forEach((s) => tabs.append(h('button', { type: 'button', dataset: { season: String(s) }, onclick: () => renderSeason(s) }, s === 0 ? 'Specials' : `Season ${s}`)));

  clear(view,
    h('div', { class: 'detail-hero' },
      first.backdropUrl ? h('div', { class: 'backdrop', style: `background-image:url("${encodeURI(first.backdropUrl)}")` }) : null,
      h('div', { class: 'detail' },
        h('div', { class: 'detail-poster' }, art(first.posterUrl || thumbUrl(first, 400), seriesTitle, '📺')),
        h('div', {},
          h('h1', {}, seriesTitle),
          h('div', { class: 'detail-meta' },
            h('span', { class: 'pill' }, `${seasons.length} season${seasons.length === 1 ? '' : 's'}`),
            h('span', { class: 'pill' }, `${episodes.length} episodes`),
            ...(first.genres || []).map((g) => h('span', { class: 'pill' }, g))),
          h('div', { class: 'detail-actions' },
            h('a', { class: 'btn btn-primary', href: `#/play/${nextUp.id}` },
              `▶ ${nextUp === first && !(first.progress) ? 'Play' : 'Continue'} S${nextUp.seasonNumber ?? '?'}E${nextUp.episodeNumber ?? '?'}`))))),
    tabs, list);
  renderSeason(nextUp.seasonNumber ?? seasons[0]);
}

// --- Album -----------------------------------------------------------------

export async function albumView(view, artist, album) {
  clear(view, spinner());
  const query = { kind: 'track', sort: 'track', limit: 200 };
  if (album) query.album = album;
  if (artist) query.artist = artist;
  const { data: tracks } = await api('/media', { query });
  if (!tracks.length) {
    clear(view, emptyState('Album not found'));
    return;
  }
  const total = tracks.reduce((s, t) => s + (t.durationSeconds || 0), 0);
  clear(view,
    h('div', { class: 'detail' },
      h('div', { class: 'detail-poster', style: 'aspect-ratio:1' }, art(thumbUrl(tracks[0], 600), album, '💿')),
      h('div', {},
        h('h1', {}, album || 'Unknown album'),
        h('p', { class: 'muted' }, [artist || 'Unknown artist', tracks[0].year, `${tracks.length} tracks`, formatDuration(total)].filter(Boolean).join(' · ')),
        h('div', { class: 'detail-actions' },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => audioPlayer.play(tracks, 0) }, '▶ Play album'),
          h('button', {
            class: 'btn', type: 'button',
            onclick: () => audioPlayer.play([...tracks].sort(() => Math.random() - 0.5), 0),
          }, '🔀 Shuffle')),
        h('div', { class: 'list' }, tracks.map((t, i) => h('a', {
          class: 'list-row', href: '#', onclick: (e) => { e.preventDefault(); audioPlayer.play(tracks, i); },
        },
        h('div', { class: 'num' }, t.trackNumber ?? i + 1),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, t.title), t.artist !== artist ? h('div', { class: 'small muted' }, t.artist) : null),
        h('div', { class: 'muted small' }, formatDuration(t.durationSeconds))))))));
}

// --- Item detail -----------------------------------------------------------

export async function itemView(view, id, { navigate }) {
  clear(view, spinner());
  const { data: item } = await api(`/media/${id}`);
  if (item.kind === 'photo') {
    lightbox([item], 0);
    history.back();
    return;
  }
  const isVideo = item.kind === 'movie' || item.kind === 'episode';
  const resume = item.progress && !item.progress.completed && item.progress.positionSeconds > 10;

  const favBtn = h('button', { class: 'btn', type: 'button' });
  const setFav = (v) => { item.favorite = v; favBtn.textContent = v ? '★ Favorited' : '☆ Favorite'; };
  setFav(item.favorite);
  favBtn.addEventListener('click', async () => {
    try {
      await api(`/media/${item.id}/favorite`, { method: item.favorite ? 'DELETE' : 'PUT' });
      setFav(!item.favorite);
    } catch (err) { toast(errorMessage(err), 'error'); }
  });

  const watchedBtn = h('button', { class: 'btn', type: 'button' }, item.progress && item.progress.completed ? 'Mark unwatched' : 'Mark watched');
  watchedBtn.addEventListener('click', async () => {
    try {
      if (item.progress && item.progress.completed) {
        await api(`/media/${item.id}/progress`, { method: 'DELETE' });
        item.progress = null;
      } else {
        const res = await api(`/media/${item.id}/watched`, { method: 'POST' });
        item.progress = { completed: true, playCount: res.data.playCount, positionSeconds: 0 };
      }
      watchedBtn.textContent = item.progress && item.progress.completed ? 'Mark unwatched' : 'Mark watched';
    } catch (err) { toast(errorMessage(err), 'error'); }
  });

  const playActions = [];
  if (isVideo) {
    playActions.push(h('a', { class: 'btn btn-primary', href: `#/play/${item.id}` },
      resume ? `▶ Resume from ${formatDuration(item.progress.positionSeconds)}` : '▶ Play'));
    if (resume) {
      playActions.push(h('button', {
        class: 'btn', type: 'button',
        onclick: async () => { await api(`/media/${item.id}/progress`, { method: 'DELETE' }); navigate(`#/play/${item.id}`); },
      }, '↺ Play from start'));
    }
  } else if (item.kind === 'track') {
    playActions.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => audioPlayer.play([item], 0) }, '▶ Play'));
  }

  const adminActions = session.isAdmin ? [
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => editDialog(item, () => itemView(view, id, { navigate })) }, '✎ Edit'),
    h('button', {
      class: 'btn btn-ghost', type: 'button',
      onclick: async () => {
        try {
          const res = await api(`/media/${item.id}/refresh-metadata`, { method: 'POST' });
          toast(res.matched ? 'Metadata updated' : 'No match found', res.matched ? 'ok' : 'info');
          itemView(view, id, { navigate });
        } catch (err) { toast(errorMessage(err), 'error'); }
      },
    }, '⟳ Refresh metadata'),
    h('button', {
      class: 'btn btn-danger', type: 'button',
      onclick: async () => {
        const del = h('input', { type: 'checkbox', id: 'del-file' });
        const ok = await confirmDialog(`Remove “${item.title}” from the library?`, {
          confirmText: 'Remove', danger: true,
          extra: h('label', { for: 'del-file', class: 'row' }, del, 'Also delete the file from disk'),
        });
        if (!ok) return;
        try {
          await api(`/media/${item.id}`, { method: 'DELETE', query: { deleteFile: del.checked ? 'true' : undefined } });
          toast('Removed', 'ok');
          history.back();
        } catch (err) { toast(errorMessage(err), 'error'); }
      },
    }, '🗑 Remove'),
  ] : [];

  const meta = [
    item.year ? h('span', { class: 'pill' }, item.year) : null,
    item.durationSeconds ? h('span', { class: 'pill' }, formatDuration(item.durationSeconds)) : null,
    item.rating ? h('span', { class: 'pill' }, `★ ${item.rating.toFixed(1)}`) : null,
    item.height ? h('span', { class: 'pill' }, item.height >= 2000 ? '4K' : `${item.height}p`) : null,
    ...(item.genres || []).map((g) => h('span', { class: 'pill' }, g)),
    item.progress && item.progress.playCount ? h('span', { class: 'pill' }, `Played ${item.progress.playCount}×`) : null,
  ];

  clear(view,
    h('div', { class: 'detail-hero' },
      item.backdropUrl ? h('div', { class: 'backdrop', style: `background-image:url("${encodeURI(item.backdropUrl)}")` }) : null,
      h('div', { class: 'detail' },
        h('div', { class: `detail-poster${item.kind === 'episode' && !item.posterUrl ? ' wide' : ''}` },
          art(artFor(item, { wide: item.kind === 'episode' && !item.posterUrl }), item.title, KIND_ICON[item.kind])),
        h('div', {},
          item.kind === 'episode'
            ? h('a', { class: 'muted', href: `#/show/${encodeURIComponent(item.seriesTitle)}` },
              `${item.seriesTitle} · Season ${item.seasonNumber ?? '?'} · Episode ${item.episodeNumber ?? '?'}`)
            : null,
          item.kind === 'track' && item.album
            ? h('a', { class: 'muted', href: `#/album/${encodeURIComponent(item.artist || '')}/${encodeURIComponent(item.album)}` },
              [item.artist, item.album].filter(Boolean).join(' · '))
            : null,
          h('h1', {}, item.title),
          h('div', { class: 'detail-meta' }, meta),
          h('div', { class: 'detail-actions' }, playActions, favBtn, isVideo ? watchedBtn : null, adminActions),
          item.overview ? h('p', { class: 'overview' }, item.overview) : null,
          h('div', { class: 'tech' },
            [
              item.videoCodec && `Video: ${item.videoCodec}${item.width ? ` ${item.width}×${item.height}` : ''}`,
              item.audioCodec && `Audio: ${item.audioCodec}`,
              item.fileSize && `Size: ${formatBytes(item.fileSize)}`,
              item.playback && (item.playback.directPlayable ? 'Direct play' : item.playback.hls ? 'Plays via transcoding' : 'May not play in browser'),
              item.playback && item.playback.subtitles.length ? `Subtitles: ${item.playback.subtitles.map((s) => s.label).join(', ')}` : null,
              session.isAdmin && item.relativePath ? `File: ${item.relativePath}` : null,
            ].filter(Boolean).map((t) => h('div', {}, t)))))));
}

function editDialog(item, onSaved) {
  const field = (name, label, value, type = 'text') => h('div', { class: 'field' },
    h('label', { for: `e-${name}` }, label),
    type === 'textarea'
      ? h('textarea', { id: `e-${name}`, name }, value ?? '')
      : h('input', { id: `e-${name}`, name, type, value: value ?? '' }));
  const fields = [field('title', 'Title', item.title)];
  if (item.kind === 'episode') {
    fields.push(field('seriesTitle', 'Series', item.seriesTitle), field('seasonNumber', 'Season', item.seasonNumber, 'number'), field('episodeNumber', 'Episode', item.episodeNumber, 'number'));
  }
  if (item.kind === 'track') {
    fields.push(field('artist', 'Artist', item.artist), field('album', 'Album', item.album), field('trackNumber', 'Track #', item.trackNumber, 'number'));
  }
  fields.push(
    field('year', 'Year', item.year, 'number'),
    field('genres', 'Genres (comma separated)', (item.genres || []).join(', ')),
    field('posterUrl', 'Poster URL', item.posterUrl, 'url'),
    field('overview', 'Overview', item.overview, 'textarea'),
  );
  const error = h('p', { class: 'error-text' });
  const form = h('form', { method: 'dialog' }, h('h2', {}, 'Edit metadata'), fields, error,
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')));
  const dlg = h('dialog', {}, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {};
    const nums = ['year', 'seasonNumber', 'episodeNumber', 'trackNumber'];
    for (const [k, raw] of fd.entries()) {
      const v = String(raw).trim();
      if (k === 'genres') body.genres = v ? v.split(',').map((g) => g.trim()).filter(Boolean) : null;
      else if (nums.includes(k)) body[k] = v === '' ? null : Number(v);
      else if (k === 'title' || k === 'seriesTitle') { if (v) body[k] = v; } else body[k] = v === '' ? null : v;
    }
    try {
      await api(`/media/${item.id}`, { method: 'PATCH', body });
      dlg.close();
      toast('Saved', 'ok');
      onSaved();
    } catch (err) {
      error.textContent = errorMessage(err);
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// --- Lists -----------------------------------------------------------------

export async function searchView(view, q) {
  clear(view, spinner());
  if (!q) {
    clear(view, emptyState('Type something to search.'));
    return;
  }
  const [items, shows, albums] = await Promise.all([
    api('/media', { query: { q, limit: 60 } }),
    api('/media/shows', { query: { q } }),
    api('/media/albums', { query: { q } }),
  ]);
  const parts = [h('h1', {}, `Results for “${q}”`)];
  if (shows.data.length) parts.push(section('Shows', h('div', { class: 'grid' }, shows.data.map(showCard))));
  if (albums.data.length) parts.push(section('Albums', h('div', { class: 'grid square' }, albums.data.map(albumCard))));
  const movies = items.data.filter((i) => i.kind === 'movie');
  const episodes = items.data.filter((i) => i.kind === 'episode');
  const tracks = items.data.filter((i) => i.kind === 'track');
  if (movies.length) parts.push(section('Movies', h('div', { class: 'grid' }, movies.map((i) => mediaCard(i)))));
  if (episodes.length) parts.push(section('Episodes', h('div', { class: 'grid wide' }, episodes.map((i) => mediaCard(i)))));
  if (tracks.length) parts.push(section('Tracks', h('div', { class: 'grid square' }, tracks.map((i) => mediaCard(i)))));
  if (parts.length === 1) parts.push(emptyState('No matches.'));
  clear(view, parts);
}

export async function listView(view, kind) {
  clear(view, spinner());
  const { data } = await api(kind === 'favorites' ? '/media/favorites' : '/media/history');
  clear(view,
    h('h1', {}, kind === 'favorites' ? 'Favorites' : 'Watch history'),
    data.length ? h('div', { class: 'grid' }, data.map((i) => mediaCard(i))) : emptyState(kind === 'favorites' ? 'Nothing favorited yet. Use ☆ on any title.' : 'Nothing watched yet.'));
}

// --- Account ---------------------------------------------------------------

export function accountView(view, { onLogout }) {
  const error = h('p', { class: 'error-text' });
  const form = h('form', { class: 'panel' },
    h('h2', {}, 'Change password'),
    h('div', { class: 'field' }, h('label', { for: 'a-cur' }, 'Current password'), h('input', { id: 'a-cur', name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' })),
    h('div', { class: 'field' }, h('label', { for: 'a-new' }, 'New password (min 10 characters)'), h('input', { id: 'a-new', name: 'newPassword', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' })),
    error,
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Update password'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      const res = await api('/auth/change-password', { method: 'POST', body: Object.fromEntries(fd) });
      session.set(res);
      form.reset();
      error.textContent = '';
      toast('Password changed. Other devices were signed out.', 'ok');
    } catch (err) {
      error.textContent = errorMessage(err);
    }
  });
  clear(view,
    h('h1', {}, 'Account'),
    h('div', { class: 'panel' },
      h('p', {}, 'Signed in as ', h('b', {}, session.user.username), ` (${session.user.role})`),
      session.user.email ? h('p', { class: 'muted' }, session.user.email) : null,
      h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          await api('/auth/logout-all', { method: 'POST' }).catch(() => {});
          onLogout();
        },
      }, 'Sign out of all devices')),
    form);
}
