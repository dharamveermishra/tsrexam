import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import Camera from '../components/Camera.jsx';
import ImageViewer from '../components/ImageViewer.jsx';

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const showLocalTime = (value) => value ? new Date(value).toLocaleString() : null;

export default function Student() {
  const { slug } = useParams();
  const key = 'tsr_attempt_' + slug;
  const [info, setInfo] = useState(null), [err, setErr] = useState('');
  const [token, setToken] = useState(() => localStorage.getItem(key));
  const [state, setState] = useState(null);

  useEffect(() => {
    let active = true;
    const refresh = () => api('/public/test/' + slug)
      .then((test) => { if (active) { setInfo(test); setErr(''); } })
      .catch((e) => { if (active) setErr(e.message); });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [slug]);
  const reload = useCallback(async () => {
    if (!token) return;
    try { setState(await api('/attempt/state', { token })); }
    catch (e) { if (e.status === 401) { localStorage.removeItem(key); setToken(null); setState(null); } else setErr('Connection problem. Retrying…'); }
  }, [token, key]);
  useEffect(() => { reload(); }, [reload]);

  if (err && !info) return <div className="card narrow"><h1>TSR Institute</h1><p role="alert">{err}</p></div>;
  if (!info) return <p className="center">Loading…</p>;
  if (!token) return <Register slug={slug} info={info} onDone={(t) => { localStorage.setItem(key, t); setToken(t); }} />;
  if (!state) return <p className="center">{err || 'Loading…'}</p>;

  if (state.status === 'registered') return <Ready token={token} info={info} state={state} reload={reload} />;
  if (state.status === 'in_progress') return <Exam key="exam" token={token} state={state} reload={reload} />;
  if (state.status === 'photo_pending')
    return (
      <div className="card narrow">
        <h1>{state.endReason === 'timeout' ? 'Time is up' : 'Answers saved'}</h1>
        <p>Your answers are saved. Please take your final photo to complete submission.</p>
        <Camera confirmLabel="Upload final photo" onConfirm={async (blob, at) => {
          const form = new FormData(); form.append('photo', blob, 'final.jpg'); form.append('capturedAt', at);
          await api('/attempt/photo/final', { method: 'POST', token, form }); reload();
        }} />
        <button className="link" onClick={async () => { await api('/attempt/skip-final-photo', { method: 'POST', token }); reload(); }}>
          I can't take the photo (submit without it)</button>
      </div>
    );
  return <Done state={state} />;
}

function Register({ slug, info, onDone }) {
  const [f, setF] = useState({ name: '', className: '', rollNo: '', email: '', accessCode: '', consent: false });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function go(e) {
    e.preventDefault(); setErr('');
    try { onDone((await api(`/public/test/${slug}/register`, { method: 'POST', body: f })).token); } catch (x) { setErr(x.message); }
  }
  return (
    <form className="card narrow" onSubmit={go}>
      <h1>{info.title}</h1>
      <p>Duration: {info.duration_minutes} minutes{info.no_back ? ' · you cannot go back to earlier questions' : ''}</p>
      {info.exam_start_at && <p>Login opens: <b>{showLocalTime(info.exam_start_at)}</b></p>}
      {info.login_deadline_at && <p>Latest time to start: <b>{showLocalTime(info.login_deadline_at)}</b></p>}
      {info.final_submission_at && <p>All active attempts submit at: <b>{showLocalTime(info.final_submission_at)}</b></p>}
      {!info.registrationOpen && <p className="notice" role="status">
        {info.notOpen ? 'Registration has not opened yet.'
          : info.loginClosed ? 'The login deadline has passed. You can no longer enter this test.'
            : 'The final submission deadline has passed.'}
      </p>}
      {info.instructions && <p className="pre">{info.instructions}</p>}
      <label>Full name<input value={f.name} onChange={set('name')} required maxLength={100} autoComplete="name" /></label>
      <label>Class / batch<input value={f.className} onChange={set('className')} required maxLength={50} /></label>
      <label>Roll number<input value={f.rollNo} onChange={set('rollNo')} required maxLength={30} /></label>
      <label>Email address<input type="email" value={f.email} onChange={set('email')} required maxLength={254} autoComplete="email" /></label>
      {info.needs_code && <label>Access code<input value={f.accessCode} onChange={set('accessCode')} required /></label>}
      <div className="notice small">
        <b>Please read:</b>
        <ul>
          {info.require_photo && <li>A live photo is taken before you start and a second photo when you submit. They are used by your teacher to
            check the attempt and {info.show_photos ? 'may appear on your report card' : 'do not appear on your report card'}. Only your teacher and
            institute administrators can see them. Photos are kept for {info.retention_days} days and then deleted.</li>}
          <li>If your camera or network fails, your answers are still saved. Tell your teacher so they can help.</li>
          {info.max_warnings > 0 && <li>Leaving the exam page or exiting full screen is recorded. After {info.max_warnings} such events your attempt is flagged for teacher review (or may end, as set by your teacher). Phone calls and notifications can cause false alerts; you can ask your teacher to review any event.</li>}
          <li>Your email is used only so your teacher can send you your response sheet (questions, correct answers and your answers).</li>
          <li>Your answers are saved to the server as you go. The timer is controlled by the server.</li>
        </ul>
        <label className="check"><input type="checkbox" checked={f.consent} onChange={set('consent')} /> I have read and accept this notice.</label>
      </div>
      {err && <p role="alert" className="notice">{err}</p>}
      <button className="primary" disabled={!f.consent || !info.registrationOpen}>Continue</button>
    </form>
  );
}

function Ready({ token, info, state, reload }) {
  const [msg, setMsg] = useState('');
  const needPhoto = state.requirePhoto && !state.hasStartPhoto;
  useEffect(() => { const timer = setInterval(reload, 5000); return () => clearInterval(timer); }, [reload]);
  async function begin() {
    setMsg('');
    try {
      if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen().catch(() => {});
      window.__fsWanted = !!document.fullscreenElement;
      await api('/attempt/begin', { method: 'POST', token }); reload();
    } catch (e) { setMsg(e.message); }
  }
  return (
    <div className="card narrow">
      <h1>Hello, {state.studentName}</h1>
      {needPhoto ? (
        <>
          <p>Take a live photo of yourself to start. A second photo will be requested when you submit.</p>
          <Camera confirmLabel="Upload start photo" onConfirm={async (blob, at) => {
            const form = new FormData(); form.append('photo', blob, 'start.jpg'); form.append('capturedAt', at);
            await api('/attempt/photo/start', { method: 'POST', token, form }); reload();
          }} />
        </>
      ) : <p>{state.requirePhoto ? 'Start photo uploaded ✓' : 'No photo is required for this test.'}</p>}
      {state.examStartAt && <p className="small">Login opens: {showLocalTime(state.examStartAt)}</p>}
      {state.loginDeadlineAt && <p className="small">Latest time to start: {showLocalTime(state.loginDeadlineAt)}</p>}
      {state.finalSubmissionAt && <p className="small">All active attempts submit at: {showLocalTime(state.finalSubmissionAt)}</p>}
      {!state.canBegin && <p role="alert" className="notice">
        {state.notOpen ? 'The test has not opened yet.'
          : state.loginClosed ? 'The login deadline has passed. You can no longer start this test.'
            : state.finalClosed ? 'The final submission deadline has passed.'
              : 'This test is not open for starting.'}
      </p>}
      <p className="small">Full screen is offered for focus. It is not a lock: the browser or device can still leave it, and that is recorded.</p>
      {msg && <p role="alert" className="notice">{msg}</p>}
      <button className="primary" disabled={needPhoto || !state.canBegin} onClick={begin}>Start test ({info.duration_minutes} min)</button>
    </div>
  );
}

function Exam({ token, state, reload }) {
  const [idx, setIdx] = useState(0);
  const [sel, setSel] = useState(() => Object.fromEntries(state.questions.map((q) => [q.id, q.selected])));
  const [marked, setMarked] = useState({});
  const [left, setLeft] = useState(state.remainingSeconds);
  const [finalLeft, setFinalLeft] = useState(state.finalSubmissionRemainingSeconds);
  const [saving, setSaving] = useState('');
  const [warn, setWarn] = useState(null);
  const endAt = useRef(Date.now() + state.remainingSeconds * 1000);
  const finalEndAt = useRef(state.finalSubmissionRemainingSeconds === null
    ? null : Date.now() + state.finalSubmissionRemainingSeconds * 1000);
  const qs = state.questions;
  const q = state.noBack ? qs[0] : qs[idx];
  const pos = state.noBack ? state.currentIndex : idx;

  useEffect(() => {
    endAt.current = Date.now() + state.remainingSeconds * 1000;
    setLeft(state.remainingSeconds);
    if (state.finalSubmissionRemainingSeconds !== null) {
      finalEndAt.current = Date.now() + state.finalSubmissionRemainingSeconds * 1000;
      setFinalLeft(state.finalSubmissionRemainingSeconds);
    }
  }, [state.remainingSeconds, state.finalSubmissionRemainingSeconds]);

  useEffect(() => { // server-synchronised countdown; at 0 ask the server, which finalises
    const t = setInterval(() => {
      const s = Math.max(0, Math.ceil((endAt.current - Date.now()) / 1000)); setLeft(s);
      if (finalEndAt.current !== null) setFinalLeft(Math.max(0, Math.ceil((finalEndAt.current - Date.now()) / 1000)));
      if (s === 0) { clearInterval(t); reload(); }
    }, 500);
    return () => clearInterval(t);
  }, [reload]);
  useEffect(() => { const timer = setInterval(reload, 10000); return () => clearInterval(timer); }, [reload]);

  useEffect(() => { // keep answer state when server returns the next question (no-back mode)
    setSel((p) => ({ ...p, ...Object.fromEntries(qs.map((x) => [x.id, x.selected])) }));
  }, [state]);

  const sendEvent = useCallback((type) => {
    api('/attempt/event', { method: 'POST', token, body: { type, clientEventId: crypto.randomUUID() } })
      .then((r) => { if (r.status && r.status !== 'in_progress') reload(); else setWarn(r); }).catch(() => {});
  }, [token, reload]);
  useEffect(() => {
    const vis = () => { if (document.hidden && !window.__viewerOpen) sendEvent('tab_hidden'); };
    const blur = () => { if (!document.hidden && !window.__viewerOpen) sendEvent('blur'); };
    const fs = () => { if (!document.fullscreenElement && window.__fsWanted && !window.__viewerOpen) sendEvent('fullscreen_exit'); };
    document.addEventListener('visibilitychange', vis); window.addEventListener('blur', blur); document.addEventListener('fullscreenchange', fs);
    const off = () => sendEvent('offline'); window.addEventListener('offline', off);
    return () => { document.removeEventListener('visibilitychange', vis); window.removeEventListener('blur', blur); document.removeEventListener('fullscreenchange', fs); window.removeEventListener('offline', off); };
  }, [sendEvent]);

  async function choose(i) {
    const prev = sel[q.id]; const next = prev === i ? null : i;
    setSel({ ...sel, [q.id]: next }); setSaving('Saving…');
    for (let n = 0; n < 4; n++) {
      try { await api('/attempt/answer', { method: 'POST', token, body: { questionId: q.id, choice: next } }); setSaving('Saved ✓'); return; }
      catch (e) { if (e.status === 409 || e.status === 400) { reload(); return; } await new Promise((r) => setTimeout(r, 800 * (n + 1))); }
    }
    setSaving('Not saved – check your connection');
  }
  async function next() { await api('/attempt/next', { method: 'POST', token }).catch(() => {}); reload(); }
  async function submit() {
    if (!window.confirm('Submit your test now? You cannot change answers afterwards.')) return;
    try { await api('/attempt/submit', { method: 'POST', token }); if (document.fullscreenElement) document.exitFullscreen?.(); window.__fsWanted = false; reload(); }
    catch { alert('Could not submit. Your answers are saved; check your connection and try again.'); }
  }
  const last = pos === state.totalQuestions - 1;
  return (
    <div className="exam">
      <div className="bar sticky">
        <span>Question {pos + 1} / {state.totalQuestions}</span>
        <span className={left < 60 ? 'timer low' : 'timer'} aria-live="off">Time left {fmt(left)}</span>
        {state.finalSubmissionAt && finalLeft !== null && <span className="timer" aria-live="off">Final submission in {fmt(finalLeft)}</span>}
        <span className="small">{saving}</span>
      </div>
      {warn?.warnings > 0 && <p className="notice" role="status">Warning {warn.warnings}{warn.max ? ` of ${warn.max}` : ''}: leaving the exam page or full screen is recorded.</p>}
      <div className="card">
        <p className="qtext pre">{q.text}</p>
        {q.hasImage && <ImageViewer key={q.id} src={`/api/attempt/question/${q.id}/image`} token={token} alt={`Diagram for question ${pos + 1}`} />}
        <div role="radiogroup" aria-label="Answer options">
          {q.options.map((o, i) => (
            <button key={i} role="radio" aria-checked={sel[q.id] === i} className={'opt' + (sel[q.id] === i ? ' on' : '')} onClick={() => choose(i)}>
              <b>{String.fromCharCode(65 + i)}</b> {o}</button>
          ))}
        </div>
        <div className="row">
          {!state.noBack && <button disabled={idx === 0} onClick={() => setIdx(idx - 1)}>Previous</button>}
          {!state.noBack && <button onClick={() => setMarked({ ...marked, [q.id]: !marked[q.id] })}>{marked[q.id] ? 'Unmark' : 'Mark for review'}</button>}
          {!last && <button className="primary" onClick={() => (state.noBack ? next() : setIdx(idx + 1))}>Next</button>}
          {last && <button className="primary" onClick={submit}>Submit test</button>}
        </div>
      </div>
      {!state.noBack && (
        <div className="palette" aria-label="Question palette">
          {qs.map((x, i) => <button key={x.id} className={(sel[x.id] !== null && sel[x.id] !== undefined ? 'done ' : '') + (marked[x.id] ? 'mk ' : '') + (i === idx ? 'cur' : '')}
            onClick={() => setIdx(i)} aria-label={`Go to question ${i + 1}`}>{i + 1}</button>)}
        </div>
      )}
      {state.noBack && <p className="small center">One-way test: you cannot return to earlier questions.</p>}
      {!last && !state.noBack && <div className="center"><button onClick={submit}>Submit test</button></div>}
    </div>
  );
}

function Done({ state }) {
  const msg = {
    submitted: 'Your test is submitted.',
    photo_missing: 'Your test is submitted. The final photo is missing; tell your teacher if you were unable to take it.',
    terminated: 'Your attempt ended because of the exam rules. Your answers up to that point were saved. Speak to your teacher if you believe this was a mistake.',
  }[state.status] || 'Done.';
  const r = state.result;
  return (
    <div className="card narrow">
      <h1>{state.testTitle}</h1>
      <p>{msg}</p>
      {r && <p><b>Score: {r.score} / {r.total}</b> ({r.percent}%) · {r.passed ? 'Pass' : 'Not passed'}<br />Correct {r.correct} · Wrong {r.wrong} · Unanswered {r.unanswered}</p>}
      {!r && state.submittedAt && <p>Your teacher will share your result.</p>}
      {state.submissionMode && <p>Submission method: {state.submissionMode === 'automatic' ? 'automatic (deadline)' : 'manual'}.</p>}
    </div>
  );
}
