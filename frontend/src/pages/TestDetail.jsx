import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, localDateTimeInput, schedulePayload } from '../api.js';
import ImageViewer from '../components/ImageViewer.jsx';

export default function TestDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null), [results, setResults] = useState([]), [qr, setQr] = useState('');
  const [msg, setMsg] = useState(''), [info, setInfo] = useState(''), [filter, setFilter] = useState('all'), [open, setOpen] = useState(null);
  const [q, setQ] = useState({ text: '', options: ['', '', '', ''], correctIndex: 0, marks: 1, image: null });
  const [schedule, setSchedule] = useState({ examStartAt: '', loginDeadlineAt: '', finalSubmissionAt: '' });
  const scheduleInitialized = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await api('/teacher/tests/' + id); setData(d);
      if (scheduleInitialized.current !== id) {
        scheduleInitialized.current = id;
        setSchedule({
          examStartAt: localDateTimeInput(d.test.exam_start_at),
          loginDeadlineAt: localDateTimeInput(d.test.login_deadline_at),
          finalSubmissionAt: localDateTimeInput(d.test.final_submission_at),
        });
      }
      setResults(await api(`/teacher/tests/${id}/results`));
      const link = `${location.origin}/t/${d.test.slug}`;
      setQr(await QRCode.toDataURL(link, { width: 240, margin: 1 }));
    } catch (e) { setMsg(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const waiting = results.some((r) => r.email_status === 'queued' || r.email_status === 'sending');
  useEffect(() => { if (!waiting) return; const t = setInterval(load, 5000); return () => clearInterval(t); }, [waiting, load]);
  if (!data) return <p className="center">{msg || 'Loading…'}</p>;
  const { test, questions } = data;
  const link = `${location.origin}/t/${test.slug}`;
  const draft = test.status === 'draft';

  async function addQ(e) {
    e.preventDefault(); setMsg('');
    const form = new FormData();
    form.append('text', q.text); form.append('options', JSON.stringify(q.options.filter((o) => o.trim())));
    form.append('correctIndex', q.correctIndex); form.append('marks', q.marks);
    if (q.image) form.append('image', q.image);
    try { await api(`/teacher/tests/${id}/questions`, { method: 'POST', form }); setQ({ text: '', options: ['', '', '', ''], correctIndex: 0, marks: 1, image: null }); e.target.reset?.(); load(); }
    catch (x) { setMsg(x.message); }
  }
  const status = async (s) => { try { await api(`/teacher/tests/${id}/status`, { method: 'POST', body: { status: s } }); load(); } catch (x) { setMsg(x.message); } };
  const dup = async () => { const r = await api(`/teacher/tests/${id}/duplicate`, { method: 'POST' }); nav('/dashboard/tests/' + r.id); };
  const review = async (aid, body) => { await api(`/teacher/attempts/${aid}/review`, { method: 'PATCH', body }); load(); };
  const emailOne = async (aid) => { setMsg(''); try { await api(`/teacher/attempts/${aid}/send-response`, { method: 'POST' }); setInfo('Email queued.'); load(); } catch (x) { setMsg(x.message); } };
  const emailAll = async () => {
    if (!window.confirm('Email every finished student their response sheet (PDF)? Students who already received it are skipped.')) return;
    setMsg(''); try { const r = await api(`/teacher/tests/${id}/send-responses`, { method: 'POST' }); setInfo(`${r.queued} email(s) queued. Status updates below.`); load(); } catch (x) { setMsg(x.message); }
  };
  const saveSchedule = async (e) => {
    e.preventDefault(); setMsg(''); setInfo('');
    try {
      await api(`/teacher/tests/${id}/schedule`, { method: 'PUT', body: schedulePayload(schedule) });
      setInfo('Schedule saved. The server will enforce the login window and final submission deadline.');
      load();
    } catch (x) { setMsg(x.message); }
  };
  const delPhoto = async (aid, kind) => { if (window.confirm('Delete this photo permanently?')) { await api(`/teacher/attempts/${aid}/photo/${kind}`, { method: 'DELETE' }); load(); } };

  const shown = results.filter((r) => ({
    all: true, missing: (test.require_photo && (!r.has_start || !r.has_final)), captured: r.has_start && r.has_final,
    unreviewed: (r.has_start || r.has_final) && !r.photo_reviewed, reviewed: r.photo_reviewed, flagged: r.flagged,
  }[filter]));

  return (
    <>
      <h1>{test.title} <span className={'tag ' + test.status}>{test.status}</span></h1>
      <p className="small">Version {test.version} · {test.duration_minutes} min · {questions.length} questions</p>
      {msg && <p role="alert" className="notice">{msg}</p>}
      {info && <p role="status" className="notice">{info}</p>}
      <div className="row">
        {draft && <button className="primary" onClick={() => status('published')}>Publish</button>}
        {test.status === 'published' && <button onClick={() => status('closed')}>Close test</button>}
        {test.status === 'closed' && <button onClick={() => status('archived')}>Archive</button>}
        <button onClick={dup}>Duplicate as new version</button>
      </div>
      {test.status === 'published' && (
        <div className="card">
          <h2>Student link</h2>
          <p><a href={link}>{link}</a></p>
          {test.access_code && <p>Access code: <b>{test.access_code}</b></p>}
          {qr && <img src={qr} alt="QR code for student link" width="180" height="180" />}
        </div>
      )}
      <form className="card" onSubmit={saveSchedule}>
        <h2>Exam schedule</h2>
        <p className="small">All three times are required when scheduling is enabled. Times use this device's local time zone; changing the final time affects every active attempt immediately.</p>
        <div className="grid">
          <label>Exam start time — student entry opens<input type="datetime-local" value={schedule.examStartAt} onChange={(e) => setSchedule({ ...schedule, examStartAt: e.target.value })} disabled={test.status === 'archived'} /></label>
          <label>Login deadline — latest time to start<input type="datetime-local" value={schedule.loginDeadlineAt} onChange={(e) => setSchedule({ ...schedule, loginDeadlineAt: e.target.value })} disabled={test.status === 'archived'} /></label>
          <label>Final submission time — hard stop for every attempt<input type="datetime-local" value={schedule.finalSubmissionAt} onChange={(e) => setSchedule({ ...schedule, finalSubmissionAt: e.target.value })} disabled={test.status === 'archived'} /></label>
        </div>
        <button disabled={test.status === 'archived'}>Save schedule</button>
      </form>

      <h2>Questions</h2>
      {questions.map((x, i) => (
        <div className="card" key={x.id}>
          <p className="pre"><b>{i + 1}.</b> {x.text} <span className="small">({x.marks} marks)</span></p>
          {x.has_image && <ImageViewer src={`/api/teacher/questions/${x.id}/image`} alt={`Image for question ${i + 1}`} />}
          <ol type="A">{x.options.map((o, j) => <li key={j} className={j === x.correct_index ? 'right' : ''}>{o}</li>)}</ol>
          {draft && <button className="link" onClick={async () => { await api(`/teacher/tests/${id}/questions/${x.id}`, { method: 'DELETE' }); load(); }}>Delete</button>}
        </div>
      ))}
      {draft ? (
        <form className="card" onSubmit={addQ}>
          <h3>Add a multiple-choice question</h3>
          <label>Question<textarea rows={3} value={q.text} onChange={(e) => setQ({ ...q, text: e.target.value })} required /></label>
          {q.options.map((o, i) => (
            <label key={i} className="check"><input type="radio" name="correct" checked={q.correctIndex === i} onChange={() => setQ({ ...q, correctIndex: i })} aria-label={`Option ${i + 1} is correct`} />
              <input value={o} placeholder={`Option ${String.fromCharCode(65 + i)}${i < 2 ? ' (required)' : ''}`} onChange={(e) => setQ({ ...q, options: q.options.map((z, k) => (k === i ? e.target.value : z)) })} required={i < 2} /></label>
          ))}
          <p className="small">Select the radio button next to the correct option.</p>
          <label>Marks<input type="number" min="0.25" step="0.25" value={q.marks} onChange={(e) => setQ({ ...q, marks: e.target.value })} /></label>
          <label>Image / diagram (optional, JPEG/PNG/WebP, max 3 MB)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setQ({ ...q, image: e.target.files[0] || null })} /></label>
          <button className="primary">Add question</button>
        </form>
      ) : <p className="notice small">This test is {test.status}; its questions are locked so results stay reliable. Use “Duplicate as new version” to change them.</p>}

      <h2>Results</h2>
      <div className="row noprint">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter results">
          <option value="all">All attempts</option><option value="captured">Both photos captured</option><option value="missing">Photo missing</option>
          <option value="unreviewed">Photos not reviewed</option><option value="reviewed">Photos reviewed</option><option value="flagged">Flagged</option>
        </select>
        <a className="btn" href={`/api/teacher/tests/${id}/results.csv`}>Export CSV</a>
        <button onClick={emailAll}>Email responses to all students</button>
      </div>
      <div className="scroll">
        <table>
          <thead><tr><th>Student</th><th>Class</th><th>Roll</th><th>Status</th><th>Submitted</th><th>Mode</th><th>Marks</th><th>%</th><th>Warnings</th><th>Photos</th><th>Response sheet</th><th /></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={r.flagged ? 'flag' : ''}>
                <td>{r.student_name}</td><td>{r.class_name}</td><td>{r.roll_no}</td>
                <td>{r.status}{r.end_reason ? ` (${r.end_reason})` : ''}</td>
                <td>{r.submitted_at ? new Date(r.submitted_at).toLocaleString() : '–'}</td>
                <td>{r.submission_mode || '–'}</td>
                <td>{r.score ?? '–'} / {r.total ?? '–'}</td><td>{r.percent ?? '–'}</td><td>{r.warnings}</td>
                <td>{r.has_start ? 'S' : '–'} {r.has_final ? 'F' : '–'} {r.photo_reviewed ? '✓' : ''}</td>
                <td>{['photo_pending', 'submitted', 'photo_missing', 'terminated'].includes(r.status) ? (<>
                  <a href={`/api/teacher/attempts/${r.id}/response.pdf`}>PDF</a>{' · '}
                  <button className="link" onClick={() => emailOne(r.id)} title={r.student_email}>{r.email_status === 'sent' ? 'Resend' : 'Email'}</button>
                  <div className="small">{r.response_pdf_saved ? 'PDF saved' : 'PDF will be generated on download'}{r.email_status ? ` · ${r.email_status === 'failed' ? `failed: ${r.email_error || ''}` : r.email_status}` : ''}</div>
                  <div className="small">{r.student_email}</div></>) : '–'}</td>
                <td><button className="link" onClick={() => setOpen(open === r.id ? null : r.id)}>Review</button></td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan="12">No attempts match.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && (() => {
        const r = results.find((x) => x.id === open); if (!r) return null;
        return (
          <div className="card">
            <h3>{r.student_name} · roll {r.roll_no}</h3>
            <p className="small">Captured photos are records of who was at the camera, not verified identity. Differences in appearance are not proof of impersonation.</p>
            <div className="photos">
              {['start', 'final'].map((k) => (r['has_' + (k === 'start' ? 'start' : 'final')]
                ? <figure key={k}><ImageViewer src={`/api/teacher/attempts/${r.id}/photo/${k}`} alt={`${k} photo of ${r.student_name}`} /><figcaption>{k === 'start' ? 'Start photo' : 'Final photo'} <button className="link" onClick={() => delPhoto(r.id, k)}>delete</button></figcaption></figure>
                : <figure key={k}><div className="imgph">No {k} photo</div></figure>))}
            </div>
            <div className="row">
              <button onClick={() => review(r.id, { photoReviewed: !r.photo_reviewed })}>{r.photo_reviewed ? 'Mark photos unreviewed' : 'Mark photos reviewed'}</button>
              <button onClick={() => review(r.id, { flagged: !r.flagged })}>{r.flagged ? 'Remove flag' : 'Flag for review'}</button>
              <Link className="btn" to={`/dashboard/attempts/${r.id}/report`}>Report card</Link>
            </div>
            <label>Internal note<textarea rows={2} defaultValue={r.note || ''} onBlur={(e) => e.target.value !== (r.note || '') && review(r.id, { note: e.target.value })} /></label>
          </div>
        );
      })()}
    </>
  );
}
