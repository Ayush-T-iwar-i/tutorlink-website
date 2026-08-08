<div align="center">

---

## 📖 Overview

TutorLink connects **students** (or parents) looking for home tuition with **verified, nearby teachers**. Instead of browsing a generic city-wide list, every student and teacher pins their **exact live location** on an interactive map, and search results are ranked by real, calculated distance (Haversine formula) within a radius the student chooses.

From there, the whole relationship lives on the platform: book a free demo or recurring classes, chat, pay online, get reminded before class, leave a review — and if anything goes wrong, report it to an admin who actually reviews it.

This repository contains the **complete full-stack application** — frontend, backend, database schema, tests, and documentation — built incrementally as a real product, not a toy demo.

---

## ✨ Features

### 🎒 For Students

- Email/password signup or **Google Sign-In**
- Live GPS location, confirmed and fine-tuned on an interactive map (Leaflet + OpenStreetMap) — shown as **Area → District → Pincode**
- Search nearby teachers by subject and radius (3–15 km), with pagination
- **Public teacher directory** (`/teachers.html`) — browsable without an account, with sort/filter
- Book a **free demo** or **recurring classes** (pick specific weekdays), choosing from the teacher's own configured time slots
- **Online payment** via Razorpay once a teacher accepts and sets a fee
- In-app **chat** with a teacher once a booking is accepted
- **Save/favorite** teachers for later
- Leave a **star rating + review** after a completed class — editable/deletable within 24 hours
- **Report** a teacher or booking issue to admins
- **Notifications** — in-app bell, email, and SMS for booking updates and class reminders
- Upload a profile photo
- Change password / manage account from Settings

### 🧑‍🏫 For Teachers

- Complete profile: qualifications, subjects, grades taught, experience, fee, bio, languages, travel radius, live location, and **their own available time slots**
- Upload **verification documents** (ID proof, address proof, certificate) — access-controlled, never public
- Accept (setting a fee), decline, or complete booking requests
- **Weekly schedule** — real, dated class sessions (correctly expands recurring bookings into every actual occurrence, not just the start date)
- **Earnings dashboard** — total earned, this month, pending payments, mark cash payments as paid
- **Reply publicly to reviews**
- Chat with students, report issues, upload a profile photo
- Only appears in student search **after admin approval**

### 🛡️ For Admins

- Review and **approve/reject** teacher verifications
- Review and **resolve reports** filed by students/teachers
- **Platform-wide stats** (students, teachers, bookings, completed classes, new signups)
- **14-day signup trend chart**
- **CSV export** of students and teachers
- No separate signup — any account can be promoted to admin via the database

### ⚙️ Platform-Wide

- JWT authentication, bcrypt password hashing
- **Account lockout** after 5 failed logins (15-minute cooldown)
- Forgot/reset password via emailed link (1-hour expiry)
- **Automated class reminders** — cron job emails + texts both people ~2 hours before each class
- Email (nodemailer/SMTP) and SMS (Twilio) — both **gracefully degrade to console logging** if not configured, so local development never breaks
- Centralized, reusable **email templates**
- Rate limiting, Helmet security headers, request logging (morgan)
- **Ownership checks on every write** — a user can never modify another user's data, enforced server-side
- **XSS-safe rendering** of all user-entered text
- Razorpay payments **verified server-side** via HMAC signature — the browser is never trusted alone
- Custom branded 404 page, SEO basics (meta tags, sitemap, robots.txt)
- Terms of Service & Privacy Policy pages
- **17 automated backend tests** (Jest + Supertest), mocked DB — no live database needed to run them

---

## 🛠 Tech Stack

