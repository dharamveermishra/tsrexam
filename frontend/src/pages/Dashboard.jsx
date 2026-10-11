import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, schedulePayload } from '../api.js';

const blank = { title: '', instructions: '', durationMinutes: 60, accessCode: '', requirePhoto: true, negativeMarking: 0,
  passPercent: 40, maxWarnings: 4, onLimit: 'flag', noBack: false, shuffle: true, releaseResult: true, showPhotos: true, retentionDays: 90,
  examStartAt: '', loginDeadlineAt: '', finalSubmissionAt: '' };

export default function Dashboard() {
  const [tests, setTests] = useState([]);
  const [f, setF] = useState(blank);
  const [err, setErr] = useState('');
  const nav = useNavigate();
  useEffect(() => { api('/teacher/tests').then(setTests); }, []);
  const set = (k, num) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : num ? Number(e.target.value) : e.target.value });
  async function create(e) {
    e.preventDefault(); setErr('');
    try {
      const schedule = schedulePayload(f);
      const r = await api('/teacher/tests', { method: 'POST', body: { ...f, ...schedule } });
      nav('/dashboard/tests/' + r.id);
    } catch (x) { setErr(x.message); }
  }
  return (
    <>
      <h1>Your tests</h1>
      <div className="card">
        {tests.length === 0 && <p>No tests yet. Create your first one below.</p>}
        {tests.map((t) => (
          <p key={t.id}><Link to={'/dashboard/tests/' + t.id}><b>{t.title}</b></Link> <span className={'tag ' + t.status}>{t.status}</span>{' '}
            v{t.version} · {t.question_count} questions · {t.attempt_count} attempts</p>
        ))}
      </div>
      <form className="card" onSubmit={create}>
        <h2>Create a test</h2>
        <label>Title<input value={f.title} onChange={set('title')} required /></label>
        <label>Instructions for students<textarea value={f.instructions} onChange={set('instructions')} rows={3} /></label>
        <h3>Exam schedule (optional)</h3>
        <p className="small">Leave all three blank for an unscheduled test. Times use this device's local time zone; the server enforces the saved timestamps.</p>
        <div className="grid">
          <label>Exam start time — student entry opens<input type="datetime-local" value={f.examStartAt} onChange={set('examStartAt')} /></label>
          <label>Login deadline — latest time to start<input type="datetime-local" value={f.loginDeadlineAt} onChange={set('loginDeadlineAt')} /></label>
          <label>Final submission time — hard stop for every attempt<input type="datetime-local" value={f.finalSubmissionAt} onChange={set('finalSubmissionAt')} /></label>
        </div>
        <div className="grid">
          <label>Duration (minutes)<input type="number" min="1" max="600" value={f.durationMinutes} onChange={set('durationMinutes', true)} /></label>
          <label>Access code (optional)<input value={f.accessCode} onChange={set('accessCode')} /></label>
          <label>Negative marks per wrong answer<input type="number" step="0.25" min="0" value={f.negativeMarking} onChange={set('negativeMarking', true)} /></label>
          <label>Pass percentage<input type="number" min="0" max="100" value={f.passPercent} onChange={set('passPercent', true)} /></label>
          <label>Warnings before action (0 = off)<input type="number" min="0" max="50" value={f.maxWarnings} onChange={set('maxWarnings', true)} /></label>
          <label>At the warning limit
            <select value={f.onLimit} onChange={set('onLimit')}><option value="flag">Flag for my review</option><option value="terminate">End the test (answers kept)</option></select></label>
          <label>Keep photos for (days)<input type="number" min="1" value={f.retentionDays} onChange={set('retentionDays', true)} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.requirePhoto} onChange={set('requirePhoto')} /> Require start and final photos</label>
        <label className="check"><input type="checkbox" checked={f.shuffle} onChange={set('shuffle')} /> Shuffle questions and options per student</label>
        <label className="check"><input type="checkbox" checked={f.noBack} onChange={set('noBack')} /> One-way navigation (no going back)</label>
        <label className="check"><input type="checkbox" checked={f.releaseResult} onChange={set('releaseResult')} /> Show score to student after submission</label>
        <label className="check"><input type="checkbox" checked={f.showPhotos} onChange={set('showPhotos')} /> Show photos on printed report cards</label>
        {err && <p role="alert" className="notice">{err}</p>}
        <button className="primary">Create test</button>
      </form>
    </>
  );
}
