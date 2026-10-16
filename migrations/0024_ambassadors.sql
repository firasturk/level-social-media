-- Up to four recurring AI people per client (brand ambassadors), each with a portrait the
-- engine keeps the same face from; a month picks which of them appear.
CREATE TABLE ambassadors (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_key TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX ambassadors_client ON ambassadors(client, position);
