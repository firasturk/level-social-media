-- A planner's answer kept as a draft until the team applies it: the posts it would add or change,
-- the diff against the month, and what was asked. Applying it is the one step that changes the
-- month; discarding it changes nothing. Closing the screen leaves the draft where it is.
CREATE TABLE IF NOT EXISTS plan_drafts (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,
  kind TEXT NOT NULL,              -- campaign | ideas | grid
  mode TEXT NOT NULL,              -- append | replace
  input TEXT NOT NULL DEFAULT '{}',-- JSON: the brief text, reference count, notes, colours
  posts TEXT NOT NULL,             -- JSON Post[] with provisional indexes
  summary TEXT NOT NULL DEFAULT '',
  diff TEXT NOT NULL DEFAULT '{}', -- JSON DraftDiff
  status TEXT NOT NULL DEFAULT 'draft', -- draft | applied | discarded
  created INTEGER NOT NULL,
  applied_at INTEGER,
  by TEXT
);
CREATE INDEX IF NOT EXISTS plan_drafts_batch ON plan_drafts(batch, status, created);
