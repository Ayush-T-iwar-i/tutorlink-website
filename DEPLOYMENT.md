
# TutorLink — Deployment Guide (single VPS, Docker Compose + HTTPS)

This guide uses what the repository already ships: `Dockerfile`, `docker-compose.yml`,
the migration runner (`database/migrate.js`) and the `/health` endpoint.
TutorLink is one Node process that serves the API, the static frontend and the background jobs,
so one small server is enough to start.

> Not verified: this guide has not been run against a real server. Follow the checks in
> section 8 after every step and fix anything that differs.

## 1. What you need

- A VPS with Ubuntu 22.04+ (2 GB RAM is enough to start) and a public IP.
- A domain name with an `A` record pointing at the VPS IP.
- Docker and the Compose plugin installed.
- Razorpay account (test keys first), and optionally SMTP, Twilio and Google credentials.

## 2. Get the code onto the server

```bash
git clone https://github.com/Ayush-T-iwar-i/tutorlink-website.git
cd tutorlink-website
```

## 3. Create the `.env` file (next to `docker-compose.yml`)

```bash
cp .env.example .env
nano .env
```

Set at least:

| Variable                                      | Value                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `DB_PASSWORD`                               | long random password                                                         |
| `MYSQL_ROOT_PASSWORD`                       | a different long random password                                             |
| `JWT_SECRET`                                | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ALLOWED_ORIGIN`                            | `https://yourdomain.com` (no trailing slash, never `*`)                  |
| `FRONTEND_URL`                              | `https://yourdomain.com`                                                   |
| `TRUST_PROXY`                               | `1` (you will sit behind a reverse proxy)                                  |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | test keys first, live keys at launch                                         |
| `RAZORPAY_WEBHOOK_SECRET`                   | the secret you type when creating the webhook (section 6)                    |

Rules for every line in `.env`: one `KEY=value` per line, no text after the value,
no quotes unless the value has spaces. A stray word after the secret causes
Razorpay `401 Authentication failed` and a 500 on `create-order`.
Never commit `.env`. Never paste its contents in chats or tickets; rotate any secret that leaked.

## 4. Remove the public database port

In `docker-compose.yml`, delete the `ports:` block of the `db` service
(`"127.0.0.1:3306:3306"`). The app reaches MySQL over the internal Docker network.

## 5. Start the stack

```bash
docker compose up -d --build
docker compose logs -f app
```

On start the container runs `node database/migrate.js` (applies `schema.sql` and every
`migration_<N>_*.sql` in order, recorded in `schema_migrations`) and then `node server.js`.
Take a database backup before deploying new migrations to a database with real data.

Create the first admin:

```bash
docker compose exec app node create-admin.js
```

Use a strong password, never the default.

## 6. HTTPS with Caddy (automatic certificates)

Install Caddy on the host and use `/etc/caddy/Caddyfile`:

```
yourdomain.com {
    reverse_proxy 127.0.0.1:5000
}
```

Then `sudo systemctl reload caddy`. Open ports 80 and 443 in the firewall; keep 5000 and 3306 closed:

```bash
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

Razorpay webhook: in the Razorpay dashboard add `https://yourdomain.com/api/payments/webhook`,
subscribe to `payment.captured`, `payment.failed` and `refund.processed`, and set the same
secret as `RAZORPAY_WEBHOOK_SECRET`.

## 7. Backups and updates

Nightly database backup (cron):

```bash
docker compose exec -T db sh -c 'mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --single-transaction tutorlink' | gzip > /backups/tutorlink-$(date +%F).sql.gz
```

Copy backups off the server. Uploaded photos live in the `tutorlink_uploads` Docker volume; back it up too.

Update to a new version:

```bash
git pull
docker compose up -d --build
```

Migrations run automatically on start.

## 8. Go-live checklist

- [ ] `https://yourdomain.com/health` returns `{"status":"ok"...}`
- [ ] Sign up as student and teacher; log in; log out
- [ ] Book a class; pay with Razorpay **test** keys; booking becomes paid (webhook works)
- [ ] Teacher My Students and student My tuition pages load (migration 22 applied)
- [ ] Email verification and password-reset mails arrive (SMTP)
- [ ] OTP SMS works, or the feature is off (Twilio and India DLT registration)
- [ ] Admin password changed; leaked secrets rotated
- [ ] `sitemap.xml` and `robots.txt` use the real domain
- [ ] Privacy and Terms pages reviewed
- [ ] Switch `CSP_MODE` from `report-only` to enforcing only after the browser console shows no CSP reports
- [ ] Switch Razorpay to live keys last, then make one real small payment and refund it
- [ ] Backups restore correctly (test a restore once)

## 9. Troubleshooting

| Symptom                                         | Likely cause                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `500` on a new endpoint                       | Migration not applied: `docker compose logs app`, then `docker compose exec app node database/migrate.js` |
| Razorpay `401 Authentication failed`          | Wrong or malformed key/secret line in `.env`; fix and `docker compose up -d`                              |
| Login works but API calls fail with CORS errors | `ALLOWED_ORIGIN` does not exactly match the site origin                                                     |
| Rate limits hit all users at once               | `TRUST_PROXY` not set, so every request looks like the proxy IP                                             |
| Photos vanish after redeploy                    | `tutorlink_uploads` volume not mounted                                                                      |
