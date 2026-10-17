-- Grids: a style on the "grid" shelf is a whole Instagram feed; tiles is how many posts it shows.
ALTER TABLE styles ADD COLUMN tiles INTEGER NOT NULL DEFAULT 0;
