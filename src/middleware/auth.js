'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { User } = require('../models');
const { unauthorized, forbidden } = require('../utils/errors');

const ISSUER = 'salmanplex';
const ALGORITHM = 'HS256';

function signAccessToken(user) {
  return jwt.sign({ typ: 'access', role: user.role, tv: user.tokenVersion }, config.auth.jwtSecret, {
    algorithm: ALGORITHM,
    subject: String(user.id),
    issuer: ISSUER,
    expiresIn: config.auth.accessTokenTtl,
  });
}

/** Short-lived token bound to a single media item, usable in URLs (<video src>, HLS). */
function signStreamToken(user, mediaItemId) {
  return jwt.sign({ typ: 'stream', mid: mediaItemId, tv: user.tokenVersion }, config.auth.jwtSecret, {
    algorithm: ALGORITHM,
    subject: String(user.id),
    issuer: ISSUER,
    expiresIn: config.auth.streamTokenTtl,
  });
}

/**
 * Read-only token for artwork (<img src> cannot send headers). It only unlocks
 * thumbnails, never playback or the API.
 */
function signImageToken(user) {
  return jwt.sign({ typ: 'image', tv: user.tokenVersion }, config.auth.jwtSecret, {
    algorithm: ALGORITHM,
    subject: String(user.id),
    issuer: ISSUER,
    expiresIn: config.auth.accessTokenTtl,
  });
}

function verify(token) {
  try {
    return jwt.verify(token, config.auth.jwtSecret, { algorithms: [ALGORITHM], issuer: ISSUER });
  } catch {
    return null;
  }
}

async function loadUser(payload) {
  const id = Number.parseInt(payload.sub, 10);
  if (!Number.isInteger(id)) return null;
  const user = await User.findByPk(id);
  // tokenVersion lets us revoke all tokens (password change, logout-all, role change).
  if (!user || user.tokenVersion !== payload.tv) return null;
  return user;
}

function bearer(req) {
  const header = req.get('authorization') || '';
  const [scheme, value] = header.split(' ');
  return scheme && scheme.toLowerCase() === 'bearer' && value ? value.trim() : null;
}

async function requireAuth(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) throw unauthorized();
    const payload = verify(token);
    if (!payload || payload.typ !== 'access') throw unauthorized('Invalid or expired token');
    const user = await loadUser(payload);
    if (!user) throw unauthorized('Invalid or expired token');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden('Administrator access required'));
  return next();
}

/**
 * Authorise a media request either with a normal bearer token or with a stream
 * token (?token=) scoped to the media item in :id.
 */
const requireMediaAccess = ({ allowImageToken = false } = {}) => async (req, res, next) => {
  try {
    const itemId = Number.parseInt(req.params.id, 10);
    const headerToken = bearer(req);
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
    const token = headerToken || queryToken;
    if (!token) throw unauthorized();
    const payload = verify(token);
    if (!payload) throw unauthorized('Invalid or expired token');
    if (payload.typ === 'image') {
      if (!allowImageToken) throw forbidden('Token is not valid for this resource');
    } else if (payload.typ === 'stream') {
      if (payload.mid !== itemId) throw forbidden('Token is not valid for this media');
      req.streamToken = token;
    } else if (payload.typ !== 'access' || !headerToken) {
      // Access tokens are only accepted in the Authorization header, never in URLs.
      throw unauthorized('Invalid token');
    }
    const user = await loadUser(payload);
    if (!user) throw unauthorized('Invalid or expired token');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = {
  signAccessToken, signStreamToken, signImageToken, verify, requireAuth, requireAdmin, requireMediaAccess,
};
