# TSR Institute – Secure Online Examination Platform (v1 foundation)

React (Vite) frontend on **Netlify** · Node/Express API on **Render** · PostgreSQL on **Render** · code on **GitHub**.

```
Browser ──► Netlify (static React app)
              └─ /api/*  (Netlify proxy rewrite, status 200)
                    ▼
               Render Web Service (Express API) ──► Render PostgreSQL
```
The browser only ever talks to the Netlify domain. Netlify forwards `/api/*` to Render, so login cookies are
**first-party** (needed for iPhone Safari, which blocks third-party cookies).

## Honest status
Implemented and *syntax/unit tested here*: see "What was tested". Everything else must be tested by you on a live deployment.

| Area | Status |
|---|---|
| Teacher register / login / logout (revokes sessions), bcrypt, rate limits, optional admin approval | Done |
| Email verification, password reset | **Not implemented** |
| Student email at registration; per-student response PDF (questions, correct option, marked option); download PDF and email one/all students from Results (DB-backed queue, 3 retries, status shown) | Done – needs SMTP settings; not run against a real mail server |
| Test builder: draft→published→closed→archived, duplicate as new version, immutable published tests | Done |
| MCQ with marks, negative marking, pass %, shuffle, one-way navigation, access code, image per question | Done |
| Short/long/numerical questions, manual grading, mark corrections | **Not implemented** (MCQ only) |
| PDF/DOCX/PPTX import, OCR, AI question generation, background queue | **Not implemented** |
| Student registration + consent notice, live start photo, final photo, answers saved first | Done |
| Server-side deadline, grading, idempotent submit, answer autosave with retry, refresh recovery | Done |
| Exam start, login deadline, final hard-stop schedule; automatic submission and submission-mode records | Done (requires an always-on backend for deadline sweeper) |
| Response PDF permanently saved per finished attempt; teacher can download and bulk-email to registered student emails | Done – SMTP required for email |
| Integrity events (tab hidden, fullscreen exit, blur, offline), dedupe, cooldown, flag/terminate policy | Done (teacher dismiss/escalate UI not built) |
| VPN/proxy detection module | **Not implemented** (needs a paid reputation provider) |
| Teacher photo review, flag, notes, delete (audited), CSV export, printable report card | Done |
| Image zoom viewer (zoom, pan, pinch, wheel, keyboard, Esc, reset/fit/100%) | Done (needs real-device test) |
| Teacher email notifications on submission | **Not implemented** |
| Photo retention purge (hourly job), audit log | Done |
| Cross-teacher isolation | Enforced in SQL (`teacher_id` on every query). Automated DB tests **not written** |

## Try the idea first
Open `demo/demo.html` in any browser for a click-through simulation (no server needed).

## Folder layout
```
backend/   Express API  (src/, migrations/, test/)
frontend/  React app    (src/, netlify.toml)
```

## Local run (optional)
Needs Node 20+, PostgreSQL 14+.
```bash
createdb tsr_exam
cd backend && cp .env.example .env     # edit DATABASE_URL and JWT_SECRET
npm install && npm run migrate && npm start      # API on :10000
cd ../frontend && npm install && npm run dev     # app on :5173 (proxies /api)
```
Camera needs HTTPS except on `localhost`.

## DEPLOYMENT – step by step

### Step 1 – Put the code on GitHub
1. Create an account at github.com → **New repository** → name `tsr-exam` → **Private** → Create.
2. On your computer unzip this project, open a terminal in the `tsr-exam` folder and run:
```bash
git init
git add .
git commit -m "Initial TSR exam platform"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/tsr-exam.git
git push -u origin main
```
(No Git? Use GitHub Desktop, or on the repo page choose **Add file → Upload files** and drag the folders in.)

### Step 2 – Database on Render
1. Sign up at render.com with GitHub.
2. **New + → PostgreSQL**. Name `tsr-exam-db`, choose the region closest to your students (e.g. Singapore), pick a plan.
   *Check Render's current pricing: free databases expire after a short period – use a paid plan for real exams.*
3. After it is created, open it and copy the **Internal Database URL** (starts with `postgres://`).

