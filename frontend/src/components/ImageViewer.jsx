import { useEffect, useRef, useState } from 'react';

// Thumbnail + accessible zoom modal. If `token` is given the image is fetched with the student's
// bearer token (img tags cannot send headers). Sets window.__viewerOpen so exam monitoring ignores it.
export default function ImageViewer({ src, alt, token }) {
  const [url, setUrl] = useState(null);
  const [state, setState] = useState('loading');
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ s: 1, x: 0, y: 0 });
  const img = useRef(), closeBtn = useRef(), opener = useRef(), pts = useRef(new Map()), pinch = useRef(0);

  useEffect(() => {
    let dead = false, obj;
    setState('loading');
    fetch(src, { headers: token ? { Authorization: 'Bearer ' + token } : {}, credentials: 'same-origin' })
      .then((r) => { if (!r.ok) throw new Error(); return r.blob(); })
      .then((b) => { if (dead) return; obj = URL.createObjectURL(b); setUrl(obj); setState('ok'); })
      .catch(() => !dead && setState('error'));
    return () => { dead = true; if (obj) URL.revokeObjectURL(obj); };
  }, [src, token]);

  useEffect(() => {
    if (!open) return;
    window.__viewerOpen = true;
    closeBtn.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const key = (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === '+' || e.key === '=') zoom(1.25);
      else if (e.key === '-') zoom(0.8);
      else if (e.key === '0') setV({ s: 1, x: 0, y: 0 });
      else if (e.key.startsWith('Arrow')) {
        const d = 40; setV((p) => ({ ...p, x: p.x + (e.key === 'ArrowLeft' ? d : e.key === 'ArrowRight' ? -d : 0), y: p.y + (e.key === 'ArrowUp' ? d : e.key === 'ArrowDown' ? -d : 0) }));
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); document.body.style.overflow = prevOverflow; setTimeout(() => { window.__viewerOpen = false; }, 400); };
  }, [open]);

  const close = () => { setOpen(false); setV({ s: 1, x: 0, y: 0 }); opener.current?.focus(); };
  const zoom = (k) => setV((p) => ({ ...p, s: Math.min(8, Math.max(0.5, p.s * k)) }));
  const actual = () => { const el = img.current; if (el && el.clientWidth) setV({ s: Math.min(8, el.naturalWidth / el.clientWidth), x: 0, y: 0 }); };

  const down = (e) => { e.currentTarget.setPointerCapture(e.pointerId); pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); pinch.current = 0; };
  const move = (e) => {
    const m = pts.current; if (!m.has(e.pointerId)) return;
    const prev = m.get(e.pointerId); m.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (m.size === 1) setV((p) => ({ ...p, x: p.x + e.clientX - prev.x, y: p.y + e.clientY - prev.y }));
    else if (m.size === 2) {
      const [a, b] = [...m.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current) zoom(d / pinch.current); pinch.current = d;
    }
  };
  const up = (e) => { pts.current.delete(e.pointerId); pinch.current = 0; };
  const wheel = (e) => zoom(e.deltaY < 0 ? 1.15 : 0.87);

  if (state === 'loading') return <div className="imgph">Loading image…</div>;
  if (state === 'error') return <div className="imgph err" role="alert">Image failed to load.</div>;
  return (
    <>
      <button type="button" ref={opener} className="thumb" onClick={() => setOpen(true)} aria-label={`Enlarge image: ${alt}`}>
        <img src={url} alt={alt} loading="lazy" />
        <span>Tap to zoom</span>
      </button>
      {open && (
        <div className="viewer" role="dialog" aria-modal="true" aria-label={alt}>
          <div className="vbar">
            <button onClick={() => zoom(1.25)} aria-label="Zoom in">＋</button>
            <button onClick={() => zoom(0.8)} aria-label="Zoom out">－</button>
            <button onClick={() => setV({ s: 1, x: 0, y: 0 })}>Fit</button>
            <button onClick={actual}>100%</button>
            <button onClick={() => setV({ s: 1, x: 0, y: 0 })}>Reset</button>
            <button ref={closeBtn} onClick={close} aria-label="Close image viewer">✕ Close</button>
          </div>
          <div className="vstage" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel}>
            <img ref={img} src={url} alt={alt} draggable={false}
              style={{ transform: `translate(${v.x}px,${v.y}px) scale(${v.s})` }} />
          </div>
        </div>
      )}
    </>
  );
}
