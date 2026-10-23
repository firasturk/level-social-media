-- The video editor's render jobs: one row per "Render & update card". The browser renders (a Worker
-- cannot), so the row records what was asked and what came back: the project and the exact saved
-- revision rendered (its document copied here, so the job is reproducible whatever is saved later),
-- the progress the tab reports, the version the upload made, and what happened to it on the card.
--   status:  rendering | uploading | done | failed | interrupted (the tab stopped reporting)
--   outcome: card (the new version is on the card and the client link)
--          | review (on the card; the client had approved another version, so it waits for
--            "Send for review")
--          | superseded (a newer render or an explicit choice was already on the card; kept as a version only)
CREATE TABLE IF NOT EXISTS video_renders (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,                -- video_projects.id
  batch TEXT NOT NULL,
  post INTEGER NOT NULL,
  project_rev INTEGER NOT NULL,         -- the saved revision this render is of
  document TEXT NOT NULL,               -- that revision's JSON, frozen
  status TEXT NOT NULL DEFAULT 'rendering',
  progress REAL NOT NULL DEFAULT 0,     -- 0 … 1
  phase TEXT,
  video_id TEXT,                        -- videos.id once uploaded
  outcome TEXT,
  error TEXT,
  width INTEGER,
  height INTEGER,
  duration REAL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,             -- the last report from the tab (the heartbeat)
  finished INTEGER,
  created_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS video_renders_project ON video_renders(project, created);
CREATE INDEX IF NOT EXISTS video_renders_post ON video_renders(batch, post, created);

-- The version the studio card shows: the done version with the highest card_rank. A render puts its
-- version there with the time the render STARTED; an explicit choice ("Select for client review",
-- "Make this the card's version") with the time of the choice. A render is promoted only when no
-- version of the post has a higher rank, so a render that finishes late never replaces a newer
-- render or a later explicit choice.
ALTER TABLE videos ADD COLUMN card_rank INTEGER;
