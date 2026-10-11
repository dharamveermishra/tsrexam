export async function api(path, { method = 'GET', body, form, token } = {}) {
  const headers = { 'X-Requested-With': 'tsr' };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch('/api' + path, { method, headers, body: payload, credentials: 'same-origin' });
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) { const e = new Error(data?.error || r.statusText); e.status = r.status; e.data = data; throw e; }
  return data;
}

export function localDateTimeInput(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function schedulePayload(values) {
  const names = ['examStartAt', 'loginDeadlineAt', 'finalSubmissionAt'];
  const raw = names.map((name) => values[name] || '');
  if (raw.every((value) => !value)) {
    return { examStartAt: null, loginDeadlineAt: null, finalSubmissionAt: null };
  }
  if (raw.some((value) => !value)) throw new Error('Enter all three exam schedule times, or clear all three.');
  const dates = raw.map((value) => new Date(value));
  if (dates.some((date) => Number.isNaN(date.getTime())) ||
      dates[0] >= dates[1] || dates[1] >= dates[2]) {
    throw new Error('Set the exam start before the login deadline, and the login deadline before final submission.');
  }
  return {
    examStartAt: dates[0].toISOString(),
    loginDeadlineAt: dates[1].toISOString(),
    finalSubmissionAt: dates[2].toISOString(),
  };
}
