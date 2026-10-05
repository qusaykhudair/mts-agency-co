'use strict';
// MTS Agency website + MTS Store (digital subscriptions).
const config = require('./src/config');
const { migrate } = require('./src/db');
const { seed } = require('./src/seed');
const settings = require('./src/lib/settings');
const money = require('./src/lib/money');
const { purgeExpiredSessions } = require('./src/lib/auth');
const orders = require('./src/lib/orders');
const services = require('./src/lib/services');
const { createApp } = require('./src/app');

async function main() {
  migrate();
  settings.load();
  await seed();
  settings.load();
  money.load();

  const housekeeping = () => {
    try {
      purgeExpiredSessions();
      const n = orders.autoComplete();
      if (n) console.log(`[jobs] auto-completed ${n} delivered order(s)`);
      const s = services.autoComplete();
      if (s) console.log(`[jobs] auto-completed ${s} delivered service request(s)`);
    } catch (err) {
      console.error('[jobs] housekeeping failed', err);
    }
  };
  housekeeping();
  setInterval(housekeeping, 60 * 60 * 1000).unref();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`MTS Store is running on http://localhost:${config.port}  (store: /store, seller dashboard: /seller)`);
    if (config.onRailway) console.log(`[storage] database: ${config.dbFile}  uploads: ${config.uploadDir}`);
    if (config.ephemeralStorage) {
      console.warn('[storage] WARNING: no Railway volume is attached — orders, accounts and receipts will be lost on the next deploy. Add a volume to this service.');
    }
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
