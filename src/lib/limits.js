'use strict';
const { rateLimit } = require('express-rate-limit');
const config = require('../config');

// Per-IP rate limit that answers with a friendly Arabic error. RATE_LIMIT=off disables it (tests only).
function limiter(limit, minutes, message) {
  return rateLimit({
    windowMs: minutes * 60000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => config.rateLimitOff,
    handler: (req, res, next) => {
      const err = new Error(message);
      err.status = 429;
      err.expose = true;
      next(err);
    },
  });
}

module.exports = { limiter };
