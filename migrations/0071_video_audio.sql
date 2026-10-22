-- Audio for a post's video versions (docs/video.md "Audio", docs/audio-capabilities.md).
-- A track kept with a post: an upload the team licensed, or (later) a generated one. The clip's
-- mp4 is never changed on the server; the browser-side video editor mixes the track in.
CREATE TABLE IF NOT EXISTS video_audio (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,
  post INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- upload | generated
  key TEXT,                          -- R2 key of the audio file
  mime TEXT,                         -- audio/mpeg | audio/mp4 | audio/aac | audio/wav
  name TEXT,                         -- the track's name as the team knows it
  duration_ms INTEGER,
  license TEXT,                      -- free text: who licensed the track and under what
  provider TEXT,                     -- the engine that generated it, when one did
  op_id TEXT,                        -- the integration op that paid for it
  created INTEGER NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS video_audio_post ON video_audio(batch, post, created);

-- Each version's audio choice: provider | none | upload | generated | instagram; audio_id points at
-- the video_audio row for upload | generated. NULL means nothing was chosen (settings.audio stands).
ALTER TABLE videos ADD COLUMN audio_choice TEXT;
ALTER TABLE videos ADD COLUMN audio_id TEXT;
