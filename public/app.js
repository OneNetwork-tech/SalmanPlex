import { api, session } from './js/api.js';
import { clear, h, toast, errorMessage } from './js/ui.js';
import {
  authView, homeView, libraryView, showView, albumView, itemView, searchView, listView, accountView,
  refreshLibraries, state,
} from './js/views.js';
import { adminView } from './js/admin.js';
import { playVideo, stopVideo, audioPlayer } from './js/player.js';

const view = document.getElementById('view');
const topbar = document.getElementById('topbar');
const sidebar = document.getElementById('sidebar');
const LIB_ICON = { movies: '🎬', tv: '📺', music: '🎵', photos: '🖼' };

function navigate(hash, { replace = false } = {}) {
  if (replace) {
    history.replaceState(null, '', hash);
    route();
  } else {
    location.hash = hash;
  }
}

function setShell(visible) {
  topbar.hidden = !visible;
  sidebar.hidden = !visible;
  document.querySelectorAll('.admin-only').forEach((el) => { el.hidden = !session.isAdmin; });
  if (visible) document.getElementById('user-name').textContent = session.user.username;
}

function renderLibraryLinks() {
  const box = document.getElementById('library-links');
  clear(box, state.libraries.map((l) => h('a', { href: `#/library/${l.id}`, dataset: { nav: `library-${l.id}` } }, `${LIB_ICON[l.type] || ''} ${l.name}`)));
  if (!state.libraries.length) box.append(h('div', { class: 'small muted', style: 'padding:4px 12px' }, 'None yet'));
}

async function onLibrariesChanged() {
  await refreshLibraries();
  renderLibraryLinks();
}

function highlightNav(key) {
  sidebar.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
  sidebar.classList.remove('open');
}

async function ensureSession() {
  if (!session.token) return false;
  if (session.user) return true;
  try {
    const res = await api('/auth/me');
    session.set({ user: res.user, imageToken: res.imageToken });
    return true;
  } catch {
    session.clear();
    return false;
  }
}

let routing = 0;
async function route() {
  const ticket = ++routing;
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryString] = raw.split('?');
  const query = new URLSearchParams(queryString || '');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);

  if (parts[0] !== 'play') stopVideo();

  if (!(await ensureSession())) {
    setShell(false);
    audioPlayer.close();
    await authView(view, {
      onAuthed: async () => {
        await bootstrap();
        navigate('#/', { replace: true });
      },
    });
    return;
  }
  if (ticket !== routing) return;
  setShell(parts[0] !== 'play');
  view.scrollTop = 0;
  window.scrollTo(0, 0);

  try {
    switch (parts[0]) {
      case undefined:
        highlightNav('home');
        await homeView(view);
        break;
      case 'library':
        highlightNav(`library-${parts[1]}`);
        await libraryView(view, parts[1], query);
        break;
      case 'show':
        highlightNav('');
        await showView(view, parts[1]);
        break;
      case 'album':
        highlightNav('');
        await albumView(view, parts[1] || null, parts[2] || null);
        break;
      case 'item':
        highlightNav('');
        await itemView(view, parts[1], { navigate });
        break;
      case 'play':
        await playVideo(view, parts[1], { navigate });
        break;
      case 'search':
        highlightNav('');
        document.getElementById('search-input').value = query.get('q') || '';
        await searchView(view, query.get('q') || '');
        break;
      case 'favorites':
      case 'history':
        highlightNav(parts[0]);
        await listView(view, parts[0]);
        break;
      case 'account':
        highlightNav('');
        accountView(view, { onLogout: logout });
        break;
      case 'admin':
        highlightNav('admin');
        await adminView(view, { onLibrariesChanged });
        break;
      default:
        clear(view, h('div', { class: 'empty' }, 'Page not found. ', h('a', { href: '#/' }, 'Go home')));
    }
  } catch (err) {
    if (ticket !== routing) return;
    if (err.status === 401) return route();
    setShell(true);
    clear(view, h('div', { class: 'empty' }, h('p', {}, errorMessage(err)), h('a', { class: 'btn', href: '#/' }, 'Go home')));
  }
  view.focus({ preventScroll: true });
}

function logout() {
  session.clear();
  audioPlayer.close();
  navigate('#/', { replace: true });
}

async function bootstrap() {
  await refreshLibraries().catch(() => {});
  renderLibraryLinks();
}

document.getElementById('logout-btn').addEventListener('click', logout);
document.getElementById('menu-btn').addEventListener('click', () => sidebar.classList.toggle('open'));
document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  if (q) navigate(`#/search?q=${encodeURIComponent(q)}`);
});
session.onExpire(() => {
  toast('Your session has ended. Please sign in again.', 'error');
  route();
});
window.addEventListener('hashchange', route);

(async () => {
  if (await ensureSession()) await bootstrap();
  route();
})();
