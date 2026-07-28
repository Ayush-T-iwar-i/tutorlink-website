# TutorLink

A home-tuition marketplace: students search for verified, nearby teachers
within a configurable radius, book a free demo or recurring classes, pay
online, chat with their teacher, and leave reviews — all from one dashboard.
Teachers manage their profile, documents, schedule, and earnings from theirs.
Admins verify teachers and moderate reports from one panel.

Live distance matching is the core idea: every student and teacher sets an
exact GPS point (confirmed on an interactive map), and search results are
ranked by real distance.

---

## Features

**Student**

- Signup/login with email+password or Google Sign-In
- Live location via GPS, confirmed on an interactive map (Leaflet + OpenStreetMap)
- Search nearby teachers by subject and radius, or browse the public directory (`teachers.html`) without an account
- Book a free demo or recurring classes (day-of-week picker), from the teacher's own available time slots
- Pay online via Razorpay once a teacher accepts and sets a fee
- In-app chat with a teacher once a booking is accepted
- Save/favorite teachers; leave a star rating + review after a completed class
- Report a teacher/booking issue to admins
- In-app notification bell + email/SMS updates on booking status
- Change password / account settings

**Teacher**

- Complete profile: qualifications, subjects, experience, fee, bio, travel radius, live location, available time slots
- Upload verification documents (access-controlled, never public)
- Accept (with a fee) / decline / complete bookings; chat with students; report issues
- Weekly schedule view + earnings dashboard (total, this month, pending, mark cash payments as paid)
- Appears in search only after admin approval

**Admin**

- Approve/reject teacher verifications
- Review and resolve student/teacher reports
- Platform stats + a 14-day signup trend chart
- Export students/teachers as CSV

**Platform-wide**

- JWT auth, bcrypt password hashing, account lockout after repeated failed logins
- Forgot/reset password via emailed link
- Email (nodemailer) + SMS (Twilio) notifications — both fall back to console logging if not configured, so local dev never breaks
- Online payments via Razorpay (test mode friendly)
- Rate limiting, Helmet security headers, ownership checks on every write, XSS-safe rendering
- Automated backend tests (Jest + Supertest) for auth and booking logic

---

## Tech Stack

- **Frontend:** HTML + CSS + vanilla JavaScript (no build step)
- **Maps:** Leaflet.js + OpenStreetMap + Nominatim (no API key required)
- **Backend:** Node.js + Express.js
- **Database:** MySQL
- **Auth:** JWT + bcrypt, optional Google Identity Services
- **Payments:** Razorpay
- **Email:** nodemailer (SMTP) · **SMS:** Twilio
- **Charts:** Chart.js (admin dashboard)
- **Tests:** Jest + Supertest

---

## Folder Structure

```
tutorlink-website/
├── backend/
│   ├── config/
│   │   ├── db.js            MySQL connection pool
│   │   ├── email.js          nodemailer wrapper (logs to console if not configured)
│   │   ├── sms.js             Twilio wrapper (logs to console if not configured)
│   │   └── razorpay.js         Razorpay client (payments disabled gracefully if not configured)
│   ├── database/
│   │   ├── schema.sql          Run once for a brand-new database
│   │   └── migration_2..10_*.sql   Run in order on an existing database
│   ├── middleware/
│   │   ├── auth.middleware.js   verifyToken, requireRole, requireOwnUser
│   │   └── upload.middleware.js  multer config for document uploads
│   ├── routes/
│   │   ├── auth.routes.js        signup, login (+ lockout), Google sign-in, forgot/reset/change password
│   │   ├── student.routes.js     student profile + location
│   │   ├── teacher.routes.js     profile, location, nearby search, public directory, documents
│   │   ├── booking.routes.js     create/respond/list bookings, payment status, earnings
│   │   ├── payment.routes.js      Razorpay order creation + signature verification
│   │   ├── review.routes.js       leave/list reviews
│   │   ├── message.routes.js      in-app chat, scoped to a booking
│   │   ├── favorite.routes.js     save/unsave/list favorite teachers
│   │   ├── notification.routes.js  in-app notification bell
│   │   ├── report.routes.js       file a report/complaint
│   │   ├── admin.routes.js        verification queue, reports, stats, CSV export
│   │   └── config.routes.js       public config (Google Client ID, default radius)
│   ├── tests/                    Jest test suites (mocked DB, no MySQL needed to run)
│   ├── uploads/                   teacher verification documents (git-ignored)
│   ├── .env                      your local secrets — never commit this
│   ├── package.json
│   └── server.js                 entry point — serves the API and the frontend
└── frontend/
    ├── css/style.css              the entire design system
    ├── js/
    │   ├── api.js                 fetch() helper, session storage, notification bell, chat + report modals
    │   └── google-auth.js          Google Identity Services integration
    ├── index.html / teachers.html  landing page + public teacher directory
    ├── signup.html / login.html / forgot-password.html / reset-password.html / account-settings.html
    ├── student-dashboard.html / student-complete-profile.html
    ├── teacher-dashboard.html / teacher-complete-profile.html / teacher-profile-view.html
    └── admin-dashboard.html
```

