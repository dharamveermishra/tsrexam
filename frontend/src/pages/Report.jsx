import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';

export default function Report() {
  const { id } = useParams();
  const [d, setD] = useState(null), [err, setErr] = useState('');
  useEffect(() => { api('/teacher/attempts/' + id).then(setD).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <p role="alert">{err}</p>;
  if (!d) return <p className="center">Loading…</p>;
  const a = d.attempt; const has = (k) => d.photos.some((p) => p.kind === k);
  const pct = Number(a.total) > 0 ? Math.round((Number(a.score) / Number(a.total)) * 10000) / 100 : 0;
  const counted = d.events.filter((e) => e.counted).length;
  const dur = a.started_at && a.submitted_at ? Math.round((new Date(a.submitted_at) - new Date(a.started_at)) / 60000) : null;
  return (
    <div className="report">
      <button className="noprint primary" onClick={() => window.print()}>Print / Save as PDF</button>
      <h1>TSR Institute – Report Card</h1>
      <h2>{a.test_title} (version {a.test_version})</h2>
      <table><tbody>
        <tr><th>Student</th><td>{a.student_name}</td><th>Class</th><td>{a.class_name}</td></tr>
        <tr><th>Roll no.</th><td>{a.roll_no}</td><th>Status</th><td>{a.status}{a.end_reason ? ` (${a.end_reason})` : ''}</td></tr>
        <tr><th>Started</th><td>{a.started_at ? new Date(a.started_at).toLocaleString() : '–'}</td><th>Submitted</th><td>{a.submitted_at ? new Date(a.submitted_at).toLocaleString() : '–'}</td></tr>
        <tr><th>Duration</th><td>{dur !== null ? dur + ' min' : '–'}</td><th>Integrity warnings</th><td>{counted}</td></tr>
        <tr><th>Marks</th><td>{a.score ?? '–'} / {a.total ?? '–'}</td><th>Percentage</th><td>{pct}% {pct >= Number(a.pass_percent) ? '(Pass)' : '(Not passed)'}</td></tr>
        <tr><th>Correct / Wrong / Unanswered</th><td colSpan="3">{a.correct} / {a.wrong} / {a.unanswered}</td></tr>
      </tbody></table>
      {a.show_photos && (
        <div className="photos">
          {['start', 'final'].map((k) => (
            <figure key={k}>
              {has(k) ? <img src={`/api/teacher/attempts/${id}/photo/${k}`} alt={`${k} photo`} /> : <div className="imgph">No {k} photo</div>}
              <figcaption>{k === 'start' ? 'Photo at start' : 'Photo at submission'}{d.photos.find((p) => p.kind === k)?.captured_at ? ' – ' + new Date(d.photos.find((p) => p.kind === k).captured_at).toLocaleString() : ''}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <p className="small">Photos are captured images and are not a verification of identity.</p>
    </div>
  );
}
