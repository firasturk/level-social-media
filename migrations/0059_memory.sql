-- Brand memory: the lessons table holds four kinds of item (brand_rule | campaign_instruction |
-- post_instruction | lesson), each with where it applies, who approved it, and its revision chain.
-- Existing rows stay lessons that apply to the whole brand.
ALTER TABLE lessons ADD COLUMN category TEXT NOT NULL DEFAULT 'lesson';
ALTER TABLE lessons ADD COLUMN scope TEXT NOT NULL DEFAULT '';       -- JSON {batch?, post?}; '' = whole brand
ALTER TABLE lessons ADD COLUMN approver TEXT;                        -- user id or name of who approved or rejected it
ALTER TABLE lessons ADD COLUMN approved_at INTEGER;
ALTER TABLE lessons ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE lessons ADD COLUMN replaces TEXT;                        -- id of the item this revision supersedes
ALTER TABLE lessons ADD COLUMN deactivated INTEGER;                  -- when it was retired; retired items never reach a prompt
-- A revision keeps the old row (deactivated), so the same text may exist twice; the code keeps
-- one active item per text instead of the database.
DROP INDEX IF EXISTS lessons_client_text;
CREATE INDEX lessons_client_text ON lessons(client, text);
CREATE INDEX lessons_client_category ON lessons(client, category, status, deactivated);
