-- ============================================
-- TutorLink — Migration 7
-- Adds Razorpay order/payment tracking to bookings.
-- ============================================

USE tutorlink;

ALTER TABLE bookings
  ADD COLUMN razorpay_order_id VARCHAR(100) NULL,
  ADD COLUMN razorpay_payment_id VARCHAR(100) NULL;