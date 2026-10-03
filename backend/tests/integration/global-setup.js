// Builds a fresh test database by running the real schema + migrations once per run.
// Refuses to touch any database whose name does not end in "_test".
module.exports = async () => {
  require('./setup-env');
  const { runMigrations } = require('../../database/migrate');
  await runMigrations({ dbName: process.env.DB_NAME, drop: true, logger: { log() {} } });
};