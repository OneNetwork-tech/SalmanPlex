'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Runs before any module is loaded in each test file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'salmanplex-test-'));
process.env.NODE_ENV = 'test';
if (process.env.TEST_DATABASE_URL) {
  // Run the suite against a real PostgreSQL (used in CI). The schema is reset per file.
  process.env.DB_DIALECT = 'postgres';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.DB_DIALECT = 'sqlite';
  process.env.DB_STORAGE = ':memory:';
}
process.env.MEDIA_ROOT = path.join(tmp, 'media');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.HLS_SEGMENT_SECONDS = '2';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-usage';
process.env.ALLOW_REGISTRATION = 'false';
process.env.TMDB_API_KEY = '';
process.env.TEST_TMP_DIR = tmp;
fs.mkdirSync(process.env.MEDIA_ROOT, { recursive: true });
