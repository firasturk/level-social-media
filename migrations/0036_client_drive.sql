-- The client's Google Drive folder: the studio's service account reads its photos (shared as Viewer).
ALTER TABLE client_profiles ADD COLUMN drive TEXT NOT NULL DEFAULT '';
