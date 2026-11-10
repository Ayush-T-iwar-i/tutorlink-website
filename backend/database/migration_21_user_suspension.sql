-- ============================================
-- TutorLink — Migration 21: admin account suspension
--
-- suspended_at  NULL = active; set = the account cannot log in and every existing session stops
--               working immediately (sessions are checked against users on each request).
-- suspended_reason  short note shown to admins (never to other users).
-- ============================================

ALTER TABLE users
  ADD COLUMN suspended_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN suspended_reason VARCHAR(255) NULL DEFAULT NULL;

CREATE INDEX idx_users_role_created ON users (role, created_at);
