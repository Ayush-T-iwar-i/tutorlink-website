# ==========================================================
# TutorLink — Multi-Stage Production Dockerfile
# Optimized for security, minimal image size, and fast boot
# ==========================================================

# ----------------- Stage 1: Build & Dependencies -----------------
FROM node:20-alpine AS dependencies

WORKDIR /app

# Install dependencies needed for node-gyp if any native modules build
RUN apk add --no-cache python3 make g++

COPY backend/package*.json ./backend/
WORKDIR /app/backend
RUN npm ci --omit=dev

# ----------------- Stage 2: Production Runtime -----------------
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

# Create a non-privileged system user for running the application
RUN addgroup -S tutorlink && adduser -S tutorlink -G tutorlink

# Copy production node_modules and code
COPY --from=dependencies /app/backend/node_modules ./backend/node_modules
COPY backend ./backend
COPY frontend ./frontend

# Ensure upload directories exist and have proper permissions
RUN mkdir -p /app/backend/uploads/photos && chown -R tutorlink:tutorlink /app

USER tutorlink

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5000/health || exit 1

WORKDIR /app/backend
# Apply pending database migrations (tracked, idempotent, lock-protected), then start the API.
CMD ["sh", "-c", "node database/migrate.js && node server.js"]