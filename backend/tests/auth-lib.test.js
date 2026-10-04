const jwt = require('jsonwebtoken');
const tokens = require('../lib/session-tokens');
const passwords = require('../lib/passwords');

beforeEach(() => { process.env.JWT_SECRET = 'unit_test_secret_value_long_enough_123'; });

describe('access tokens', () => {
  it('round-trips id, role and sid, and expires in 15 minutes by default', () => {
    const t = tokens.signAccessToken({ id: 7, role: 'teacher', sid: 42 });
    const d = tokens.verifyAccessToken(t);
    expect(d).toMatchObject({ id: 7, role: 'teacher', sid: 42 });
    expect(d.exp - d.iat).toBe(900);
  });
  it('honours ACCESS_TOKEN_TTL_MIN and ignores nonsense values', () => {
    process.env.ACCESS_TOKEN_TTL_MIN = '5';
    expect(tokens.accessTtlMinutes()).toBe(5);
    process.env.ACCESS_TOKEN_TTL_MIN = '-3';
    expect(tokens.accessTtlMinutes()).toBe(15);
    delete process.env.ACCESS_TOKEN_TTL_MIN;
  });
  it('rejects wrong-secret tokens, alg:none tokens and expired tokens', () => {
    expect(() => tokens.verifyAccessToken(jwt.sign({ id: 1 }, 'another-secret-another-secret-123'))).toThrow();
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"id":1,"role":"admin","sid":1}').toString('base64url')}.`;
    expect(() => tokens.verifyAccessToken(none)).toThrow();
    const expired = jwt.sign({ id: 1, sid: 1 }, process.env.JWT_SECRET, { expiresIn: -5 });
    expect(() => tokens.verifyAccessToken(expired)).toThrow(/expired/i);
    expect(() => tokens.verifyAccessToken(expired, { ignoreExpiration: true })).not.toThrow();
  });
  it('refuses to sign when JWT_SECRET is missing', () => {
    delete process.env.JWT_SECRET;
    expect(() => tokens.signAccessToken({ id: 1, role: 'student', sid: 1 })).toThrow(/JWT_SECRET/);
  });
});

describe('refresh and email tokens', () => {
  it('refresh tokens are long, unique and URL-safe; only their hash is meant to be stored', () => {
    const a = tokens.generateRefreshToken();
    const b = tokens.generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.hashToken(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(tokens.hashToken(a)).not.toBe(a);
  });
  it('email tokens come as a raw/hash pair that match each other', () => {
    const { raw, hash } = tokens.generateEmailToken();
    expect(raw).toMatch(/^[a-f0-9]{64}$/);
    expect(tokens.hashToken(raw)).toBe(hash);
  });
});

describe('auth cookies', () => {
  const fakeRes = () => ({ calls: [], cookie(n, v, o) { this.calls.push(['set', n, v, o]); }, clearCookie(n, o) { this.calls.push(['clear', n, o]); } });
  afterEach(() => { process.env.NODE_ENV = 'test'; });

  it('are httpOnly, SameSite=Lax, and the refresh cookie is restricted to /api/auth', () => {
    const res = fakeRes();
    tokens.setAuthCookies(res, { accessToken: 'a', refreshToken: 'r' });
    const [access, refresh] = res.calls;
    expect(access[3]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect(refresh[3]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/auth' });
  });
  it('are Secure in production only', () => {
    process.env.NODE_ENV = 'production';
    const res = fakeRes();
    tokens.setAuthCookies(res, { accessToken: 'a', refreshToken: 'r' });
    expect(res.calls.every((c) => c[3].secure === true)).toBe(true);
    process.env.NODE_ENV = 'test';
    const dev = fakeRes();
    tokens.setAuthCookies(dev, { accessToken: 'a', refreshToken: 'r' });
    expect(dev.calls.every((c) => c[3].secure === false)).toBe(true);
  });
  it('set only the access cookie when no refresh token is given, and clear both with matching paths', () => {
    const res = fakeRes();
    tokens.setAuthCookies(res, { accessToken: 'a', refreshToken: null });
    expect(res.calls).toHaveLength(1);
    const out = fakeRes();
    tokens.clearAuthCookies(out);
    expect(out.calls.map((c) => [c[1], c[2].path])).toEqual([['token', '/'], ['refresh_token', '/api/auth']]);
  });
});

describe('password policy', () => {
  it.each(['Str0ng!Passw0rd', 'Tutor2026Link', 'xY7-plain-Long-enough'])('accepts %s', (pw) => expect(passwords.validatePassword(pw)).toBeNull());
  it.each([
    [undefined, /required/], [12345678, /required/], ['Ab1', /at least 8/], ['alllower123', /uppercase/],
    ['ALLUPPER123', /lowercase/], ['NoDigitsHere', /number/], ['Password1', /too common/], ['Welcome123', /too common/],
    [`A1${'a'.repeat(71)}`, /at most 72/],
  ])('rejects %p', (pw, message) => expect(passwords.validatePassword(pw)).toMatch(message));
  it('counts BYTES, so multi-byte characters cannot sneak past the 72-byte bcrypt limit', () => {
    expect(passwords.validatePassword(`Aa1${'é'.repeat(36)}`)).toMatch(/at most 72/);
  });
  it('uses the label in messages', () => {
    expect(passwords.validatePassword('x', 'New password')).toMatch(/^New password must/);
  });
});

describe('password hashing', () => {
  beforeEach(() => { process.env.BCRYPT_ROUNDS = '4'; });
  it('hashes (never stores plaintext) and verifies', async () => {
    const hash = await passwords.hashPassword('Str0ng!Passw0rd');
    expect(hash).toMatch(/^\$2[aby]\$04\$/);
    expect(await passwords.verifyPassword('Str0ng!Passw0rd', hash)).toBe(true);
    expect(await passwords.verifyPassword('Str0ng!Passw0rD', hash)).toBe(false);
  });
  it('"no such account" (null hash) and non-string input are always false, but still do the bcrypt work', async () => {
    expect(await passwords.verifyPassword('anything', null)).toBe(false);
    expect(await passwords.verifyPassword({ $ne: '' }, 'x')).toBe(false);
    expect(await passwords.verifyPassword(undefined, null)).toBe(false);
  });
  it('production cost is 12 unless overridden within 4-15', () => {
    delete process.env.BCRYPT_ROUNDS;
    return passwords.hashPassword('Str0ng!Passw0rd').then((h) => {
      expect(h).toMatch(/^\$2[aby]\$12\$/);
      process.env.BCRYPT_ROUNDS = '99';
    }).then(() => passwords.hashPassword('Str0ng!Passw0rd')).then((h) => expect(h).toMatch(/^\$2[aby]\$12\$/));
  });
});