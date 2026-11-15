const nodemailer = require('nodemailer');

// Two ways to send mail:
//  1. BREVO_API_KEY  -> Brevo's HTTPS API (port 443). Use this on hosts that block SMTP ports
//     (for example Render's free plan blocks 25, 465 and 587).
//  2. SMTP_HOST + SMTP_USER + SMTP_PASS -> classic SMTP.
// With neither set, mail is only logged to the console so local development works.
const useApi = !!process.env.BREVO_API_KEY;
const useSmtp = !useApi && !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const isConfigured = useApi || useSmtp;

let transporter = null;
if (useSmtp) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465, // true for port 465, false for others
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/** Splits `Name <address@example.com>` (or a bare address) into { name, email }. */
function parseSender(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$/);
  if (m) return { name: m[1].trim() || 'TutorLink', email: m[2] };
  return { name: 'TutorLink', email: raw };
}

async function sendViaApi({ to, subject, html }) {
  const sender = parseSender(process.env.SMTP_FROM);
  if (!sender.email) throw new Error('SMTP_FROM is required when BREVO_API_KEY is set (e.g. GharTutor <no-reply@yourdomain>).');

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Brevo API responded ${res.status}: ${detail}`);
  }
}

/**
 * Sends an email if a provider is configured; otherwise logs it to the console
 * so local development keeps working without real credentials.
 * @param {{to: string, subject: string, html: string}} opts
 */
async function sendMail({ to, subject, html }) {
  if (!isConfigured) {
    console.log('--------------------------------------------------');
    console.log('[email — SMTP not configured, logging instead]');
    console.log('To:', to);
    console.log('Subject:', subject);
    console.log(html.replace(/<[^>]+>/g, ' ').trim());
    console.log('--------------------------------------------------');
    return;
  }

  if (useApi) return sendViaApi({ to, subject, html });

  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"TutorLink" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
  });
}

module.exports = { sendMail, isConfigured, parseSender };