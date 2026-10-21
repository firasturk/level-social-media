-- A library grid read into tiles (positions, kinds, text) once, so the picker can say what the grid
-- holds without reading it again; written when a month is planned from the grid.
CREATE TABLE IF NOT EXISTS grid_reads (
  style TEXT PRIMARY KEY,
  read TEXT NOT NULL,
  created INTEGER NOT NULL
);
