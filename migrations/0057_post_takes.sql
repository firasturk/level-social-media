-- Every take of a post's picture, as it is stored or as it fails: the key of the picture, what the
-- attempt cost (as recorded against the budget), the revision it was made for and a note (the edit
-- asked for, or the failure). The editor's Versions list and "Previous picture" read these rows.
CREATE TABLE IF NOT EXISTS post_takes (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,
  post INTEGER NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,            -- made | failed
  key TEXT,                        -- the stored picture (made)
  cost REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  made_for INTEGER,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS post_takes_batch_post ON post_takes(batch, post, created);
