import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { pool, audit } from './db.js';

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  console.error('JWT_SECRET must be set to 32+ characters');
  process.exit(1);
}
const COOKIE = 'tsr_session';
const cookieOpts = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 8 * 3600 * 1000,
  path: '/',
};
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

export async function requireTeacher(req, res, next) {
  try {
    const tok = req.cookies[COOKIE];
    if (!tok) return res.status(401).json({ error: 'auth' });
    const p = jwt.verify(tok, SECRET);
    const { rows: [u] } = await pool.query(
      'SELECT id,email,name,role,approved,disabled,token_version FROM teachers WHERE id=$1', [p.sub]);
    if (!u || u.disabled || !u.approved || u.token_version !== p.tv) return res.status(401).json({ error: 'auth' });
    req.user = u;
    next();
  } catch { res.status(401).json({ error: 'auth' }); }
}

const router = Router();
const emailOk = (e) => typeof e === 'string' && e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

router.post('/register', limiter, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 100) return res.status(400).json({ error: 'Enter your name' });
  if (!emailOk(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (typeof password !== 'string' || password.length < 10 || password.length > 200)
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  const em = email.trim().toLowerCase();
  const isAdmin = process.env.ADMIN_EMAIL && em === process.env.ADMIN_EMAIL.toLowerCase();
  const approved = isAdmin || process.env.REQUIRE_APPROVAL !== 'true';
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows: [u] } = await pool.query(
      'INSERT INTO teachers(email,name,password_hash,role,approved) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [em, name.trim(), hash, isAdmin ? 'admin' : 'teacher', approved]);
    audit(u.id, 'teacher.register', u.id, {}, req.ip);
    res.json({ ok: true, approved });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', limiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!emailOk(email) || typeof password !== 'string') return res.status(400).json({ error: 'Invalid credentials' });
  const { rows: [u] } = await pool.query('SELECT * FROM teachers WHERE email=$1', [email.trim().toLowerCase()]);
  const ok = u && (await bcrypt.compare(password, u.password_hash));
  if (!ok || u.disabled) { audit(u?.id ?? null, 'login.failed', email.slice(0, 100), {}, req.ip); return res.status(401).json({ error: 'Invalid credentials' }); }
  if (!u.approved) return res.status(403).json({ error: 'Your account is waiting for administrator approval' });
  const token = jwt.sign({ sub: u.id, tv: u.token_version }, SECRET, { expiresIn: '8h' });
  res.cookie(COOKIE, token, cookieOpts);
  audit(u.id, 'login.ok', u.id, {}, req.ip);
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role });
});

// Logout revokes every session of this teacher (token_version bump)
router.post('/logout', requireTeacher, async (req, res) => {
  await pool.query('UPDATE teachers SET token_version=token_version+1 WHERE id=$1', [req.user.id]);
  audit(req.user.id, 'logout', req.user.id, {}, req.ip);
  res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined });
  res.json({ ok: true });
});

export default router;
