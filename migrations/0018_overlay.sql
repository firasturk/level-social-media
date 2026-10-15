-- Per-client overlay spec (headline, logo, fonts placement) drawn by the browser over each post.
ALTER TABLE clients ADD COLUMN overlay TEXT;
