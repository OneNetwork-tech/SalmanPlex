# SalmanPlex

A self-hosted, Plex-style media server. Point it at folders of movies, TV shows, music and photos; it indexes them, fetches artwork and metadata, and streams them to any modern browser. Files the browser can't play are transcoded on the fly to adaptive HLS.

## Features

| Area | What you get |
|---|---|
| **Libraries** | Movies, TV, Music and Photos libraries. Recursive scanning with ffprobe (duration, resolution, codecs, embedded tags), smart file-name parsing (`Movie (2020)`, `Show - S01E02 - Title`, `Artist/Album/01 - Song`), incremental rescans (only changed files are re-probed), and removal of deleted files |
| **Metadata** | Optional TMDb lookups: posters, backdrops, overviews, genres, ratings and episode titles. Admins can edit metadata by hand, and edits survive rescans |
| **Streaming** | Direct play with HTTP Range support. Seek-aware **on-demand HLS** (1080p/720p/480p/360p, capped at the source resolution) with automatic fallback, MP3 transcoding for audio formats browsers can't play, and subtitles (sidecar `.srt`/`.vtt` and embedded text tracks, served as WebVTT) |
| **Player** | Resume where you left off, quality picker, subtitle picker, keyboard shortcuts, auto-play of the next episode, Cast (Remote Playback API) and AirPlay, plus a persistent music player with album queue and lock-screen controls |
| **Users** | JWT auth with roles (`admin`, `viewer`). The first account becomes admin; registration after that is closed by default. Per-user watch progress, history, Continue Watching and favorites |
| **Admin** | Server status, libraries (folder picker, scan, metadata refresh, uploads, removal) and users (create, change role, reset password, delete) |
| **Web UI** | Responsive single-page app that works on desktop, tablet and phone, installable as a PWA. No build step |

## Quick start (Docker)

```bash
cp .env.example .env
# edit .env: set JWT_SECRET (openssl rand -hex 48) and POSTGRES_PASSWORD
mkdir -p media/Movies media/TV media/Music media/Photos
docker compose up -d --build
```

Open <http://localhost:3000> and create the administrator account. In **Admin → Libraries**, add a library for each folder (paths are relative to the media root, for example `Movies`).

## Local development

Requirements: Node.js 20 or newer, PostgreSQL 13 or newer, and ffmpeg/ffprobe on `PATH`. Without ffmpeg the server still runs, but you lose transcoding, thumbnails and codec detection.

```bash
npm install
cp .env.example .env     # set POSTGRES_* (or DATABASE_URL) and JWT_SECRET
npm run dev              # migrates the database, then serves http://localhost:3000
```

Without `JWT_SECRET`, development mode generates a random secret, so you're signed out on every restart. Production refuses to start without one, or with one shorter than 32 characters.

### Tests

```bash
npm test                                  # SQLite in memory, real ffmpeg fixtures
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/salmanplex_test npm test
npm run check                             # syntax check of server and client code
```

The suite builds real media fixtures with ffmpeg. It covers auth and roles, path-traversal and symlink defences, scanning and parsing, range streaming, token scoping, HLS segment generation and seeking, subtitles, uploads, progress and favorites, and admin flows. CI runs it against both SQLite and PostgreSQL, then builds and smoke-tests the Docker image.

### Database migrations

Migrations live in `src/db/migrations` and run automatically on startup. You can also run them by hand:

```bash
npm run migrate
npm run migrate:down   # roll back the latest migration
```

## Organising media

```
media/
├── Movies/
│   ├── Heat (1995)/Heat (1995).mkv
│   ├── Heat (1995)/Heat (1995).en.srt      ← sidecar subtitles
│   └── The.Matrix.1999.1080p.BluRay.mkv
├── TV/
│   └── Breaking Bad/Season 1/Breaking Bad - S01E01 - Pilot.mkv
├── Music/
│   └── Artist/Album/01 - Song.flac          ← embedded tags take priority
└── Photos/
    └── 2024 Holiday/IMG_0001.jpg
```

## Configuration

All settings are environment variables; `.env.example` documents each one. The most important:

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | none (required in production) | Signs session, stream and image tokens |
| `DATABASE_URL` / `POSTGRES_*` | `localhost` | PostgreSQL connection |
| `MEDIA_ROOT` | `./media` | Every library must live inside this folder |
| `CACHE_DIR` | `./.cache` | Thumbnails, WebVTT and HLS segments |
| `ALLOW_REGISTRATION` | `false` | Let anyone register after the admin account exists |
| `TMDB_API_KEY` | empty | Enables online metadata |
| `MAX_TRANSCODES` | `2` | Number of concurrent ffmpeg HLS jobs |
| `CORS_ORIGIN` | empty | Comma-separated origins allowed to call the API cross-origin |
| `TRUST_PROXY` | `loopback` | Set this when running behind a reverse proxy |

## Security model

