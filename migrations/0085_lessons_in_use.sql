-- Findings of the review are in use the day they are found (28 Oct): the team rejects the wrong
-- ones instead of approving each. The findings still waiting become rules now.
UPDATE lessons SET status = 'approved' WHERE status = 'pending' AND category = 'lesson' AND deactivated IS NULL;
