-- ============================================
-- TutorLink — Migration 12
-- Teachers can publicly reply to a review; students can edit their own
-- review within 24 hours of posting it.
-- ============================================

USE tutorlink;

ALTER TABLE reviews
  ADD COLUMN teacher_reply TEXT NULL,
  ADD COLUMN teacher_reply_at TIMESTAMP NULL,
  ADD COLUMN edited_at TIMESTAMP NULL;