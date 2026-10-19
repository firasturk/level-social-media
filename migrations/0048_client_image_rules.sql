-- The client's own picture rules (an editorial spec, product preservation): sent with every post.
ALTER TABLE clients ADD COLUMN image_rules TEXT NOT NULL DEFAULT '';
