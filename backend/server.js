require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const multer = require('multer');
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
const enrollmentRoutes = require('./routes/enrollment.routes');
const courseRoutes = require('./routes/course.routes');

const app = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);

// ---------- Security middleware ----------
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// Fail fast if someone deploys to production without setting a real origin —
// "*" + credentials:true is both a security gap and gets silently rejected
// by browsers for credentialed requests anyway.
if (process.env.NODE_ENV === 'production' && (!process.env.ALLOWED_ORIGIN || process.env.ALLOWED_ORIGIN === '*')) {
  console.error('❌ ALLOWED_ORIGIN must be set to your real frontend domain in production. Refusing to start.');
  process.exit(1);
}

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth', authLimiter);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.use('/uploads/photos', express.static(path.join(__dirname, 'uploads', 'photos')));

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

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'frontend', '404.html'));
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Uploaded file is too large (max limit exceeded).' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }

  if (err && (err.code === 'INVALID_FILE_TYPE' || err.message?.includes('Only JPG, PNG'))) {
    return res.status(400).json({ error: err.message });
  }

  console.error('Unhandled error:', err);
  const isDev = process.env.NODE_ENV === 'development';
  res.status(err.status || 500).json({
    error: isDev ? (err.message || 'Server error') : 'Something went wrong on our end.',
  });
});

let server = null;
if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    console.log('================================================');
    console.log('  TutorLink website backend is running');
    console.log('================================================');
    console.log(`  Port:           ${PORT}`);
    console.log(`  Health check:   /health`);
    console.log(`  API base:       /api`);
    console.log(`  Environment:    ${process.env.NODE_ENV || 'development'}`);
    console.log('================================================');

    require('./jobs/reminders').startReminderJob();
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
}

module.exports = app;