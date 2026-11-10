-- ============================================
-- TutorLink — Migration 20: one review per booking
--
-- The API checked "already reviewed?" before inserting, but two submits racing past that check
-- could both insert. A UNIQUE key makes the database refuse the second one.
-- Existing duplicates (if any) are removed first, keeping the earliest review per booking,
-- and teacher rating aggregates are recalculated afterwards.
-- ============================================

DELETE r1 FROM reviews r1
  JOIN reviews r2 ON r1.booking_id = r2.booking_id AND r1.id > r2.id;

ALTER TABLE reviews ADD UNIQUE KEY uniq_reviews_booking (booking_id);

UPDATE teachers t
SET
  rating_avg = COALESCE((SELECT AVG(r.rating) FROM reviews r JOIN bookings b ON b.id = r.booking_id WHERE b.teacher_id = t.id), 0),
  total_reviews = (SELECT COUNT(*) FROM reviews r JOIN bookings b ON b.id = r.booking_id WHERE b.teacher_id = t.id);