### Step 3 – Backend on Render
1. **New + → Web Service** → connect your GitHub repo `tsr-exam`.
2. Settings: **Root Directory** `backend` · **Runtime** Node · **Build Command** `npm install` · **Start Command** `npm start`
   (`npm start` runs the database migrations first, then the server).
3. Choose a plan. *Free web services sleep after inactivity and take ~1 minute to wake: do not use free for live exams.*
4. **Environment** → add:
   | Key | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | the Internal Database URL from Step 2 |
   | `JWT_SECRET` | 48+ random characters (run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) |
   | `APP_ORIGIN` | your Netlify URL, e.g. `https://tsr-exam.netlify.app` (set after Step 4, then redeploy) |
   | `TRUST_PROXY` | `2` |
   | `ADMIN_EMAIL` | the email you will register first (becomes admin) |
   | `REQUIRE_APPROVAL` | `false` (or `true` to approve each new teacher) |
5. Click **Create Web Service**. When the log says `TSR exam API listening`, open `https://YOUR-SERVICE.onrender.com/health` – you should see `{"ok":true}`.
6. Copy the service URL (e.g. `https://tsr-exam-api.onrender.com`).

### Step 4 – Frontend on Netlify
1. **Edit `frontend/netlify.toml`** (in GitHub or locally, then push): replace `https://YOUR-SERVICE-NAME.onrender.com` with your Render URL from Step 3.6. Keep `/api/:splat` at the end.
2. Sign up at netlify.com with GitHub → **Add new site → Import an existing project → GitHub** → pick `tsr-exam`.
3. **Base directory** `frontend` · **Build command** `npm run build` · **Publish directory** `dist` → **Deploy**.
4. When it finishes you get a URL like `https://something.netlify.app` (change it under *Site configuration → Change site name*).
5. Go back to Render → backend → Environment → set `APP_ORIGIN` to that exact URL (no trailing slash) → it redeploys.

### Step 4b – Turn on email (needed for "Email responses to students")
1. Pick an SMTP provider (e.g. Brevo, Zoho, SendGrid, or Gmail with an *App Password*) and create SMTP credentials. Verify your sender address/domain with the provider.
2. In Render → backend → Environment add `SMTP_HOST`, `SMTP_PORT` (usually 587), `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM` (e.g. `TSR Institute <exams@yourdomain.com>`), then let it redeploy.
3. Check Render's current rules: outbound SMTP may be restricted on free instances. If emails fail with a connection error, use a paid instance or ask for an API-based email adapter.
4. Teacher side: Test → Results → **PDF** (download), **Email** (one student) or **Email responses to all students**. Status shows queued / sent / failed; failures retry 3 times automatically.
Note: the PDF uses a standard Latin font, so non-Latin text (e.g. Hindi) will not render correctly yet; question diagrams appear as a note, not the image.

## Exam schedule and saved response PDFs

When creating a test or from its teacher detail page, set all three schedule values together:

1. **Exam start time** opens registration.
2. **Login deadline** is exclusive: registration and starting are denied at or after this server timestamp.
3. **Final submission time** is the hard stop for all active attempts, even when their individual duration would end later.

Times entered in the teacher's browser are converted to ISO timestamps with a timezone offset before saving. PostgreSQL/server time is authoritative; students see the displayed times in their browser's local timezone. Active attempts have their deadline capped at the earlier of their normal duration and the final submission time. A backend sweep runs every second and finalizes overdue attempts; any student API request at/after the deadline also finalizes before it can accept another answer. The submission record stores a cutoff timestamp and `manual` or `automatic` mode. A required final-photo step can remain pending after the answer/result has been safely finalized; it never extends the deadline or permits answer changes.

Each finalized attempt's question/answer response PDF is saved in PostgreSQL. In Test → Results the teacher can download one student's PDF or queue PDFs to the email addresses captured at registration. Bulk sends skip students already sent or currently queued; the database-backed worker tracks status and retries temporary failures. SMTP must be configured as described above.

