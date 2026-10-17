-- A client's profile: what the Analysis read from their Instagram, their website and the brands
-- the team compares them with, and what it understood (tone, offer, branding, content, tips).
CREATE TABLE client_profiles (
  client TEXT PRIMARY KEY,
  instagram TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  refs TEXT NOT NULL DEFAULT '[]',     -- JSON [{handle, website, kind: competitor | direction}]
  profile TEXT,                        -- JSON ClientProfile
  sources TEXT,                        -- JSON: what was read, for the screen
  status TEXT NOT NULL DEFAULT 'idle', -- idle | running | failed
  error TEXT,
  analysed INTEGER,
  updated INTEGER NOT NULL
);
-- Grids suggested for one client by its profile (empty for the shared library).
ALTER TABLE styles ADD COLUMN client TEXT NOT NULL DEFAULT '';
CREATE INDEX styles_client ON styles(client, status);
