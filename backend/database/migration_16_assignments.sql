-- ============================================
-- TutorLink — Migration 16
-- Completes the LMS: assignments (set by a teacher, tied to a course and
-- optionally a specific module) and student submissions against them.
-- ADDITIVE ONLY — no existing tables are modified.
-- ============================================

USE tutorlink;

CREATE TABLE IF NOT EXISTS assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  course_id INT NOT NULL,
  module_id INT NULL,                 -- optional: which module/lesson this belongs to
  title VARCHAR(255) NOT NULL,
  instructions TEXT NULL,
  resource_path VARCHAR(500) NULL,    -- teacher-attached reference file, if any
  due_date DATE NULL,
  status ENUM('draft','published') NOT NULL DEFAULT 'published',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
  FOREIGN KEY (module_id) REFERENCES course_modules(id) ON DELETE SET NULL,
  INDEX idx_assignments_course (course_id),
  INDEX idx_assignments_module (module_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assignment_submissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  assignment_id INT NOT NULL,
  student_id INT NOT NULL,
  submission_text TEXT NULL,
  file_path VARCHAR(500) NULL,
  status ENUM('submitted','reviewed') NOT NULL DEFAULT 'submitted',
  feedback TEXT NULL,
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP NULL,
  -- A student can resubmit (updates this same row) but never has two rows
  -- for one assignment — keeps "did they submit yet" a simple existence check.
  UNIQUE KEY uniq_submission (assignment_id, student_id),
  FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  INDEX idx_submissions_assignment (assignment_id),
  INDEX idx_submissions_student (student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;