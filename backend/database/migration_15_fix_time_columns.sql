

USE tutorlink;

ALTER TABLE bookings
  MODIFY COLUMN booking_time VARCHAR(20) NULL;

ALTER TABLE class_sessions
  MODIFY COLUMN session_time VARCHAR(20) NULL;