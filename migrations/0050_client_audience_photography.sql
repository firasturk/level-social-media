-- The client's audience in the team's own words (above the Analysis) and its photography direction (lens, light, angle).
ALTER TABLE clients ADD COLUMN audience TEXT;
ALTER TABLE clients ADD COLUMN photography TEXT;
