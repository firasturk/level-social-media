-- An ambassador's gender and dress are fields, not free text: the engine never puts a headscarf on
-- a man, and a family brand's people dress modestly unless the team says otherwise.
ALTER TABLE ambassadors ADD COLUMN gender TEXT NOT NULL DEFAULT '';
ALTER TABLE ambassadors ADD COLUMN modest INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ambassadors ADD COLUMN hijab INTEGER NOT NULL DEFAULT 0;
