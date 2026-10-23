-- The Help assistant (server/help.ts): every question asked and every request sent to Firas.
--   kind:   question (asked the assistant; its answer kept) | request (sent to Firas, from the assistant's draft)
--   known:  1 = the guide covered it, 0 = the assistant could not answer (the request button was offered)
--   status: requests only: open | done (Firas marks it, with an optional reply the sender sees)
CREATE TABLE IF NOT EXISTS help_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  known INTEGER NOT NULL DEFAULT 1,
  screen TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  reply TEXT,
  mailed INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS help_requests_kind ON help_requests (kind, status, created);
CREATE INDEX IF NOT EXISTS help_requests_user ON help_requests (user_id, created);
