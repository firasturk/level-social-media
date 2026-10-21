-- A small fingerprint of every finished picture, so one that looks like an earlier post is noticed.
ALTER TABLE tasks ADD COLUMN phash TEXT;
