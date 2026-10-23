-- The music library (docs/music-library.md, server/music.ts).
--
-- music_tracks: a client's own tracks, imported by an admin from Drive or an upload, each with the
-- licence the admin filled in and confirmed. A track is archived, never deleted, so a video that
-- used it keeps its licence record.
CREATE TABLE IF NOT EXISTS music_tracks (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  moods TEXT NOT NULL DEFAULT '[]',          -- JSON list of moods (shared/music.ts MUSIC_MOODS)
  genre TEXT NOT NULL DEFAULT '',
  bpm INTEGER,
  bpm_source TEXT,                           -- source | measured
  duration_ms INTEGER,
  key TEXT NOT NULL,                         -- R2 key of the audio file
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha1 TEXT,
  origin TEXT NOT NULL,                      -- upload | drive
  file_name TEXT,
  drive_id TEXT,
  drive_version TEXT,                        -- the Drive file's modifiedTime when it was copied
  drive_md5 TEXT,
  source TEXT NOT NULL,                      -- where the recording comes from, in words
  source_url TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  licence TEXT NOT NULL,                     -- cc0-1.0 | pdm-1.0 | cc-by-4.0 | cc-by-3.0 | paid | own | other
  licence_name TEXT NOT NULL,
  licence_version TEXT NOT NULL DEFAULT '',
  licence_url TEXT NOT NULL DEFAULT '',
  attribution TEXT NOT NULL DEFAULT '',
  content_id TEXT NOT NULL DEFAULT 'unknown', -- unknown | registered | not_registered
  content_id_note TEXT NOT NULL DEFAULT '',
  confirmed_by TEXT NOT NULL,                -- the admin who confirmed the rights
  confirmed INTEGER NOT NULL,
  created INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  archived INTEGER
);
CREATE INDEX IF NOT EXISTS music_tracks_client ON music_tracks(client, archived, created);

-- music_copies: each catalog track copied into our storage on first use, from where, under which
-- licence, by whom and when, with the size and SHA-1 of what was stored.
CREATE TABLE IF NOT EXISTS music_copies (
  track TEXT PRIMARY KEY,                    -- the catalog slug
  key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  licence TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha1 TEXT,
  copied INTEGER NOT NULL,
  copied_by TEXT NOT NULL
);
