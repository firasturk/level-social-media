-- Videos made from finished posts (Higgsfield image-to-video): the idea the designer approved,
-- the engine request and the stored result.
CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,
  post INTEGER NOT NULL,
  task TEXT NOT NULL,
  owner TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | done | failed
  request_id TEXT,
  key TEXT,                                -- R2 key of the mp4 once stored
  error TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX videos_post ON videos(batch, post, created);
