'use strict';

const { ValidationError, UniqueConstraintError, ForeignKeyConstraintError } = require('sequelize');
const multer = require('multer');
const config = require('../config');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    req.socket.destroy();
    return undefined;
  }

  let status = err.status || err.statusCode || 500;
  let message = err.expose || status < 500 ? err.message : 'Internal server error';
  let { details } = err;

  if (err instanceof UniqueConstraintError) {
    status = 409;
    message = 'Resource already exists';
    details = err.errors.map((e) => ({ path: e.path, message: e.message }));
  } else if (err instanceof ValidationError) {
    status = 400;
    message = 'Validation failed';
    details = err.errors.map((e) => ({ path: e.path, message: e.message }));
  } else if (err instanceof ForeignKeyConstraintError) {
    status = 400;
    message = 'Referenced resource does not exist';
  } else if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = err.message;
  } else if (err.type === 'entity.too.large') {
    status = 413;
    message = 'Request body too large';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Malformed JSON body';
  } else if (err.code === 'ENOENT') {
    status = 404;
    message = 'File not found on disk';
  }

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  }

  const body = { error: message };
  if (details) body.details = details;
  if (!config.isProduction && status >= 500 && err.message) body.debug = err.message;
  return res.status(status).json(body);
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Route not found' });
}

module.exports = { errorHandler, notFoundHandler };
