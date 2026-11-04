'use strict';

const { badRequest } = require('../utils/errors');

/**
 * Validate and coerce req[part] with a zod schema. The parsed value replaces the
 * original so handlers only ever see validated data.
 */
const validate = (schema, part = 'body') => (req, res, next) => {
  const result = schema.safeParse(req[part] === undefined ? {} : req[part]);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return next(badRequest('Validation failed', details));
  }
  if (part === 'query') {
    // req.query is a getter in Express 5 and may be read-only; store separately.
    req.validQuery = result.data;
  } else {
    req[part] = result.data;
  }
  return next();
};

module.exports = { validate };