---

## Setup

### 1. Prerequisites

- **Node.js** v18+: https://nodejs.org
- **MySQL** — via XAMPP (bundles MySQL + phpMyAdmin): https://www.apachefriends.org

### 2. Create the database

**Brand-new install:**

```powershell
mysql -u root -p < backend/database/schema.sql
```

**Existing database — run every migration below, in order:**

```powershell
mysql -u root -p tutorlink < backend/database/migration_2_add_profile_and_google.sql
mysql -u root -p tutorlink < backend/database/migration_3_fix_location_and_reset.sql
mysql -u root -p tutorlink < backend/database/migration_4_notifications.sql
mysql -u root -p tutorlink < backend/database/migration_5_messages.sql
mysql -u root -p tutorlink < backend/database/migration_6_favorites.sql
mysql -u root -p tutorlink < backend/database/migration_7_payments.sql
mysql -u root -p tutorlink < backend/database/migration_8_teacher_slots.sql
mysql -u root -p tutorlink < backend/database/migration_9_reports.sql
mysql -u root -p tutorlink < backend/database/migration_10_login_lockout.sql
```

(Or open each file in MySQL Workbench: **File → Open SQL Script** → click ⚡ Execute.)

### 3. Configure environment variables

Create `backend/.env` — see the reference table below.

### 4. Install & run

```powershell
cd backend
npm install
npm start
```

Open **http://localhost:5000** — the backend serves the frontend automatically.

### 5. Run the test suite (optional but recommended)

```powershell
npm test
```

---

## Environment Variables (`backend/.env`)

| Variable                                                                      | Required?   | Example                                        | Notes                                                                                                     |
| ----------------------------------------------------------------------------- | ----------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PORT`                                                                      | No          | `5000`                                       |                                                                                                           |
| `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`                     | Yes         | `localhost` / `root` / ... / `tutorlink` |                                                                                                           |
| `JWT_SECRET`                                                                | Yes         | any long random string                         | Change before production                                                                                  |
| `DEFAULT_RADIUS_KM`                                                         | No          | `5`                                          |                                                                                                           |
| `FRONTEND_URL`                                                              | Recommended | `http://localhost:5000`                      | Used to build the password-reset link                                                                     |
| `GOOGLE_CLIENT_ID`                                                          | Optional    | ends in`.apps.googleusercontent.com`         | Leave blank to disable Google Sign-In                                                                     |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Optional    | see below                                      | Leave blank to log emails to console instead                                                              |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER`      | Optional    | from twilio.com console                        | Leave blank to log SMS to console instead                                                                 |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`                                 | Optional    | from the Razorpay dashboard, test mode         | Leave blank and students will see "online payments not set up yet" — teachers can still be paid manually |

**Gmail SMTP:** Google Account → Security → 2-Step Verification → App Passwords → use that as `SMTP_PASS` (not your real password).
**Razorpay test keys:** dashboard.razorpay.com → Settings → API Keys → generate **Test Mode** keys.
**Twilio trial:** twilio.com → get a free trial number + Account SID + Auth Token (trial accounts can only text verified numbers).

---

