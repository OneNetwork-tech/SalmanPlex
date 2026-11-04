import { api, session, uploadFiles } from './api.js';
import {
  h, clear, toast, spinner, confirmDialog, errorMessage, formatDuration,
} from './ui.js';
import { refreshLibraries, state } from './views.js';

const TYPE_LABEL = { movies: 'Movies', tv: 'TV shows', music: 'Music', photos: 'Photos' };

export async function adminView(view, { onLibrariesChanged }) {
  if (!session.isAdmin) {
    clear(view, h('div', { class: 'empty' }, 'Administrator access required.'));
    return;
  }
  clear(view, spinner());
  const statusPanel = h('div', { class: 'panel' });
  const libPanel = h('div', { class: 'panel' });
  const userPanel = h('div', { class: 'panel' });
  clear(view, h('h1', {}, 'Server administration'), statusPanel, libPanel, userPanel);

  let poll = null;
  const anyScanning = () => state.libraries.some((l) => l.scanning || l.scanStatus === 'scanning');

  // While a scan runs, refresh the library table and stats every few seconds.
  const schedulePoll = () => {
    clearTimeout(poll);
    if (!anyScanning()) return;
    poll = setTimeout(async () => {
      if (!document.body.contains(libPanel)) return; // navigated away
      await Promise.all([renderLibraries(libPanel, renderAll, onLibrariesChanged), renderStatus(statusPanel)]);
      if (!anyScanning()) onLibrariesChanged();
      schedulePoll();
    }, 2500);
  };

  async function renderAll() {
    await Promise.all([renderStatus(statusPanel), renderLibraries(libPanel, renderAll, onLibrariesChanged), renderUsers(userPanel)]);
    schedulePoll();
  }
  await renderAll();
}

async function renderStatus(panel) {
  const { data: s } = await api('/system/status');
  const stat = (label, value) => h('div', { class: 'stat' }, h('b', {}, value), h('span', { class: 'muted small' }, label));
  clear(panel,
    h('h2', {}, 'Status'),
    h('div', { class: 'stats' },
      stat('Movies', s.counts.movie || 0),
      stat('Episodes', s.counts.episode || 0),
      stat('Tracks', s.counts.track || 0),
      stat('Photos', s.counts.photo || 0),
      stat('Users', s.counts.users),
      stat('Active transcodes', s.transcodes.length),
      stat('Uptime', formatDuration(s.uptimeSeconds))),
    h('p', { class: 'small muted', style: 'margin-top:12px' },
      `v${s.version} · Node ${s.node} · DB ${s.database} · ffmpeg ${s.ffmpeg ? '✓' : '✗ (transcoding disabled)'} · ffprobe ${s.ffprobe ? '✓' : '✗'} · TMDb ${s.tmdb ? '✓' : 'not configured'}`));
}

async function renderLibraries(panel, rerender, onChanged) {
  const libraries = await refreshLibraries();
  const rows = libraries.map((lib) => {
    const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
    const progress = h('span', { class: 'small muted' });
    fileInput.addEventListener('change', async () => {
      if (!fileInput.files.length) return;
      try {
        await uploadFiles(`/libraries/${lib.id}/upload`, fileInput.files, (p) => { progress.textContent = `Uploading ${Math.round(p * 100)}%`; });
        toast(`Uploaded ${fileInput.files.length} file(s); scanning…`, 'ok');
        rerender();
      } catch (err) {
        toast(errorMessage(err), 'error');
      } finally {
        progress.textContent = '';
        fileInput.value = '';
      }
    });
    const status = lib.scanning || lib.scanStatus === 'scanning'
      ? h('span', { class: 'pill' }, 'Scanning…')
      : lib.scanStatus === 'error'
        ? h('span', { class: 'pill error-text', title: lib.scanError || '' }, 'Scan failed')
        : h('span', { class: 'small muted' }, lib.lastScannedAt ? `Scanned ${new Date(lib.lastScannedAt).toLocaleString()}` : 'Never scanned');
    return h('tr', {},
      h('td', {}, h('a', { href: `#/library/${lib.id}` }, lib.name)),
      h('td', {}, TYPE_LABEL[lib.type]),
      h('td', { class: 'small muted' }, lib.path),
      h('td', {}, lib.itemCount),
      h('td', {}, status, ' ', progress),
      h('td', {}, h('div', { class: 'row' },
        h('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: async () => {
            await api(`/libraries/${lib.id}/scan`, { method: 'POST' }).catch((e) => toast(errorMessage(e), 'error'));
            rerender();
          },
        }, 'Scan'),
        h('button', {
          class: 'btn btn-sm', type: 'button', title: 'Re-fetch online metadata for all items',
          onclick: async () => {
            await api(`/libraries/${lib.id}/scan`, { method: 'POST', query: { refreshMetadata: 'true' } }).catch((e) => toast(errorMessage(e), 'error'));
            rerender();
          },
        }, 'Refresh metadata'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => fileInput.click() }, 'Upload'),
        fileInput,
        h('button', {
          class: 'btn btn-sm btn-danger', type: 'button',
          onclick: async () => {
            if (!await confirmDialog(`Remove library “${lib.name}”? Files on disk are not deleted.`, { confirmText: 'Remove', danger: true })) return;
            try {
              await api(`/libraries/${lib.id}`, { method: 'DELETE' });
              toast('Library removed', 'ok');
              onChanged();
              rerender();
            } catch (err) { toast(errorMessage(err), 'error'); }
          },
        }, 'Remove'))));
  });

  // Create form with folder browser.
  const pathInput = h('input', { name: 'path', required: true, placeholder: 'e.g. Movies', id: 'l-path' });
  const browser = h('div', { class: 'folder-browser', hidden: true });
  const browse = async (p) => {
    try {
      const res = await api('/libraries/browse', { query: { path: p } });
      browser.hidden = false;
      clear(browser,
        h('div', { class: 'small muted', style: 'padding:6px 10px' }, `${res.root}/${res.path === '.' ? '' : res.path}`),
        res.parent !== null ? h('button', { type: 'button', onclick: () => browse(res.parent) }, '⬆ ..') : null,
        h('button', { type: 'button', onclick: () => { pathInput.value = res.path; browser.hidden = true; } }, '✓ Use this folder'),
        res.directories.map((d) => h('button', { type: 'button', onclick: () => browse(res.path === '.' ? d : `${res.path}/${d}`) }, `📁 ${d}`)));
    } catch (err) { toast(errorMessage(err), 'error'); }
  };
  const error = h('p', { class: 'error-text' });
  const form = h('form', {},
    h('h3', { style: 'margin-top:20px' }, 'Add library'),
    h('div', { class: 'form-grid' },
      h('div', {}, h('label', { for: 'l-name' }, 'Name'), h('input', { id: 'l-name', name: 'name', required: true, placeholder: 'Movies' })),
      h('div', {}, h('label', { for: 'l-type' }, 'Type'),
        h('select', { id: 'l-type', name: 'type' }, Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v }, l)))),
      h('div', {}, h('label', { for: 'l-path' }, 'Folder (inside media root)'),
        h('div', { class: 'row' }, pathInput, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => browse(pathInput.value || '.') }, 'Browse'))),
      h('div', {}, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add & scan'))),
    browser, error);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/libraries', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      toast('Library added; scanning…', 'ok');
      onChanged();
      rerender();
    } catch (err) {
      error.textContent = errorMessage(err);
    }
  });

  clear(panel,
    h('h2', {}, 'Libraries'),
    libraries.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Name', 'Type', 'Folder', 'Items', 'Status', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows)))
      : h('p', { class: 'muted' }, 'No libraries yet.'),
    form);
}

