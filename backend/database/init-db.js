// Kept for backward compatibility with `npm run db:init`.
// The real work (schema + tracked migrations) lives in migrate.js.
const { runMigrations } = require('./migrate');

if (require.main === module) {
  require('dotenv').config();
  runMigrations().catch((err) => {
    console.error('\n❌ Database initialization error:', err.message);
    process.exit(1);
  });
}

module.exports = runMigrations;