## Making an admin account

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
```

Log out and back in afterwards — the role is cached at login time.

## Approving teachers

New teachers start as `pending` and won't appear in search until approved —
via `admin-dashboard.html`, or manually:

```sql
UPDATE teachers SET verification_status = 'approved' WHERE user_id = <their user id>;
```

## Setting up Google Sign-In (optional)

1. https://console.cloud.google.com/apis/credentials → Create Credentials → OAuth client ID → Web application
2. Add your exact serving URL under "Authorized JavaScript origins" (no trailing slash)
3. Put the Client ID in `backend/.env` (`GOOGLE_CLIENT_ID`) and in `frontend/js/google-auth.js`
4. Restart the server. Without this, email/password still works fine.

---

## API Reference (high level)

| Base path                                                                                                                                                                                                | Purpose                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `POST /api/auth/signup`, `/login`, `/google`, `/forgot-password`, `/reset-password`                                                                                                            | Authentication                                |
| `PUT /api/auth/change-password`                                                                                                                                                                        | Change password (logged in)                   |
| `GET/PUT /api/students/...`                                                                                                                                                                            | Student profile, preferences, location        |
| `GET/PUT /api/teachers/...`, `/browse` (public), `/nearby`, `/:userId/documents`                                                                                                                 | Teacher profile, directory, search, documents |
| `POST /api/bookings`, `PUT /:id/status`, `PUT /:id/payment`, `GET /student/me`, `/teacher/me`, `/teacher/earnings`                                                                           | Bookings & earnings                           |
| `POST /api/payments/create-order`, `/verify`                                                                                                                                                         | Razorpay checkout                             |
| `POST /api/reviews`, `GET /teacher/:id`                                                                                                                                                              | Reviews                                       |
| `GET/POST /api/messages/:bookingId`                                                                                                                                                                    | Chat                                          |
| `GET/POST/DELETE /api/favorites`                                                                                                                                                                       | Saved teachers                                |
| `POST /api/reports`                                                                                                                                                                                    | File a report                                 |
| `GET/PUT /api/notifications/...`                                                                                                                                                                       | Notification bell                             |
| `GET /api/admin/teachers/pending`, `PUT .../verification`, `GET /stats`, `GET /stats/signups-by-day`, `GET /reports`, `PUT /reports/:id`, `GET /export/students`, `GET /export/teachers` | Admin                                         |
| `GET /api/config`                                                                                                                                                                                      | Public config                                 |

Every write route requires `Authorization: Bearer <token>`; ownership is
always checked server-side.

---

## Security notes

- Passwords bcrypt-hashed; accounts lock for 15 minutes after 5 failed logins in a row
- JWTs signed with `JWT_SECRET`, 7-day expiry
- `helmet` + `express-rate-limit`; ownership middleware blocks editing anyone else's data
- User-entered text is HTML-escaped before rendering (stored-XSS prevention)
- Verification documents served only through an authenticated route, never as public static files
- Razorpay payments are verified server-side by recomputing the HMAC signature — the browser's "success" callback is never trusted alone
- `.env` and `backend/uploads/` are git-ignored

---

## Testing

```powershell
cd backend
npm test
```

Tests mock the database, so they run in under 2 seconds with no MySQL
connection required — safe to run in CI.

---

## Deploying to production

1. Push to GitHub
2. Provision a managed MySQL database and run `schema.sql` against it
3. Deploy `backend/` as a Node web service (Render/Railway — a `Procfile` is included); build `npm install`, start `npm start`
4. Set every `.env` variable in the platform's environment settings — never upload your local `.env`
5. Update `FRONTEND_URL`, Razorpay to **live** keys, and Google Cloud's authorized origins to your real domain
6. `server.js` serves `frontend/` too, so one deployment covers the whole site

---

## Roadmap / not yet built

- Recurring-booking auto-scheduling (currently a date + a list of weekdays, no calendar generation)
- Teacher payout automation (Razorpay Route/payouts) — currently students pay, teachers are paid outside the platform
- Push notifications (currently in-app + email + SMS onl

# TutorLink — Website (Frontend + Backend + Database)

A home-tuition booking website: students search for verified teachers within
a configurable radius (default 5 km) of their location, book a free demo
class, and then book recurring tuition.

## Tech Stack

- **Frontend:** HTML + CSS + JavaScript (plain, no build step — just open in a browser)
- **Backend:** Node.js + Express.js
- **Database:** MySQL

## Folder Structure

```
tutorlink-website/
├── backend/
│   ├── config/db.js          MySQL connection
│   ├── database/schema.sql   Run this once to create all tables
│   ├── routes/                auth, teachers, students, bookings APIs
│   ├── .env                   Your local database credentials
│   ├── package.json
│   └── server.js               Main entry point — serves API + the website
└── frontend/
    ├── css/style.css
    ├── js/api.js               Shared fetch() helper used by every page
    ├── index.html               Landing page
    ├── signup.html               Student/Teacher signup
    ├── login.html
    ├── student-dashboard.html    Search nearby teachers, book demo
    └── teacher-dashboard.html    Profile, location/radius, booking requests
```

## Step-by-Step Setup (Windows)

### 1. Install requirements

- Install **Node.js** (v18 or newer): https://nodejs.org
- Install **MySQL** — easiest option is **XAMPP** (includes MySQL + phpMyAdmin): https://www.apachefriends.org

### 2. Create the database

1. Start MySQL (via XAMPP control panel, click "Start" next to MySQL).
2. Open phpMyAdmin (usually `http://localhost/phpmyadmin`) or use the MySQL command line.
3. Open `backend/database/schema.sql`, copy all of it, and run it in phpMyAdmin's SQL tab
   (or run: `mysql -u root -p < backend/database/schema.sql`).
   This creates the `tutorlink` database and all tables.

### 3. Configure the backend

1. Open `backend/.env` in a text editor.
2. Update `DB_PASSWORD` if your MySQL root user has a password (XAMPP default has no password, so you can leave it blank).

### 4. Install & run

Open PowerShell/Command Prompt in the `backend` folder:

```powershell
cd backend
npm install
npm start
```

You should see:

