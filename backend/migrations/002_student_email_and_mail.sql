ALTER TABLE attempts ADD COLUMN student_email text;

CREATE TABLE email_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'response',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  tries int NOT NULL DEFAULT 0,
  error text,
  run_after timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX email_log_attempt_idx ON email_log(attempt_id);
CREATE INDEX email_log_queue_idx ON email_log(status, run_after);
