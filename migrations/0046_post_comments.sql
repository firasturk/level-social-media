-- Notes the team leaves on a post of a month (what to change, what the client said).
CREATE TABLE post_comments (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  post INTEGER NOT NULL,
  user TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX post_comments_batch ON post_comments(batch, post, created);
