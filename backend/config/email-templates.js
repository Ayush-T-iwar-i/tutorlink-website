// ============================================
// TutorLink — Email templates
// Every outgoing email's HTML lives here instead of scattered inline
// strings across route files, so copy/branding only needs updating once.
// ============================================

const BRAND_COLOR = '#1F6E4A';

function layout(bodyHtml) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1C1E22;">
      <div style="padding: 20px 0; border-bottom: 2px solid ${BRAND_COLOR};">
        <span style="font-size: 20px; font-weight: 700; color: #16233F;">Tutor<span style="color:${BRAND_COLOR}; font-style:italic;">Link</span></span>
      </div>
      <div style="padding: 24px 0; line-height: 1.6; font-size: 14.5px;">
        ${bodyHtml}
      </div>
      <div style="padding-top: 16px; border-top: 1px solid #E2DFD3; font-size: 12px; color: #6C7689;">
        You're receiving this because you have a TutorLink account.
      </div>
    </div>
  `;
}

const templates = {
  passwordReset: (resetLink) => ({
    subject: 'Reset your TutorLink password',
    html: layout(`
      <p>Hi,</p>
      <p>We got a request to reset your TutorLink password. This link expires in 1 hour:</p>
      <p><a href="${resetLink}" style="color:${BRAND_COLOR};">${resetLink}</a></p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `),
  }),

  newBookingRequest: ({ teacherName, studentName, type, subject, date, time }) => ({
    subject: 'New booking request on TutorLink',
    html: layout(`
      <p>Hi ${teacherName},</p>
      <p><strong>${studentName}</strong> requested a ${type || 'demo'} class${subject ? ' for ' + subject : ''}
         on ${date || 'a date to be confirmed'} at ${time || 'a time to be confirmed'}.</p>
      <p>Log in to your TutorLink dashboard to accept or decline.</p>
    `),
  }),

  bookingStatusChanged: ({ studentName, status }) => ({
    subject: `Your TutorLink booking was ${status}`,
    html: layout(`
      <p>Hi ${studentName},</p>
      <p>Your class request has been <strong>${status}</strong> by the teacher.</p>
    `),
  }),

  classReminderStudent: ({ studentName, teacherName, whenText }) => ({
    subject: `Reminder: your class is soon`,
    html: layout(`
      <p>Hi ${studentName},</p>
      <p>Your class with <strong>${teacherName}</strong> is at ${whenText}.</p>
    `),
  }),

  classReminderTeacher: ({ teacherName, studentName, whenText }) => ({
    subject: `Reminder: you have a class soon`,
    html: layout(`
      <p>Hi ${teacherName},</p>
      <p>Your class with <strong>${studentName}</strong> is at ${whenText}.</p>
    `),
  }),

  paymentReceived: ({ teacherName }) => ({
    subject: 'Payment received on TutorLink',
    html: layout(`
      <p>Hi ${teacherName},</p>
      <p>A student just paid for their class. Check your Earnings tab for details.</p>
    `),
  }),

  emailVerification: (verifyLink) => ({
    subject: 'Verify your TutorLink email address',
    html: layout(`
      <p>Hi,</p>
      <p>Thank you for joining TutorLink! Please click the link below to verify your email address. This link is valid for 24 hours:</p>
      <p><a href="${verifyLink}" style="display:inline-block; padding:10px 20px; background:${BRAND_COLOR}; color:#fff; text-decoration:none; border-radius:6px; font-weight:600;">Verify Email</a></p>
      <p>Or paste this link into your browser:</p>
      <p><a href="${verifyLink}" style="color:${BRAND_COLOR};">${verifyLink}</a></p>
      <p>If you did not sign up for TutorLink, you can safely ignore this email.</p>
    `),
  }),
};

module.exports = templates;