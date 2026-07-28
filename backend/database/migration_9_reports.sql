-- ============================================
-- TutorLink — Migration 9
-- Students/teachers can report a problem with a booking or the
-- other person; admins review and resolve.
-- ============================================

USE tutorlink;

CREATE TABLE IF NOT EXISTS reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reporter_user_id INT NOT NULL,
  reported_user_id INT NOT NULL,
  booking_id INT NULL,
  reason VARCHAR(100) NOT NULL,
  details TEXT,
  status ENUM('open','reviewed','resolved') NOT NULL DEFAULT 'open',
  admin_notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL
);