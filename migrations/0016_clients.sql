-- Clients: the brands Level works for. Replaces the production-approach cards as the first choice
-- of a batch. Brand-kit fields are stored here from the start; Phase 2 fills them in.
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,         -- export names, lowercase a-z0-9-
  name TEXT NOT NULL,
  logo_key TEXT,                     -- R2 key of the primary logo
  colors TEXT NOT NULL DEFAULT '[]', -- JSON [{name, hex}]
  fonts TEXT NOT NULL DEFAULT '{}',  -- JSON {headline, body}
  tone TEXT NOT NULL DEFAULT '',
  dos TEXT NOT NULL DEFAULT '',
  donts TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',    -- "Analyse identity" result, editable
  grid_rhythm TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'ar', -- caption language: ar | en | both
  status TEXT NOT NULL DEFAULT 'active', -- active | archived
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS brand_assets (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- logo | logo_white | logo_dark | font | example
  key TEXT NOT NULL,
  name TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS brand_assets_client ON brand_assets(client, kind);

-- Every batch belongs to one client (denormalised from config.client for filtering).
ALTER TABLE batches ADD COLUMN client TEXT;
CREATE INDEX IF NOT EXISTS batches_client ON batches(client, created);

-- Level's first clients.
INSERT OR IGNORE INTO clients (id, slug, name, position, created, updated) VALUES
  ('habibah', 'habibah', 'Habibah', 1, strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000),
  ('abu-saleh', 'abu-saleh', 'Abu Saleh', 2, strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000),
  ('united-insurance', 'united-insurance', 'United Insurance', 3, strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000),
  ('abira', 'abira', 'Abira', 4, strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000),
  ('jubilee', 'jubilee', 'Jubilee', 5, strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000);