async function renderUsers(panel) {
  const { data: users } = await api('/users');
  const rows = users.map((u) => {
    const role = h('select', { 'aria-label': `Role for ${u.username}` },
      h('option', { value: 'viewer' }, 'Viewer'), h('option', { value: 'admin' }, 'Admin'));
    role.value = u.role;
    role.addEventListener('change', async () => {
      try {
        await api(`/users/${u.id}`, { method: 'PATCH', body: { role: role.value } });
        toast('Role updated', 'ok');
      } catch (err) {
        role.value = u.role;
        toast(errorMessage(err), 'error');
      }
    });
    return h('tr', {},
      h('td', {}, u.username, u.id === session.user.id ? h('span', { class: 'muted small' }, ' (you)') : null),
      h('td', { class: 'muted' }, u.email || '—'),
      h('td', {}, role),
      h('td', { class: 'small muted' }, u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'),
      h('td', {}, h('div', { class: 'row' },
        h('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: async () => {
            const input = h('input', { type: 'password', minlength: 10, placeholder: 'New password (min 10)', style: 'width:100%' });
            if (!await confirmDialog(`Set a new password for ${u.username}`, { confirmText: 'Set password', extra: input })) return;
            try {
              await api(`/users/${u.id}`, { method: 'PATCH', body: { password: input.value } });
              toast('Password updated', 'ok');
            } catch (err) { toast(errorMessage(err), 'error'); }
          },
        }, 'Reset password'),
        u.id !== session.user.id ? h('button', {
          class: 'btn btn-sm btn-danger', type: 'button',
          onclick: async () => {
            if (!await confirmDialog(`Delete user ${u.username}? Their history and favorites are removed.`, { confirmText: 'Delete', danger: true })) return;
            try {
              await api(`/users/${u.id}`, { method: 'DELETE' });
              renderUsers(panel);
            } catch (err) { toast(errorMessage(err), 'error'); }
          },
        }, 'Delete') : null)));
  });

  const error = h('p', { class: 'error-text' });
  const form = h('form', {},
    h('h3', { style: 'margin-top:20px' }, 'Add user'),
    h('div', { class: 'form-grid' },
      h('div', {}, h('label', { for: 'u-name' }, 'Username'), h('input', { id: 'u-name', name: 'username', required: true, autocomplete: 'off' })),
      h('div', {}, h('label', { for: 'u-email' }, 'Email (optional)'), h('input', { id: 'u-email', name: 'email', type: 'email' })),
      h('div', {}, h('label', { for: 'u-pass' }, 'Password'), h('input', { id: 'u-pass', name: 'password', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' })),
      h('div', {}, h('label', { for: 'u-role' }, 'Role'), h('select', { id: 'u-role', name: 'role' }, h('option', { value: 'viewer' }, 'Viewer'), h('option', { value: 'admin' }, 'Admin'))),
      h('div', {}, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create user'))),
    error);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    if (!body.email) delete body.email;
    try {
      await api('/users', { method: 'POST', body });
      toast('User created', 'ok');
      renderUsers(panel);
    } catch (err) {
      error.textContent = errorMessage(err);
    }
  });

  clear(panel,
    h('h2', {}, 'Users'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Username', 'Email', 'Role', 'Last login', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows))),
    form);
}
