/**
 * TutorLink — Database Initializer & Migration Runner
 * Run via: npm run db:init
 * Automatically executes the consolidated schema and ensures all tables/columns exist.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function initializeDatabase() {
  console.log('🔄 Initializing TutorLink database...');

  const dbHost = process.env.DB_HOST || 'localhost';
  const dbUser = process.env.DB_USER || 'root';
  const dbPassword = process.env.DB_PASSWORD || '';

  let connection = null;

  try {
    connection = await mysql.createConnection({
      host: dbHost,
      user: dbUser,
      password: dbPassword,
      multipleStatements: true,
    });

    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    await connection.query(schemaSql);
    console.log('✅ Database and all 10 tables initialized successfully!');
  } catch (err) {
    console.error('\n❌ Database initialization error:', err.message);
    if (err.code === 'ECONNREFUSED') {
      console.error('\n⚠️  Could not connect to MySQL server at ' + dbHost + ':3306.');
      console.error('👉 Make sure your MySQL database server is running:');
      console.error('   1. If using XAMPP/WampServer: Open control panel and click "Start" on MySQL.');
      console.error('   2. If using Windows MySQL Service: Start the MySQL service.');
      console.error('   3. If using Docker: Run "docker-compose up -d db"');
      console.error('   4. Verify DB_HOST, DB_USER, and DB_PASSWORD in backend/.env\n');
    } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('\n⚠️  Invalid database username or password. Check backend/.env credentials.\n');
    }
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

if (require.main === module) {
  initializeDatabase();
}

module.exports = initializeDatabase;
