const crypto = require('crypto');
const p = require('../lib/payments');

describe('toPaise', () => {
  it.each([
    [350.5, 35050], ['350.50', 35050], [1, 100], ['0.01', 1], [1.005, 101], [499.99, 49999],
  ])('%p rupees -> %p paise', (r, paise) => expect(p.toPaise(r)).toBe(paise));
  it.each([0, -5, '-1', 'abc', null, undefined, NaN, Infinity, ''])('%p -> 0 (never a payable amount)', (v) => expect(p.toPaise(v)).toBe(0));
});

describe('checkout signature', () => {
  const secret = 'key_secret';
  it('accepts the genuine HMAC of order_id|payment_id', () => {
    const sig = crypto.createHmac('sha256', secret).update('order_1|pay_1').digest('hex');
    expect(p.verifyCheckoutSignature('order_1', 'pay_1', sig, secret)).toBe(true);
  });
  it('rejects tampering with any part, a wrong secret, and malformed input', () => {
    const sig = p.checkoutSignature('order_1', 'pay_1', secret);
    expect(p.verifyCheckoutSignature('order_2', 'pay_1', sig, secret)).toBe(false);
    expect(p.verifyCheckoutSignature('order_1', 'pay_2', sig, secret)).toBe(false);
    expect(p.verifyCheckoutSignature('order_1', 'pay_1', sig, 'other')).toBe(false);
    expect(p.verifyCheckoutSignature('order_1', 'pay_1', sig.slice(0, -1), secret)).toBe(false);
    expect(p.verifyCheckoutSignature('order_1', 'pay_1', undefined, secret)).toBe(false);
    expect(p.verifyCheckoutSignature('order_1', 'pay_1', 12345, secret)).toBe(false);
    expect(p.verifyCheckoutSignature('order_1', 'pay_1', sig, '')).toBe(false);
  });
});

describe('webhook signature', () => {
  const secret = 'whsec';
  const body = Buffer.from('{"event":"payment.captured"}');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  it('accepts the HMAC of the exact raw bytes', () => expect(p.verifyWebhookSignature(body, sig, secret)).toBe(true));
  it('rejects altered bodies, wrong secrets and missing parts', () => {
    expect(p.verifyWebhookSignature(Buffer.from('{"event":"payment.captured" }'), sig, secret)).toBe(false);
    expect(p.verifyWebhookSignature(body, sig, 'nope')).toBe(false);
    expect(p.verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(p.verifyWebhookSignature(body, sig, '')).toBe(false);
    expect(p.verifyWebhookSignature(undefined, sig, secret)).toBe(false);
  });
});

describe('refund window', () => {
  // 2026-10-02 10:00 UTC == 15:30 IST
  const now = new Date('2026-10-02T10:00:00Z');
  afterEach(() => { delete process.env.REFUND_WINDOW_HOURS; });

  it('defaults to 24 hours', () => expect(p.refundWindowHours()).toBe(24));
  it('is refundable when the class is more than 24h away, not when it is closer or already started', () => {
    expect(p.isWithinRefundWindow({ booking_date: '2026-10-04', booking_time: '5:00 PM' }, now)).toBe(true);
    expect(p.isWithinRefundWindow({ booking_date: '2026-10-03', booking_time: '3:00 PM' }, now)).toBe(false);
    expect(p.isWithinRefundWindow({ booking_date: '2026-10-02', booking_time: '5:00 PM' }, now)).toBe(false);
    expect(p.isWithinRefundWindow({ booking_date: '2026-10-01', booking_time: '5:00 PM' }, now)).toBe(false);
  });
  it('honours REFUND_WINDOW_HOURS, ignores garbage values, and treats undated bookings as refundable', () => {
    process.env.REFUND_WINDOW_HOURS = '2';
    expect(p.isWithinRefundWindow({ booking_date: '2026-10-02', booking_time: '9:00 PM' }, now)).toBe(true);
    process.env.REFUND_WINDOW_HOURS = 'abc';
    expect(p.refundWindowHours()).toBe(24);
    expect(p.isWithinRefundWindow({ booking_date: null, booking_time: null }, now)).toBe(true);
  });
});