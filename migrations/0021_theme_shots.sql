-- One ready shot (image prompt) per reference picture or collage tile, written by Analyse theme.
ALTER TABLE skills ADD COLUMN shots TEXT NOT NULL DEFAULT '[]';
