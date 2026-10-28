-- Designed styles (28 Oct): the design the vision reader found on a pin (typography boxes, an
-- Instagram post mockup), as JSON (shared/style-design.ts StyleDesign); NULL for a plain photo style.
ALTER TABLE styles ADD COLUMN design TEXT;
