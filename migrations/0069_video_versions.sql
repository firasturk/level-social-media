-- Video versions of a post: where each clip came from (Higgsfield, an upload, an editor), the
-- settings it was made with, its poster, and which one the client sees on the approval link.
-- status is now queued | generating | done | failed.
ALTER TABLE videos ADD COLUMN provider TEXT NOT NULL DEFAULT 'higgsfield';
ALTER TABLE videos ADD COLUMN settings TEXT;                          -- JSON {duration, aspect?, resolution?, audio?, estimate?}
ALTER TABLE videos ADD COLUMN poster_key TEXT;                        -- R2 key of the still the clip started from
ALTER TABLE videos ADD COLUMN source TEXT NOT NULL DEFAULT 'picture'; -- picture | artwork | upload | editor
ALTER TABLE videos ADD COLUMN for_client INTEGER NOT NULL DEFAULT 0;  -- the version on the client link (at most one per post)
ALTER TABLE videos ADD COLUMN op_id TEXT;                             -- the integration op that paid for it
CREATE INDEX videos_client ON videos(batch, post, for_client);
