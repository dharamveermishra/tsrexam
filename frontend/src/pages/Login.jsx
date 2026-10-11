import { useState } from 'react';
import { api } from '../api.js';

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [msg, setMsg] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault(); setMsg('');
    try {
      if (mode === 'register') {
        const r = await api('/auth/register', { method: 'POST', body: f });
        setMsg(r.approved ? 'Account created. You can log in now.' : 'Account created. An administrator must approve it before you can log in.');
        setMode('login');
      } else onLogin(await api('/auth/login', { method: 'POST', body: { email: f.email, password: f.password } }));
    } catch (err) { setMsg(err.message); }
  }
  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>TSR Institute</h1>
      <h2>{mode === 'login' ? 'Teacher login' : 'Teacher registration'}</h2>
      {mode === 'register' && <label>Full name<input value={f.name} onChange={set('name')} required /></label>}
      <label>Email<input type="email" value={f.email} onChange={set('email')} required autoComplete="username" /></label>
      <label>Password<input type="password" value={f.password} onChange={set('password')} required minLength={mode === 'register' ? 10 : 1}
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
      {msg && <p role="alert" className="notice">{msg}</p>}
      <button className="primary">{mode === 'login' ? 'Log in' : 'Register'}</button>
      <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'Create a teacher account' : 'I already have an account'}
      </button>
    </form>
  );
}
