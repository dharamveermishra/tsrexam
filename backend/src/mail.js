import nodemailer from 'nodemailer';
import { pool } from './db.js';
import { getOrCreateResponsePdf } from './pdf.js';

export const mailConfigured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_FROM);
let transport;
const getTransport = () => (transport ||= nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}));

/** Queue one response email for an attempt unless one is already waiting. Returns true if queued. */
export async function queueResponseEmail(attemptId) {
  const { rowCount } = await pool.query(
    `INSERT INTO email_log(attempt_id) SELECT $1 WHERE NOT EXISTS
     (SELECT 1 FROM email_log WHERE attempt_id=$1 AND kind='response' AND status IN ('queued','sending'))`, [attemptId]);
  return rowCount > 0;
}

let running = false;
/** Persistent queue worker (DB-backed): retries failures up to 3 times with growing delay. */
export async function processEmailQueue() {
  if (running) return; running = true;
  try {
    for (;;) {
      const { rows: [job] } = await pool.query(
        `UPDATE email_log SET status='sending' WHERE id=(
           SELECT id FROM email_log WHERE status='queued' AND run_after<=now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING *`);
      if (!job) break;
      try {
        if (!mailConfigured()) throw new Error('Email (SMTP) is not configured on the server');
        const { buffer, filename, attempt } = await getOrCreateResponsePdf(job.attempt_id);
        if (!attempt.student_email) throw new Error('Student has no email address');
        await getTransport().sendMail({
          from: process.env.MAIL_FROM, to: attempt.student_email,
          subject: `Your responses - ${attempt.test_title}`,
          text: `Dear ${attempt.student_name},\n\nAttached is your response sheet for "${attempt.test_title}", showing each question, the correct option and the option you marked.\n\nTSR Institute`,
          attachments: [{ filename, content: buffer, contentType: 'application/pdf' }],
        });
        await pool.query(`UPDATE email_log SET status='sent', sent_at=now(), error=NULL, tries=tries+1 WHERE id=$1`, [job.id]);
      } catch (e) {
        const tries = job.tries + 1;
        const final = tries >= 3 || /not configured|no email/i.test(e.message);
        await pool.query(
          `UPDATE email_log SET status=$2, tries=$3, error=$4, run_after=now()+make_interval(mins => $5::int) WHERE id=$1`,
          [job.id, final ? 'failed' : 'queued', tries, String(e.message).slice(0, 300), tries * 2]);
      }
      await new Promise((r) => setTimeout(r, 300)); // gentle pace for SMTP providers
    }
  } finally { running = false; }
}