| Layer                      | Technology                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend**         | HTML, CSS, vanilla JavaScript — no framework, no build step                                                                                  |
| **Maps & Geocoding** | [Leaflet.js](https://leafletjs.com) + [OpenStreetMap](https://www.openstreetmap.org) + [Nominatim](https://nominatim.org) — no API key required |
| **Backend**          | Node.js + Express.js                                                                                                                          |
| **Database**         | MySQL                                                                                                                                         |
| **Auth**             | JWT (`jsonwebtoken`) + `bcryptjs`, optional Google Identity Services                                                                      |
| **Payments**         | [Razorpay](https://razorpay.com)                                                                                                               |
| **Email**            | `nodemailer` (any SMTP provider)                                                                                                            |
| **SMS**              | [Twilio](https://www.twilio.com)                                                                                                               |
| **Scheduled jobs**   | `node-cron`                                                                                                                                 |
| **Charts**           | [Chart.js](https://www.chartjs.org) (admin dashboard)                                                                                          |
| **File uploads**     | `multer`                                                                                                                                    |
| **Security**         | `helmet`, `express-rate-limit`, `express-validator`                                                                                     |
| **Logging**          | `morgan`                                                                                                                                    |
| **Testing**          | `jest` + `supertest`                                                                                                                      |

---

## 📁 Project Structure

```
tutorlink-website/
├── backend/
│   ├── config/
│   │   ├── db.js                 MySQL connection pool
│   │   ├── email.js               nodemailer wrapper (console fallback if unconfigured)
│   │   ├── email-templates.js      all outgoing email HTML, centralized
│   │   ├── sms.js                  Twilio wrapper (console fallback if unconfigured)
│   │   └── razorpay.js              Razorpay client (payments disabled gracefully if unconfigured)
│   │
│   ├── database/
│   │   ├── schema.sql               fresh install — creates everything
│   │   └── migration_2 .. 12.sql     run in order on an existing database
│   │
│   ├── middleware/
│   │   ├── auth.middleware.js        verifyToken, requireRole, requireOwnUser
│   │   └── upload.middleware.js       multer configs (documents + profile photos)
│   │
│   ├── jobs/
│   │   └── reminders.js              cron job: class reminders every 15 minutes
│   │
│   ├── routes/
│   │   ├── auth.routes.js             signup · login (+lockout) · Google · forgot/reset/change password
│   │   ├── student.routes.js          profile · location · photo upload
│   │   ├── teacher.routes.js          profile · location · public directory · nearby search · documents · photo
│   │   ├── booking.routes.js          create/respond to bookings · sessions · payment status · earnings · schedule
│   │   ├── payment.routes.js          Razorpay order creation + signature verification
│   │   ├── review.routes.js           create/edit/delete reviews · teacher replies
│   │   ├── message.routes.js          in-app chat, scoped to a booking
│   │   ├── favorite.routes.js         save/unsave/list favorite teachers
│   │   ├── notification.routes.js      in-app notification bell
│   │   ├── report.routes.js           file + view your own reports
│   │   ├── admin.routes.js            verification queue · reports · stats · CSV export
│   │   └── config.routes.js           public config (Google Client ID, default radius)
│   │
│   ├── tests/
│   │   ├── auth.test.js               Jest suite (mocked DB)
│   │   ├── booking.test.js            Jest suite (mocked DB)
│   │   ├── TutorLink.postman_collection.json   import into Postman for manual API testing
│   │   └── testing-checklist.md        full manual QA checklist before every deploy
│   │
│   ├── uploads/                       verification documents + profile photos (git-ignored)
│   ├── .env.example                   template — copy to .env and fill in
│   ├── package.json
│   └── server.js                      entry point — serves the API and the frontend
│
└── frontend/
    ├── css/style.css                    the entire design system (single file)
    ├── js/
    │   ├── api.js                       fetch() helper, session storage, notification bell, chat + report modals
    │   └── google-auth.js                 Google Identity Services integration
    │
    ├── index.html                        landing page
    ├── teachers.html                      public teacher directory (no login required)
    ├── signup.html / login.html
    ├── forgot-password.html / reset-password.html / account-settings.html
    ├── student-dashboard.html / student-complete-profile.html
    ├── teacher-dashboard.html / teacher-complete-profile.html / teacher-profile-view.html
    ├── admin-dashboard.html
    ├── terms.html / privacy.html
    ├── 404.html
    ├── favicon.svg / robots.txt / sitemap.xml
    └── (all pages share css/style.css and js/api.js)
```

---

## 🚀 Getting Started

### Prerequisites

- **[Node.js](https://nodejs.org)** v18 or later
- **MySQL** — the easiest route on Windows is **[XAMPP](https://www.apachefriends.org)**, which bundles MySQL + phpMyAdmin

### 1. Clone the repository

```bash
git clone https://github.com/<your-username>/tutorlink-website.git
cd tutorlink-website
```

### 2. Set up the database

**Brand-new install** (recommended for a first-time setup):

```bash
mysql -u root -p < backend/database/schema.sql
```

This creates the `tutorlink` database with every table already up to date — **skip the migrations below**.

**Upgrading an existing database** — run every migration below, **in this exact order**:

```bash
mysql -u root -p tutorlink < backend/database/migration_2_add_profile_and_google.sql
mysql -u root -p tutorlink < backend/database/migration_3_fix_location_and_reset.sql
mysql -u root -p tutorlink < backend/database/migration_4_notifications.sql
mysql -u root -p tutorlink < backend/database/migration_5_messages.sql
mysql -u root -p tutorlink < backend/database/migration_6_favorites.sql
mysql -u root -p tutorlink < backend/database/migration_7_payments.sql
mysql -u root -p tutorlink < backend/database/migration_8_teacher_slots.sql
mysql -u root -p tutorlink < backend/database/migration_9_reports.sql
mysql -u root -p tutorlink < backend/database/migration_10_login_lockout.sql
mysql -u root -p tutorlink < backend/database/migration_11_class_sessions.sql
mysql -u root -p tutorlink < backend/database/migration_12_review_replies.sql
```

(Or open each file in MySQL Workbench: **File → Open SQL Script → ⚡ Execute**.)

### 3. Configure environment variables

```bash
cd backend
cp .env.example .env
```

Then fill in `.env` — see the [full reference table](#-environment-variables) below. Only the database and JWT settings are strictly required to run the app; everything else (Google, email, SMS, payments) degrades gracefully when left blank.

### 4. Install dependencies

```bash
npm install
```

### 5. Run the app

```bash
npm start        # production
npm run dev       # development, auto-restarts on file changes (nodemon)
```

You should see:

```
✅ Connected to MySQL database: tutorlink
================================================
  TutorLink website backend is running
================================================
  Port:           5000
  Health check:   /health
  API base:       /api
================================================
✅ Class reminder job scheduled (every 15 minutes)
```

### 6. Open the site

Go to **http://localhost:5000** — the Express server serves the frontend directly; there's no separate frontend build or dev server.

---

## 🔑 Environment Variables

All variables live in `backend/.env` (never commit this file — see `.env.example` for a safe template).

| Variable                |  Required?  | Example                             | Notes                                                                          |
| ----------------------- | :---------: | ----------------------------------- | ------------------------------------------------------------------------------ |
| `PORT`                |     No     | `5000`                            | Defaults to 5000                                                               |
| `DB_HOST`             |     ✅     | `localhost`                       |                                                                                |
| `DB_USER`             |     ✅     | `root`                            |                                                                                |
| `DB_PASSWORD`         |     ✅     | `your_password`                   |                                                                                |
| `DB_NAME`             |     ✅     | `tutorlink`                       |                                                                                |
| `JWT_SECRET`          |     ✅     | long random string                  | **Change this before production**                                        |
| `DEFAULT_RADIUS_KM`   |     No     | `5`                               | Default search radius shown to students                                        |
| `FRONTEND_URL`        | Recommended | `http://localhost:5000`           | Used to build the password-reset link                                          |
| `GOOGLE_CLIENT_ID`    |  Optional  | `xxxx.apps.googleusercontent.com` | Blank = Google button hides automatically                                      |
| `SMTP_HOST`           |  Optional  | `smtp.gmail.com`                  | Blank = emails log to console instead                                          |
| `SMTP_PORT`           |  Optional  | `587`                             |                                                                                |
| `SMTP_USER`           |  Optional  | `you@gmail.com`                   |                                                                                |
| `SMTP_PASS`           |  Optional  | 16-char app password                | **Not your real Gmail password** — see below                            |
| `SMTP_FROM`           |  Optional  | `"TutorLink" <you@gmail.com>`     | Defaults to`SMTP_USER`                                                       |
| `TWILIO_ACCOUNT_SID`  |  Optional  | from Twilio console                 | Blank = SMS logs to console instead                                            |
| `TWILIO_AUTH_TOKEN`   |  Optional  | from Twilio console                 |                                                                                |
| `TWILIO_PHONE_NUMBER` |  Optional  | `+1234567890`                     |                                                                                |
| `RAZORPAY_KEY_ID`     |  Optional  | from Razorpay dashboard             | Blank = online payment shows "not set up yet"; manual/cash payment still works |
| `RAZORPAY_KEY_SECRET` |  Optional  | from Razorpay dashboard             | Use**test mode** keys while developing                                   |

<details>
<summary><strong>How to get a Gmail App Password</strong></summary>

Google blocks plain-password SMTP logins entirely — you need an App Password:

1. Go to [myaccount.google.com](https://myaccount.google.com) → **Security**
2. Turn on **2-Step Verification** (required before App Passwords are available)
3. Search for **"App passwords"** on the same page → create one named "TutorLink"
4. Paste the 16-character code into `SMTP_PASS`

</details>

<details>
<summary><strong>How to get Razorpay test keys</strong></summary>

1. Sign up at [dashboard.razorpay.com](https://dashboard.razorpay.com)
2. Make sure you're in **Test Mode** (toggle top-right)
3. Settings → API Keys → Generate Test Key

</details>

<details>
<summary><strong>How to get a Twilio trial number</strong></summary>

1. Sign up at [twilio.com](https://www.twilio.com) — a free trial includes a number and credit
2. Copy the **Account SID** and **Auth Token** from the console dashboard
3. Trial accounts can only text phone numbers you've manually verified in the Twilio console

</details>

<details>
<summary><strong>How to set up Google Sign-In</strong></summary>

1. [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) → Create Credentials → OAuth client ID → **Web application**
2. Under **Authorized JavaScript origins**, add the exact URL you're serving the site from (e.g. `http://localhost:5000`) — no trailing slash
3. Paste the Client ID into `.env` as `GOOGLE_CLIENT_ID`
4. Restart the server — the frontend fetches this dynamically via `/api/config`, so nothing else needs updating

</details>

---

## 👑 Making an Admin Account

There's no separate admin signup flow — an admin is just a normal account with its role changed directly in the database:

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
```

**Log out and back in** afterwards — the role is cached in the browser session at login time. You'll then be routed to `admin-dashboard.html` automatically.

## ✅ Approving Teachers

New teachers start as `pending` and are invisible in student search until approved — either from `admin-dashboard.html`, or manually for quick testing:

```sql
UPDATE teachers SET verification_status = 'approved' WHERE user_id = <their user id>;
```

---

## 🧪 Testing

```bash
cd backend
npm test
```

17 tests covering signup validation, login (including the account-lockout logic), and booking creation/status rules. The database is **mocked**, so the whole suite runs in ~2 seconds with no MySQL connection needed — safe to wire into CI.

For manual, end-to-end QA before a deploy, work through **[`backend/tests/testing-checklist.md`](backend/tests/testing-checklist.md)** — it covers every user flow, security spot-check, and cross-browser check.

For exploring the API by hand, import **[`backend/tests/TutorLink.postman_collection.json`](backend/tests/TutorLink.postman_collection.json)** into Postman.

---

## 📡 API Reference

Every write endpoint requires `Authorization: Bearer <token>`. Ownership is always verified server-side — never trust a request body's user ID alone.

<details>
<summary><strong>Auth</strong> — <code>/api/auth</code></summary>

| Method | Endpoint             | Description                            |
| ------ | -------------------- | -------------------------------------- |
| POST   | `/signup`          | Create an account (student or teacher) |
| POST   | `/login`           | Log in (locks after 5 failed attempts) |
| POST   | `/google`          | Google Sign-In                         |
| POST   | `/forgot-password` | Email a password-reset link            |
| POST   | `/reset-password`  | Consume the reset token                |
| PUT    | `/change-password` | Change password (logged in)            |
| GET    | `/me`              | Get the current logged-in user         |

</details>

<details>
<summary><strong>Students</strong> — <code>/api/students</code></summary>

| Method | Endpoint                 | Description                                        |
| ------ | ------------------------ | -------------------------------------------------- |
| GET    | `/by-user/:userId`     | Get a student's profile                            |
| PUT    | `/:userId/preferences` | Update subject/grade preferences                   |
| PUT    | `/:userId/location`    | Update location (lat/lng, area, district, pincode) |
| POST   | `/:userId/photo`       | Upload profile photo                               |

</details>

<details>
<summary><strong>Teachers</strong> — <code>/api/teachers</code></summary>

| Method | Endpoint                     | Description                                                       |
| ------ | ---------------------------- | ----------------------------------------------------------------- |
| GET    | `/browse`                  | Public directory — paginated, sortable, no auth                  |
| GET    | `/nearby`                  | Distance-based search (`lat`, `lng`, `radius`, `subject`) |
| GET    | `/by-user/:userId`         | Get your own full teacher record                                  |
| GET    | `/:id`                     | Public profile (approved teachers only)                           |
| PUT    | `/:userId/profile`         | Update qualifications, subjects, fee, bio, available slots, etc.  |
| PUT    | `/:userId/location`        | Update location + travel radius                                   |
| POST   | `/:userId/documents`       | Upload ID/address/certificate (resets to "pending")               |
| GET    | `/:userId/documents/:type` | View own/admin-only document                                      |
| POST   | `/:userId/photo`           | Upload profile photo                                              |

</details>

<details>
<summary><strong>Bookings</strong> — <code>/api/bookings</code></summary>

| Method | Endpoint              | Description                                                              |
| ------ | --------------------- | ------------------------------------------------------------------------ |
| POST   | `/`                 | Create a booking (demo or recurring)                                     |
| PUT    | `/:id/status`       | Accept (with fee)/decline/complete — generates class sessions on accept |
| PUT    | `/:id/payment`      | Mark paid/unpaid/refunded manually                                       |
| GET    | `/:id/sessions`     | List a booking's dated class sessions                                    |
| GET    | `/student/me`       | All of my bookings (student)                                             |
| GET    | `/teacher/me`       | All of my bookings (teacher)                                             |
| GET    | `/teacher/schedule` | Next 7 days of scheduled sessions                                        |
| GET    | `/teacher/earnings` | Earnings summary + recent completed classes                              |

</details>

<details>
<summary><strong>Payments</strong> — <code>/api/payments</code></summary>

| Method | Endpoint          | Description                                     |
| ------ | ----------------- | ----------------------------------------------- |
| POST   | `/create-order` | Create a Razorpay order for an accepted booking |
| POST   | `/verify`       | Verify payment signature server-side, mark paid |

</details>

<details>
<summary><strong>Reviews, Chat, Favorites, Reports, Notifications</strong></summary>

| Method              | Endpoint                     | Description                                |
| ------------------- | ---------------------------- | ------------------------------------------ |
| POST                | `/api/reviews`             | Leave a review (after a completed booking) |
| PUT / DELETE        | `/api/reviews/:id`         | Edit/delete your own review (within 24h)   |
| PUT                 | `/api/reviews/:id/reply`   | Teacher replies to a review                |
| GET                 | `/api/reviews/teacher/:id` | Public reviews for a teacher               |
| GET / POST          | `/api/messages/:bookingId` | Chat, scoped to a booking                  |
| GET / POST / DELETE | `/api/favorites`           | Saved teachers                             |
| POST                | `/api/reports`             | File a report                              |
| GET                 | `/api/reports/mine`        | View my own filed reports                  |
| GET / PUT           | `/api/notifications/...`   | Notification bell                          |

</details>

<details>
<summary><strong>Admin</strong> — <code>/api/admin</code> (requires <code>role: admin</code>)</summary>

| Method | Endpoint                       | Description                      |
| ------ | ------------------------------ | -------------------------------- |
| GET    | `/teachers/pending`          | Verification queue               |
| PUT    | `/teachers/:id/verification` | Approve/reject                   |
| GET    | `/stats`                     | Platform-wide counts             |
| GET    | `/stats/signups-by-day`      | 14-day signup trend (chart data) |
| GET    | `/reports`                   | List reports (`?status=open`)  |
| PUT    | `/reports/:id`               | Mark reviewed/resolved           |
| GET    | `/export/students`           | Download CSV                     |
| GET    | `/export/teachers`           | Download CSV                     |

</details>

<details>
<summary><strong>Misc</strong></summary>

| Method | Endpoint        | Description                                      |
| ------ | --------------- | ------------------------------------------------ |
| GET    | `/health`     | Uptime + live DB connectivity check              |
| GET    | `/api/config` | Public config (Google Client ID, default radius) |

</details>

---

## 🔒 Security

- Passwords hashed with **bcrypt**, never logged or stored in plain text
- Accounts **lock for 15 minutes** after 5 consecutive failed logins
- JWTs signed with `JWT_SECRET`, 7-day expiry
- `helmet` security headers + `express-rate-limit` (auth endpoints get an extra-tight limit)
- **Ownership middleware** blocks a user from ever editing another user's data, even with a valid token
- All **user-entered text is HTML-escaped** before rendering — no stored XSS
- Verification documents are served only through an **authenticated route** — never as public static files
- Razorpay payments are verified by **recomputing the HMAC signature server-side** — a tampered client-side "success" response is rejected
- Input validated with `express-validator` on signup/login (email format, 10-digit Indian mobile pattern, password length)

---

## 🌍 Deployment

1. Push this repo to GitHub
2. Provision a managed MySQL database (Railway, PlanetScale, Render, etc.) and run `schema.sql` against it
3. Deploy `backend/` as a Node web service (Render/Railway — a `Procfile` is included). Build command: `npm install`. Start command: `npm start`
4. Set **every** variable from the [Environment Variables](#-environment-variables) table in the platform's dashboard — never upload your local `.env`
5. Switch Razorpay to **live** keys, point `FRONTEND_URL` and Google's "Authorized JavaScript origins" at your real domain
6. Update the placeholder `tutorlink.example.com` URLs in `index.html`, `teachers.html`, `robots.txt`, and `sitemap.xml` to your real domain
7. Since `server.js` serves the `frontend/` folder too, **one deployment covers the entire site** — no separate frontend hosting needed
8. Run through `backend/tests/testing-checklist.md` end-to-end on the live URL before announcing launch

---

## 🗺 Roadmap / Future Plans

TutorLink's core product is fully built and tested. These are the features planned for future iterations, roughly grouped by how soon they'd add value:

### Near-term

- [ ] **Teacher payout automation** — currently students pay online but teachers are paid outside the platform; integrate Razorpay Route/Payouts for automatic split payments
- [ ] **Push notifications** (web push) alongside the existing email/SMS/in-app bell
- [ ] **Recurring booking calendar management** — let teachers/students reschedule or cancel individual sessions from a recurring series, not just the whole booking
- [ ] **Video call integration** (Zoom/Google Meet link generation) for online classes
- [ ] Dependency housekeeping — resolve remaining transitive `npm audit` warnings (uuid via `gaxios`/`node-cron`)

### Mid-term

- [ ] **In-app subject/curriculum tagging** — structured subject+board+grade taxonomy instead of free-text fields, enabling better matching and filters
- [ ] **Group classes** — one teacher, multiple students, split fee
- [ ] **Referral program** — students/teachers who invite others earn credit
- [ ] **Multi-language UI** (Hindi, regional languages) — the backend/data model already supports a `languages` field for teachers; extend this to the interface itself
- [ ] **Teacher availability calendar UI** (visual weekly grid) instead of a simple slot checklist
- [ ] **Admin analytics v2** — revenue charts, retention/cohort analysis, geographic heatmap of demand vs. supply
- [ ] **Automated content moderation** for reviews/bios (profanity/spam filtering) as a first pass before human report review

### Long-term / Vision

- [ ] **Native mobile apps** (React Native/Flutter) sharing the same backend API
- [ ] **AI-assisted matching** — recommend teachers based on a student's learning history and stated goals, not just subject/distance
- [ ] **Progress tracking** — teachers log topics covered per session; parents/students see a learning timeline
- [ ] **Verified badge tiers** — background-check partnerships for an extra trust layer beyond document upload
- [ ] **Marketplace for teaching materials** — teachers sell worksheets/notes to their students
- [ ] **Institutional accounts** — schools/coaching centers managing multiple teacher profiles under one organization
- [ ] **Public API / webhooks** for third-party integrations (school ERPs, CRM tools)
- [ ] **Internationalization beyond India** — currency, phone-format, and address-format abstraction (currently assumes ₹ and 10-digit Indian mobile numbers)

Contributions and suggestions for this roadmap are welcome — see below.

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Make your changes — run `npm test` and work through the relevant sections of `testing-checklist.md`
4. Commit with a clear message and open a Pull Request describing what changed and why

Please don't commit `.env`, `backend/uploads/`, or `node_modules/` — these are already git-ignored.

---

## 📄 License

This project is available under the **MIT License** — free to use, modify, and distribute. See `LICENSE` for the full text.

---

## 🙏 Acknowledgments

- [Leaflet.js](https://leafletjs.com) & [OpenStreetMap](https://www.openstreetmap.org) contributors — for a free, no-API-key mapping stack
- [Chart.js](https://www.chartjs.org) — admin analytics visualization
- Every open-source package listed in [`package.json`](backend/package.json)

---

<div align="center">

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
