-- ============================================
-- TutorLink — Migration 11
-- Turns an accepted booking into concrete, dated class sessions.
-- A demo booking gets exactly one session; a recurring booking gets
-- one session per matching weekday for the next 8 weeks. This is what
-- powers the schedule view and automated class reminders.
-- ============================================

USE tutorlink;

CREATE TABLE IF NOT EXISTS class_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NOT NULL,
  session_date DATE NOT NULL,
  session_time VARCHAR(20),          -- text, e.g. "5:00 PM" (matches booking_time format)
  status ENUM('scheduled','completed','missed','cancelled') NOT NULL DEFAULT 'scheduled',
  reminder_sent TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_date ON class_sessions (session_date, status, reminder_sent);