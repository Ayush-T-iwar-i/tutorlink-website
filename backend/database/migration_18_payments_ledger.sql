-- ============================================
-- TutorLink — Migration 18: payments ledger
--
-- `payments`        one row per payment attempt/settlement (online Razorpay order or an
--                   offline/cash payment the teacher recorded). bookings.payment_status stays
--                   as a denormalised summary for existing dashboards; this table is the source
--                   of truth for money.
-- `payment_events`  one row per processed Razorpay webhook event id, so a re-delivered webhook
--                   is recognised and ignored.
--
-- Status meanings
--   created         online order exists, not paid yet
--   paid            money received and booking marked paid
--   refund_pending  refund decided, not yet confirmed by Razorpay
--   refunded        money returned
--   void            an offline payment the teacher reversed
--   duplicate       a second capture for an already-settled/inactive booking — must be refunded
--
-- `active_booking_key` is non-NULL only while a payment is counting as "the" payment for a booking
-- (paid / refund_pending). Its UNIQUE index makes it impossible for two active payments to exist for
-- one booking, even under a race.
-- ============================================

CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NOT NULL,
  method ENUM('razorpay', 'offline') NOT NULL,
  status ENUM('created', 'paid', 'refund_pending', 'refunded', 'void', 'duplicate') NOT NULL DEFAULT 'created',
  amount_paise INT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  razorpay_order_id VARCHAR(100) NULL,
  razorpay_payment_id VARCHAR(100) NULL,
  razorpay_refund_id VARCHAR(100) NULL,
  failure_reason VARCHAR(255) NULL,
  paid_at TIMESTAMP NULL,
  refunded_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  active_booking_key INT GENERATED ALWAYS AS (IF(status IN ('paid', 'refund_pending'), booking_id, NULL)) VIRTUAL,
  UNIQUE KEY uniq_payments_order (razorpay_order_id),
  UNIQUE KEY uniq_payments_payment (razorpay_payment_id),
  UNIQUE KEY uniq_payments_refund (razorpay_refund_id),
  UNIQUE KEY uniq_payments_active_booking (active_booking_key),
  KEY idx_payments_booking (booking_id, status),
  CONSTRAINT fk_payments_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payment_events (
  event_id VARCHAR(100) PRIMARY KEY,
  event_type VARCHAR(60) NOT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backfill: money that was recorded on bookings before this table existed.
INSERT INTO payments (booking_id, method, status, amount_paise, razorpay_order_id, razorpay_payment_id, paid_at)
SELECT b.id,
       IF(b.razorpay_payment_id IS NOT NULL, 'razorpay', 'offline'),
       IF(b.payment_status = 'refunded', 'refunded', 'paid'),
       ROUND(b.fee * 100),
       b.razorpay_order_id,
       b.razorpay_payment_id,
       b.created_at
FROM bookings b
WHERE b.payment_status IN ('paid', 'refunded')
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id);

-- Backfill: online orders that were created but not paid yet (so a late payment can still be matched).
INSERT INTO payments (booking_id, method, status, amount_paise, razorpay_order_id)
SELECT b.id, 'razorpay', 'created', ROUND(b.fee * 100), b.razorpay_order_id
FROM bookings b
WHERE b.payment_status = 'unpaid'
  AND b.razorpay_order_id IS NOT NULL
  AND b.fee > 0
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id);