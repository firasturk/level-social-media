-- A deleted month waits in the bin (restorable) before its rows and files are purged.
ALTER TABLE batches ADD COLUMN deleted INTEGER;
