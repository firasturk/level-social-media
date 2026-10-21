-- The art director's reading of a post before paying (the preflight), run from the Plan on request
-- and kept per post with the revision it was read for; the engine reuses it when the post is
-- unchanged, so the plan shows exactly what the engine will get.
CREATE TABLE IF NOT EXISTS plan_preflights (
  batch TEXT NOT NULL,
  post INTEGER NOT NULL,
  revision INTEGER,
  brief TEXT NOT NULL,        -- the PostBrief after the reading (JSON)
  inputs TEXT NOT NULL,       -- what the reading was made from (JSON), compared before reuse
  notes TEXT NOT NULL,        -- JSON string[]
  created INTEGER NOT NULL,
  PRIMARY KEY (batch, post)
);
