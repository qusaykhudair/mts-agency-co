'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Values already present in the environment win over the .env file.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* no .env file — rely on the real environment */
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const dataDir = path.resolve(ROOT, env.DATA_DIR || 'data');

module.exports = {
  root: ROOT,
  isProd,
  port: Number(env.PORT) || 3000,
  appUrl: (env.APP_URL || '').replace(/\/+$/, ''),
  dataDir,
  dbFile: env.DB_FILE ? path.resolve(ROOT, env.DB_FILE) : path.join(dataDir, 'store.db'),
  uploadDir: path.resolve(ROOT, env.UPLOAD_DIR || 'uploads'),
  // Number of reverse proxies in front of the app (Nginx, Render, Railway…), 0 when exposed directly.
  trustProxy: env.TRUST_PROXY !== undefined ? Number(env.TRUST_PROXY) : isProd ? 1 : 0,
  sessionDays: Number(env.SESSION_DAYS) || 30,
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  rateLimitOff: env.RATE_LIMIT === 'off',
  seedDemo: env.SEED_DEMO !== 'false',
  admin: {
    name: env.ADMIN_NAME || 'مدير المتجر',
    email: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    password: env.ADMIN_PASSWORD || '',
    whatsapp: env.ADMIN_WHATSAPP || '',
  },
};
