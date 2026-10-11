import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { pool } from './db.js';
import { isUuid, sniffImage, shuffle, gradeAnswers, hashToken, newToken } from './lib.js';
import { getOrCreateResponsePdf } from './pdf.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
const regLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const QUALIFYING = new Set(['tab_hidden', 'fullscreen_exit']);
const EVENT_TYPES = new Set(['tab_hidden', 'fullscreen_exit', 'blur', 'offline']);

/** Idempotent, transactional finalisation. Answers are always graded from what the server stored. */
export async function finalize(attemptId, reason) {
  const c = await pool.connect();
  let finalized;
  try {
    await c.query('BEGIN');
    const { rows: [a] } = await c.query(
      `SELECT a.*, t.negative_marking, t.require_photo, t.final_submission_at
       FROM attempts a JOIN tests t ON t.id=a.test_id
       WHERE a.id=$1 FOR UPDATE OF a`, [attemptId]);
    if (!a) throw new Error('Attempt not found during finalization');
    if (a.status !== 'in_progress') {
      finalized = a;
      await c.query('COMMIT');
    } else {
      let finalReason = reason;
      if (reason === 'submitted') {
        const { rows: [clock] } = await c.query('SELECT now() AS server_now');
        const reachedDurationDeadline = a.deadline_at && new Date(a.deadline_at) <= clock.server_now;
        const reachedFinalDeadline = a.final_submission_at && new Date(a.final_submission_at) <= clock.server_now;
        if (reachedDurationDeadline || reachedFinalDeadline) finalReason = 'timeout';
      }
      const { rows } = await c.query(
        `SELECT q.marks, q.correct_index, ans.selected_index FROM questions q
         LEFT JOIN answers ans ON ans.question_id=q.id AND ans.attempt_id=$1 WHERE q.test_id=$2`,
        [attemptId, a.test_id]);
      const g = gradeAnswers(rows, a.negative_marking);
      const status = finalReason === 'terminated' ? 'terminated' : a.require_photo ? 'photo_pending' : 'submitted';
      const cutoff = [a.deadline_at, a.final_submission_at]
        .filter(Boolean)
        .sort((left, right) => new Date(left) - new Date(right))[0] || null;
      const { rows: [u] } = await c.query(
        `UPDATE attempts SET status=$2, end_reason=$3,
           submitted_at = CASE WHEN $3='timeout' THEN LEAST(now(), COALESCE($9::timestamptz, now())) ELSE now() END,
           submission_mode = CASE WHEN $3='submitted' THEN 'manual' ELSE 'automatic' END,
           score=$4,total=$5,correct=$6,wrong=$7,unanswered=$8 WHERE id=$1 RETURNING *`,
        [attemptId, status, finalReason, g.score, g.total, g.correct, g.wrong, g.unanswered, cutoff]);
      finalized = u;
      await c.query('COMMIT');
    }
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  if (finalized?.submitted_at) {
    try { await getOrCreateResponsePdf(attemptId); }
    catch (e) { console.error('response PDF generation failed', attemptId, e.message); }
  }
  return finalized;
}

const ATTEMPT_SQL = `SELECT a.*, t.duration_minutes, t.require_photo, t.negative_marking, t.no_back, t.shuffle,
  t.release_result, t.max_warnings, t.on_limit, t.pass_percent, t.status AS test_status, t.title AS test_title,
  t.exam_start_at, t.login_deadline_at, t.final_submission_at,
  (t.exam_start_at IS NOT NULL AND t.exam_start_at > now()) AS not_open,
  (t.login_deadline_at IS NOT NULL AND t.login_deadline_at <= now()) AS login_closed,
  (t.final_submission_at IS NOT NULL AND t.final_submission_at <= now()) AS final_closed,
  (a.deadline_at IS NOT NULL AND LEAST(a.deadline_at,t.final_submission_at) <= now()) AS expired,
  EXTRACT(EPOCH FROM (LEAST(a.deadline_at,t.final_submission_at) - now())) AS remaining,
  EXTRACT(EPOCH FROM (t.final_submission_at - now())) AS final_submission_remaining
  FROM attempts a JOIN tests t ON t.id=a.test_id WHERE a.token_hash=$1`;

export async function processDueAttempts() {
  const { rows } = await pool.query(
    `SELECT a.id FROM attempts a JOIN tests t ON t.id=a.test_id
     WHERE a.status='in_progress'
       AND (a.deadline_at <= now() OR t.final_submission_at <= now())
     ORDER BY LEAST(a.deadline_at,t.final_submission_at) LIMIT 100`);
  for (const { id } of rows) {
    try { await finalize(id, 'timeout'); }
    catch (e) { console.error('automatic submission failed', id, e.message); }
  }
}

export async function processPendingResponseReports() {
  const { rows } = await pool.query(
    `SELECT a.id FROM attempts a
     LEFT JOIN response_reports rp ON rp.attempt_id=a.id
     WHERE a.submitted_at IS NOT NULL AND rp.attempt_id IS NULL
     ORDER BY a.submitted_at DESC LIMIT 20`);
  for (const { id } of rows) {
    try { await getOrCreateResponsePdf(id); }
    catch (e) { console.error('response PDF recovery failed', id, e.message); }
  }
}

async function att(req, res, next) {
  try {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.get('authorization') || '');
    if (!m) return res.status(401).json({ error: 'auth' });
    let { rows: [a] } = await pool.query(ATTEMPT_SQL, [hashToken(m[1])]);
    if (!a) return res.status(401).json({ error: 'auth' });
    if (a.status === 'in_progress' && a.expired) {
      await finalize(a.id, 'timeout'); // the server deadline is never extended
      ({ rows: [a] } = await pool.query(ATTEMPT_SQL, [hashToken(m[1])]));
    }
    req.a = a; next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
}

// ---- Public ----
router.get('/public/test/:slug', async (req, res) => {
  const { rows: [t] } = await pool.query(
    `SELECT title,instructions,duration_minutes,require_photo,no_back,max_warnings,retention_days,show_photos,
            exam_start_at,login_deadline_at,final_submission_at,
            (exam_start_at IS NULL OR exam_start_at <= now()) AS start_open,
            (login_deadline_at IS NULL OR login_deadline_at > now()) AS before_login_deadline,
            (final_submission_at IS NULL OR final_submission_at > now()) AS before_final_deadline,
            (access_code IS NOT NULL) AS needs_code
     FROM tests WHERE slug=$1 AND status='published'`, [req.params.slug]);
  if (!t) return res.status(404).json({ error: 'Test not found or not open' });
  const { start_open, before_login_deadline, before_final_deadline, ...test } = t;
  res.json({
    ...test,
    registrationOpen: start_open && before_login_deadline && before_final_deadline,
    notOpen: !start_open,
    loginClosed: !before_login_deadline,
    finalClosed: !before_final_deadline,
  });
});

router.post('/public/test/:slug/register', regLimiter, async (req, res) => {
  const { name, className, rollNo, email, accessCode, consent } = req.body || {};
  const ok = (s, n) => typeof s === 'string' && s.trim().length >= 1 && s.length <= n;
  if (!ok(name, 100) || !ok(className, 50) || !ok(rollNo, 30)) return res.status(400).json({ error: 'Fill in name, class and roll number' });
  if (typeof email !== 'string' || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return res.status(400).json({ error: 'Enter a valid email address' });
  if (consent !== true) return res.status(400).json({ error: 'You must accept the notice to continue' });
  const { rows: [t] } = await pool.query(
    `SELECT id,access_code,exam_start_at,login_deadline_at,final_submission_at,
       (exam_start_at IS NULL OR exam_start_at <= now()) AS start_open,
       (login_deadline_at IS NULL OR login_deadline_at > now()) AS before_login_deadline,
       (final_submission_at IS NULL OR final_submission_at > now()) AS before_final_deadline
     FROM tests WHERE slug=$1 AND status='published'`, [req.params.slug]);
  if (!t) return res.status(404).json({ error: 'Test not found or not open' });
  if (!t.start_open) return res.status(409).json({ error: 'Registration has not opened yet' });
  if (!t.before_login_deadline) return res.status(409).json({ error: 'The login deadline has passed; you can no longer enter this test' });
  if (!t.before_final_deadline) return res.status(409).json({ error: 'The final submission deadline has passed' });
  if (t.access_code && t.access_code !== accessCode) return res.status(403).json({ error: 'Wrong access code' });
  const token = newToken();
  try {
    await pool.query(
      `INSERT INTO attempts(test_id,student_name,class_name,roll_no,student_email,token_hash,consent_at,ip) VALUES($1,$2,$3,$4,$5,$6,now(),$7)`,
      [t.id, name.trim(), className.trim(), rollNo.trim().toUpperCase(), email.trim().toLowerCase(), hashToken(token), req.ip]);
    res.json({ token });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'This roll number has already registered for this test. Ask your teacher for help.' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

// ---- Attempt (student token) ----
async function buildState(a) {
  const out = {
    status: a.status, endReason: a.end_reason, testTitle: a.test_title, requirePhoto: a.require_photo,
    noBack: a.no_back, durationMinutes: a.duration_minutes, studentName: a.student_name,
    submissionMode: a.submission_mode, finalSubmissionAt: a.final_submission_at,
    examStartAt: a.exam_start_at, loginDeadlineAt: a.login_deadline_at,
    canBegin: a.test_status === 'published' && !a.not_open && !a.login_closed && !a.final_closed,
    notOpen: a.not_open, loginClosed: a.login_closed, finalClosed: a.final_closed,
  };
  const { rows: ph } = await pool.query('SELECT kind FROM photos WHERE attempt_id=$1', [a.id]);
  out.hasStartPhoto = ph.some((p) => p.kind === 'start');
  out.hasFinalPhoto = ph.some((p) => p.kind === 'final');
  if (a.status === 'in_progress') {
    out.remainingSeconds = Math.max(0, Math.floor(Number(a.remaining)));
    out.finalSubmissionRemainingSeconds = a.final_submission_remaining === null
      ? null : Math.max(0, Math.floor(Number(a.final_submission_remaining)));
    out.currentIndex = a.current_index;
    out.totalQuestions = a.question_order.length;
    const ids = a.no_back ? [a.question_order[a.current_index]] : a.question_order;
    const { rows: qs } = await pool.query(
      `SELECT q.id,q.text,q.options,(q.image_data IS NOT NULL) AS has_image, ans.selected_index
       FROM questions q LEFT JOIN answers ans ON ans.question_id=q.id AND ans.attempt_id=$1 WHERE q.id = ANY($2::uuid[])`,
      [a.id, ids]);
    const by = Object.fromEntries(qs.map((q) => [q.id, q]));
    out.questions = ids.map((id) => {
      const q = by[id]; const ord = a.option_orders[id];
      return {
        id, text: q.text, hasImage: q.has_image,
        options: ord.map((oi) => q.options[oi]),
        selected: q.selected_index === null || q.selected_index === undefined ? null : ord.indexOf(q.selected_index),
      };
    });
  }
  if (a.submitted_at) {
    out.submittedAt = a.submitted_at;
    if (a.release_result) {
      const pct = Number(a.total) > 0 ? (Number(a.score) / Number(a.total)) * 100 : 0;
      out.result = { score: Number(a.score), total: Number(a.total), correct: a.correct, wrong: a.wrong,
        unanswered: a.unanswered, percent: Math.round(pct * 100) / 100, passed: pct >= Number(a.pass_percent) };
    }
  }
  return out;
}

router.get('/attempt/state', att, async (req, res) => res.json(await buildState(req.a)));

router.post('/attempt/photo/:kind', att, upload.single('photo'), async (req, res) => {
  const a = req.a; const kind = req.params.kind;
  if (!['start', 'final'].includes(kind)) return res.status(400).json({ error: 'bad kind' });
  if (kind === 'start' && a.status !== 'registered') return res.status(409).json({ error: 'wrong_state', status: a.status });
  if (kind === 'final' && a.status !== 'photo_pending') return res.status(409).json({ error: 'wrong_state', status: a.status });
  if (!req.file) return res.status(400).json({ error: 'No photo received' });
  const mime = sniffImage(req.file.buffer);
  if (!mime) return res.status(415).json({ error: 'Only JPEG, PNG or WebP photos are accepted' });
  let captured = new Date(req.body?.capturedAt);
  if (isNaN(captured) || Math.abs(captured - Date.now()) > 15 * 60 * 1000) captured = null;
  await pool.query(
    `INSERT INTO photos(attempt_id,kind,mime,data,captured_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT (attempt_id,kind) DO NOTHING`,
    [a.id, kind, mime, req.file.buffer, captured]);
  if (kind === 'final') await pool.query(`UPDATE attempts SET status='submitted' WHERE id=$1 AND status='photo_pending'`, [a.id]);
  res.json({ ok: true });
});

router.post('/attempt/begin', att, async (req, res) => {
  const a = req.a;
  if (a.status !== 'registered') return res.json({ ok: true, status: a.status });
  const { rows: [window] } = await pool.query(
    `SELECT status,exam_start_at,login_deadline_at,final_submission_at,
       (exam_start_at IS NULL OR exam_start_at <= now()) AS start_open,
       (login_deadline_at IS NULL OR login_deadline_at > now()) AS before_login_deadline,
       (final_submission_at IS NULL OR final_submission_at > now()) AS before_final_deadline
     FROM tests WHERE id=$1`, [a.test_id]);
  if (window.status !== 'published') return res.status(403).json({ error: 'This test is closed' });
  if (!window.start_open) return res.status(409).json({ error: 'The test has not opened yet' });
  if (!window.before_login_deadline) return res.status(409).json({ error: 'The login deadline has passed; you can no longer start this test' });
  if (!window.before_final_deadline) return res.status(409).json({ error: 'The final submission deadline has passed' });
  if (a.require_photo) {
    const { rowCount } = await pool.query(`SELECT 1 FROM photos WHERE attempt_id=$1 AND kind='start'`, [a.id]);
    if (!rowCount) return res.status(409).json({ error: 'start_photo_required' });
  }
  const { rows: qs } = await pool.query(
    'SELECT id, jsonb_array_length(options) AS n FROM questions WHERE test_id=$1 ORDER BY position,id', [a.test_id]);
  if (!qs.length) return res.status(409).json({ error: 'Test has no questions' });
  let ids = qs.map((q) => q.id); if (a.shuffle) ids = shuffle(ids);
  const oo = {};
  for (const q of qs) { const idx = [...Array(q.n).keys()]; oo[q.id] = a.shuffle ? shuffle(idx) : idx; }
  const { rowCount } = await pool.query(
    `UPDATE attempts a SET status='in_progress', started_at=now(),
       deadline_at=CASE WHEN t.final_submission_at IS NULL THEN now()+make_interval(mins => $2::int)
         ELSE LEAST(now()+make_interval(mins => $2::int),t.final_submission_at) END,
       question_order=$3, option_orders=$4
     FROM tests t
     WHERE a.id=$1 AND a.test_id=t.id AND a.status='registered' AND t.status='published'
       AND (t.exam_start_at IS NULL OR t.exam_start_at <= now())
       AND (t.login_deadline_at IS NULL OR t.login_deadline_at > now())
       AND (t.final_submission_at IS NULL OR t.final_submission_at > now())`,
    [a.id, a.duration_minutes, JSON.stringify(ids), JSON.stringify(oo)]);
  const { rows: [fresh] } = await pool.query(ATTEMPT_SQL, [hashToken(/^Bearer (.+)$/.exec(req.get('authorization'))[1])]);
  if (!rowCount) {
    if (fresh.status !== 'registered') return res.json(await buildState(fresh));
    if (fresh.login_closed) return res.status(409).json({ error: 'The login deadline has passed; you can no longer start this test' });
    if (fresh.not_open) return res.status(409).json({ error: 'The test has not opened yet' });
    if (fresh.final_closed) return res.status(409).json({ error: 'The final submission deadline has passed' });
    return res.status(409).json({ error: 'This test is not open for starting' });
  }
  res.json(await buildState(fresh));
});

const live = (req, res, next) =>
  req.a.status === 'in_progress' ? next() : res.status(409).json({ error: 'not_in_progress', status: req.a.status });

router.post('/attempt/answer', att, live, async (req, res) => {
  const a = req.a; const { questionId, choice } = req.body || {};
  if (!isUuid(questionId) || !a.question_order.includes(questionId)) return res.status(400).json({ error: 'bad question' });
  const ord = a.option_orders[questionId];
  let sel = null;
  if (choice !== null) {
    if (!Number.isInteger(choice) || choice < 0 || choice >= ord.length) return res.status(400).json({ error: 'bad choice' });
    sel = ord[choice];
  }

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [locked] } = await c.query(
      `SELECT a.status,a.question_order,a.option_orders,a.current_index,t.no_back,
         (a.deadline_at IS NOT NULL AND LEAST(a.deadline_at,t.final_submission_at) <= now()) AS expired
       FROM attempts a JOIN tests t ON t.id=a.test_id WHERE a.id=$1 FOR UPDATE OF a`, [a.id]);
    if (!locked || locked.status !== 'in_progress' || locked.expired) {
      await c.query('COMMIT');
      if (locked?.status === 'in_progress' && locked.expired) await finalize(a.id, 'timeout');
      return res.status(409).json({ error: 'not_in_progress', status: locked?.status || 'unknown' });
    }
    if (!locked.question_order.includes(questionId)) {
      await c.query('ROLLBACK');
      return res.status(400).json({ error: 'bad question' });
    }
    if (locked.no_back && locked.question_order[locked.current_index] !== questionId) {
      await c.query(
        `INSERT INTO integrity_events(attempt_id,type,severity,client_event_id) VALUES($1,'forbidden_navigation','info',gen_random_uuid()::text)`,
        [a.id]);
      await c.query('COMMIT');
      return res.status(409).json({ error: 'forbidden_navigation' });
    }
    await c.query(
      `INSERT INTO answers(attempt_id,question_id,selected_index) VALUES($1,$2,$3)
       ON CONFLICT (attempt_id,question_id) DO UPDATE SET selected_index=EXCLUDED.selected_index, updated_at=now()`,
      [a.id, questionId, sel]);
    await c.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
});

router.post('/attempt/next', att, live, async (req, res) => {
  const a = req.a;
  if (!a.no_back) return res.status(400).json({ error: 'not applicable' });
  await pool.query('UPDATE attempts SET current_index=LEAST(current_index+1,$2) WHERE id=$1 AND status=\'in_progress\'',
    [a.id, a.question_order.length - 1]);
  res.json({ ok: true });
});

router.post('/attempt/submit', att, async (req, res) => {
  if (req.a.status === 'in_progress') await finalize(req.a.id, 'submitted');
  const { rows: [fresh] } = await pool.query(ATTEMPT_SQL, [hashToken(/^Bearer (.+)$/.exec(req.get('authorization'))[1])]);
  res.json(await buildState(fresh)); // repeat calls are harmless (idempotent)
});

router.post('/attempt/skip-final-photo', att, async (req, res) => {
  await pool.query(`UPDATE attempts SET status='photo_missing' WHERE id=$1 AND status='photo_pending'`, [req.a.id]);
  res.json({ ok: true });
});

router.post('/attempt/event', att, async (req, res) => {
  const a = req.a; const { type, clientEventId } = req.body || {};
  if (a.status !== 'in_progress') return res.json({ status: a.status });
  if (!EVENT_TYPES.has(type) || typeof clientEventId !== 'string' || clientEventId.length > 64) return res.status(400).json({ error: 'bad event' });
  const { rows: [recent] } = await pool.query(
    `SELECT 1 FROM integrity_events WHERE attempt_id=$1 AND type=$2 AND created_at > now() - interval '5 seconds'`, [a.id, type]);
  const counted = QUALIFYING.has(type) && !recent;
  const ins = await pool.query(
    `INSERT INTO integrity_events(attempt_id,type,severity,counted,client_event_id) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (attempt_id,client_event_id) DO NOTHING`,
    [a.id, type, counted ? 'warning' : 'info', counted, clientEventId]);
  let warnings = a.warnings;
  if (counted && ins.rowCount) {
    ({ rows: [{ warnings }] } = await pool.query('UPDATE attempts SET warnings=warnings+1 WHERE id=$1 RETURNING warnings', [a.id]));
    if (a.max_warnings > 0 && warnings >= a.max_warnings) {
      if (a.on_limit === 'terminate') { const f = await finalize(a.id, 'terminated'); return res.json({ warnings, status: f.status }); }
      await pool.query('UPDATE attempts SET flagged=true WHERE id=$1', [a.id]);
    }
  }
  res.json({ warnings, max: a.max_warnings, onLimit: a.on_limit, status: 'in_progress' });
});

router.get('/attempt/question/:qid/image', att, async (req, res) => {
  if (!isUuid(req.params.qid)) return res.status(400).end();
  const { rows: [q] } = await pool.query('SELECT image_mime,image_data FROM questions WHERE id=$1 AND test_id=$2', [req.params.qid, req.a.test_id]);
  if (!q?.image_data) return res.status(404).end();
  res.set({ 'Content-Type': q.image_mime, 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff' });
  res.send(q.image_data);
});

export default router;
