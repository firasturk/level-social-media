-- How far a style reaches the team's bar (1-10: a bold advertising concept scores high, a plain
-- catalogue packshot low), and its picture's size so the gallery lays photos out in even rows.
ALTER TABLE styles ADD COLUMN score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE styles ADD COLUMN w INTEGER NOT NULL DEFAULT 0;
ALTER TABLE styles ADD COLUMN h INTEGER NOT NULL DEFAULT 0;
