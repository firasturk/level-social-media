-- The month's colours for a theme: suggested by Analyse from the references, then the designer's.
ALTER TABLE skills ADD COLUMN palette TEXT NOT NULL DEFAULT '[]';
-- 1 while the palette is the suggestion (Analyse may refresh it); 0 once the designer edited it.
ALTER TABLE skills ADD COLUMN palette_auto INTEGER NOT NULL DEFAULT 1;
