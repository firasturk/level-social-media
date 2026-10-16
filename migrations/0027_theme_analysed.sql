-- When the theme's pins were last read (Analyse); a pin added later means the theme must be read again.
ALTER TABLE skills ADD COLUMN analysed INTEGER;
