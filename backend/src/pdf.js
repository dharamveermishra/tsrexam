import PDFDocument from 'pdfkit';
import { pool } from './db.js';

/** Builds a compressed (Flate) PDF of one student's responses. Returns {buffer, filename, attempt}. */
export async function buildResponsePdf(attemptId) {
  const { rows: [a] } = await pool.query(
    `SELECT a.*, t.title AS test_title, t.version AS test_version, t.pass_percent
     FROM attempts a JOIN tests t ON t.id=a.test_id WHERE a.id=$1`, [attemptId]);
  if (!a || !a.question_order) throw new Error('Attempt has no responses yet');
  const { rows: qs } = await pool.query(
    `SELECT q.id,q.text,q.options,q.correct_index,q.marks,(q.image_data IS NOT NULL) AS has_image, ans.selected_index
     FROM questions q LEFT JOIN answers ans ON ans.question_id=q.id AND ans.attempt_id=$1 WHERE q.test_id=$2`, [attemptId, a.test_id]);
  const by = Object.fromEntries(qs.map((q) => [q.id, q]));

  const doc = new PDFDocument({ size: 'A4', margin: 46, compress: true, info: { Title: `${a.test_title} - ${a.student_name}` } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => doc.on('end', r));

  const pct = Number(a.total) > 0 ? Math.round((Number(a.score) / Number(a.total)) * 10000) / 100 : 0;
  doc.font('Helvetica-Bold').fontSize(16).text('TSR Institute - Test Response Sheet');
  doc.font('Helvetica').fontSize(11).moveDown(0.3)
    .text(`${a.test_title} (version ${a.test_version})`)
    .text(`Student: ${a.student_name}   Class: ${a.class_name}   Roll no: ${a.roll_no}`)
    .text(`Submitted: ${a.submitted_at ? new Date(a.submitted_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '-'}`)
    .text(`Submission method: ${a.submission_mode || '-'}   End reason: ${a.end_reason || '-'}`)
    .text(`Marks: ${a.score ?? '-'} / ${a.total ?? '-'}  (${pct}%)   Correct ${a.correct ?? 0} | Wrong ${a.wrong ?? 0} | Unanswered ${a.unanswered ?? 0}`);
  doc.moveDown(0.3).fontSize(9).fillColor('#555').text('[x] = option marked by the student     (Correct answer) = right option', { lineGap: 2 }).fillColor('#000');
  doc.moveDown(0.6);

  const order = a.option_orders || {};
  a.question_order.forEach((qid, i) => {
    const q = by[qid]; if (!q) return;
    const ord = order[qid] || q.options.map((_, k) => k);
    if (doc.y > 700) doc.addPage();
    const result = q.selected_index === null || q.selected_index === undefined ? 'Unanswered'
      : q.selected_index === q.correct_index ? 'Correct' : 'Wrong';
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(`Q${i + 1}. ${q.text}`, { continued: false });
    if (q.has_image) doc.font('Helvetica-Oblique').fontSize(9).fillColor('#555').text('(This question has a diagram - see the online test)').fillColor('#000');
    doc.font('Helvetica').fontSize(10);
    ord.forEach((oi, k) => {
      const mark = q.selected_index === oi ? '[x]' : '[ ]';
      const right = oi === q.correct_index ? '  (Correct answer)' : '';
      doc.fillColor(oi === q.correct_index ? '#0a7a3d' : q.selected_index === oi ? '#b42318' : '#000')
        .text(`   ${mark} ${String.fromCharCode(65 + k)}. ${q.options[oi]}${right}`);
    });
    doc.fillColor('#000').font('Helvetica-Oblique').fontSize(9).text(`Result: ${result}   Marks: ${q.marks}`).moveDown(0.6);
  });
  doc.end(); await done;
  const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
  return { buffer: Buffer.concat(chunks), filename: `${safe(a.student_name)}_${safe(a.roll_no)}_responses.pdf`, attempt: a };
}

export async function getOrCreateResponsePdf(attemptId) {
  const { rows: [saved] } = await pool.query(
    'SELECT filename,pdf_data FROM response_reports WHERE attempt_id=$1', [attemptId]);
  if (saved) {
    const { rows: [attempt] } = await pool.query(
      `SELECT a.*,t.title AS test_title,t.version AS test_version,t.pass_percent
       FROM attempts a JOIN tests t ON t.id=a.test_id WHERE a.id=$1`, [attemptId]);
    return { buffer: saved.pdf_data, filename: saved.filename, attempt };
  }

  const generated = await buildResponsePdf(attemptId);
  await pool.query(
    `INSERT INTO response_reports(attempt_id,filename,pdf_data) VALUES($1,$2,$3)
     ON CONFLICT (attempt_id) DO NOTHING`,
    [attemptId, generated.filename, generated.buffer]);
  const { rows: [report] } = await pool.query(
    'SELECT filename,pdf_data FROM response_reports WHERE attempt_id=$1', [attemptId]);
  return { buffer: report.pdf_data, filename: report.filename, attempt: generated.attempt };
}
