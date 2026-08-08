require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./config/db');

const authRoutes = require('./routes/auth.routes');
const teacherRoutes = require('./routes/teacher.routes');
const studentRoutes = require('./routes/student.routes');
const bookingRoutes = require('./routes/booking.routes');
const configRoutes = require('./routes/config.routes');
const adminRoutes = require('./routes/admin.routes');
const reviewRoutes = require('./routes/review.routes');
const notificationRoutes = require('./routes/notification.routes');
const messageRoutes = require('./routes/message.routes');
const favoriteRoutes = require('./routes/favorite.routes');
const paymentRoutes = require('./routes/payment.routes');
const reportRoutes = require('./routes/report.routes');

const app = express();
const PORT = process.env.PORT || 5000;

// Needed when deployed behind a proxy/load balancer (Render, Railway, Heroku, etc.)
// so rate limiting and client IPs are read correctly.
app.set('trust proxy', 1);

// ---------- Security middleware ----------
app.use(helmet({
  contentSecurityPolicy: false, // keep simple for a plain HTML/CSS/JS frontend; tighten later if needed
}));

// Request logging — 'dev' format is concise and colour-coded, good for
// local development. Skipped in tests to keep test output clean.
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*', // set ALLOWED_ORIGIN in production .env to your real domain
}));

app.use(express.json({ limit: '2mb' }));

// Limit repeated requests to auth endpoints to slow down brute-force attempts
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,                  // 30 requests per IP per window
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});
app.use('/api/auth', authLimiter);

// General API rate limit (protects the whole backend from abuse/scraping)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many requests. Please slow down.' },
});
app.use('/api', apiLimiter);

// ---------- Serve the frontend (HTML/CSS/JS) as static files ----------
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Profile photos are meant to be publicly visible (teacher directory,
// profile pages). Verification documents are NOT served this way — those
// stay behind the authenticated route in teacher.routes.js.
app.use('/uploads/photos', express.static(path.join(__dirname, 'uploads', 'photos')));

// ---------- API Routes ----------
app.use('/api/auth', authRoutes);
app.use('/api/teachers', teacherRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/config', configRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reports', reportRoutes);

// ---------- Health check (used by hosting platforms to confirm the app is alive) ----------
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    database: 'unknown',
  };
  try {
    await db.query('SELECT 1');
    health.database = 'connected';
  } catch (err) {
    health.database = 'disconnected';
    health.status = 'degraded';
  }
  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

// ---------- 404 handler for unknown API routes ----------
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

// ---------- 404 handler for unknown frontend pages ----------
// (Only reached if express.static above found no matching file.)
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'frontend', '404.html'));
});

// ---------- Global error handler (catches anything that slips through) ----------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

// ---------- Start server ----------
const server = app.listen(PORT, () => {
  console.log('================================================');
  console.log('  TutorLink website backend is running');
  console.log('================================================');
  console.log(`  Port:           ${PORT}`);
  console.log(`  Health check:   /health`);
  console.log(`  API base:       /api`);
  console.log(`  Environment:    ${process.env.NODE_ENV || 'development'}`);
  console.log('================================================');

  // Skip the cron job during automated tests (Jest imports server.js
  // indirectly through route files, and we don't want a real timer
  // running during test runs).
  if (process.env.NODE_ENV !== 'test') {
    require('./jobs/reminders').startReminderJob();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Change PORT in .env or close the other process.`);
  } else {
    console.error('Server failed to start:', err);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('SIGINT', () => {
  console.log('\nShutting down TutorLink backend...');
  server.close(() => process.exit(0));
});