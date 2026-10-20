-- Lessons wait for the admin's approval before the prompts carry them; where each came from is kept.
ALTER TABLE lessons ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'; -- pending | approved | rejected
ALTER TABLE lessons ADD COLUMN source TEXT NOT NULL DEFAULT 'review';  -- review | client | retry
UPDATE lessons SET status = 'approved';
CREATE INDEX lessons_status_last ON lessons(status, last);
