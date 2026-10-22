-- Notifications: who wants to hear when a client answers on the approval page, the answers waiting
-- to be mailed (one grouped mail per month), and how far each team member has read.

-- A team member who wants an e-mail when this client answers. With no row for a client, every
-- admin is written to.
CREATE TABLE IF NOT EXISTS notify_subscriptions (
  user_id TEXT NOT NULL,
  client TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (user_id, client)
);

-- One row per answer. pending: waits for the cron to group and send it; sent: mailed (sent_at);
-- unsent: no Resend key was saved when it came due, kept until "Send the unsent" is pressed;
-- failed: Resend refused it (error).
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  batch TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'client_answer',
  payload TEXT NOT NULL,                  -- JSON {index, status, note, by, at}
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | unsent | failed
  sent_at INTEGER,
  error TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_status_created ON notifications(status, created);
CREATE INDEX IF NOT EXISTS notifications_batch_created ON notifications(batch, created);

-- When each team member last looked at a month's client answers (the "n new" badge counts after it).
CREATE TABLE IF NOT EXISTS notify_seen (
  user_id TEXT NOT NULL,
  batch TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, batch)
);