```
✅ Connected to MySQL database: tutorlink
================================================
  TutorLink website backend is running
================================================
  Website:        http://localhost:5000
  Health check:   http://localhost:5000/health
  API base:       http://localhost:5000/api
================================================
```

### 5. Open the website

Go to **http://localhost:5000** in your browser. That's it — the backend
serves the frontend automatically, so you don't need a separate server for it.

## How the Core Features Work

- **Signup/Login:** `backend/routes/auth.routes.js` — passwords hashed with bcrypt, JWT issued on login.
- **5 km radius search:** `backend/routes/teacher.routes.js` (`GET /api/teachers/nearby`) — uses the
  Haversine formula directly in a MySQL query to calculate distance between the student's
  coordinates and every approved teacher's coordinates, and filters by radius.
- **Live location:** captured in the browser via `navigator.geolocation.getCurrentPosition()`
  on both the student and teacher dashboards.
- **Demo booking:** student clicks "Book free demo class" → `POST /api/bookings` → appears in
  the teacher's dashboard under "Incoming booking requests" → teacher accepts/declines.

## Security (added for production)

- All write operations (updating profile, location, bookings) require a valid login token (`Authorization: Bearer <token>`).
- A user can only ever modify their own account — verified server-side, never trusted from the browser.
- Passwords are hashed with bcrypt; tokens are signed JWTs.
- `helmet` sets safe HTTP security headers; `express-rate-limit` throttles repeated requests (especially on `/api/auth`, to slow down brute-force login attempts).
- `.env` is git-ignored — only `.env.example` (with placeholder values) should ever be committed.

## Deploying to Production

### 1. Push to GitHub

```powershell
cd tutorlink-website
git init
git add .
git commit -m "Initial commit"
git remote add origin <your-empty-github-repo-url>
git push -u origin main
```

### 2. Set up a production MySQL database

Use any provider that gives you a MySQL database + connection details, for example:

- **Railway** (railway.app) — easiest, free tier available
- **Render** (render.com) — has managed PostgreSQL; for MySQL use Railway or PlanetScale instead
- **PlanetScale** (planetscale.com)

Run `backend/database/schema.sql` against that database (most providers let you run SQL directly from their dashboard, or connect with a MySQL client and pipe the file in).

### 3. Deploy the backend

On **Render** or **Railway**:

1. Create a new "Web Service" and connect your GitHub repo.
2. Set the root directory to `backend`.
3. Build command: `npm install`
4. Start command: `npm start` (or the platform will detect the `Procfile`)
5. Add these environment variables in the platform's dashboard (do NOT upload your `.env` file):
   - `NODE_ENV=production`
   - `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` (from step 2)
   - `JWT_SECRET` (generate with the command in `.env.example`)
   - `ALLOWED_ORIGIN` (your deployed site's URL, once you know it)
   - `DEFAULT_RADIUS_KM=5`
6. Deploy. The platform gives you a live URL like `https://tutorlink-backend.onrender.com`.

Since `server.js` also serves the `frontend/` folder as static files, your entire website
(frontend + backend) runs from that **one URL** — no separate frontend hosting needed.

### 4. Point a custom domain (optional)

Most platforms let you add a custom domain (e.g. `www.tutorlink.com`) under project settings,
then update your domain's DNS records as instructed.

## ⚠️ If you already ran this project before (existing database)

New features were added: Google Sign-In, teacher qualifications, and area/location names.
**Run this migration once** — do NOT re-run `schema.sql` on an existing database:

```powershell
mysql -u root -p tutorlink < backend/database/migration_2_add_profile_and_google.sql
```

(or copy the contents of that file into phpMyAdmin's SQL tab and run it)

Then run `npm install` again inside `backend` to get the new `google-auth-library` package.

## Setting up Google Sign-In (optional)

1. Go to https://console.cloud.google.com/apis/credentials
2. Create a project → "Create Credentials" → "OAuth client ID" → Application type: **Web application**
3. Under "Authorized JavaScript origins" add: `http://localhost:5000` (and your live domain later)
4. Copy the generated **Client ID** into `backend/.env` as `GOOGLE_CLIENT_ID=...`
5. Restart the server. The Google button will now appear on login/signup automatically.
   (If left blank, the site works fine with just email/password — the Google button
   will show a small "not set up yet" message instead of breaking.)

## Approving teachers (until the admin panel is built)

New teacher accounts are created with `verification_status = 'pending'` and will **not**
appear in student search results until approved. Until the admin panel exists, approve a
teacher manually for testing:

```sql
UPDATE teachers SET verification_status = 'approved' WHERE user_id = <their user id>;
```

## What's Next (Not Yet Built)

- Document upload for teacher verification (ID, certificates)
- Admin panel (approve/reject teachers, manage disputes)
- Online payments (Razorpay/Stripe integration)
- Chat between student and teacher
- Email/SMS notifications

Ask for any of these next and they'll be built the same way — one working
piece at a time.
