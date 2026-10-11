import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { pool } from './db.js';
import auth from './auth.js';
import teacher from './teacher.js';
import student, { processDueAttempts, processPendingResponseReports } from './student.js';
import { processEmailQueue } from './mail.js';

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 2));
app.use(helmet());
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));

// CSRF defence: no CORS is enabled, and every state-changing call must carry a custom header
// (browsers cannot add it cross-site without a CORS preflight, which is refused) + SameSite=Lax cookies.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (req.get('x-requested-with') !== 'tsr') return res.status(403).json({ error: 'csrf' });
    const origin = req.get('origin');
    if (origin && process.env.APP_ORIGIN && origin !== process.env.APP_ORIGIN) return res.status(403).json({ error: 'origin' });
  }
  next();
});

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});
app.use('/api/auth', auth);
app.use('/api/teacher', teacher);
app.use('/api', student);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// Photo retention: delete photos older than each test's retention_days (runs hourly).
async function purge() {
  try {
    const r = await pool.query(
      `DELETE FROM photos p USING attempts a, tests t WHERE p.attempt_id=a.id AND a.test_id=t.id
       AND p.uploaded_at < now() - make_interval(days => t.retention_days)`);
    if (r.rowCount) {
      console.log('retention purge removed', r.rowCount, 'photos');
      await pool.query(`INSERT INTO audit_log(action,target,meta) VALUES('photo.retention_purge','system',$1)`, [JSON.stringify({ count: r.rowCount })]);
    }
  } catch (e) { console.error('purge failed', e.message); }
}
setInterval(purge, 60 * 60 * 1000).unref();
let submissionSweepRunning = false;
setInterval(() => {
  if (submissionSweepRunning) return;
  submissionSweepRunning = true;
  processDueAttempts()
    .catch((e) => console.error('automatic submission sweep failed', e.message))
    .finally(() => { submissionSweepRunning = false; });
}, 1000).unref();
setInterval(() => {
  processPendingResponseReports().catch((e) => console.error('response report recovery failed', e.message));
}, 30 * 1000).unref();
// Email queue: pick up queued/retry jobs (also survives restarts because it lives in the database).
setInterval(() => processEmailQueue().catch(console.error), 30 * 1000).unref();

const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log('TSR exam API listening on', port));
