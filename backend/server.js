require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const path = require('path');
const db = require('./config/db');
const logger = require('./lib/logger');
const security = require('./config/security');
const { requestContext, bindLogContext, apiNotFound, errorHandler } = require('./middleware/request-context');

// Route every console.log/warn/error through the structured logger (request ids, secret redaction).
// Skipped under Jest so test output stays readable.
if (process.env.NODE_ENV !== 'test') logger.installConsoleBridge();

function fatal(message) {
  logger.error(message);
  if (process.env.NODE_ENV === 'test') throw new Error(message);
  process.exit(1);
}

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

let trustProxy;
try {
  trustProxy = security.parseTrustProxy(process.env.TRUST_PROXY);
} catch (err) {
  fatal(err.message);
}
app.set('trust proxy', trustProxy);

let cspMode;
try {
  cspMode = security.parseCspMode(process.env.CSP_MODE);
} catch (err) {
  fatal(err.message);
}

// Fail fast if someone deploys to production without setting a real origin —
// "*" + credentials:true is both a security gap and gets silently rejected
// by browsers for credentialed requests anyway.
const corsProblem = security.corsProblem(process.env);
if (corsProblem) fatal(corsProblem);

// Must be the first middleware: request id, uniform error responses, request log.
app.use(requestContext);

// ---------- Gzip / Brotli compression (saves 60-80% bandwidth) ----------
app.use(compression({
  level: 6,                    // balanced speed vs ratio
  threshold: 1024,             // only compress responses > 1 KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));

// ---------- Security middleware ----------
app.use(helmet({
  contentSecurityPolicy: security.buildCsp(cspMode),
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // OpenStreetMap tile servers expect a Referer; strict-origin-when-cross-origin keeps that and still
  // hides the full URL from other sites.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(security.permissionsPolicy);

app.use(cors(security.buildCorsOptions(process.env)));

// Razorpay signs the exact bytes of the webhook body, so this path must be read as a raw Buffer
// BEFORE the global JSON parser (which would re-serialise and break the signature).
app.use('/api/payments/webhook', express.raw({ type: '*/*', limit: '1mb' }));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());
app.use(bindLogContext);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Every page calls GET /me on load and logout is harmless; counting them throttled ordinary users
  // behind a shared IP. They still fall under the general API limiter.
  skip: (req) => (req.method === 'GET' && req.path === '/me') || req.path === '/logout',
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

// Serve frontend static files with proper cache headers
app.use(express.static(path.join(__dirname, '..', 'frontend'), {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // HTML files: no cache (always fresh)
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    // CSS/JS are not fingerprinted, so a long max-age would pair new HTML with stale scripts after a
    // deploy. Revalidate every time instead; unchanged files come back as a cheap 304 via the ETag.
    else if (/\.(css|js)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
    // Images/fonts: very long cache
    else if (/\.(woff2?|ttf|otf|eot|svg|png|jpg|jpeg|webp|ico)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

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
app.use('/api/enrollments', enrollmentRoutes);
app.use('/api/courses', courseRoutes);

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

app.use('/api', apiNotFound);

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'frontend', '404.html'));
});

app.use(errorHandler);

let server = null;
if (process.env.NODE_ENV !== 'test') {
  if (!process.env.JWT_SECRET) {
    fatal('JWT_SECRET is not set. Add a long random value to your environment. Refusing to start.');
  }
  if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET.length < 32) {
    fatal('JWT_SECRET must be at least 32 characters in production. Refusing to start.');
  }

  server = app.listen(PORT, () => {
    logger.info('TutorLink backend is running', {
      port: Number(PORT),
      environment: process.env.NODE_ENV || 'development',
      csp: cspMode,
      trustProxy,
      healthCheck: '/health',
    });

    require('./jobs/reminders').startReminderJob();
    require('./jobs/cleanup').startCleanupJob();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${PORT} is already in use. Change PORT in .env or close the other process.`);
    } else {
      logger.error('Server failed to start', { err });
    }
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { err: reason });
  });

  // Docker/Kubernetes stop containers with SIGTERM: stop accepting requests, let in-flight emails and
  // refunds finish, then exit. A watchdog forces exit if something hangs.
  const shutdown = (signal) => {
    logger.info(`${signal} received. Shutting down TutorLink backend...`);
    setTimeout(() => process.exit(1), 15000).unref();
    server.close(async () => {
      try { await require('./lib/after-response').drain(); } catch (_) { /* best effort */ }
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = app;