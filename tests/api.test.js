'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createFixtures, write } = require('./helpers');
const { createApp } = require('../src/app');
const { sequelize } = require('../src/models');
const { migrateUp } = require('../src/db/migrate');
const transcoder = require('../src/services/transcoder');

const MEDIA_ROOT = process.env.MEDIA_ROOT;
const PASSWORD = 'correct-horse-battery';

let app;
let fixtures;
let admin;
let viewer;
const libs = {};

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function findItem(token, query) {
  const res = await request(app).get('/api/media').query({ limit: 200, ...query }).set(auth(token));
  expect(res.status).toBe(200);
  return res.body.data;
}

beforeAll(async () => {
  fixtures = createFixtures(MEDIA_ROOT);
  if (sequelize.getDialect() === 'postgres') {
    await sequelize.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }
  await migrateUp();
  app = createApp();
});

afterAll(async () => {
  transcoder.stopAll({ removeFiles: true });
  await sequelize.close();
  fs.rmSync(process.env.TEST_TMP_DIR, { recursive: true, force: true });
});

describe('authentication', () => {
  test('setup status reports first run', async () => {
    const res = await request(app).get('/api/auth/setup-status');
    expect(res.body).toEqual({ needsSetup: true, allowRegistration: true });
  });

  test('rejects weak passwords', async () => {
    const res = await request(app).post('/api/auth/register').send({ username: 'admin', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe('password');
  });

  test('first registered user becomes admin', async () => {
    const res = await request(app).post('/api/auth/register').send({ username: 'admin', email: 'Admin@Example.com', password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.email).toBe('admin@example.com');
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.accessToken).toBeTruthy();
    admin = res.body.accessToken;
  });

  test('open registration is closed after setup', async () => {
    const res = await request(app).post('/api/auth/register').send({ username: 'mallory', password: PASSWORD });
    expect(res.status).toBe(403);
  });

  test('login works by username or email and rejects bad passwords uniformly', async () => {
    expect((await request(app).post('/api/auth/login').send({ username: 'admin', password: PASSWORD })).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ username: 'admin@example.com', password: PASSWORD })).status).toBe(200);
    const bad = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong-password!' });
    const missing = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'wrong-password!' });
    expect(bad.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(bad.body.error).toBe(missing.body.error);
  });

  test('API requires a valid token', async () => {
    expect((await request(app).get('/api/media')).status).toBe(401);
    expect((await request(app).get('/api/media').set(auth('garbage'))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(auth(admin))).body.user.username).toBe('admin');
  });

  test('admin creates a viewer; viewer cannot use admin endpoints', async () => {
    const created = await request(app).post('/api/users').set(auth(admin)).send({ username: 'viewer', password: PASSWORD });
    expect(created.status).toBe(201);
    expect(created.body.data.role).toBe('viewer');
    const login = await request(app).post('/api/auth/login').send({ username: 'viewer', password: PASSWORD });
    viewer = login.body.accessToken;
    expect((await request(app).get('/api/users').set(auth(viewer))).status).toBe(403);
    expect((await request(app).post('/api/libraries').set(auth(viewer)).send({ name: 'x', type: 'movies', path: 'Movies' })).status).toBe(403);
    expect((await request(app).get('/api/system/status').set(auth(viewer))).status).toBe(403);
  });

  test('duplicate usernames are rejected', async () => {
    const res = await request(app).post('/api/users').set(auth(admin)).send({ username: 'viewer', password: PASSWORD });
    expect(res.status).toBe(409);
  });

  test('last admin cannot be demoted or deleted', async () => {
    const me = await request(app).get('/api/auth/me').set(auth(admin));
    const res = await request(app).patch(`/api/users/${me.body.user.id}`).set(auth(admin)).send({ role: 'viewer' });
    expect(res.status).toBe(400);
  });
});

