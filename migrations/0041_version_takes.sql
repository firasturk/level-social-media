-- Every picture a version holds (all the takes of each post), not only the latest of each post.
ALTER TABLE month_versions ADD COLUMN takes TEXT NOT NULL DEFAULT '[]';
