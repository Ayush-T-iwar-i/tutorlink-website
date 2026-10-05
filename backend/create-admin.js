// Creates (or reports on) an administrator account. Nothing secret lives in this file.
//
//   Interactive:       npm run admin:create
//   Non-interactive:   ADMIN_NAME="..." ADMIN_EMAIL="..." ADMIN_PHONE="9XXXXXXXXX" ADMIN_PASSWORD="..." npm run admin:create
//
// The password must satisfy the same policy as normal signup. It is hashed with bcrypt and is never
// printed or logged. Run it once per administrator, from the backend/ folder.

require('dotenv').config();
const readline = require('readline');
const db = require('./config/db');
const passwords = require('./lib/passwords');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[6-9]\d{9}$/;

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(question); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function value(envName, question, opts) {
  return (process.env[envName] || '').trim() || ask(question, opts);
}

async function createAdmin() {
  await db.query('SELECT 1'); // fail early (and let the pool finish connecting) before asking anything
  const name = await value('ADMIN_NAME', 'Full name: ');
  const email = (await value('ADMIN_EMAIL', 'Email: ')).toLowerCase();
  const phone = await value('ADMIN_PHONE', 'Mobile number (10 digits): ');
  const password = (process.env.ADMIN_PASSWORD || '') || await ask('Password (hidden): ', { hidden: true });

  if (name.length < 2 || name.length > 120) throw new Error('Name must be 2-120 characters.');
  if (!EMAIL_RE.test(email) || email.length > 150) throw new Error('Please provide a valid email address.');
  if (!PHONE_RE.test(phone)) throw new Error('Please provide a valid 10-digit Indian mobile number.');
  const weak = passwords.validatePassword(password);
  if (weak) throw new Error(weak);

  const [existing] = await db.query('SELECT id FROM users WHERE email = ? OR phone = ?', [email, phone]);
  if (existing.length > 0) throw new Error('A user with this email or phone number already exists.');

  await db.query(
    "INSERT INTO users (name, email, phone, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 'admin', 1)",
    [name, email, phone, await passwords.hashPassword(password)]
  );
  console.log(`✅ Admin account created for ${email}. Log in at /login.html — you will land on the admin dashboard.`);
}

createAdmin()
  .catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.end().catch(() => {}));