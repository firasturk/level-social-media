-- Mistakes the automatic review found in a client's pictures, kept so later prompts forbid them.
CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 1,
  first INTEGER NOT NULL,
  last INTEGER NOT NULL,
  batch TEXT
);
CREATE UNIQUE INDEX lessons_client_text ON lessons(client, text);
CREATE INDEX lessons_client_last ON lessons(client, last);
