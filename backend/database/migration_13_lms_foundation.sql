-- ==========================================================
-- TutorLink — Migration 13: LMS Foundation
-- Adds enrollments, courses, course_modules tables
-- Adds LMS columns to class_sessions
-- ADDITIVE ONLY — no existing tables are modified destructively
-- ==========================================================

USE tutorlink;

-- ---------- ENROLLMENTS (the "active tuition" relationship) ----------
CREATE TABLE IF NOT EXISTS enrollments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL,
  teacher_id INT NOT NULL,
  booking_id INT NULL,                           -- the booking that created this enrollment (nullable for manual creation)
  subject VARCHAR(255) NULL,
  status ENUM('active','paused','completed','cancelled') NOT NULL DEFAULT 'active',
  start_date DATE NULL,
  end_date DATE NULL,
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL,
  INDEX idx_enrollments_student (student_id),
  INDEX idx_enrollments_teacher (teacher_id),
  INDEX idx_enrollments_status (status),
  INDEX idx_enrollments_booking (booking_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- COURSES (academic course tied to an enrollment) ----------
CREATE TABLE IF NOT EXISTS courses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  enrollment_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  subject VARCHAR(255) NULL,
  status ENUM('active','paused','completed') NOT NULL DEFAULT 'active',
  start_date DATE NULL,
  end_date DATE NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE CASCADE,
  INDEX idx_courses_enrollment (enrollment_id),
  INDEX idx_courses_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- COURSE MODULES (chapters/units within a course) ----------
CREATE TABLE IF NOT EXISTS course_modules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  course_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  status ENUM('active','completed') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
  INDEX idx_modules_course (course_id),
  INDEX idx_modules_sort (course_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- ADD LMS COLUMNS TO CLASS_SESSIONS ----------
-- These are additive — existing rows keep working as before.
-- We use ALTER IGNORE + IF NOT EXISTS pattern for safe re-runs.

-- Add enrollment_id to class_sessions (nullable for backward compat)
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'tutorlink' AND TABLE_NAME = 'class_sessions' AND COLUMN_NAME = 'enrollment_id');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE class_sessions ADD COLUMN enrollment_id INT NULL AFTER booking_id, ADD INDEX idx_sessions_enrollment (enrollment_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add course_id to class_sessions
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'tutorlink' AND TABLE_NAME = 'class_sessions' AND COLUMN_NAME = 'course_id');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE class_sessions ADD COLUMN course_id INT NULL AFTER enrollment_id',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add topic to class_sessions
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'tutorlink' AND TABLE_NAME = 'class_sessions' AND COLUMN_NAME = 'topic');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE class_sessions ADD COLUMN topic VARCHAR(255) NULL AFTER session_time',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add location to class_sessions
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'tutorlink' AND TABLE_NAME = 'class_sessions' AND COLUMN_NAME = 'location');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE class_sessions ADD COLUMN location VARCHAR(255) NULL AFTER topic',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add notes to class_sessions
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'tutorlink' AND TABLE_NAME = 'class_sessions' AND COLUMN_NAME = 'notes');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE class_sessions ADD COLUMN notes TEXT NULL AFTER location',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add start_time (proper TIME) to class_sessions
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'tutorlink' AND TABLE_NAME = 'class_sessions' AND COLUMN_NAME = 'start_time');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE class_sessions ADD COLUMN start_time TIME NULL AFTER session_time',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add end_time (proper TIME) to class_sessions
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'tutorlink' AND TABLE_NAME = 'class_sessions' AND COLUMN_NAME = 'end_time');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE class_sessions ADD COLUMN end_time TIME NULL AFTER start_time',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
