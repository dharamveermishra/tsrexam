import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
});

export const audit = (teacherId, action, target, meta = {}, ip = null) =>
  pool
    .query('INSERT INTO audit_log(teacher_id,action,target,meta,ip) VALUES($1,$2,$3,$4,$5)', [
      teacherId, action, target, JSON.stringify(meta), ip,
    ])
    .catch((e) => console.error('audit failed', e.message));
