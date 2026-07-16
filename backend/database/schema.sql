-- ============================================
-- TutorLink Website - Database Schema (MySQL)
-- Run this once to create the database and all tables (fresh install)
-- If you already ran an older version of this file, run
-- migration_2_add_profile_and_google.sql instead, NOT this file.
-- ============================================

CREATE DATABASE IF NOT EXISTS tutorlink;
USE tutorlink;

-- ---------- USERS (base table for students, teachers, admin) ----------
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  phone VARCHAR(15) UNIQUE,                -- nullable: Google sign-in does not provide a phone number
  password_hash VARCHAR(255),              -- nullable: Google-only accounts have no password
  google_id VARCHAR(255) UNIQUE,           -- Google account identifier, if signed up/in via Google
  role ENUM('student', 'teacher', 'admin') NOT NULL,
  profile_photo VARCHAR(255),
  reset_token VARCHAR(255) NULL,
  reset_token_expires TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- TEACHERS (extra profile info for role = teacher) ----------
CREATE TABLE IF NOT EXISTS teachers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  qualification VARCHAR(255),              -- e.g. "B.Sc Mathematics, B.Ed"
  subjects VARCHAR(255) NOT NULL DEFAULT '',  -- e.g. "Maths, Physics"
  grades VARCHAR(100),                     -- e.g. "Class 6-10"
  experience_years INT DEFAULT 0,
  fee_per_hour DECIMAL(10,2) DEFAULT 0,
  languages VARCHAR(255),                  -- e.g. "English, Hindi"
  bio TEXT,
  address VARCHAR(255),                    -- human-readable area/locality, e.g. "Sector 14, Gurugram"
  city VARCHAR(100),
  latitude DECIMAL(10,7),                  -- current/live location (used for radius matching)
  longitude DECIMAL(10,7),
  travel_radius_km DECIMAL(4,1) DEFAULT 5,
  verification_status ENUM('pending','under_review','approved','rejected') DEFAULT 'pending',
  id_proof_path VARCHAR(255),
  address_proof_path VARCHAR(255),
  certificate_path VARCHAR(255),
  rating_avg DECIMAL(3,2) DEFAULT 0,
  total_reviews INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ---------- STUDENTS (extra profile info for role = student) ----------
CREATE TABLE IF NOT EXISTS students (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  address VARCHAR(255),
  area VARCHAR(150),
  district VARCHAR(150),
  pincode VARCHAR(10),
  city VARCHAR(100),
  latitude DECIMAL(10,7),
  longitude DECIMAL(10,7),
  preferred_subjects VARCHAR(255),
  preferred_grade VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ---------- BOOKINGS (demo classes + recurring appointments) ----------
CREATE TABLE IF NOT EXISTS bookings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL,
  teacher_id INT NOT NULL,
  type ENUM('demo', 'recurring') NOT NULL DEFAULT 'demo',
  subject VARCHAR(100),
  booking_date DATE,
  booking_time TIME,
  days_per_week VARCHAR(100),              -- e.g. "Mon,Wed,Fri" for recurring
  status ENUM('requested','accepted','declined','completed','cancelled') DEFAULT 'requested',
  fee DECIMAL(10,2) DEFAULT 0,
  payment_status ENUM('unpaid','paid','refunded') DEFAULT 'unpaid',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

-- ---------- REVIEWS ----------
CREATE TABLE IF NOT EXISTS reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NOT NULL,
  rating INT CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);