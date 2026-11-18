

CREATE TABLE IF NOT EXISTS uploaded_files (
  path VARCHAR(255) NOT NULL PRIMARY KEY,   -- same value stored in users.profile_photo / teachers.*_path
  mime VARCHAR(50) NOT NULL,
  data LONGBLOB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);