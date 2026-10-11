CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE teachers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'teacher' CHECK (role IN ('teacher','admin')),
  approved boolean NOT NULL DEFAULT true,
  disabled boolean NOT NULL DEFAULT false,
  token_version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL REFERENCES teachers(id),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  duration_minutes int NOT NULL CHECK (duration_minutes BETWEEN 1 AND 600),
  access_code text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed','archived')),
  require_photo boolean NOT NULL DEFAULT true,
  negative_marking numeric NOT NULL DEFAULT 0,
  pass_percent numeric NOT NULL DEFAULT 40,
  max_warnings int NOT NULL DEFAULT 4,
  on_limit text NOT NULL DEFAULT 'flag' CHECK (on_limit IN ('flag','terminate')),
  no_back boolean NOT NULL DEFAULT false,
  shuffle boolean NOT NULL DEFAULT true,
  release_result boolean NOT NULL DEFAULT true,
  show_photos boolean NOT NULL DEFAULT true,
  retention_days int NOT NULL DEFAULT 90,
  version int NOT NULL DEFAULT 1,
  parent_test_id uuid REFERENCES tests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX tests_teacher_idx ON tests(teacher_id);

CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  position int NOT NULL DEFAULT 0,
  text text NOT NULL,
  options jsonb NOT NULL,
  correct_index int NOT NULL,
  marks numeric NOT NULL DEFAULT 1,
  image_mime text,
  image_data bytea
);
CREATE INDEX questions_test_idx ON questions(test_id);

CREATE TABLE attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES tests(id),
  student_name text NOT NULL,
  class_name text NOT NULL,
  roll_no text NOT NULL,
  status text NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered','in_progress','photo_pending','submitted','photo_missing','terminated')),
  end_reason text CHECK (end_reason IN ('submitted','timeout','terminated')),
  token_hash text NOT NULL UNIQUE,
  question_order jsonb,
  option_orders jsonb,
  current_index int NOT NULL DEFAULT 0,
  started_at timestamptz,
  deadline_at timestamptz,
  submitted_at timestamptz,
  score numeric, total numeric, correct int, wrong int, unanswered int,
  warnings int NOT NULL DEFAULT 0,
  flagged boolean NOT NULL DEFAULT false,
  photo_reviewed boolean NOT NULL DEFAULT false,
  note text,
  consent_at timestamptz,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_id, roll_no)
);

CREATE TABLE answers (
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id),
  selected_index int,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('start','final')),
  mime text NOT NULL,
  data bytea NOT NULL,
  captured_at timestamptz,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, kind)
);

CREATE TABLE integrity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  type text NOT NULL,
  severity text NOT NULL,
  counted boolean NOT NULL DEFAULT false,
  client_event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, client_event_id)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  teacher_id uuid,
  action text NOT NULL,
  target text,
  meta jsonb NOT NULL DEFAULT '{}',
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
