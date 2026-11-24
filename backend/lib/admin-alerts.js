const db = require('../config/db');
const { createNotification } = require('../routes/notification.routes');


async function notifyAdmins(message, link = 'admin-dashboard.html') {
  try {
    const [admins] = await db.query("SELECT id FROM users WHERE role = 'admin'");
    for (const a of admins || []) await createNotification(a.id, String(message).slice(0, 250), link);
  } catch (err) {
    console.error('Admin alert failed:', err);
  }
}

module.exports = { notifyAdmins };