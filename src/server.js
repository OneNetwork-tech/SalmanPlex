'use strict';

const fs = require('fs');
const config = require('./config');
const { sequelize, Library } = require('./models');
const { migrateUp } = require('./db/migrate');
const { createApp } = require('./app');
const ffmpeg = require('./services/ffmpeg');
const scanner = require('./services/scanner');
const transcoder = require('./services/transcoder');

async function start() {
  await fs.promises.mkdir(config.media.root, { recursive: true });
  await fs.promises.mkdir(config.media.cacheDir, { recursive: true });

  await sequelize.authenticate();
  const applied = await migrateUp();
  if (applied.length) console.log(`[db] applied migrations: ${applied.map((m) => m.name).join(', ')}`);

  await transcoder.cleanCache();
  const tools = await ffmpeg.detect();
  console.log(`[media] root=${config.media.root} ffmpeg=${tools.ffmpeg} ffprobe=${tools.ffprobe}`);
  if (!tools.ffprobe) console.warn('[media] ffprobe not found: durations/codecs will be unknown and HLS disabled');

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`SalmanPlex listening on http://localhost:${config.port} (${config.env})`);
  });
  server.requestTimeout = 0; // long-running streams
  server.headersTimeout = 65000;
  server.keepAliveTimeout = 61000;

  if (config.media.scanOnStartup) {
    const libraries = await Library.findAll();
    libraries.forEach((lib) => scanner.scanLibrary(lib.id).catch((e) => console.error(`[scanner] ${lib.name}: ${e.message}`)));
  }

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, shutting down`);
    transcoder.stopAll();
    server.close(async () => {
      await scanner.waitForScans();
      await sequelize.close();
      process.exit(0);
    });
    // Streams may hold connections open; force exit after a grace period.
    setTimeout(() => process.exit(0), 10000).unref();
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