**Hosting caveat:** a periodic sweep only runs while the backend process is running. Free backend tiers may sleep, restart, or scale to zero, so they cannot guarantee exact-time background work. The backend recovers overdue attempts on the next request/startup sweep, but for scheduled high-stakes tests use an always-on backend instance (or a managed scheduler/worker with the same database). Netlify remains static hosting and proxies API requests; it cannot itself perform automatic submission.

Migrations are applied by `npm start` and recorded in `schema_migrations`; migration `003_exam_schedule_and_response_reports.sql` adds schedule timestamps, submission mode, and persistent PDF storage without dropping existing records.

Relevant schedule/report API routes:

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/teacher/tests` | Create a test with optional `examStartAt`, `loginDeadlineAt`, and `finalSubmissionAt` ISO timestamps |
| `PUT` | `/api/teacher/tests/:id/schedule` | Change or clear an owned test's schedule; updates active attempt deadlines transactionally |
| `GET` | `/api/public/test/:slug` | Return test instructions, schedule, and whether registration is currently open |
| `POST` | `/api/public/test/:slug/register` | Create a registration only while server time is within the configured window |
| `POST` | `/api/attempt/begin` | Re-check the login deadline and start with a server-calculated deadline |
| `GET` | `/api/attempts/:id/response.pdf` | Teacher-only download of the persisted response sheet |
| `POST` | `/api/teacher/tests/:id/send-responses` | Queue response PDFs to finished students' registration emails |

### Step 5 – First use
1. Open your Netlify URL → **Create a teacher account** using the same email as `ADMIN_EMAIL` → log in.
2. **Create a test** → add questions → **Publish** → copy the student link / QR code.
3. Open the link on an Android phone (Chrome) and an iPhone (Safari), register, allow the camera, take the test.
4. Back on the teacher page → test → Results → **Review** to see photos, flag, export CSV, open the report card.

### Updating later
Push to GitHub; Netlify and Render redeploy automatically. To change a **published** test, use **Duplicate as new version**.

## Security notes
- Correct answers never leave the server before grading; students receive only question text and shuffled options.
- Deadlines, grading, navigation limits and attempt state are enforced on the server; client timers are cosmetic.
- Photos are stored in PostgreSQL (private), validated by file signature (JPEG/PNG/WebP), max 2 MB, served only through
  authenticated, ownership-checked endpoints with `no-store`. Back up your database (Render paid plans include backups; or `pg_dump`).
- CSRF: no CORS, mandatory `X-Requested-With` header, Origin check, `SameSite=Lax` HttpOnly Secure cookies.
- Browser monitoring is a **signal, not proof**. Calls, notifications and OS behaviour cause false positives; teachers should review.
- A normal web page **cannot** block screenshots, split-screen, other apps/AI tools, second devices, or VPNs, and a browser camera cannot
  rule out virtual cameras. Photos are "captured photos", not verified identity. For high-stakes exams use supervised rooms or
  managed devices (Android Enterprise lock-task, supervised iPad with Automatic Assessment Configuration / a kiosk exam app).
- Privacy (India DPDP Act 2023): collect only what is needed, give the notice (shown to students), obtain a parent/guardian's consent for
  minors, set short retention, and appoint someone responsible for deletion requests. Have a lawyer review your final notice.

## Known gaps / next work
Email verification & reset, short/long answer + manual grading, document import/OCR/AI generation (needs a worker and
paid AI key), VPN reputation provider, integrity-event dismiss UI, single-tab enforcement (currently last write wins), automated
cross-teacher and end-to-end tests, authorised-exception flow for broken cameras, rate-limit store shared across instances.

## What was tested here
In this authoring environment, `node --test backend/test/*.test.js` passed **6/6 tests**, including schedule validation. `node --check` passed for backend JS and frontend plain-JS files; editor diagnostics reported no errors in the changed JSX files. npm/Vite dependencies and PostgreSQL were unavailable, so the production frontend build, migration execution, schedule/PDF database integration, real SMTP delivery, and Android Chrome/iOS Safari testing were not run. Run `cd backend && npm test`, `cd frontend && npm run build`, and apply migrations against a staging PostgreSQL database before deployment.
