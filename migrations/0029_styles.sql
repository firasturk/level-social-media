-- The style gallery: product-photo styles collected from Pinterest, each kept with its pin as the
-- reference image and a prompt written for any product. A month picks styles for its posts and
-- each one is rewritten for the post's own product.
CREATE TABLE styles (
  id TEXT PRIMARY KEY,
  -- product: the product alone; people: a person holds, uses or presents it.
  kind TEXT NOT NULL DEFAULT 'product',
  -- pool: collected, not read yet; spare: read and ready, not shown; active: in the gallery;
  -- removed: taken out by the team; rejected: not a usable photo style.
  status TEXT NOT NULL DEFAULT 'pool',
  title TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  pin TEXT,
  source TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  image_key TEXT,
  thumb_key TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX styles_pin ON styles(pin);
CREATE INDEX styles_status ON styles(status, kind, position);
