-- Every OCR check of a post's picture: the raw picture as the engine made it (nothing may be written
-- on it but the product's packaging) or the final artwork with the words drawn by the browser (the
-- approved headline, sub-line and price must read exactly). What the provider read, what was
-- expected and the findings are kept as JSON; connected = 0 marks a demo result (no Google credential).
CREATE TABLE IF NOT EXISTS ocr_checks (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,
  post INTEGER NOT NULL,
  task TEXT,
  kind TEXT NOT NULL,              -- raw | artwork
  provider TEXT NOT NULL,          -- google-vision | demo
  connected INTEGER NOT NULL DEFAULT 0,
  expected TEXT,                   -- JSON ExpectedText (artwork) or {allowed} (raw)
  detected TEXT NOT NULL,          -- JSON OcrResult
  findings TEXT NOT NULL,          -- JSON Finding[]
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ocr_checks_batch_post ON ocr_checks(batch, post, created);
