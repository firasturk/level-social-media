-- AI influencers come back (docs/influencers.md): the sheet costs about 1.1 credits, not 1,125 as first
-- read, or one of the account's free generations. Trends use them through ambassador_trends
-- (character "influencer:<id>"). Same table as 0079, with the free generations left.
--   influencers.status: draft (designed and priced, nothing made) | making | ready | failed
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
  free_gens INTEGER,                    -- free influencer generations left, as Higgsfield said
  job_id TEXT,                          -- the character sheet's job (a trend's character_sheet)
  image_key TEXT,                       -- the finished sheet, copied to R2
  op_id TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS influencers_client ON influencers(client, created);
