-- Trend videos with a character (docs/ambassador-trends.md): Genjutsu motion presets with the
-- character's picture as its reference: one of the client's ambassadors (its portrait) or one of the
-- Soul characters made on the Higgsfield account. Replaces the AI influencer tables of 0079 (never
-- used: making a Higgsfield influencer costs too much; the team brings its own characters).
--   ambassador_trends.status: queued | generating | done | failed
DROP TABLE IF EXISTS influencer_trends;
DROP TABLE IF EXISTS influencers;
CREATE TABLE IF NOT EXISTS ambassador_trends (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  character TEXT NOT NULL,              -- "ambassador:<id>" or "soul:<soul id>"
  character_name TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  preset_name TEXT NOT NULL,
  preview TEXT,                         -- the preset's own example (hotlinked)
  status TEXT NOT NULL DEFAULT 'queued',
  job_id TEXT,
  video_key TEXT,
  credits REAL,
  op_id TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ambassador_trends_client ON ambassador_trends(client, created);
