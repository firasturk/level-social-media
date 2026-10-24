-- AI influencers (docs/influencers.md): a client's own AI person, made as a Higgsfield character
-- sheet, and the trend videos it is put into (Genjutsu motion presets).
--   influencers.status: draft (designed and priced, nothing made) | making | ready | failed
--   influencer_trends.status: queued | generating | done | failed
CREATE TABLE IF NOT EXISTS influencers (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  name TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  params TEXT,                          -- the exact params ai_influencer_prepare returned
  design TEXT,                          -- what the preparation said about the design
  credits REAL,                         -- its quote
  job_id TEXT,                          -- the character sheet's job (the trends' character_sheet)
  image_key TEXT,                       -- the finished sheet, copied to R2
  op_id TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS influencers_client ON influencers(client, created);

CREATE TABLE IF NOT EXISTS influencer_trends (
  id TEXT PRIMARY KEY,
  influencer TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS influencer_trends_influencer ON influencer_trends(influencer, created);
