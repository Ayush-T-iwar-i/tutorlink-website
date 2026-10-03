/**
 * Run `fn(connection)` inside a database transaction.
 * Commits on success, rolls back on any thrown error, always releases the connection.
 * Retries automatically (up to `retries` times) when MySQL aborts the transaction as a
 * deadlock victim or a lock-wait timeout — both are safe to retry because nothing was committed.
 */
async function withTransaction(db, fn, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      try { await conn.rollback(); } catch (_) { /* connection already dead */ }
      const retryable = err && (err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT');
      if (retryable && attempt < retries) continue;
      throw err;
    } finally {
      conn.release();
    }
  }
}

module.exports = { withTransaction };