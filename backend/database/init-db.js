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

    // 1) Base schema (creates the DB + all core tables)
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    await connection.query(schemaSql);
    console.log('✅ Base schema applied.');

    const dbName = process.env.DB_NAME || 'tutorlink';
    await connection.query(`USE \`${dbName}\`;`);

    // 2) Every migration_*.sql file, sorted numerically (so migration_10 runs
    //    after migration_2, not before — plain alphabetical sort gets this wrong)
    const files = fs.readdirSync(__dirname)
      .filter((f) => /^migration_\d+.*\.sql$/i.test(f))
      .sort((a, b) => {
        const numA = parseInt(a.match(/^migration_(\d+)/)[1], 10);
        const numB = parseInt(b.match(/^migration_(\d+)/)[1], 10);
        return numA - numB;
      });

    for (const file of files) {
      const sql = fs.readFileSync(path.join(__dirname, file), 'utf-8');
      try {
        await connection.query(sql);
        console.log(`✅ Migration applied: ${file}`);
      } catch (migErr) {
           if (migErr.code === 'ER_DUP_FIELDNAME' || migErr.code === 'ER_TABLE_EXISTS_ERROR' || migErr.code === 'ER_DUP_KEYNAME') {
          console.log(`↪️  Skipped (already applied): ${file}`);
        } else {
          throw new Error(`Migration "${file}" failed: ${migErr.message}`);
        }
      }
    }

    console.log(`✅ Database fully initialized (schema + ${files.length} migrations)!`);
  } catch (err) {
    console.error('\n❌ Database initialization error:', err.message);
    if (err.code === 'ECONNREFUSED') {
      console.error('\n⚠️  Could not connect to MySQL server at ' + dbHost + ':3306.');
      console.error('👉 Make sure your MySQL database server is running.\n');
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