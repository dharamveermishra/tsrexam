import { Router } from 'express';
import multer from 'multer';
import { pool, audit } from './db.js';
import { requireTeacher } from './auth.js';
import { isUuid, sniffImage, newSlug, csvCell, normalizeExamSchedule } from './lib.js';
import { getOrCreateResponsePdf } from './pdf.js';
import { queueResponseEmail, processEmailQueue, mailConfigured } from './mail.js';

const router = Router();
router.use(requireTeacher);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 } });

// Every query below filters by teacher_id: ownership is enforced in SQL, deny by default.
const ownedTest = async (id, teacherId) => {
  if (!isUuid(id)) return null;
  const { rows: [t] } = await pool.query('SELECT * FROM tests WHERE id=$1 AND teacher_id=$2', [id, teacherId]);
  return t || null;
};
const ownedAttempt = async (id, teacherId) => {
  if (!isUuid(id)) return null;
  const { rows: [a] } = await pool.query(
    `SELECT a.*, t.title AS test_title, t.version AS test_version, t.show_photos, t.pass_percent, t.id AS tid
     FROM attempts a JOIN tests t ON t.id=a.test_id WHERE a.id=$1 AND t.teacher_id=$2`, [id, teacherId]);
  return a || null;
};

router.get('/me', (req, res) => res.json(req.user));

router.get('/tests', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id,t.title,t.status,t.slug,t.duration_minutes,t.version,t.created_at,
       (SELECT count(*) FROM questions q WHERE q.test_id=t.id)::int AS question_count,
       (SELECT count(*) FROM attempts a WHERE a.test_id=t.id)::int AS attempt_count
     FROM tests t WHERE t.teacher_id=$1 ORDER BY t.created_at DESC`, [req.user.id]);
  res.json(rows);
});

router.post('/tests', async (req, res) => {
  const b = req.body || {};
  const num = (v, lo, hi, d) => { const n = Number(v ?? d); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
  const f = {
    title: typeof b.title === 'string' ? b.title.trim().slice(0, 200) : '',
    instructions: typeof b.instructions === 'string' ? b.instructions.slice(0, 5000) : '',
    duration: num(b.durationMinutes, 1, 600, 60), neg: num(b.negativeMarking, 0, 10, 0),
    pass: num(b.passPercent, 0, 100, 40), warn: num(b.maxWarnings, 0, 50, 4), ret: num(b.retentionDays, 1, 3650, 90),
  };
  if (!f.title || [f.duration, f.neg, f.pass, f.warn, f.ret].includes(null)) return res.status(400).json({ error: 'Check the test settings' });
  const schedule = normalizeExamSchedule(b);
  if (!schedule.valid) return res.status(400).json({ error: 'Enter all three schedule times in order, with the exam start before login closes and login closing before final submission.' });
  const code = typeof b.accessCode === 'string' && b.accessCode.trim() ? b.accessCode.trim().slice(0, 40) : null;
  const { rows: [t] } = await pool.query(
    `INSERT INTO tests(teacher_id,slug,title,instructions,duration_minutes,access_code,require_photo,negative_marking,pass_percent,
       max_warnings,on_limit,no_back,shuffle,release_result,show_photos,retention_days,
       exam_start_at,login_deadline_at,final_submission_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [req.user.id, newSlug(), f.title, f.instructions, f.duration, code, b.requirePhoto !== false, f.neg, f.pass, f.warn,
      b.onLimit === 'terminate' ? 'terminate' : 'flag', !!b.noBack, b.shuffle !== false, b.releaseResult !== false,
      b.showPhotos !== false, f.ret, schedule.schedule.examStartAt, schedule.schedule.loginDeadlineAt,
      schedule.schedule.finalSubmissionAt]);
  audit(req.user.id, 'test.create', t.id, {}, req.ip);
  res.json({ id: t.id });
});

