-- ============================================
-- TutorLink — Migration 2
-- Run this ONLY if you already created the database using the old
-- schema.sql (i.e. you've already run npm start successfully before).
-- Do NOT run schema.sql again — it will not touch existing tables.
-- ============================================

USE tutorlink;

-- ---------- Allow Google-only accounts (no phone / no password) ----------
ALTER TABLE users
  MODIFY COLUMN phone VARCHAR(15) UNIQUE NULL,
  MODIFY COLUMN password_hash VARCHAR(255) NULL,
  ADD COLUMN google_id VARCHAR(255) UNIQUE NULL AFTER password_hash;

-- ---------- Add professional profile fields to teachers ----------
ALTER TABLE teachers
  ADD COLUMN qualification VARCHAR(255) AFTER user_id,
  ADD COLUMN languages VARCHAR(255) AFTER fee_per_hour,
  ADD COLUMN address VARCHAR(255) AFTER bio,
  ADD COLUMN city VARCHAR(100) AFTER address;

-- ---------- Add city field to students ----------
ALTER TABLE students
  ADD COLUMN city VARCHAR(100) AFTER address;
