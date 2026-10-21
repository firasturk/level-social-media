-- How many times a post was made again by itself this month (a regenerate by hand never resets it).
ALTER TABLE tasks ADD COLUMN auto_retries INTEGER NOT NULL DEFAULT 0;
