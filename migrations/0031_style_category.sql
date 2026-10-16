-- The style library is open now: no fixed count, styles grouped by category and paged, and new
-- ones read every day. Spares join the library; categories start from the kind until re-read.
ALTER TABLE styles ADD COLUMN category TEXT NOT NULL DEFAULT '';
UPDATE styles SET status = 'active' WHERE status = 'spare';
UPDATE styles SET category = CASE WHEN kind = 'people' THEN 'people' ELSE 'product' END WHERE category = '';
CREATE INDEX styles_category ON styles(status, category, score);
CREATE INDEX styles_created ON styles(status, created);
