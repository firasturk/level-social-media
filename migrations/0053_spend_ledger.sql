-- The spending ledger: what the designer approved for a scope (a month's batch id, or
-- client:<id> for a client's own paid work) and what the engine has reserved against it.
-- A reservation is taken with one conditional UPDATE, so two requests never spend the same
-- remaining allowance. Approved and reserved are USD list-price estimates, not invoices.
CREATE TABLE spend (
  scope TEXT PRIMARY KEY,
  approved REAL NOT NULL DEFAULT 0,
  reserved REAL NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL
);