describe('libraries', () => {
  test('rejects paths outside the media root', async () => {
    for (const p of ['../', '/etc', '../../..', 'does-not-exist']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post('/api/libraries').set(auth(admin)).send({ name: 'Evil', type: 'movies', path: p });
      expect(res.status).toBe(400);
    }
  });

  test('rejects symlinks escaping the media root', async () => {
    fs.symlinkSync('/etc', path.join(MEDIA_ROOT, 'escape'));
    const res = await request(app).post('/api/libraries').set(auth(admin)).send({ name: 'Evil', type: 'movies', path: 'escape' });
    expect(res.status).toBe(400);
    fs.unlinkSync(path.join(MEDIA_ROOT, 'escape'));
  });

  test('folder browser lists media root directories', async () => {
    const res = await request(app).get('/api/libraries/browse').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.directories).toEqual(expect.arrayContaining(['Movies', 'TV', 'Music', 'Photos']));
    expect((await request(app).get('/api/libraries/browse').query({ path: '../..' }).set(auth(admin))).status).toBe(400);
  });

  test.each([
    ['movies', 'Movies'], ['tv', 'TV'], ['music', 'Music'], ['photos', 'Photos'],
  ])('creates and scans a %s library', async (type, folder) => {
    const res = await request(app).post('/api/libraries').set(auth(admin)).send({ name: folder, type, path: folder });
    expect(res.status).toBe(201);
    libs[type] = res.body.data;
    const scan = await request(app).post(`/api/libraries/${libs[type].id}/scan?wait=true`).set(auth(admin));
    expect(scan.status).toBe(200);
    expect(scan.body.data.failed).toBe(0);
  });

  test('duplicate library folder is rejected', async () => {
    const res = await request(app).post('/api/libraries').set(auth(admin)).send({ name: 'Again', type: 'movies', path: 'Movies' });
    expect(res.status).toBe(409);
  });

  test('viewers see libraries without server paths', async () => {
    const res = await request(app).get('/api/libraries').set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(4);
    expect(res.body.data[0].path).toBeUndefined();
    const movies = res.body.data.find((l) => l.type === 'movies');
    expect(movies.itemCount).toBe(2);
  });
});

describe('browsing', () => {
  test('movies are parsed from file names, ignoring hidden and non-media files', async () => {
    const items = await findItem(viewer, { libraryId: libs.movies.id });
    expect(items.map((i) => i.title).sort()).toEqual(['Another Film', 'The Test Movie']);
    const movie = items.find((i) => i.title === 'The Test Movie');
    expect(movie.year).toBe(2021);
    expect(movie.relativePath).toBeDefined();
    expect(movie.progress).toBeNull();
    expect(movie.favorite).toBe(false);
    if (fixtures.real) {
      expect(movie.durationSeconds).toBeGreaterThan(4);
      expect(movie.videoCodec).toBe('h264');
      expect(movie.width).toBe(320);
    }
  });

  test('search is case-insensitive and supports pagination', async () => {
    const res = await request(app).get('/api/media').query({ q: 'test MOVIE' }).set(auth(viewer));
    expect(res.body.total).toBe(1);
    const page = await request(app).get('/api/media').query({ libraryId: libs.movies.id, limit: 1, offset: 1, sort: 'title' }).set(auth(viewer));
    expect(page.body.data).toHaveLength(1);
    expect(page.body.total).toBe(2);
    // LIKE wildcards in user input are escaped.
    expect((await request(app).get('/api/media').query({ q: '%' }).set(auth(viewer))).body.total).toBe(0);
  });

  test('TV episodes are grouped into shows', async () => {
    const res = await request(app).get('/api/media/shows').set(auth(viewer));
    expect(res.body.data).toEqual([expect.objectContaining({ seriesTitle: 'Test Show', episodeCount: 2, seasonCount: 1 })]);
    const eps = await findItem(viewer, { seriesTitle: 'Test Show', sort: 'episode' });
    expect(eps.map((e) => [e.seasonNumber, e.episodeNumber, e.title])).toEqual([[1, 1, 'Pilot'], [1, 2, 'The Second']]);
  });

  test('music uses embedded tags when available', async () => {
    const res = await request(app).get('/api/media/albums').set(auth(viewer));
    expect(res.body.data).toHaveLength(1);
    const album = res.body.data[0];
    if (fixtures.real) {
      expect(album).toMatchObject({ artist: 'Tagged Artist', album: 'Tagged Album', trackCount: 1, year: 2020 });
    } else {
      expect(album).toMatchObject({ artist: 'Test Artist', album: 'Test Album' });
    }
  });

  test('detail includes playback capabilities and next episode', async () => {
    const [ep1] = await findItem(viewer, { seriesTitle: 'Test Show', sort: 'episode' });
    const res = await request(app).get(`/api/media/${ep1.id}`).set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data.relativePath).toBeUndefined(); // hidden from viewers
    expect(res.body.data.playback.directPlayable).toBe(true);
    expect(res.body.data.nextItemId).toBeTruthy();
    const next = await request(app).get(`/api/media/${res.body.data.nextItemId}`).set(auth(viewer));
    expect(next.body.data.episodeNumber).toBe(2);
    if (fixtures.real) {
      expect(next.body.data.playback.directPlayable).toBe(false); // mpeg4/mp2 in mkv
      expect(next.body.data.playback.hls).toBe(true);
    }
  });

  test('unknown media returns 404 and bad ids 400', async () => {
    expect((await request(app).get('/api/media/999999').set(auth(viewer))).status).toBe(404);
    expect((await request(app).get('/api/media/abc').set(auth(viewer))).status).toBe(400);
  });
});

