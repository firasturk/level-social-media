-- Error log (15 Nov): every failed action and server error is written down with the user and the
-- screen, so a problem is found the day it happens instead of weeks later over WhatsApp. One row
-- per occurrence; the fingerprint is a hash of the kind and the message with its numbers, ids,
-- quoted names and amounts taken out, so the same problem groups together on the Admin page.
-- Never a request body, a cookie or a header; keys and tokens are stripped before a row is stored.
-- Rows older than 30 days are removed by the daily cleanup.

CREATE TABLE IF NOT EXISTS error_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,               -- ms
  kind TEXT NOT NULL,                -- toast (an error message the user was shown) | crash (uncaught error, failed render) | network (no connection, timeout) | server (a 5xx answer or a throw)
  user_id TEXT,
  user_name TEXT,
  role TEXT,
  screen TEXT,                       -- path + search, and the step or tab when known
  message TEXT NOT NULL,             -- what the user saw, or the error text (max 500)
  detail TEXT,                       -- stack top, or the request's method, path and status (max 1000)
  build TEXT,                        -- the X-Build the page was loaded from, or the server's build
  fingerprint TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS error_log_at ON error_log(at);
CREATE INDEX IF NOT EXISTS error_log_fingerprint ON error_log(fingerprint, at);
