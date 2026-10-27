-- The product family a source belongs to (Coffee drinks, Fresh juices & smoothies, Desserts, …),
-- read once by the text model from its notes, so a style that shows several products takes
-- products of the same family (coffee with coffee, juice with juice). NULL = not read yet.
ALTER TABLE sources ADD COLUMN family TEXT;
