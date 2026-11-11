-- ============================================
-- TutorLink — Migration 22: teacher student-management tools
--
-- class_sessions.attendance   what the teacher recorded for a class
--                             (present / late / absent / excused). NULL = not recorded yet.
-- fee_records                 one row per enrollment per month: what the student owes, whether it was
--                             paid, when, and how. Offline fees (cash / UPI / bank) are recorded here by
--                             the teacher; online Razorpay payments stay in the `payments` ledger.
-- student_tests               tests / exams a teacher gave an enrolled student, with marks.
-- student_notes               private teacher notes about an enrolled student (never shown to the student).
-- ============================================

ALTER TABLE class_sessions
  ADD COLUMN attendance ENUM('present','late','absent','excused') NULL AFTER status;

CREATE TABLE IF NOT EXISTS fee_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  enrollment_id INT NOT NULL,
  period_month CHAR(7) NOT NULL,                  -- 'YYYY-MM'
  amount DECIMAL(10,2) NOT NULL,
  status ENUM('due','paid') NOT NULL DEFAULT 'due',
  paid_on DATE NULL,
  method ENUM('cash','upi','bank','online','other') NULL,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_fee_month (enrollment_id, period_month),
  FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_tests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  enrollment_id INT NOT NULL,
  title VARCHAR(150) NOT NULL,
  test_date DATE NOT NULL,
  max_marks DECIMAL(6,2) NOT NULL,
  marks_obtained DECIMAL(6,2) NULL,               -- NULL = test given, not marked yet
  remarks VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tests_enrollment (enrollment_id, test_date),
  FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_notes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  enrollment_id INT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notes_enrollment (enrollment_id, created_at),
  FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;