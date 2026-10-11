ALTER TABLE tests ADD COLUMN exam_start_at timestamptz;
ALTER TABLE tests ADD COLUMN login_deadline_at timestamptz;
ALTER TABLE tests ADD COLUMN final_submission_at timestamptz;

ALTER TABLE attempts
  ADD COLUMN submission_mode text NOT NULL DEFAULT 'manual'
    CHECK (submission_mode IN ('manual', 'automatic'));

CREATE INDEX attempts_active_deadline_idx
  ON attempts(status, deadline_at)
  WHERE status = 'in_progress';

CREATE INDEX tests_final_submission_idx
  ON tests(final_submission_at)
  WHERE status = 'published' AND final_submission_at IS NOT NULL;

CREATE TABLE response_reports (
  attempt_id uuid PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
  filename text NOT NULL,
  pdf_data bytea NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);