router.put('/tests/:id/schedule', async (req, res) => {
  const t = await ownedTest(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.status === 'archived') return res.status(409).json({ error: 'Archived tests cannot be rescheduled' });
  const schedule = normalizeExamSchedule(req.body || {});
  if (!schedule.valid) return res.status(400).json({ error: 'Enter all three schedule times in order, with the exam start before login closes and login closing before final submission.' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `UPDATE tests SET exam_start_at=$2,login_deadline_at=$3,final_submission_at=$4 WHERE id=$1`,
      [t.id, schedule.schedule.examStartAt, schedule.schedule.loginDeadlineAt, schedule.schedule.finalSubmissionAt]);
    await c.query(
      `UPDATE attempts a SET deadline_at=CASE WHEN t.final_submission_at IS NULL
          THEN a.started_at + make_interval(mins => t.duration_minutes)
          ELSE LEAST(a.started_at + make_interval(mins => t.duration_minutes),t.final_submission_at) END
       FROM tests t WHERE a.test_id=t.id AND t.id=$1 AND a.status='in_progress'`,
      [t.id]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally { c.release(); }
  audit(req.user.id, 'test.schedule', t.id, schedule.schedule, req.ip);
  res.json({ ok: true, schedule: schedule.schedule });
});

router.get('/tests/:id', async (req, res) => {
  const t = await ownedTest(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const { rows: questions } = await pool.query(
    `SELECT id,position,text,options,correct_index,marks,(image_data IS NOT NULL) AS has_image
     FROM questions WHERE test_id=$1 ORDER BY position,id`, [t.id]);
  res.json({ test: t, questions });
});

router.post('/tests/:id/status', async (req, res) => {
  const t = await ownedTest(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const to = req.body?.status;
  const allowed = { draft: ['published'], published: ['closed'], closed: ['archived', 'published'] };
  if (!(allowed[t.status] || []).includes(to)) return res.status(409).json({ error: `Cannot go from ${t.status} to ${to}` });
  if (to === 'published') {
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int n FROM questions WHERE test_id=$1', [t.id]);
    if (!n) return res.status(409).json({ error: 'Add at least one question first' });
  }
  await pool.query('UPDATE tests SET status=$2, published_at=CASE WHEN $2=\'published\' THEN COALESCE(published_at,now()) ELSE published_at END WHERE id=$1', [t.id, to]);
  audit(req.user.id, 'test.status', t.id, { to }, req.ip);
  res.json({ ok: true });
});

// Published tests are immutable. To change one, duplicate it into a new draft (new version).
router.post('/tests/:id/duplicate', async (req, res) => {
  const t = await ownedTest(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [n] } = await c.query(
      `INSERT INTO tests(teacher_id,slug,title,instructions,duration_minutes,access_code,require_photo,negative_marking,pass_percent,
         max_warnings,on_limit,no_back,shuffle,release_result,show_photos,retention_days,version,parent_test_id)
       SELECT teacher_id,$2,title,instructions,duration_minutes,access_code,require_photo,negative_marking,pass_percent,
         max_warnings,on_limit,no_back,shuffle,release_result,show_photos,retention_days,version+1,id FROM tests WHERE id=$1 RETURNING id`,
      [t.id, newSlug()]);
    await c.query(
      `INSERT INTO questions(test_id,position,text,options,correct_index,marks,image_mime,image_data)
       SELECT $2,position,text,options,correct_index,marks,image_mime,image_data FROM questions WHERE test_id=$1`, [t.id, n.id]);
    await c.query('COMMIT');
    audit(req.user.id, 'test.duplicate', t.id, { newId: n.id }, req.ip);
    res.json({ id: n.id });
  } catch (e) { await c.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'Server error' }); } finally { c.release(); }
});

router.post('/tests/:id/questions', upload.single('image'), async (req, res) => {
  const t = await ownedTest(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.status !== 'draft') return res.status(409).json({ error: 'Published tests cannot be edited. Duplicate it to make a new version.' });
  let options; try { options = JSON.parse(req.body.options); } catch { options = null; }
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  const ci = Number(req.body.correctIndex); const marks = Number(req.body.marks ?? 1);
  if (!text || text.length > 4000 || !Array.isArray(options) || options.length < 2 || options.length > 8 ||
      !options.every((o) => typeof o === 'string' && o.trim() && o.length <= 500) ||
      !Number.isInteger(ci) || ci < 0 || ci >= options.length || !(marks > 0 && marks <= 100))
    return res.status(400).json({ error: 'Check the question, options (2-8), correct answer and marks' });
  let mime = null, data = null;
  if (req.file) {
    mime = sniffImage(req.file.buffer);
    if (!mime) return res.status(415).json({ error: 'Image must be JPEG, PNG or WebP' });
    data = req.file.buffer;
  }
  const { rows: [{ pos }] } = await pool.query('SELECT COALESCE(max(position),0)+1 AS pos FROM questions WHERE test_id=$1', [t.id]);
  const { rows: [q] } = await pool.query(
    'INSERT INTO questions(test_id,position,text,options,correct_index,marks,image_mime,image_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [t.id, pos, text, JSON.stringify(options.map((o) => o.trim())), ci, marks, mime, data]);
  res.json({ id: q.id });
});

router.delete('/tests/:id/questions/:qid', async (req, res) => {
  const t = await ownedTest(req.params.id, req.user.id);
  if (!t || !isUuid(req.params.qid)) return res.status(404).json({ error: 'Not found' });
  if (t.status !== 'draft') return res.status(409).json({ error: 'Published tests cannot be edited' });
  await pool.query('DELETE FROM questions WHERE id=$1 AND test_id=$2', [req.params.qid, t.id]);
  res.json({ ok: true });
});

router.get('/questions/:qid/image', async (req, res) => {
  if (!isUuid(req.params.qid)) return res.status(404).end();
  const { rows: [q] } = await pool.query(
    `SELECT q.image_mime,q.image_data FROM questions q JOIN tests t ON t.id=q.test_id WHERE q.id=$1 AND t.teacher_id=$2`,
    [req.params.qid, req.user.id]);
  if (!q?.image_data) return res.status(404).end();
  res.set({ 'Content-Type': q.image_mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(q.image_data);
});

const RESULTS_SQL = `SELECT a.id,a.student_name,a.class_name,a.roll_no,a.student_email,
  (SELECT e.status FROM email_log e WHERE e.attempt_id=a.id AND e.kind='response' ORDER BY e.created_at DESC LIMIT 1) AS email_status,
  (SELECT e.error FROM email_log e WHERE e.attempt_id=a.id AND e.kind='response' ORDER BY e.created_at DESC LIMIT 1) AS email_error,a.status,a.end_reason,a.started_at,a.submitted_at,
  a.score,a.total,a.correct,a.wrong,a.unanswered,a.warnings,a.flagged,a.photo_reviewed,a.note,a.submission_mode,
  EXISTS(SELECT 1 FROM response_reports rp WHERE rp.attempt_id=a.id) AS response_pdf_saved,
  CASE WHEN a.total>0 THEN round(a.score/a.total*100,2) END AS percent,
  EXISTS(SELECT 1 FROM photos p WHERE p.attempt_id=a.id AND p.kind='start') AS has_start,
  EXISTS(SELECT 1 FROM photos p WHERE p.attempt_id=a.id AND p.kind='final') AS has_final
  FROM attempts a WHERE a.test_id=$1 ORDER BY a.created_at DESC`;

router.get('/tests/:id/results', async (req, res) => {
  const t = await ownedTest(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json((await pool.query(RESULTS_SQL, [t.id])).rows);
});

router.get('/tests/:id/results.csv', async (req, res) => {
  const t = await ownedTest(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const { rows } = await pool.query(RESULTS_SQL, [t.id]);
  const cols = ['student_name', 'class_name', 'roll_no', 'student_email', 'status', 'end_reason', 'submission_mode', 'started_at', 'submitted_at', 'score', 'total', 'percent',
    'correct', 'wrong', 'unanswered', 'warnings', 'flagged', 'has_start', 'has_final', 'photo_reviewed'];
  const csv = '\ufeff' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c] instanceof Date ? r[c].toISOString() : r[c])).join(','))].join('\r\n');
  audit(req.user.id, 'results.export', t.id, {}, req.ip);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="results.csv"', 'Cache-Control': 'private, no-store' });
  res.send(csv);
});

router.get('/attempts/:id', async (req, res) => {
  const a = await ownedAttempt(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const { rows: events } = await pool.query('SELECT type,severity,counted,created_at FROM integrity_events WHERE attempt_id=$1 ORDER BY created_at', [a.id]);
  const { rows: photos } = await pool.query('SELECT kind,captured_at,uploaded_at FROM photos WHERE attempt_id=$1', [a.id]);
  const { token_hash, question_order, option_orders, ip, ...safe } = a;
  res.json({ attempt: safe, events, photos });
});

router.get('/attempts/:id/photo/:kind', async (req, res) => {
  if (!['start', 'final'].includes(req.params.kind)) return res.status(400).end();
  const a = await ownedAttempt(req.params.id, req.user.id);
  if (!a) return res.status(404).end();
  const { rows: [p] } = await pool.query('SELECT mime,data FROM photos WHERE attempt_id=$1 AND kind=$2', [a.id, req.params.kind]);
  if (!p) return res.status(404).end();
  audit(req.user.id, 'photo.view', a.id, { kind: req.params.kind }, req.ip);
  res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(p.data);
});

router.delete('/attempts/:id/photo/:kind', async (req, res) => {
  if (!['start', 'final'].includes(req.params.kind)) return res.status(400).end();
  const a = await ownedAttempt(req.params.id, req.user.id);
  if (!a) return res.status(404).end();
  await pool.query('DELETE FROM photos WHERE attempt_id=$1 AND kind=$2', [a.id, req.params.kind]);
  audit(req.user.id, 'photo.delete', a.id, { kind: req.params.kind }, req.ip);
  res.json({ ok: true });
});

router.patch('/attempts/:id/review', async (req, res) => {
  const a = await ownedAttempt(req.params.id, req.user.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const { flagged, photoReviewed, note } = req.body || {};
  await pool.query(
    `UPDATE attempts SET flagged=COALESCE($2,flagged), photo_reviewed=COALESCE($3,photo_reviewed), note=COALESCE($4,note) WHERE id=$1`,
    [a.id, typeof flagged === 'boolean' ? flagged : null, typeof photoReviewed === 'boolean' ? photoReviewed : null,
      typeof note === 'string' ? note.slice(0, 2000) : null]);
  audit(req.user.id, 'attempt.review', a.id, { flagged, photoReviewed }, req.ip);
  res.json({ ok: true });
});

const FINISHED = ['photo_pending', 'submitted', 'photo_missing', 'terminated'];

router.get('/attempts/:id/response.pdf', async (req, res) => {
  const a = await ownedAttempt(req.params.id, req.user.id);
  if (!a || !FINISHED.includes(a.status)) return res.status(404).json({ error: 'No finished attempt found' });
  const { buffer, filename } = await getOrCreateResponsePdf(a.id);
  audit(req.user.id, 'response.pdf', a.id, {}, req.ip);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'private, no-store' });
  res.send(buffer);
});

router.post('/attempts/:id/send-response', async (req, res) => {
  if (!mailConfigured()) return res.status(503).json({ error: 'Email is not set up on the server yet (SMTP settings missing).' });
  const a = await ownedAttempt(req.params.id, req.user.id);
  if (!a || !FINISHED.includes(a.status)) return res.status(409).json({ error: 'The student has not finished the test' });
  if (!a.student_email) return res.status(409).json({ error: 'No email address for this student' });
  const queued = await queueResponseEmail(a.id);
  audit(req.user.id, 'response.email', a.id, {}, req.ip);
  processEmailQueue().catch(console.error);
  res.status(202).json({ queued });
});

// Queues emails for every finished student who has not already received (or is not waiting for) one.
router.post('/tests/:id/send-responses', async (req, res) => {
  if (!mailConfigured()) return res.status(503).json({ error: 'Email is not set up on the server yet (SMTP settings missing).' });
  const t = await ownedTest(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const { rows } = await pool.query(
    `SELECT a.id FROM attempts a WHERE a.test_id=$1 AND a.status = ANY($2) AND a.student_email IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.attempt_id=a.id AND e.kind='response' AND e.status IN ('sent','queued','sending'))`,
    [t.id, FINISHED]);
  let queued = 0;
  for (const r of rows) if (await queueResponseEmail(r.id)) queued++;
  audit(req.user.id, 'response.email_all', t.id, { queued }, req.ip);
  processEmailQueue().catch(console.error);
  res.status(202).json({ queued });
});

export default router;
