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
// Railway injects these into every deployment; use them as defaults so the app works without extra setup.
const onRailway = Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);
const volume = env.RAILWAY_VOLUME_MOUNT_PATH || '';
const isProd = env.NODE_ENV === 'production' || (onRailway && !env.NODE_ENV);
// The database and uploads must live on the persistent volume, otherwise every redeploy wipes them.
const dataDir = path.resolve(ROOT, env.DATA_DIR || volume || 'data');
const uploadDir = path.resolve(ROOT, env.UPLOAD_DIR || (volume ? path.join(volume, 'uploads') : 'uploads'));
const publicDomain = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '';

module.exports = {
  root: ROOT,
  isProd,
  onRailway,
  // Running on Railway without a volume: data disappears on the next deploy.
  ephemeralStorage: onRailway && !volume,
  port: Number(env.PORT) || 3000,
  appUrl: (env.APP_URL || publicDomain).replace(/\/+$/, ''),
  dataDir,
  dbFile: env.DB_FILE ? path.resolve(ROOT, env.DB_FILE) : path.join(dataDir, 'store.db'),
  uploadDir,
  // Number of reverse proxies in front of the app (Nginx, Render, Railway…), 0 when exposed directly.
  trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) : isProd || onRailway ? 1 : 0,
  sessionDays: Number(env.SESSION_DAYS) || 30,
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  rateLimitOff: env.RATE_LIMIT === 'off',
  seedDemo: env.SEED_DEMO !== 'false',
  admin: {
    name: env.ADMIN_NAME || 'مدير المتجر',
    email: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    password: env.ADMIN_PASSWORD || '',
    // One-off recovery on hosts without shell access: sets this password on boot (remove it afterwards).
    resetPassword: env.ADMIN_RESET_PASSWORD || '',
    whatsapp: env.ADMIN_WHATSAPP || '',
  },
};
