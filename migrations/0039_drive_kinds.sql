-- The Drive reading learned more kinds (lifestyle, drink, factory): photos read by the first
-- version are read again by the cron, keeping their old reading until then.
ALTER TABLE drive_photos ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
