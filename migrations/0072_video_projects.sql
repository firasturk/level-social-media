-- The video editor's projects: one JSON document per cut of a post's footage (clips, trims, order,
-- speed, transitions, colour, music, output). `source_video` is the version the project opened
-- from; `rendered_video` is the version the last export produced (a `videos` row with
-- provider = 'editor'). `rev` grows on every save and guards against a stale tab (409).
CREATE TABLE IF NOT EXISTS video_projects (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,
  post INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL,                -- JSON, shared/video-project.ts
  rev INTEGER NOT NULL DEFAULT 0,
  source_video TEXT,                    -- videos.id the project opened from
  rendered_video TEXT,                  -- videos.id the last export produced
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS video_projects_post ON video_projects(batch, post, updated);
