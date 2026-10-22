-- What a month delivered into the client's Google Drive: one row per file the studio put in the
-- month's subfolder of the client's Outputs folder (a post's picture, or captions.txt). A second
-- delivery of the same post updates the file the row names instead of creating a duplicate.
CREATE TABLE drive_deliveries (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,
  client TEXT NOT NULL,
  folder TEXT NOT NULL,                    -- the month's subfolder id in Drive
  file_id TEXT NOT NULL,                   -- the Drive file id
  post INTEGER,                            -- the plan post index; NULL for captions.txt
  name TEXT NOT NULL,                      -- the file name in Drive
  kind TEXT NOT NULL,                      -- picture | captions
  md5 TEXT NOT NULL DEFAULT '',            -- Drive's checksum of the last upload
  web_link TEXT NOT NULL DEFAULT '',       -- Drive's webViewLink
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX drive_deliveries_batch_post ON drive_deliveries(batch, post, kind);
