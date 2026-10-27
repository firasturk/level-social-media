-- How many product units a style's picture shows (read once by the vision model when the style is
-- first applied; 0 = not read yet). A post made in a style showing several takes other products of
-- the month.
ALTER TABLE styles ADD COLUMN products INTEGER NOT NULL DEFAULT 0;
