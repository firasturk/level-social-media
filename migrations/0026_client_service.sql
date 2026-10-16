-- A client with no products (insurance, a bank, a clinic): what it offers; the posts are built around it.
ALTER TABLE clients ADD COLUMN service TEXT NOT NULL DEFAULT '';
