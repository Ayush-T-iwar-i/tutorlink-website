-- ============================================
-- TutorLink — Migration 5
-- In-app chat between student and teacher, scoped to a booking
-- (keeps conversations organized per class, not one giant global inbox).
-- ============================================

USE tutorlink;

CREATE TABLE IF NOT EXISTS messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NOT NULL,
  sender_id INT NOT NULL,        -- users.id of whoever sent it
  message VARCHAR(1000) NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_booking ON messages (booking_id, created_at);