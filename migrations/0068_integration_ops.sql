-- Integration governance (server/integrations.ts): the ledger of every operation proposed or run on
-- an outside provider behind an admin switch (Freepik's Photo lab, Higgsfield video, the video
-- editor placeholder), and the claims that stop the same submission going out twice.

-- One row per operation. A paid run is first 'proposed' with its estimate; the admin confirms it
-- ('confirmed'), it is handed to the provider ('running', task_id), and it ends 'done' or 'failed'
-- with the cost the provider reported when it did. 'refused' is a proposal the server would not
-- execute (unknown cost, duplicate, switched off). user_id is the admin who confirmed it; a
-- background pass never writes one of these on a member's behalf.
CREATE TABLE IF NOT EXISTS integration_ops (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,                -- freepik | higgsfield | editor
  kind TEXT NOT NULL,                    -- photolab.remove-bg, video.submit, key.save, ...
  user_id TEXT NOT NULL,
  batch TEXT,                            -- the month, when the operation belongs to one
  post INTEGER,                          -- the post, when it belongs to one
  task_id TEXT,                          -- the provider's task or request id once it has one
  estimate REAL,                         -- USD before the run; NULL when the price is not known
  reported REAL,                         -- USD the provider reported afterwards, when it did
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed | confirmed | running | done | failed | refused
  note TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS integration_ops_provider_created ON integration_ops(provider, created);
CREATE INDEX IF NOT EXISTS integration_ops_user_created ON integration_ops(user_id, created);

-- A submission key claimed before a provider is called. The same key within its time to live is a
-- duplicate (a double click, two tabs, a retried request) and is refused. In D1 so a claim survives
-- the isolate restarting between the two requests.
CREATE TABLE IF NOT EXISTS integration_claims (
  key TEXT PRIMARY KEY,
  created INTEGER NOT NULL
);
