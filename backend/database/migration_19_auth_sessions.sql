-- ============================================
-- TutorLink — Migration 19: server-side sessions, login throttling, hashed one-time tokens
--
-- sessions        one row per login (device). The access JWT carries this row's id (`sid`); the row can be
--                 revoked at any moment (logout, password change, admin action, theft detected).
--                 `refresh_hash` is the SHA-256 of the current refresh token; `prev_refresh_hash` is the one
--                 it replaced, kept briefly so two browser tabs refreshing at once do not look like theft.
-- login_failures  failed-login counters per (email, IP). The email is stored only as a SHA-256 hash, and
--                 unknown emails are tracked exactly like real ones, so lockouts reveal nothing.
--
-- Password-reset and email-verification tokens are now stored hashed. Any link emailed before this
-- migration was stored in plain text, so those tokens are cleared: affected users simply request a new link.
-- ============================================

CREATE TABLE IF NOT EXISTS sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  refresh_hash CHAR(64) NOT NULL,
  prev_refresh_hash CHAR(64) NULL,
  rotated_at DATETIME NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  revoked_reason VARCHAR(30) NULL,
  user_agent VARCHAR(255) NULL,
  ip VARCHAR(45) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME NULL,
  UNIQUE KEY uniq_sessions_refresh (refresh_hash),
  KEY idx_sessions_prev_refresh (prev_refresh_hash),
  KEY idx_sessions_user (user_id, revoked_at),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS login_failures (
  email_hash CHAR(64) NOT NULL,
  ip VARCHAR(45) NOT NULL,
  failures INT NOT NULL DEFAULT 0,
  window_started_at DATETIME NOT NULL,
  locked_until DATETIME NULL,
  PRIMARY KEY (email_hash, ip),
  KEY idx_login_failures_window (window_started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

UPDATE users
SET reset_token = NULL, reset_token_expires = NULL,
    email_verify_token = NULL, email_verify_expires = NULL;