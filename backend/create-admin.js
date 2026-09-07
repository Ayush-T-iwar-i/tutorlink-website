// One-time script to create an admin account.
// Run from inside the backend/ folder:   node create-admin.js
// Delete this file afterwards — it's not meant to stay in the project.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./config/db');

// 👇 Edit these 4 values before running
const ADMIN_NAME = 'Admin';
const ADMIN_EMAIL = 'Ayush879145@gmail.com';
const ADMIN_PHONE = '9027078590';       // must be a valid-looking 10-digit number
const ADMIN_PASSWORD = '147258369Ay#'; // change this to something strong

async function createAdmin() {
  try {
    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);
    if (existing.length > 0) {
      console.log('❌ A user with this email already exists. Pick a different ADMIN_EMAIL.');
      process.exit(1);
    }

    const password_hash = await bcrypt.hash(ADMIN_PASSWORD, 10);

    await db.query(
      'INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      [ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE, password_hash, 'admin']
    );

    console.log('✅ Admin account created successfully!');
    console.log(`   Email:    ${ADMIN_EMAIL}`);
    console.log(`   Password: ${ADMIN_PASSWORD}`);
    console.log('   Log in at login.html with these credentials — you will land on admin-dashboard.html.');
    console.log('\n⚠️  Delete this create-admin.js file now that the account is made.');
  } catch (err) {
    console.error('Error creating admin:', err.message);
  } finally {
    process.exit(0);
  }
}

createAdmin();