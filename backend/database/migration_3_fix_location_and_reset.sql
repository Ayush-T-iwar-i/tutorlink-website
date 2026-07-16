-- ============================================
-- TutorLink — Migration 3
-- Fixes two real bugs:
--   1. students table was missing area/district/pincode
--      columns that student.routes.js already tries to write to.
--   2. There was no way to store a password-reset token.
-- Safe to run once against an existing database.
-- ============================================

USE tutorlink;

ALTER TABLE students
  ADD COLUMN area VARCHAR(150) AFTER address,
  ADD COLUMN district VARCHAR(150) AFTER area,
  ADD COLUMN pincode VARCHAR(10) AFTER district;

ALTER TABLE users
  ADD COLUMN reset_token VARCHAR(255) NULL,
  ADD COLUMN reset_token_expires TIMESTAMP NULL;