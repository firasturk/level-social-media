-- How many times Fix it made a post again by itself after the review still found hard problems.
ALTER TABLE tasks ADD COLUMN fix_rounds INTEGER NOT NULL DEFAULT 0;
