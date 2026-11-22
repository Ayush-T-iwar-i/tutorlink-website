
ALTER TABLE bookings
  ADD COLUMN plan_request ENUM('pause','stop') NULL,
  ADD COLUMN plan_request_note VARCHAR(200) NULL,
  ADD COLUMN plan_request_at DATETIME NULL;
