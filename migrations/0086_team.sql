-- Team: the studio's own workspace for LEVEL employees (28 Oct). Channels (one for everyone, one
-- per client, projects, direct and group conversations), messages with threads, reactions, pins
-- and attachments in the studio's own bucket, tasks, internal creative approvals and in-app
-- notifications. Nothing here is reachable from a client's link: every route needs a signed-in
-- employee. No outside service: the same database, bucket and session.

CREATE TABLE IF NOT EXISTS team_channels (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- general | client | project | dm | group
  name TEXT NOT NULL,
  client TEXT REFERENCES clients(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  archived INTEGER
);
CREATE INDEX IF NOT EXISTS team_channels_client ON team_channels(client);

-- Who is in a dm, group or project channel (general and client channels are everyone's).
CREATE TABLE IF NOT EXISTS team_channel_members (
  channel TEXT NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
  user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined INTEGER NOT NULL,
  PRIMARY KEY (channel, user)
);
CREATE INDEX IF NOT EXISTS team_channel_members_user ON team_channel_members(user);

CREATE TABLE IF NOT EXISTS team_messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
  thread TEXT REFERENCES team_messages(id) ON DELETE CASCADE,   -- the message this one replies to (a thread's root), or NULL
  author TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'text',  -- text | voice | system
  body TEXT NOT NULL DEFAULT '',
  ref TEXT,                           -- JSON: {batch?, post?, video?, task?} the message is about
  attachments TEXT,                   -- JSON: attachment ids
  mentions TEXT,                      -- JSON: user ids mentioned
  at INTEGER NOT NULL,
  edited INTEGER,
  deleted INTEGER,
  updated INTEGER NOT NULL            -- any change (edit, delete, reaction, pin): the sync cursor
);
CREATE INDEX IF NOT EXISTS team_messages_channel_at ON team_messages(channel, at);
CREATE INDEX IF NOT EXISTS team_messages_thread ON team_messages(thread, at);
CREATE INDEX IF NOT EXISTS team_messages_updated ON team_messages(updated);

CREATE TABLE IF NOT EXISTS team_attachments (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES users(id),
  message TEXT REFERENCES team_messages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  key TEXT NOT NULL,                  -- bucket key: team/<owner>/<id>.<ext>
  kind TEXT NOT NULL,                 -- image | file | voice
  width INTEGER,
  height INTEGER,
  duration REAL,
  sha256 TEXT,                        -- the same file twice is one object
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS team_attachments_sha ON team_attachments(sha256);

CREATE TABLE IF NOT EXISTS team_reactions (
  message TEXT NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
  user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (message, user, emoji)
);

CREATE TABLE IF NOT EXISTS team_pins (
  channel TEXT NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
  message TEXT NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
  by TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (channel, message)
);

-- How far each person has read each channel (unread = messages after last_read by others).
CREATE TABLE IF NOT EXISTS team_reads (
  channel TEXT NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
  user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read INTEGER NOT NULL,
  PRIMARY KEY (channel, user)
);

CREATE TABLE IF NOT EXISTS team_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee TEXT REFERENCES users(id) ON DELETE SET NULL,
  client TEXT REFERENCES clients(id) ON DELETE SET NULL,
  batch TEXT REFERENCES batches(id) ON DELETE SET NULL,
  post INTEGER,
  due TEXT,                           -- YYYY-MM-DD
  priority TEXT NOT NULL DEFAULT 'normal',  -- low | normal | high | urgent
  status TEXT NOT NULL DEFAULT 'todo',      -- todo | doing | review | done
  source_message TEXT REFERENCES team_messages(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'task',  -- task | month (the parent task of an assigned month)
  created_by TEXT NOT NULL REFERENCES users(id),
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS team_tasks_assignee ON team_tasks(assignee, status);
CREATE INDEX IF NOT EXISTS team_tasks_client ON team_tasks(client, status);
CREATE INDEX IF NOT EXISTS team_tasks_batch ON team_tasks(batch, post);

CREATE TABLE IF NOT EXISTS team_task_events (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
  by TEXT NOT NULL,
  at INTEGER NOT NULL,
  change TEXT NOT NULL                -- JSON: {field, from, to} or {comment}
);
CREATE INDEX IF NOT EXISTS team_task_events_task ON team_task_events(task, at);

-- Internal creative approvals: one row per decision on a post's version (its picture key).
CREATE TABLE IF NOT EXISTS team_reviews (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  post INTEGER NOT NULL,
  version TEXT,                       -- the picture key the decision is about
  status TEXT NOT NULL,               -- draft | review | changes | approved
  by TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS team_reviews_post ON team_reviews(batch, post, at);

CREATE TABLE IF NOT EXISTS team_notifications (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                 -- dm | mention | task | review | approval | due
  text TEXT NOT NULL,
  ref TEXT,                           -- JSON: {channel?, message?, task?, batch?, post?}
  at INTEGER NOT NULL,
  seen INTEGER
);
CREATE INDEX IF NOT EXISTS team_notifications_user ON team_notifications(user, seen, at);
