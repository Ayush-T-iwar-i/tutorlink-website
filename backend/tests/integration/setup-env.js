// Runs in every integration test worker BEFORE any app module is loaded, so
// config/db.js connects to the throw-away test database — never a real one.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration_test_secret_at_least_32_chars';
process.env.DB_HOST = process.env.TEST_DB_HOST || process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.TEST_DB_PORT || process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.TEST_DB_USER || process.env.DB_USER || 'root';
process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || process.env.DB_PASSWORD || '';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'tutorlink_test';
// Email/SMS providers log full message bodies when unconfigured — hide that noise in tests.
// console.error / console.warn stay visible so real failures are not hidden.
console.log = () => {};