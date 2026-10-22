-- The Drive folders a client's photos are read from, each with a role: product photos, brand
-- assets (logos, packaging art), references (inspiration, never a product) and outputs. A folder is
-- read once the team approves it. A client with no approved folder keeps reading the one folder
-- linked on its profile (client_profiles.drive) as its product folder.
CREATE TABLE drive_folders (
  id TEXT PRIMARY KEY,                     -- the Drive folder id
  client TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'product',    -- product | brand | reference | output
  approved INTEGER NOT NULL DEFAULT 0,
  added_by TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX drive_folders_client ON drive_folders(client, approved);

-- The snapshot a month's product photo was imported from: the Drive file, the version (its
-- modifiedTime) and checksum at the time. A later change in Drive never alters what the month used.
ALTER TABLE sources ADD COLUMN drive_id TEXT;
ALTER TABLE sources ADD COLUMN drive_version TEXT;
ALTER TABLE sources ADD COLUMN drive_md5 TEXT;

-- What the listing knows of each Drive photo: its checksum (two files with one checksum are
-- duplicates), when it changed, and the role of the folder it was found under. A photo Drive no
-- longer gives (deleted, in the bin, unshared) takes status 'missing' with the reason.
ALTER TABLE drive_photos ADD COLUMN md5 TEXT NOT NULL DEFAULT '';
ALTER TABLE drive_photos ADD COLUMN modified TEXT NOT NULL DEFAULT '';
ALTER TABLE drive_photos ADD COLUMN role TEXT NOT NULL DEFAULT '';
ALTER TABLE drive_photos ADD COLUMN reason TEXT NOT NULL DEFAULT '';
