-- ============================================
-- GharTutor — Migration 25: monthly plans after a demo class
-- duration_months : length of a recurring plan (1, 2, 3, 4 or 6 months; 4 weeks per month).
--                   NULL keeps the old behaviour (8 weeks).
-- continued_from  : the earlier booking (a demo or the previous plan) this one continues.
-- demo_decision   : what the student chose after a demo class: 'continue' or 'declined'.
-- ============================================

ALTER TABLE bookings
  ADD COLUMN duration_months TINYINT NULL AFTER days_per_week,
  ADD COLUMN continued_from INT NULL,
  ADD COLUMN demo_decision ENUM('continue', 'declined') NULL;

ALTER TABLE bookings ADD CONSTRAINT chk_bookings_duration CHECK (duration_months IS NULL OR duration_months BETWEEN 1 AND 6);