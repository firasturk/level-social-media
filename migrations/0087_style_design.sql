-- Designed styles (28 Oct): a pin that is a designed post, not only a photograph: words set as
-- typography over or along the product (a huge rotated word, a small vertical line, an outlined
-- label) or an Instagram post mockup framing the product photo. The reader returns the design as
-- JSON (shared/style-design.ts: StyleDesign) next to the photo prompt; NULL for a plain photo.
-- The engine makes the photograph alone; the studio draws the design in the client's fonts and
-- Instagram account, so no letter is ever drawn wrong.
ALTER TABLE styles ADD COLUMN design TEXT;
