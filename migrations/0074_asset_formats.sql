-- What a downloaded asset really is (read from its bytes when it is stored, see server/asset-format.ts)
-- and the file an image layer draws from it:
--   format      the outer file: svg | png | jpg | webp | gif | eps | ai | pdf | psd | zip | unknown
--   contents    JSON list of the formats inside a ZIP (["ai","eps","jpg","svg"]), '[]' for a single file
--   layer_key   R2 key of the sanitised SVG or the raster an image layer draws; NULL when only the
--               preview picture can stand in (EPS/AI/PSD-only bundles)
--   layer_mime  its content type
--   colors      JSON list of the SVG's distinct paint colours (#rrggbb), the swatches a layer recolours
--   format_note the plain sentence the UI shows ("This file is EPS/AI: colours cannot be changed here…")
ALTER TABLE assets ADD COLUMN format TEXT;
ALTER TABLE assets ADD COLUMN contents TEXT;
ALTER TABLE assets ADD COLUMN layer_key TEXT;
ALTER TABLE assets ADD COLUMN layer_mime TEXT;
ALTER TABLE assets ADD COLUMN colors TEXT;
ALTER TABLE assets ADD COLUMN format_note TEXT;
