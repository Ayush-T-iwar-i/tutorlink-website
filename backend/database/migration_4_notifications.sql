-- ============================================
-- TutorLink — Migration 4
-- Adds in-app notifications (bookings, status changes, reviews).
-- ============================================

USE tutorlink;

CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  message VARCHAR(255) NOT NULL,
  link VARCHAR(255),               -- e.g. 'student-dashboard.html' — where clicking it should go
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_notifications_user_unread ON notifications (user_id, is_read);