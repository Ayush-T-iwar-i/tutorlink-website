-- ============================================
-- TutorLink — Migration 17: booking integrity
--
-- 1. slot_key: a generated column that is non-NULL only for ACTIVE bookings
--    (requested / accepted) that have a date and time. A UNIQUE index on it means the
--    database itself refuses two active bookings for the same teacher + date + time,
--    even if two requests race past the application-level checks.
-- 2. A CHECK constraint so a fee can never be negative.
-- 3. Index to make the per-teacher conflict lookup fast.
-- 4. class_sessions uniqueness so generating sessions twice cannot duplicate rows.
--
-- NOTE: if an existing database already contains two active bookings for the same
-- teacher/date/time, the UNIQUE index cannot be created. Resolve those rows first
-- (decline or cancel one of them), then re-run `npm run db:migrate`.
-- ============================================

ALTER TABLE bookings
  ADD COLUMN slot_key VARCHAR(80)
    GENERATED ALWAYS AS (
      IF(status IN ('requested', 'accepted') AND booking_date IS NOT NULL AND booking_time IS NOT NULL,
         CONCAT(teacher_id, '|', booking_date, '|', booking_time),
         NULL)
    ) VIRTUAL;

ALTER TABLE bookings ADD UNIQUE KEY uniq_bookings_active_slot (slot_key);

ALTER TABLE bookings ADD CONSTRAINT chk_bookings_fee_nonneg CHECK (fee >= 0);

CREATE INDEX idx_bookings_teacher_date ON bookings (teacher_id, booking_date, status);
CREATE INDEX idx_bookings_student_date ON bookings (student_id, booking_date, status);

ALTER TABLE class_sessions
  ADD UNIQUE KEY uniq_session_slot (booking_id, session_date, session_time);