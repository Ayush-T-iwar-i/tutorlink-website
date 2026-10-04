// Runs before every UNIT test file.
//
// Unit tests mock the database, so they cannot exercise the real session table. Session behaviour
// (revocation, rotation, reuse detection, ...) is tested against MySQL in tests/integration/auth.integration.test.js.
// Here the session layer is replaced by a stand-in that simply trusts a correctly signed token, which lets
// route-level unit tests keep minting tokens with jwt.sign({ id, role }).
// Plain functions (not jest.fn) on purpose: jest.resetAllMocks() in a test file must not wipe them.
process.env.BCRYPT_ROUNDS = '4';

jest.mock('../lib/sessions', () => ({
  authenticateAccessToken: async (_db, decoded) => (decoded && decoded.id ? { id: decoded.id, role: decoded.role, email_verified: 1 } : null),
  issueSession: async () => ({ accessToken: 'test.access.token', refreshToken: 'test-refresh-token-value', sessionId: 1 }),
  rotateSession: async () => ({ status: 'invalid' }),
  revokeSession: async () => 0,
  revokeAllUserSessions: async () => 0,
  findSessionIdByRefreshToken: async () => null,
  cleanupExpired: async () => ({ sessions: 0, loginFailures: 0, paymentEvents: 0 }),
}));