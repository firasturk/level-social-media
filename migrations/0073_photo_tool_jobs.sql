-- Photo studio, AI tools and Presets: one job per provider tool run on a post's picture through the
-- Higgsfield MCP (upscale, remove background, outpaint, reframe, relight, a Soul-style picture, a
-- product-shot preset) or the Magnific MCP (its image tools). The input is the post's picture as it
-- was; the result lands under the post's output prefix (<owner>/<batch>/output/<task>/<job>.<ext>)
-- so "Use as the post's picture" only points the post at it. Credits, not dollars: `estimate` and
-- `reported` are credits of the provider's balance (null = not known).
CREATE TABLE IF NOT EXISTS photo_tool_jobs (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,
  post INTEGER NOT NULL,
  task TEXT NOT NULL,
  owner TEXT NOT NULL,                     -- who ran it
  provider TEXT NOT NULL,                  -- higgsfield | magnific
  tool TEXT NOT NULL,                      -- the studio's tool id (hf-upscale, mg-relight…) or preset:<id>
  label TEXT NOT NULL DEFAULT '',          -- plain words for the panel ("Upscale (Higgsfield)")
  options TEXT NOT NULL DEFAULT '{}',      -- what the person chose, as JSON
  input_key TEXT NOT NULL,
  output_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  provider_job TEXT,                       -- the Higgsfield job id or the Magnific creation identifier
  estimate REAL,                           -- credits named before the run; null = cost not known
  reported REAL,                           -- credits the balance moved by, when it could be read
  error TEXT,
  op_id TEXT,                              -- the integration_ops row
  settings TEXT NOT NULL DEFAULT '{}',     -- balanceBefore, the MCP tool and arguments (no secrets), jobIds
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photo_tool_jobs_post ON photo_tool_jobs(batch, post, created);
