// Thin API client. The access token is kept in localStorage; the strict CSP
// (no inline or third-party scripts) is the main defence against token theft.

const TOKEN_KEY = 'sp.accessToken';
const IMAGE_KEY = 'sp.imageToken';

const listeners = new Set();

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  get imageToken() { return localStorage.getItem(IMAGE_KEY); },
  user: null,
  set({ accessToken, imageToken, user }) {
    if (accessToken) localStorage.setItem(TOKEN_KEY, accessToken);
    if (imageToken) localStorage.setItem(IMAGE_KEY, imageToken);
    if (user) this.user = user;
  },
  clear({ expired = false } = {}) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(IMAGE_KEY);
    this.user = null;
    if (expired) listeners.forEach((fn) => fn());
  },
  onExpire(fn) { listeners.add(fn); },
  get isAdmin() { return this.user && this.user.role === 'admin'; },
};

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body, query, form } = {}) {
  const url = new URL(`/api${path}`, location.origin);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
  }
  const headers = {};
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && session.token && !path.startsWith('/auth/login')) session.clear({ expired: true });
    throw new ApiError(res.status, data);
  }
  return data;
}

/** Upload with progress (fetch has no upload progress events). */
export function uploadFiles(path, files, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    [...files].forEach((f) => form.append('files', f, f.name));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${session.token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError(0, { error: 'Network error' }));
    xhr.send(form);
  });
}

export function thumbUrl(item, width = 480) {
  if (!item) return null;
  const id = typeof item === 'object' ? item.id : item;
  return `/api/media/${id}/thumbnail?w=${width}&token=${encodeURIComponent(session.imageToken || '')}`;
}

/** Best artwork: TMDb poster when present, otherwise a generated thumbnail. */
export function artFor(item, { wide = false } = {}) {
  if (!item) return null;
  if (wide && item.backdropUrl) return item.backdropUrl;
  if (!wide && item.posterUrl) return item.posterUrl;
  return thumbUrl(item, wide ? 640 : 400);
}