- **Authentication.** Passwords are hashed with bcrypt (12 rounds). Login responses don't reveal whether a username exists, and the auth endpoints are rate-limited. Changing a password, changing a role, or using "sign out everywhere" bumps a per-user token version, which immediately revokes every existing token.
- **Tokens.** The API only accepts access tokens in the `Authorization` header. Media URLs carry a **stream token** scoped to a single item. Artwork URLs carry a read-only **image token** that can't be used for playback or the API. Tokens in query strings are redacted from access logs.
- **Filesystem.** Library folders, files, uploads and subtitles are resolved with `realpath` and must stay inside `MEDIA_ROOT` or their library, so `..` and symlink escapes are rejected. Uploads are restricted to the library's media extensions, written under a temporary name, sanitised and renamed so nothing is overwritten. Deleting a library never touches files on disk.
- **Browser.** A strict Content-Security-Policy is applied (no inline or third-party scripts; hls.js is served locally). The UI builds the DOM without `innerHTML`, so media metadata can't inject markup. CORS is off unless configured.
- **Input.** Every request body and query is validated with zod. JSON bodies are limited to 100 KB. Queries are parameterised, with escaped `LIKE` patterns.
- **Deployment.** The container runs as a non-root user under `tini`, with a read-only root filesystem, all capabilities dropped and a health check. The database is not exposed outside the compose network.

## Architecture

```
src/
  app.js                  Express app (security headers, routes, SPA)
  server.js               Startup: migrations, ffmpeg detection, graceful shutdown
  config/                 Validated environment configuration
  db/                     Sequelize instance + Umzug migrations
  models/                 User, Library, MediaItem, WatchProgress, Favorite
  middleware/             Auth (access/stream/image tokens), validation, errors
  routes/                 auth, users, libraries, media, stream, system
  services/
    scanner.js            Library walker, ffprobe, sidecar subtitles, TMDb enrichment
    transcoder.js         On-demand HLS: VOD playlists, seek-aware ffmpeg jobs, reaper
    thumbnails.js         Cached ffmpeg thumbnails / album art
    subtitles.js          SRT → WebVTT, embedded subtitle extraction
    metadata.js           TMDb client (optional)
public/                   SPA (ES modules, no build step), vendored hls.js
tests/                    Jest + Supertest with real ffmpeg fixtures
k8s/                      Deployment, PVCs, Service, Ingress
```

### How HLS transcoding works

When a video can't be played directly, the client asks for `master.m3u8`. Playlists are generated immediately from the probed duration as fixed-length VOD segments, so the player can seek anywhere straight away. Requesting a segment starts an ffmpeg job at that position, with keyframes forced on segment boundaries and timestamps offset to match the playlist. If the player seeks beyond what the encoder has produced, the job restarts at the new position. Segments that are already encoded are reused, and idle jobs are stopped and cleaned up after `TRANSCODE_IDLE_TIMEOUT_S`.

## API overview

All endpoints are under `/api`. Except where noted, they require `Authorization: Bearer <accessToken>`.

| Method & path | Description |
|---|---|
| `GET /health` | Liveness and database check (no auth) |
| `GET /auth/setup-status` · `POST /auth/register` · `POST /auth/login` | First-run setup and sessions |
| `GET /auth/me` · `POST /auth/change-password` · `POST /auth/logout-all` | Account management |
| `GET/POST /users` · `PATCH/DELETE /users/:id` | User management (admin) |
| `GET /libraries` · `POST /libraries` · `PATCH/DELETE /libraries/:id` | Libraries (writes are admin-only) |
| `POST /libraries/:id/scan[?wait=true&refreshMetadata=true]` · `POST /libraries/:id/upload` · `GET /libraries/browse` | Scanning, uploads, folder picker (admin) |
| `GET /media?libraryId&kind&q&genre&seriesTitle&artist&album&sort&order&limit&offset` | Browse and search |
| `GET /media/recent` · `/continue` · `/history` · `/favorites` · `/genres` · `/shows` · `/albums` | Shelves and groupings |
| `GET /media/:id` · `PATCH /media/:id` · `DELETE /media/:id[?deleteFile=true]` · `POST /media/:id/refresh-metadata` | Item detail and admin edits |
| `POST /media/:id/playback` | Issues a stream token plus direct, HLS, audio and subtitle URLs |
| `PUT/DELETE /media/:id/progress` · `POST /media/:id/watched` · `PUT/DELETE /media/:id/favorite` | Per-user state |
| `GET /media/:id/thumbnail?token=<imageToken>` | Artwork |
| `GET /stream/:id/direct` · `/hls/master.m3u8` · `/hls/:quality/index.m3u8` · `/hls/:quality/seg_N.ts` · `/audio` · `/subtitles/:track.vtt` | Streaming (`?token=<streamToken>`) |
| `GET /system/status` | Counts, tool availability and active transcodes (admin) |

## Roadmap

- Hardware-accelerated transcoding (VAAPI / NVENC / QuickSync)
- Filesystem watching for automatic rescans
- MusicBrainz / Cover Art Archive lookups for music
- Per-library sharing permissions and parental ratings
- Native Chromecast receiver app and DLNA
