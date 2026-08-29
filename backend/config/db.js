// MySQL database connection pool
const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tutorlink',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Test the connection once when the server starts
pool.getConnection((err, connection) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
    if (err.code === 'ECONNREFUSED') {
      console.error('   ⚠️ MySQL server is not running on ' + (process.env.DB_HOST || 'localhost') + ':3306.');
      console.error('   👉 Start MySQL (via XAMPP, Windows Service, or `docker-compose up -d db`).');
    } else {
      console.error('   Check your .env file (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)');
    }
  } else {
    console.log('✅ Connected to MySQL database:', process.env.DB_NAME || 'tutorlink');
    connection.release();
  }
});

module.exports = pool.promise();