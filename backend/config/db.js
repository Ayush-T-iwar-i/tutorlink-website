// MySQL database connection pool
const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tutorlink',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_POOL_SIZE, 10) || 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  // Return DATE columns as plain 'YYYY-MM-DD' strings. The default (a JS Date at the
  // server's local midnight) shifts the day by one when serialised with toISOString()
  // on any server that is not in UTC.
  dateStrings: ['DATE'],
});

// Test the connection once when the server starts (skipped under Jest)
if (process.env.NODE_ENV !== 'test') {
  pool.getConnection((err, connection) => {
    if (err) {
      console.error('❌ Database connection failed:', err.message);
      if (err.code === 'ECONNREFUSED') {
        console.error('   ⚠️ MySQL server is not running on ' + (process.env.DB_HOST || 'localhost') + ':3306.');
        console.error('   👉 Start MySQL (via XAMPP, Windows Service, or `docker compose up -d db`).');
      } else {
        console.error('   Check your .env file (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)');
      }
    } else {
      console.log('✅ Connected to MySQL database:', process.env.DB_NAME || 'tutorlink');
      connection.release();
    }
  });
}

module.exports = pool.promise();