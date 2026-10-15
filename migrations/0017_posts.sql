-- Level Social Media: themes per client, months of posts, captions.
ALTER TABLE skills ADD COLUMN client TEXT;              -- null = legacy/global skill; set = a client's theme
CREATE INDEX IF NOT EXISTS skills_client ON skills(client);
ALTER TABLE sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'product'; -- product | reference
ALTER TABLE tasks ADD COLUMN post INTEGER;              -- index into config.plan
ALTER TABLE tasks ADD COLUMN caption TEXT;              -- JSON {text, hashtags}
ALTER TABLE batches ADD COLUMN month TEXT;              -- YYYY-MM of a plan of posts
ALTER TABLE batches ADD COLUMN theme TEXT;              -- skills.id
CREATE INDEX IF NOT EXISTS batches_client_month ON batches(client, month);
