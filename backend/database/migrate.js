/**
 * TutorLink migration runner.
 *
 *  - Creates the database named by DB_NAME if it does not exist.
 *  - Applies schema.sql, then every migration_<N>_*.sql in numeric order.
 *  - Records each applied file in the `schema_migrations` table, so re-running is a no-op.
 *  - Executes statement-by-statement. "Already applied" errors (duplicate column / key /
 *    table) are tolerated per statement, so databases created by older versions of the
 *    project (which have no tracking table) upgrade cleanly without skipping the rest of a file.
 *  - Takes a MySQL advisory lock so two containers starting together never migrate concurrently.
 *
 * Usage:  node database/migrate.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// MySQL error codes that mean "this change is already in place".
const ALREADY_APPLIED = new Set([
  'ER_DUP_FIELDNAME',            // ADD COLUMN that exists
  'ER_DUP_KEYNAME',              // ADD INDEX / UNIQUE that exists
  'ER_TABLE_EXISTS_ERROR',       // CREATE TABLE without IF NOT EXISTS
  'ER_FK_DUP_NAME',              // ADD CONSTRAINT FOREIGN KEY that exists
  'ER_CHECK_CONSTRAINT_DUP_NAME',
  'ER_CANT_DROP_FIELD_OR_KEY',   // DROP of something already gone
]);

/**
 * Split a SQL script into individual statements. Understands '...' / "..." / `...`
 * strings, `-- line` comments, `# line` comments and block comments, so a ';' inside
 * any of those never splits a statement.
 */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-' && (sql[i + 2] === ' ' || sql[i + 2] === '\n' || sql[i + 2] === '\t' || i + 2 >= n)) {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '#') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      current += ch;
      i++;
      while (i < n) {
        current += sql[i];
        if (sql[i] === '\\' && quote !== '`') {
          current += sql[i + 1] || '';
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { current += sql[i + 1]; i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

// Older files hard-code the database name. The runner already selects the right
// database, so those statements are dropped rather than rewritten.
function isDatabaseSelector(stmt) {
  return /^(USE\s|CREATE\s+DATABASE\s)/i.test(stmt);
}

function listMigrationFiles(dir) {
  const numbered = fs.readdirSync(dir)
    .filter((f) => /^migration[-_]\d+.*\.sql$/i.test(f))
    .sort((a, b) => parseInt(a.match(/^migration[-_](\d+)/)[1], 10) - parseInt(b.match(/^migration[-_](\d+)/)[1], 10));
  return ['schema.sql', ...numbered];
}

async function runMigrations({ dbName, logger = console, drop = false } = {}) {
  const name = dbName || process.env.DB_NAME || 'tutorlink';
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Invalid DB_NAME "${name}".`);

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4',
  });

  try {
    if (drop) {
      if (!name.endsWith('_test')) throw new Error('Refusing to drop a database whose name does not end in "_test".');
      await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
    }
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.query(`USE \`${name}\``);

    const [[lock]] = await connection.query("SELECT GET_LOCK('tutorlink_migrate', 60) AS got");
    if (!lock.got) throw new Error('Could not acquire migration lock within 60s.');

    await connection.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name VARCHAR(190) PRIMARY KEY,
         applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    );
    const [doneRows] = await connection.query('SELECT name FROM schema_migrations');
    const done = new Set(doneRows.map((r) => r.name));

    let applied = 0;
    for (const file of listMigrationFiles(__dirname)) {
      if (done.has(file)) continue;

      const statements = splitStatements(fs.readFileSync(path.join(__dirname, file), 'utf-8'))
        .filter((s) => !isDatabaseSelector(s));

      for (const stmt of statements) {
        try {
          await connection.query(stmt);
        } catch (err) {
          if (ALREADY_APPLIED.has(err.code)) continue;
          throw new Error(`Migration "${file}" failed: ${err.message}\n  Statement: ${stmt.slice(0, 200)}`);
        }
      }
      await connection.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      logger.log(`✅ Applied ${file}`);
      applied++;
    }

    await connection.query("SELECT RELEASE_LOCK('tutorlink_migrate')");
    logger.log(applied === 0 ? '✅ Database is up to date.' : `✅ Database ready (${applied} file(s) applied).`);
    return applied;
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  runMigrations().catch((err) => {
    console.error('\n❌ Migration failed:', err.message);
    if (err.code === 'ECONNREFUSED') console.error('   MySQL is not reachable. Check DB_HOST / DB_PORT and that the server is running.');
    if (err.code === 'ER_ACCESS_DENIED_ERROR') console.error('   Wrong DB_USER / DB_PASSWORD.');
    process.exit(1);
  });
}

module.exports = { runMigrations, splitStatements };