-- ============================================
-- TutorLink — Migration 14
-- Email verification: a signup link the user must click before their
-- account is marked verified. Login still works either way (we don't
-- lock unverified users out), but the frontend can show a reminder banner.
-- ============================================

USE tutorlink;

ALTER TABLE users
  ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN email_verify_token VARCHAR(255) NULL,
  ADD COLUMN email_verify_expires TIMESTAMP NULL;