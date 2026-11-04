'use strict';

const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ quiet: true });

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';
const isTest = env === 'test';

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`Environment variable ${name} must be an integer`);
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function resolveJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret) {
    if (isProduction && secret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters in production');
    }
    return secret;
  }
  if (isProduction) {
    throw new Error('JWT_SECRET is required in production');
  }
  // Development/test only: a random per-process secret. Tokens are invalidated on restart.
  return crypto.randomBytes(48).toString('hex');
}

const rootDir = path.resolve(__dirname, '..', '..');

const config = {
  env,
  isProduction,
  isTest,
  port: int('PORT', 3000),
  trustProxy: process.env.TRUST_PROXY || 'loopback',
  // Served over HTTPS (CSP upgrade-insecure-requests + HSTS). Set HTTPS_ONLY=false to test over plain HTTP on a LAN.
  httpsOnly: bool('HTTPS_ONLY', isProduction),
  corsOrigins: (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  db: {
    url: process.env.DATABASE_URL || null,
    dialect: process.env.DB_DIALECT || 'postgres',
    host: process.env.POSTGRES_HOST || 'localhost',
    port: int('POSTGRES_PORT', 5432),
    database: process.env.POSTGRES_DB || 'salmanplex',
    username: process.env.POSTGRES_USER || 'salmanplex',
    password: process.env.POSTGRES_PASSWORD || '',
    storage: process.env.DB_STORAGE || ':memory:',
    logging: bool('DB_LOGGING', false),
    ssl: bool('POSTGRES_SSL', false),
  },

  auth: {
    jwtSecret: resolveJwtSecret(),
    accessTokenTtl: process.env.JWT_EXPIRES_IN || '12h',
    streamTokenTtl: process.env.STREAM_TOKEN_EXPIRES_IN || '8h',
    bcryptRounds: int('BCRYPT_ROUNDS', isTest ? 4 : 12),
    allowRegistration: bool('ALLOW_REGISTRATION', false),
  },

  media: {
    // Every library path must live inside this directory.
    root: path.resolve(process.env.MEDIA_ROOT || path.join(rootDir, 'media')),
    cacheDir: path.resolve(process.env.CACHE_DIR || path.join(rootDir, '.cache')),
    maxUploadBytes: int('MAX_UPLOAD_MB', 4096) * 1024 * 1024,
    scanOnStartup: bool('SCAN_ON_STARTUP', false),
  },

  ffmpeg: {
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    enabled: bool('TRANSCODING_ENABLED', true),
    maxConcurrentTranscodes: int('MAX_TRANSCODES', 2),
    hlsSegmentSeconds: int('HLS_SEGMENT_SECONDS', 6),
    transcodeIdleTimeoutMs: int('TRANSCODE_IDLE_TIMEOUT_S', 60) * 1000,
    preset: process.env.FFMPEG_PRESET || 'veryfast',
  },

  metadata: {
    tmdbApiKey: process.env.TMDB_API_KEY || '',
    tmdbBaseUrl: process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3',
    tmdbImageBase: 'https://image.tmdb.org/t/p/w500',
    tmdbLanguage: process.env.TMDB_LANGUAGE || 'en-US',
  },
};

module.exports = config;
