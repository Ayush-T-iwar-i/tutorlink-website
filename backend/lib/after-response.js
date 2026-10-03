/**
 * Run slow, non-critical work (emails, SMS, notifications) AFTER the HTTP response has been
 * sent, so users are never kept waiting on an email provider. Failures are logged, never thrown.
 * Pending work is tracked so graceful shutdown (and tests) can wait for it with drain().
 */
const pending = new Set();

function runAfterResponse(res, label, fn) {
  const run = () => {
    const p = Promise.resolve()
      .then(fn)
      .catch((err) => console.error(`${label} failed:`, err))
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  if (res.writableEnded) run();
  else res.once('finish', run);
}

async function drain() {
  await new Promise((resolve) => setImmediate(resolve));
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

module.exports = { runAfterResponse, drain };