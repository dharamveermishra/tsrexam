import { useEffect, useRef, useState } from 'react';

function explain(e) {
  switch (e?.name) {
    case 'NotAllowedError': return 'Camera permission was denied. Allow camera access for this site in your browser settings, then tap Try again.';
    case 'NotFoundError': return 'No camera was found on this device.';
    case 'NotReadableError': return 'The camera is being used by another app. Close it and tap Try again.';
    case 'OverconstrainedError': return 'This camera does not support the requested settings.';
    default: return 'The camera could not be started. ' + (window.isSecureContext ? '' : 'This page must be opened over HTTPS.');
  }
}

// Live capture only: the picture is drawn from the active camera stream, never from a file picker.
export default function Camera({ onConfirm, confirmLabel = 'Use this photo' }) {
  const video = useRef(), stream = useRef();
  const [err, setErr] = useState(''), [shot, setShot] = useState(null), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);

  const stop = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; setReady(false); };
  async function open() {
    setErr('');
    if (!navigator.mediaDevices?.getUserMedia) { setErr('This browser does not support camera access. Use current Chrome (Android) or Safari (iPhone/iPad).'); return; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      stream.current = s; video.current.srcObject = s; await video.current.play(); setReady(true);
    } catch (e) { setErr(explain(e)); }
  }
  useEffect(() => { open(); return stop; }, []);

  function capture() {
    const v = video.current; if (!v.videoWidth) return;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    c.toBlob((b) => { setShot({ blob: b, url: URL.createObjectURL(b), at: new Date().toISOString() }); stop(); }, 'image/jpeg', 0.85);
  }
  const retake = () => { URL.revokeObjectURL(shot.url); setShot(null); open(); };
  async function confirm() {
    setBusy(true); setErr('');
    try { await onConfirm(shot.blob, shot.at); } catch (e) { setErr(e.message || 'Upload failed. Check your connection and try again.'); }
    setBusy(false);
  }
  return (
    <div className="camera">
      <video ref={video} playsInline muted autoPlay style={{ display: shot ? 'none' : 'block' }} />
      {shot && <img src={shot.url} alt="Your captured photo" />}
      {err && <p role="alert" className="notice">{err}</p>}
      <div className="row">
        {!shot && !ready && <button type="button" onClick={open}>Try again</button>}
        {!shot && ready && <button type="button" className="primary" onClick={capture}>Capture photo</button>}
        {shot && <>
          <button type="button" onClick={retake} disabled={busy}>Retake</button>
          <button type="button" className="primary" onClick={confirm} disabled={busy}>{busy ? 'Uploading…' : confirmLabel}</button>
        </>}
      </div>
    </div>
  );
}
