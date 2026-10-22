-- Posts published to Instagram from the studio (Meta Graph content publishing). One row per
-- Instagram post: a single picture or a whole carousel. The artwork (words and logo drawn over the
-- picture in the browser) is kept in R2 under publish/<id>-<n>.jpg, one key per slide, so Instagram
-- fetches exactly what the designer saw. A queued row is published by the cron when its time comes;
-- 'publishing' is the claim one cron pass takes so another never publishes the same row.
CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,
  client TEXT,
  post INTEGER NOT NULL,                   -- the post's index in the month's plan (a carousel: its first slide)
  ig_account TEXT NOT NULL,                -- the Instagram business account id it goes to
  kind TEXT NOT NULL DEFAULT 'single',     -- single | carousel
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | publishing | published | failed | cancelled
  scheduled_at INTEGER NOT NULL,
  published_at INTEGER,
  media_id TEXT,                           -- the Instagram media id once published
  permalink TEXT,
  error TEXT,                              -- Meta's message when it failed, as a person reads it
  artwork_keys TEXT NOT NULL DEFAULT '[]', -- JSON array of R2 keys, one per slide
  caption TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX publications_due ON publications(status, scheduled_at);
CREATE INDEX publications_batch ON publications(batch, post);

-- Which Instagram account each client publishes to, remembered from the last publish.
CREATE TABLE client_publish (
  client TEXT PRIMARY KEY,
  ig_account TEXT NOT NULL,
  updated INTEGER NOT NULL
);
