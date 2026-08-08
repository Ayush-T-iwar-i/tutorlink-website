
# TutorLink — Manual Testing Checklist

Run through this before every deploy to production. Check off each item;
anything that fails blocks the deploy until fixed.

## Setup

- [ ] `npm install` runs clean, `npm test` passes (17/17)
- [ ] `.env` has all required vars filled (see `.env.example`)
- [ ] Fresh DB: `schema.sql` + `migration_2` through `migration_12` all run without error
- [ ] `npm start` shows "✅ Connected to MySQL database" and "✅ Class reminder job scheduled"
- [ ] `GET /health` returns `{"status":"ok","database":"connected"}`

## Auth

- [ ] Sign up as a student — role-specific fields (grade, subjects) save correctly
- [ ] Sign up as a teacher — role-specific fields (subjects, qualification, experience) save correctly
- [ ] Sign up with an already-used email → clear error, not a 500
- [ ] Sign up with an already-used phone → clear error, not a 500
- [ ] Log in with correct password → redirected to the right dashboard for the role
- [ ] Log in with wrong password 5x in a row → account locks for 15 minutes
- [ ] Forgot password → email arrives (or logs to console if SMTP not configured) → reset link works → new password logs in
- [ ] Change password from Account Settings works with correct current password, rejects wrong one
- [ ] Google Sign-In button appears only if `GOOGLE_CLIENT_ID` is set; hidden otherwise

## Student flow

- [ ] "Use my current location" opens the map with a GPS accuracy circle
- [ ] Dragging the pin and confirming updates Area/District/Pincode correctly
- [ ] Search nearby teachers by subject + radius returns results, sorted by distance
- [ ] `teachers.html` (public directory) works without being logged in
- [ ] Book a demo class — date, time slot (teacher's own slots, not a hardcoded list), subject all required
- [ ] Book a recurring class — day-of-week picker works, at least one day required
- [ ] Booking shows up in "My bookings" with status "requested"
- [ ] Save/unsave a teacher (heart icon) reflects immediately and persists on reload
- [ ] Upload a profile photo — preview updates immediately
- [ ] Chat button appears only after a booking is accepted; messages send/receive
- [ ] Report button opens the modal and submits successfully
- [ ] After teacher marks a booking "completed," Leave a Review appears
- [ ] Submitted review can be edited/deleted within 24 hours; buttons disappear after 24h (test by editing a review's `created_at` in the DB to simulate)
- [ ] "Pay Now" button appears only when accepted + unpaid + fee > 0; Razorpay checkout opens (test mode)
- [ ] Notification bell shows unread count and marks read on click

## Teacher flow

- [ ] Complete profile: qualifications, subjects, fee, bio, travel radius, location all save
- [ ] Set available time slots — reflected correctly on the student's booking modal for this teacher
- [ ] Upload ID proof / address proof / certificate — succeeds, and status resets to "pending"
- [ ] Upload profile photo — appears on the public profile page
- [ ] Teacher does NOT appear in student search until admin approves them
- [ ] Accept a booking — fee modal appears and is required; booking status updates
- [ ] Class sessions are generated correctly: demo = 1 session, recurring = one per matching weekday for 8 weeks (spot-check in `class_sessions` table)
- [ ] "This week's schedule" shows only real upcoming sessions from `class_sessions`, grouped by date
- [ ] Decline / Mark completed both work and update status
- [ ] Earnings panel shows correct total/this month/pending; "Mark paid" works for cash payments
- [ ] Reply to a review — appears on the public profile under that review
- [ ] Report a student — succeeds

## Admin flow

- [ ] Promote a test account to admin via SQL, log out/in, lands on `admin-dashboard.html`
- [ ] Pending teacher shows in the queue; Approve makes them searchable immediately
- [ ] Reject a teacher — they no longer appear, banner on their dashboard reflects "rejected"
- [ ] Open reports list populates; Mark reviewed / Resolve both work
- [ ] Platform stats numbers match what's actually in the DB (spot-check counts)
- [ ] Signup chart renders with no console errors
- [ ] CSV export downloads and opens correctly in Excel/Sheets for both students and teachers

## Notifications (email/SMS)

- [ ] Without SMTP/Twilio configured: emails and SMS print to the server console instead of crashing anything
- [ ] With SMTP configured: password reset, new booking, booking status change, payment received all arrive
- [ ] With Twilio configured: booking request/status SMS arrive on a verified test number
- [ ] Class reminder cron: manually insert a `class_sessions` row dated ~90 minutes from now, wait for the 15-min cron tick, confirm reminder email/SMS sent and `reminder_sent` flips to 1

## Payments (Razorpay test mode)

- [ ] Teacher accepts with a fee > 0 → "Pay Now" appears for the student
- [ ] Complete a test-mode payment with Razorpay's test card/UPI → `payment_status` flips to "paid"
- [ ] Tampering with the payment response client-side (e.g. via devtools) does NOT mark a booking paid — signature verification must reject it server-side

## Security spot-checks

- [ ] A logged-in student cannot edit another student's profile (try hitting the API directly with a different `userId`)
- [ ] A logged-in teacher cannot approve themselves (admin-only route rejects non-admins)
- [ ] Uploaded ID/address documents are NOT reachable via a direct guessed URL (only via the authenticated route)
- [ ] XSS check: set a teacher's bio to `<script>alert(1)</script>` and confirm it renders as literal text everywhere, not executes
- [ ] Visiting a random nonsense URL (e.g. `/foo-bar`) shows the branded 404 page, not a raw error

## Cross-browser / mobile

- [ ] Chrome, Safari, Edge — signup/login/dashboard render correctly
- [ ] Mobile Chrome (real phone, not devtools emulation) — GPS location picker actually gets accurate coordinates
- [ ] Map modal, chat modal, and booking modal are usable on a small screen (no cut-off buttons)

## Pre-deploy final check

- [ ] `.env` values are production values, not localhost/test placeholders
- [ ] `FRONTEND_URL`, Google "Authorized JavaScript origins," and Razorpay webhook/keys all point at the real domain
- [ ] Razorpay is switched from test keys to live keys
- [ ] Terms of Service / Privacy Policy reviewed by a human (ideally a lawyer) before going live
- [ ] Canonical URLs in `index.html`/`teachers.html`/`robots.txt`/`sitemap.xml` updated from the `tutorlink.example.com` placeholder to the real domain
