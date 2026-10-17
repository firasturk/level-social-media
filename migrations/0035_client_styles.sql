-- A client's own collection of styles and grids, picked by the team ("Add to Habibah's").
CREATE TABLE client_styles (
  client TEXT NOT NULL,
  style TEXT NOT NULL,
  added INTEGER NOT NULL,
  PRIMARY KEY (client, style)
);
CREATE INDEX client_styles_style ON client_styles(style);
