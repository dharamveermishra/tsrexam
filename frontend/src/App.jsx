import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import TestDetail from './pages/TestDetail.jsx';
import Report from './pages/Report.jsx';
import Student from './pages/Student.jsx';

function TeacherShell({ children, user, onLogout }) {
  return (
    <div className="shell">
      <header className="bar noprint">
        <Link to="/dashboard" className="brand">TSR Institute</Link>
        <span>{user.name} <button className="link" onClick={onLogout}>Log out</button></span>
      </header>
      <main>{children}</main>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(undefined);
  const nav = useNavigate();
  useEffect(() => { api('/teacher/me').then(setUser).catch(() => setUser(null)); }, []);
  const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); setUser(null); nav('/login'); };
  if (user === undefined) return <p className="center">Loading…</p>;
  const guard = (el) => (user ? <TeacherShell user={user} onLogout={logout}>{el}</TeacherShell> : <Navigate to="/login" replace />);
  return (
    <Routes>
      <Route path="/t/:slug" element={<Student />} />
      <Route path="/login" element={<Login onLogin={(u) => { setUser(u); nav('/dashboard'); }} />} />
      <Route path="/dashboard" element={guard(<Dashboard />)} />
      <Route path="/dashboard/tests/:id" element={guard(<TestDetail />)} />
      <Route path="/dashboard/attempts/:id/report" element={guard(<Report />)} />
      <Route path="*" element={<Navigate to={user ? '/dashboard' : '/login'} replace />} />
    </Routes>
  );
}
