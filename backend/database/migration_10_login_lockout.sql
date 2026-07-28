-- ============================================
-- TutorLink — Migration 10
-- Tracks failed login attempts so an account can be temporarily
-- locked after too many wrong passwords in a row (brute-force protection).
-- ============================================

USE tutorlink;

ALTER TABLE users
  ADD COLUMN failed_login_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN locked_until TIMESTAMP NULL;