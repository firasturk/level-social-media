-- Attempts whose billing is not known (a timeout, a dropped connection, a vendor failure after
-- it accepted the request) keep their reservation and are counted here for reconciliation.
ALTER TABLE spend ADD COLUMN uncertain REAL NOT NULL DEFAULT 0;
-- One approval per run: a retried or repeated approval request with the same run id never adds
-- the allowance twice.
CREATE TABLE spend_runs (
  run TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  amount REAL NOT NULL,
  created INTEGER NOT NULL
);
