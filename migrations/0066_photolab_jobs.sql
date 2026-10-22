-- Photo lab: one job per real-photo tool run on Freepik (Magnific) against a client's approved
-- Drive photo, a made picture or an earlier result: remove the background, replace it from a
-- prompt, relight, upscale. The input is copied into the bucket first (photolab/<id>-in.*) so the
-- provider reads a stable URL; the result lands beside it (photolab/<id>-out.*). A job made with
-- no key connected is a demo: the output is the input copied, provider 'demo', cost 0.
CREATE TABLE IF NOT EXISTS photolab_jobs (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  batch TEXT,                              -- the month the input came from, when it did
  post INTEGER,                            -- the post whose picture was the input, when it was
  op TEXT NOT NULL,                        -- remove-bg | background | relight | upscale
  prompt TEXT NOT NULL DEFAULT '',
  input_key TEXT NOT NULL,
  input_label TEXT NOT NULL DEFAULT '',
  output_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  provider TEXT NOT NULL DEFAULT 'freepik',-- freepik | demo
  provider_task TEXT,                      -- the provider's task id while it runs
  cost REAL NOT NULL DEFAULT 0,            -- approximate USD, from the price table
  error TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photolab_jobs_client ON photolab_jobs(client, created);
