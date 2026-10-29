const security = require('../config/security');

describe('security config', () => {
  describe('parseOrigins', () => {
    it('splits on commas, trims and drops trailing slashes and blanks', () => {
      expect(security.parseOrigins(' https://a.com/ , https://www.a.com,, ')).toEqual(['https://a.com', 'https://www.a.com']);
    });
    it('returns an empty list for empty input', () => {
      expect(security.parseOrigins('')).toEqual([]);
      expect(security.parseOrigins(undefined)).toEqual([]);
    });
  });

  describe('corsProblem', () => {
    it('refuses a missing or wildcard origin in production', () => {
      expect(security.corsProblem({ NODE_ENV: 'production' })).toMatch(/ALLOWED_ORIGIN/);
      expect(security.corsProblem({ NODE_ENV: 'production', ALLOWED_ORIGIN: '*' })).toMatch(/ALLOWED_ORIGIN/);
      expect(security.corsProblem({ NODE_ENV: 'production', ALLOWED_ORIGIN: 'https://a.com,*' })).toMatch(/ALLOWED_ORIGIN/);
    });
    it('accepts real origins in production, and anything outside production', () => {
      expect(security.corsProblem({ NODE_ENV: 'production', ALLOWED_ORIGIN: 'https://a.com' })).toBeNull();
      expect(security.corsProblem({ NODE_ENV: 'development' })).toBeNull();
    });
  });

  describe('buildCorsOptions', () => {
    const decide = (opts, origin) => {
      let allowed;
      opts.origin(origin, (err, value) => { allowed = value; });
      return allowed;
    };

    it('allows only the listed origins (several are supported)', () => {
      const opts = security.buildCorsOptions({ ALLOWED_ORIGIN: 'https://a.com, https://b.com/' });
      expect(opts.credentials).toBe(true);
      expect(decide(opts, 'https://a.com')).toBe(true);
      expect(decide(opts, 'https://b.com')).toBe(true);
      expect(decide(opts, 'https://evil.com')).toBe(false);
    });

    it('allows requests without an Origin header (same-origin, curl, webhooks)', () => {
      const opts = security.buildCorsOptions({ ALLOWED_ORIGIN: 'https://a.com' });
      expect(decide(opts, undefined)).toBe(true);
    });

    it('reflects the caller when no origin is configured (development only)', () => {
      expect(security.buildCorsOptions({}).origin).toBe(true);
    });
  });

  describe('parseTrustProxy', () => {
    it('defaults to 1 proxy (previous behaviour)', () => {
      expect(security.parseTrustProxy(undefined)).toBe(1);
      expect(security.parseTrustProxy('')).toBe(1);
    });
    it('accepts whole numbers including 0', () => {
      expect(security.parseTrustProxy('0')).toBe(0);
      expect(security.parseTrustProxy('2')).toBe(2);
    });
    it('refuses true/false and anything that is not a small whole number', () => {
      expect(() => security.parseTrustProxy('true')).toThrow(/NUMBER of proxies/);
      expect(() => security.parseTrustProxy('false')).toThrow(/NUMBER of proxies/);
      expect(() => security.parseTrustProxy('-1')).toThrow(/whole number/);
      expect(() => security.parseTrustProxy('1.5')).toThrow(/whole number/);
      expect(() => security.parseTrustProxy('11')).toThrow(/whole number/);
      expect(() => security.parseTrustProxy('loopback')).toThrow(/whole number/);
    });
  });

  describe('CSP', () => {
    it('defaults to report-only', () => {
      expect(security.parseCspMode(undefined)).toBe('report-only');
      expect(security.buildCsp('report-only').reportOnly).toBe(true);
    });
    it('enforces only when asked', () => {
      expect(security.parseCspMode('ENFORCE')).toBe('enforce');
      expect(security.buildCsp('enforce').reportOnly).toBe(false);
    });
    it('can be switched off', () => {
      expect(security.buildCsp('off')).toBe(false);
    });
    it('rejects unknown modes', () => {
      expect(() => security.parseCspMode('maybe')).toThrow(/CSP_MODE/);
    });
    it('forbids plugins, base-tag hijacking, foreign form posts and framing of the site', () => {
      const d = security.buildCsp('enforce').directives;
      expect(d.objectSrc).toEqual(["'none'"]);
      expect(d.baseUri).toEqual(["'self'"]);
      expect(d.formAction).toEqual(["'self'"]);
      expect(d.frameAncestors).toEqual(["'self'"]);
    });
    it('allows exactly the outside origins the frontend uses for scripts', () => {
      const scripts = security.buildCsp('enforce').directives.scriptSrc;
      for (const origin of ['https://unpkg.com', 'https://cdn.jsdelivr.net', 'https://checkout.razorpay.com', 'https://accounts.google.com']) {
        expect(scripts).toContain(origin);
      }
      expect(scripts).not.toContain('*');
    });
    it('does not add upgrade-insecure-requests (it would break plain-http localhost)', () => {
      expect(security.buildCsp('enforce').useDefaults).toBe(false);
      expect(Object.keys(security.buildCsp('enforce').directives)).not.toContain('upgradeInsecureRequests');
    });
  });

  describe('permissionsPolicy', () => {
    it('sets the header and calls next', () => {
      const headers = {};
      let called = false;
      security.permissionsPolicy({}, { setHeader: (k, v) => { headers[k] = v; } }, () => { called = true; });
      expect(called).toBe(true);
      expect(headers['Permissions-Policy']).toContain('geolocation=(self)');
      expect(headers['Permissions-Policy']).toContain('camera=()');
    });
  });
});