describe('streaming', () => {
  let movie;
  let playback;

  beforeAll(async () => {
    [movie] = await findItem(viewer, { q: 'The Test Movie' });
    const res = await request(app).post(`/api/media/${movie.id}/playback`).set(auth(viewer));
    expect(res.status).toBe(200);
    playback = res.body.data;
  });

  test('direct stream supports range requests', async () => {
    const size = fs.statSync(fixtures.movie).size;
    const full = await request(app).get(playback.directUrl);
    expect(full.status).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(Number(full.headers['content-length'])).toBe(size);
    const part = await request(app).get(playback.directUrl).set('Range', 'bytes=0-99');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-99/${size}`);
    expect(part.body.length).toBe(100);
  });

  test('stream tokens are scoped to one item', async () => {
    const [other] = await findItem(viewer, { q: 'Another Film' });
    const token = new URL(playback.directUrl, 'http://x').searchParams.get('token');
    const res = await request(app).get(`/api/stream/${other.id}/direct`).query({ token });
    expect(res.status).toBe(403);
  });

  test('access tokens are not accepted in URLs', async () => {
    const res = await request(app).get(`/api/stream/${movie.id}/direct`).query({ token: viewer });
    expect(res.status).toBe(401);
  });

  test('stream tokens cannot call the API', async () => {
    const token = new URL(playback.directUrl, 'http://x').searchParams.get('token');
    expect((await request(app).get('/api/media').set(auth(token))).status).toBe(401);
  });

  test('sidecar subtitles are converted to WebVTT', async () => {
    expect(playback.subtitles).toHaveLength(1);
    expect(playback.subtitles[0].language).toBe('en');
    const res = await request(app).get(playback.subtitles[0].url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/vtt/);
    expect(res.text).toMatch(/^WEBVTT/);
    expect(res.text).toContain('00:00:00.500 --> 00:00:02.000');
  });

  test('thumbnails accept the image token but it cannot stream', async () => {
    const me = await request(app).get('/api/auth/me').set(auth(viewer));
    const { imageToken } = me.body;
    const thumb = await request(app).get(`/api/media/${movie.id}/thumbnail`).query({ token: imageToken });
    if (fixtures.real) {
      expect(thumb.status).toBe(200);
      expect(thumb.headers['content-type']).toMatch(/image\/jpeg/);
    } else {
      expect(thumb.headers['content-type']).toMatch(/image\/svg\+xml/); // placeholder
    }
    const [track] = await findItem(viewer, { kind: 'track' });
    const noArt = await request(app).get(`/api/media/${track.id}/thumbnail`).query({ token: imageToken });
    expect(noArt.status).toBe(200);
    expect(noArt.headers['content-type']).toMatch(/image\/svg\+xml/);
    const stream = await request(app).get(`/api/stream/${movie.id}/direct`).query({ token: imageToken });
    expect(stream.status).toBe(403);
  });

  test('HLS master, variant and segment are produced on demand', async () => {
    if (!fixtures.real) return;
    const master = await request(app).get(playback.hlsUrl);
    expect(master.status).toBe(200);
    expect(master.headers['content-type']).toMatch(/mpegurl/);
    // Source is 180p so only the lowest rendition is offered.
    expect(master.text).toContain('360p/index.m3u8?token=');
    const base = playback.hlsUrl.split('/master.m3u8')[0];
    const tokenQs = playback.hlsUrl.split('?')[1];
    const variant = await request(app).get(`${base}/360p/index.m3u8?${tokenQs}`);
    expect(variant.status).toBe(200);
    expect(variant.text).toContain('#EXT-X-ENDLIST');
    const seg = await request(app).get(`${base}/360p/seg_0.ts?${tokenQs}`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(seg.status).toBe(200);
    expect(seg.body[0]).toBe(0x47); // MPEG-TS sync byte
    // Seeking: request the last segment directly.
    const last = await request(app).get(`${base}/360p/seg_2.ts?${tokenQs}`);
    expect(last.status).toBe(200);
    expect((await request(app).get(`${base}/360p/seg_99.ts?${tokenQs}`)).status).toBe(404);
    expect((await request(app).get(`${base}/9000p/index.m3u8?${tokenQs}`)).status).toBe(404);
  }, 60000);

  test('audio can be transcoded to mp3', async () => {
    if (!fixtures.real) return;
    const [track] = await findItem(viewer, { kind: 'track' });
    const pb = await request(app).post(`/api/media/${track.id}/playback`).set(auth(viewer));
    const res = await request(app).get(pb.body.data.audioTranscodeUrl);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
  }, 30000);
});

describe('progress, history and favorites', () => {
  let movie;
  beforeAll(async () => {
    [movie] = await findItem(viewer, { q: 'The Test Movie' });
  });

  test('saving progress shows the item in continue watching', async () => {
    const res = await request(app).put(`/api/media/${movie.id}/progress`).set(auth(viewer)).send({ positionSeconds: fixtures.real ? 6 : 30 });
    expect(res.status).toBe(200);
    expect(res.body.data.completed).toBe(false);
    const cont = await request(app).get('/api/media/continue').set(auth(viewer));
    expect(cont.body.data.map((i) => i.id)).toContain(movie.id);
    // Progress is per user.
    const adminCont = await request(app).get('/api/media/continue').set(auth(admin));
    expect(adminCont.body.data).toHaveLength(0);
  });

  test('playback resumes from saved position', async () => {
    const pb = await request(app).post(`/api/media/${movie.id}/playback`).set(auth(viewer));
    expect(pb.body.data.resumePositionSeconds).toBe(fixtures.real ? 6 : 30);
  });

  test('reaching the end marks the item watched and counts a play', async () => {
    if (!fixtures.real) return;
    const res = await request(app).put(`/api/media/${movie.id}/progress`).set(auth(viewer)).send({ positionSeconds: 12 });
    expect(res.body.data).toMatchObject({ completed: true, playCount: 1 });
    const cont = await request(app).get('/api/media/continue').set(auth(viewer));
    expect(cont.body.data.map((i) => i.id)).not.toContain(movie.id);
    const hist = await request(app).get('/api/media/history').set(auth(viewer));
    expect(hist.body.data[0].id).toBe(movie.id);
  });

  test('mark unwatched clears progress', async () => {
    expect((await request(app).delete(`/api/media/${movie.id}/progress`).set(auth(viewer))).status).toBe(204);
    const detail = await request(app).get(`/api/media/${movie.id}`).set(auth(viewer));
    expect(detail.body.data.progress).toBeNull();
  });

  test('progress payload is validated', async () => {
    const res = await request(app).put(`/api/media/${movie.id}/progress`).set(auth(viewer)).send({ positionSeconds: -5 });
    expect(res.status).toBe(400);
  });

  test('favorites can be toggled', async () => {
    expect((await request(app).put(`/api/media/${movie.id}/favorite`).set(auth(viewer))).status).toBe(200);
    expect((await request(app).put(`/api/media/${movie.id}/favorite`).set(auth(viewer))).status).toBe(200); // idempotent
    const favs = await request(app).get('/api/media/favorites').set(auth(viewer));
    expect(favs.body.data.map((i) => i.id)).toEqual([movie.id]);
    expect(favs.body.data[0].favorite).toBe(true);
    await request(app).delete(`/api/media/${movie.id}/favorite`).set(auth(viewer));
    expect((await request(app).get('/api/media/favorites').set(auth(viewer))).body.data).toHaveLength(0);
  });
});

describe('administration', () => {
  test('metadata edits are admin-only and survive rescans', async () => {
    const [movie] = await findItem(admin, { q: 'Another Film' });
    expect((await request(app).patch(`/api/media/${movie.id}`).set(auth(viewer)).send({ title: 'Hacked' })).status).toBe(403);
    const bad = await request(app).patch(`/api/media/${movie.id}`).set(auth(admin)).send({ posterUrl: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
    const res = await request(app).patch(`/api/media/${movie.id}`).set(auth(admin)).send({ title: 'Another Film: Director’s Cut', genres: ['Drama'] });
    expect(res.status).toBe(200);
    // Touch the file so it is re-probed.
    const now = new Date();
    fs.utimesSync(fixtures.mkv, now, new Date(now.getTime() + 5000));
    await request(app).post(`/api/libraries/${libs.movies.id}/scan?wait=true`).set(auth(admin));
    const after = await request(app).get(`/api/media/${movie.id}`).set(auth(admin));
    expect(after.body.data.title).toBe('Another Film: Director’s Cut');
    const byGenre = await request(app).get('/api/media').query({ genre: 'Drama' }).set(auth(admin));
    expect(byGenre.body.data.map((i) => i.id)).toEqual([movie.id]);
    const genres = await request(app).get('/api/media/genres').set(auth(admin));
    expect(genres.body.data).toContain('Drama');
  });

  test('rescan picks up new files and removes deleted ones', async () => {
    const extra = path.join(MEDIA_ROOT, 'Movies', 'Brand New (2024).mp4');
    fs.copyFileSync(fixtures.movie, extra);
    let scan = await request(app).post(`/api/libraries/${libs.movies.id}/scan?wait=true`).set(auth(admin));
    expect(scan.body.data.added).toBe(1);
    fs.unlinkSync(extra);
    scan = await request(app).post(`/api/libraries/${libs.movies.id}/scan?wait=true`).set(auth(admin));
    expect(scan.body.data.removed).toBe(1);
  });

  test('uploads reject disallowed file types', async () => {
    const res = await request(app)
      .post(`/api/libraries/${libs.movies.id}/upload`)
      .set(auth(admin))
      .attach('files', Buffer.from('<script>alert(1)</script>'), 'evil.html');
    expect(res.status).toBe(400);
    const leftovers = fs.readdirSync(path.join(MEDIA_ROOT, 'Movies')).filter((f) => f.startsWith('.upload-'));
    expect(leftovers).toHaveLength(0);
  });

  test('uploads are sanitised and indexed', async () => {
    const res = await request(app)
      .post(`/api/libraries/${libs.movies.id}/upload`)
      .query({ folder: '../../escape' })
      .set(auth(admin))
      .attach('files', fs.readFileSync(fixtures.movie), '../Uploaded Film (2023).mp4');
    expect(res.status).toBe(201);
    expect(res.body.data.files).toEqual([path.join('escape', 'Uploaded Film (2023).mp4')]);
    expect(fs.existsSync(path.join(MEDIA_ROOT, 'Movies', 'escape', 'Uploaded Film (2023).mp4'))).toBe(true);
    expect((await request(app).post(`/api/libraries/${libs.movies.id}/upload`).set(auth(viewer))
      .attach('files', Buffer.from('x'), 'a.mp4')).status).toBe(403);
  });

  test('deleting media with deleteFile removes it from disk', async () => {
    await request(app).post(`/api/libraries/${libs.movies.id}/scan?wait=true`).set(auth(admin));
    const [item] = await findItem(admin, { q: 'Uploaded Film' });
    const file = path.join(MEDIA_ROOT, 'Movies', item.relativePath);
    expect((await request(app).delete(`/api/media/${item.id}`).set(auth(viewer))).status).toBe(403);
    expect((await request(app).delete(`/api/media/${item.id}?deleteFile=true`).set(auth(admin))).status).toBe(204);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('system status reports counts', async () => {
    const res = await request(app).get('/api/system/status').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.counts).toMatchObject({ users: 2, libraries: 4, movie: 2, episode: 2, track: 1, photo: 1 });
  });

  test('deleting a library removes its items but not files', async () => {
    const res = await request(app).delete(`/api/libraries/${libs.photos.id}`).set(auth(admin));
    expect(res.status).toBe(204);
    expect(fs.existsSync(fixtures.photo)).toBe(true);
    expect(await findItem(admin, { kind: 'photo' })).toHaveLength(0);
  });

  test('changing password revokes existing tokens', async () => {
    const res = await request(app).post('/api/auth/change-password').set(auth(viewer))
      .send({ currentPassword: PASSWORD, newPassword: 'another-long-password' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth(viewer))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(auth(res.body.accessToken))).status).toBe(200);
  });

  test('role change by admin revokes the user sessions', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'viewer', password: 'another-long-password' });
    const token = login.body.accessToken;
    const id = login.body.user.id;
    await request(app).patch(`/api/users/${id}`).set(auth(admin)).send({ role: 'admin' });
    expect((await request(app).get('/api/auth/me').set(auth(token))).status).toBe(401);
    // Now there are two admins, so one can be demoted.
    expect((await request(app).patch(`/api/users/${id}`).set(auth(admin)).send({ role: 'viewer' })).status).toBe(200);
  });
});

describe('web UI and errors', () => {
  test('serves the SPA with a strict CSP', async () => {
    const res = await request(app).get('/library/1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<main id="view"');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('serves vendored hls.js', async () => {
    const res = await request(app).get('/vendor/hls.min.js');
    expect(res.status).toBe(200);
  });

  test('unknown API routes return JSON 404', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Route not found');
  });

  test('malformed JSON returns 400', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
  });

  test('health endpoint', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.status).toBe('ok');
  });

  test('scanner tolerates unreadable entries', async () => {
    write(path.join(MEDIA_ROOT, 'TV', 'Broken Show', 'S01E01.mp4'), 'not a real video');
    const scan = await request(app).post(`/api/libraries/${libs.tv.id}/scan?wait=true`).set(auth(admin));
    expect(scan.status).toBe(200);
    expect(scan.body.data.added).toBe(1);
  });
});
