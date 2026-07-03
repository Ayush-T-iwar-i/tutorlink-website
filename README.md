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

## What's Next (Not Yet Built)
- Document upload for teacher verification (ID, certificates)
- Admin panel (approve/reject teachers, manage disputes)
- Online payments (Razorpay/Stripe integration)
- Chat between student and teacher
- Email/SMS notifications

Ask for any of these next and they'll be built the same way — one working
piece at a time.
