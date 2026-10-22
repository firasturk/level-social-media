-- Client feedback on a month (pasted, typed, dictated or from the approval page) and the changes
-- read out of it, each approved and applied one at a time by the designer. Nothing here is applied
-- by itself; a layer or words change patches the plan, a picture edit goes through Generate's own
-- approval, an idea rewrites the post's brief.
CREATE TABLE IF NOT EXISTS client_feedback (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  post INTEGER,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'typed',   -- pasted | typed | voice | approval-page
  interpreter TEXT NOT NULL DEFAULT 'rules', -- rules | model | demo
  created INTEGER NOT NULL,
  by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS client_feedback_batch ON client_feedback(batch, created);

CREATE TABLE IF NOT EXISTS feedback_actions (
  id TEXT PRIMARY KEY,
  feedback TEXT NOT NULL REFERENCES client_feedback(id) ON DELETE CASCADE,
  batch TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  post INTEGER,
  slide INTEGER,
  version TEXT,
  kind TEXT NOT NULL,                      -- layer | image | words | idea | unclear
  change TEXT NOT NULL,
  patch TEXT,                              -- JSON: a PostOverlayPatch (layer) or {headline, caption, subline} (words)
  instruction TEXT,
  ambiguity TEXT,
  conflict TEXT,
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed | approved | applied | rejected
  applied_at INTEGER,
  applied_result TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_actions_batch ON feedback_actions(batch, created);
CREATE INDEX IF NOT EXISTS feedback_actions_feedback ON feedback_actions(feedback, created);
