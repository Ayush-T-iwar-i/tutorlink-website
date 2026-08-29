-- ==========================================================
-- TutorLink Website - Consolidated Database Schema (MySQL)
-- Run this once to create the database and all tables (fresh install).
-- Contains all core tables, relationships, and feature migrations (1-12).
-- ==========================================================

CREATE DATABASE IF NOT EXISTS tutorlink CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE tutorlink;

-- ---------- USERS (base table for students, teachers, admin) ----------
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  phone VARCHAR(15) UNIQUE NULL,                -- nullable: Google sign-in does not provide a phone number
  password_hash VARCHAR(255) NULL,              -- nullable: Google-only accounts have no password
  google_id VARCHAR(255) UNIQUE NULL,           -- Google account identifier, if signed up/in via Google
  role ENUM('student', 'teacher', 'admin') NOT NULL,
  profile_photo VARCHAR(255) NULL,
  reset_token VARCHAR(255) NULL,
  reset_token_expires TIMESTAMP NULL,
  failed_login_attempts INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_email (email),
  INDEX idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- TEACHERS (extra profile info for role = teacher) ----------
CREATE TABLE IF NOT EXISTS teachers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  qualification VARCHAR(255) NULL,              -- e.g. "B.Sc Mathematics, B.Ed"
  subjects VARCHAR(255) NOT NULL DEFAULT '',    -- e.g. "Maths, Physics"
  grades VARCHAR(100) NULL,                     -- e.g. "Class 6-10"
  experience_years INT DEFAULT 0,
  fee_per_hour DECIMAL(10,2) DEFAULT 0,
  languages VARCHAR(255) NULL,                  -- e.g. "English, Hindi"
  bio TEXT NULL,
  available_slots VARCHAR(255) NULL,            -- e.g. "9:00 AM,11:00 AM,3:00 PM"
  address VARCHAR(255) NULL,                    -- human-readable area/locality, e.g. "Sector 14, Gurugram"
  city VARCHAR(100) NULL,
  latitude DECIMAL(10,7) NULL,                  -- live/stored location (used for radius matching)
  longitude DECIMAL(10,7) NULL,
  travel_radius_km DECIMAL(4,1) DEFAULT 5.0,
  verification_status ENUM('pending','under_review','approved','rejected') DEFAULT 'pending',
  id_proof_path VARCHAR(255) NULL,
  address_proof_path VARCHAR(255) NULL,
  certificate_path VARCHAR(255) NULL,
  rating_avg DECIMAL(3,2) DEFAULT 0.00,
  total_reviews INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_teachers_user (user_id),
  INDEX idx_teachers_verification (verification_status),
  INDEX idx_teachers_location (latitude, longitude),
  INDEX idx_teachers_rating (rating_avg, total_reviews)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- STUDENTS (extra profile info for role = student) ----------
CREATE TABLE IF NOT EXISTS students (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  address VARCHAR(255) NULL,
  area VARCHAR(150) NULL,
  district VARCHAR(150) NULL,
  pincode VARCHAR(10) NULL,
  city VARCHAR(100) NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  preferred_subjects VARCHAR(255) NULL,
  preferred_grade VARCHAR(50) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_students_user (user_id),
  INDEX idx_students_city (city)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- BOOKINGS (demo classes + recurring appointments) ----------
CREATE TABLE IF NOT EXISTS bookings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL,
  teacher_id INT NOT NULL,
  type ENUM('demo', 'recurring') NOT NULL DEFAULT 'demo',
  subject VARCHAR(100) NULL,
  booking_date DATE NULL,
  booking_time VARCHAR(20) NULL,
  days_per_week VARCHAR(100) NULL,              -- e.g. "Mon,Wed,Fri" for recurring
  status ENUM('requested','accepted','declined','completed','cancelled') DEFAULT 'requested',
  fee DECIMAL(10,2) DEFAULT 0.00,
  payment_status ENUM('unpaid','paid','refunded') DEFAULT 'unpaid',
  razorpay_order_id VARCHAR(100) NULL,
  razorpay_payment_id VARCHAR(100) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
  INDEX idx_bookings_student (student_id),
  INDEX idx_bookings_teacher (teacher_id),
  INDEX idx_bookings_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- CLASS SESSIONS (scheduled session dates for bookings) ----------
CREATE TABLE IF NOT EXISTS class_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NOT NULL,
  session_date DATE NOT NULL,
  session_time VARCHAR(20) NULL,
  status ENUM('scheduled','completed','missed','cancelled') NOT NULL DEFAULT 'scheduled',
  reminder_sent TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
  INDEX idx_sessions_date (session_date, status, reminder_sent),
  INDEX idx_sessions_booking (booking_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- REVIEWS ----------
CREATE TABLE IF NOT EXISTS reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NOT NULL,
  rating INT CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NULL,
  teacher_reply TEXT NULL,
  teacher_reply_at TIMESTAMP NULL,
  edited_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
  INDEX idx_reviews_booking (booking_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- NOTIFICATIONS ----------
CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  message VARCHAR(255) NOT NULL,
  link VARCHAR(255) NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_notifications_user_unread (user_id, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- MESSAGES (in-app chat per booking) ----------
CREATE TABLE IF NOT EXISTS messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NOT NULL,
  sender_id INT NOT NULL,
  message VARCHAR(1000) NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_messages_booking (booking_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- FAVORITES (saved teachers for students) ----------
CREATE TABLE IF NOT EXISTS favorites (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL,
  teacher_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_student_teacher (student_id, teacher_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- REPORTS (moderation complaints) ----------
CREATE TABLE IF NOT EXISTS reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reporter_user_id INT NOT NULL,
  reported_user_id INT NOT NULL,
  booking_id INT NULL,
  reason VARCHAR(100) NOT NULL,
  details TEXT NULL,
  status ENUM('open','reviewed','resolved') NOT NULL DEFAULT 'open',
  admin_notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL,
  INDEX idx_reports_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;