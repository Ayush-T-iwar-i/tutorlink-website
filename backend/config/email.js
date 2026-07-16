const nodemailer = require('nodemailer');

const isConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transporter = null;
if (isConfigured) {
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

/**
 * Sends an email if SMTP is configured; otherwise logs it to the console
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

  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"TutorLink" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
  });
}

module.exports = { sendMail, isConfigured };