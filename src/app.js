'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./config');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const publicDir = path.join(__dirname, '..', 'public');
const hlsDist = path.dirname(require.resolve('hls.js/dist/hls.min.js'));

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'blob:', 'https://image.tmdb.org'],
        'media-src': ["'self'", 'blob:'],
        'worker-src': ["'self'", 'blob:'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': config.httpsOnly ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: config.httpsOnly,
    // Allow casting devices / other origins to fetch media when CORS permits.
    crossOriginResourcePolicy: { policy: config.corsOrigins.length ? 'cross-origin' : 'same-origin' },
  }));

  // CORS is off unless explicitly configured (the web UI is served same-origin).
  if (config.corsOrigins.length) {
    app.use(cors({ origin: config.corsOrigins, maxAge: 600 }));
  }

  if (!config.isTest) app.use(morgan(config.isProduction ? 'combined' : 'dev', {
    // Never log stream/image tokens from query strings.
    skip: (req) => req.path === '/api/health',
  }));
  morgan.token('url', (req) => req.originalUrl.replace(/([?&]token=)[^&]+/g, '$1[redacted]'));

  app.use(express.json({ limit: '100kb' }));

  app.use('/api', require('./routes/system'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/libraries', require('./routes/libraries'));
  app.use('/api/media', require('./routes/media'));
  app.use('/api/stream', require('./routes/stream'));
  app.use('/api', notFoundHandler);

  // Web UI
  app.use('/vendor', express.static(hlsDist, { maxAge: '7d', index: false }));
  app.use(express.static(publicDir, { index: false, maxAge: config.isProduction ? '1h' : 0 }));
  app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
