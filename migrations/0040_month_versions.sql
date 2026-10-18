-- Earlier versions of a month: when new ideas (a new grid) replace a month that has pictures, the
-- old plan and its pictures are kept here, so the team can open the grids they made before.
CREATE TABLE month_versions (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'snapshot',  -- snapshot | backfill (rebuilt from stored pictures) | scanned (marker)
  label TEXT NOT NULL DEFAULT '',
  grid TEXT,                              -- the grid the version followed (gridRef)
  plan TEXT,                              -- JSON Post[] (snapshots only)
  outputs TEXT NOT NULL DEFAULT '{}',     -- JSON { [post index]: R2 key }
  created INTEGER NOT NULL
);
CREATE INDEX month_versions_batch ON month_versions(batch, created);
