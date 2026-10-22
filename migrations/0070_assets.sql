-- Asset library: one row per Freepik stock item (or an upload) the team brought into the studio,
-- shared by the Freepik API routes and the Magnific MCP adapter so a picture is downloaded once and
-- reused. `file_key` is set after a licensed download (assets/<provider_id>.<ext> in the bucket);
-- until then only the preview is known. `license` is JSON as the provider reports it: the type
-- (freemium | premium), whether attribution is required, and the allowed uses. `flattened` is 1
-- when the stored format cannot be edited as layers (a photo, a PSD rendered to a picture).
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  client TEXT,                              -- the client it was brought in for, when one
  source TEXT NOT NULL DEFAULT 'freepik',   -- freepik | upload
  provider_id TEXT NOT NULL,                -- Freepik resource id (demo-* in the demo catalogue)
  kind TEXT NOT NULL DEFAULT 'photo',       -- photo | vector | psd | template
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '{}',       -- JSON {type, attribution, uses[]}
  preview_url TEXT NOT NULL DEFAULT '',
  file_key TEXT,                            -- R2 key after a licensed download
  mime TEXT,
  width INTEGER,
  height INTEGER,
  flattened INTEGER NOT NULL DEFAULT 1,
  added_by TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS assets_provider ON assets(source, provider_id);
CREATE INDEX IF NOT EXISTS assets_client ON assets(client, created);

-- Where an asset went: a post's reference picture, or an image layer of a design (slide of a carousel).
CREATE TABLE IF NOT EXISTS asset_uses (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL,
  batch TEXT NOT NULL,
  post INTEGER NOT NULL,
  slide INTEGER,
  role TEXT NOT NULL,                       -- reference | design
  layer_id TEXT,                            -- the design layer, for a design use
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS asset_uses_asset ON asset_uses(asset, created);
CREATE INDEX IF NOT EXISTS asset_uses_batch ON asset_uses(batch, post);
