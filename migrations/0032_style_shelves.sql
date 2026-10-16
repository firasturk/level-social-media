-- The team's own shelves, and each picture's fingerprint (the pinimg file name) so a style taken out
-- never comes back as "another" pin of the same picture.
ALTER TABLE styles ADD COLUMN sig TEXT;
UPDATE styles SET sig = substr(source, instr(source, '/736x/') + 15, 32) WHERE instr(source, '/736x/') > 0;
CREATE INDEX styles_sig ON styles(sig);
-- The old shelves map onto the new ones until the styles are sorted again.
UPDATE styles SET category = 'lifestyle' WHERE category IN ('people', 'product');
UPDATE styles SET category = 'sweets' WHERE category = 'food';
