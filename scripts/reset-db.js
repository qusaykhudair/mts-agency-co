'use strict';
// Deletes the local database and uploaded files so the next start seeds a fresh store.
// Usage: npm run reset-db -- --yes
const fs = require('fs');
const config = require('../src/config');

if (!process.argv.includes('--yes')) {
  console.log('This permanently deletes the database and all uploaded files:');
  console.log('  ' + config.dbFile);
  console.log('  ' + config.uploadDir);
  console.log('Run again with --yes to confirm:  npm run reset-db -- --yes');
  process.exit(1);
}

for (const file of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) fs.rmSync(file, { force: true });
fs.rmSync(config.uploadDir, { recursive: true, force: true });
console.log('Database and uploads removed. Start the server to create a fresh store.');
