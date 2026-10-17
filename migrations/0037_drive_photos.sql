-- What vision read in each photo of the clients' Drive folders: a name the team finds it by, and
-- whether it is a product, a place, people or a design. Read a few at a time by the cron.
CREATE TABLE drive_photos (
  id TEXT PRIMARY KEY,                 -- the Drive file id
  client TEXT NOT NULL,
  file TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',       -- product | place | people | design | other
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',  -- new | read | failed
  updated INTEGER NOT NULL
);
CREATE INDEX drive_photos_client ON drive_photos(client, status);
-- When the client's folder was last listed by the cron.
ALTER TABLE client_profiles ADD COLUMN drive_listed INTEGER;
