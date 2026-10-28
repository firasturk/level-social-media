-- A month assigned to team members besides its owner (the copywriter who fixes the words and
-- pictures): they open it with full access, like its owner. Admins assign.
CREATE TABLE IF NOT EXISTS batch_members (
  batch TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  user TEXT NOT NULL REFERENCES users(id),
  assigned_by TEXT,
  created INTEGER NOT NULL,
  PRIMARY KEY (batch, user)
);
CREATE INDEX IF NOT EXISTS batch_members_user ON batch_members(user);
