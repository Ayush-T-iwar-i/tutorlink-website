const isConfigured = !!(
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_PHONE_NUMBER
);

let client = null;
if (isConfigured) {
  const twilio = require('twilio');
  client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

/**
 * Sends an SMS if Twilio is configured; otherwise logs it to the console
 * so local development keeps working without a Twilio account.
 * @param {string} to - phone number, e.g. "+919876543210" (include country code)
 * @param {string} body - message text (keep under ~150 chars)
 */
async function sendSms(to, body) {
  if (!isConfigured) {
    console.log(`[sms — Twilio not configured, logging instead] To: ${to} | ${body}`);
    return;
  }

  // Indian 10-digit numbers are stored without a country code — add +91
  // if nothing was provided, since Twilio requires E.164 format.
  const formattedTo = to.startsWith('+') ? to : `+91${to}`;

  try {
    await client.messages.create({
      to: formattedTo,
      from: process.env.TWILIO_PHONE_NUMBER,
      body,
    });
  } catch (err) {
    // SMS failures should never break the booking/signup flow they're
    // attached to — log and move on.
    console.error('SMS send failed:', err.message);
  }
}

module.exports = { sendSms, isConfigured };