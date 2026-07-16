// MySQL database connection
const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test the connection once when the server starts
pool.getConnection((err, connection) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
    console.error('   Full error:', err);
    console.error('   Check your .env file (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)');
  } else {
    console.log('✅ Connected to MySQL database:', process.env.DB_NAME);
    connection.release();
  }
});

module.exports = pool.promise();