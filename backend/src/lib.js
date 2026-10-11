import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === 'string' && UUID.test(s);

/** Detect image type from file signature (never trust client MIME). */
export function sniffImage(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export function shuffle(a) {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/** rows: [{marks, correct_index, selected_index}] */
export function gradeAnswers(rows, negative = 0) {
  let score = 0, total = 0, correct = 0, wrong = 0, unanswered = 0;
  for (const r of rows) {
    const m = Number(r.marks);
    total += m;
    if (r.selected_index === null || r.selected_index === undefined) { unanswered++; continue; }
    if (r.selected_index === r.correct_index) { score += m; correct++; }
    else { score -= Number(negative); wrong++; }
  }
  const round = (n) => Math.round(n * 100) / 100;
  return { score: round(score), total: round(total), correct, wrong, unanswered };
}

export function normalizeExamSchedule(values = {}) {
  const names = ['examStartAt', 'loginDeadlineAt', 'finalSubmissionAt'];
  const raw = names.map((name) => values[name] ?? '');
  if (raw.every((value) => value === '')) {
    return { valid: true, schedule: { examStartAt: null, loginDeadlineAt: null, finalSubmissionAt: null } };
  }
  const pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/;
  if (raw.some((value) => typeof value !== 'string' || value.trim() === '' || !pattern.test(value))) {
    return { valid: false };
  }
  if (raw.some((value) => {
    const [, y, m, d, h, min, s = '0', , , oh = '0', om = '0'] = value.match(pattern);
    const year = Number(y), month = Number(m), day = Number(d);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return month < 1 || month > 12 || day < 1 || day > daysInMonth ||
      Number(h) > 23 || Number(min) > 59 || Number(s) > 59 || Number(oh) > 23 || Number(om) > 59;
  })) return { valid: false };
  const dates = raw.map((value) => new Date(value));
  if (dates.some((date) => Number.isNaN(date.getTime())) ||
      dates[0] >= dates[1] || dates[1] >= dates[2]) {
    return { valid: false };
  }
  return {
    valid: true,
    schedule: {
      examStartAt: dates[0].toISOString(),
      loginDeadlineAt: dates[1].toISOString(),
      finalSubmissionAt: dates[2].toISOString(),
    },
  };
}

export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('hex');
export const newSlug = () => crypto.randomBytes(9).toString('base64url');

/** Prevent spreadsheet formula injection in CSV exports. */
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
