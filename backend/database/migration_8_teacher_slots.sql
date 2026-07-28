-- ============================================
-- TutorLink — Migration 8
-- Teachers can now set which time slots they're available in,
-- instead of students seeing one hardcoded list for everyone.
-- ============================================

USE tutorlink;

ALTER TABLE teachers
  ADD COLUMN available_slots VARCHAR(255) NULL;
  -- comma-separated, e.g. "9:00 AM,11:00 AM,3:00 PM,5:00 PM"