-- Which revision of the post's idea a picture was made for. making_for is captured when the
-- generation is submitted; made_for is set from it only when a picture is saved, so a failed or
-- pending replacement never relabels the previous picture. Pictures made before this column exist
-- keep NULL: their lineage is unknown, which is shown in details, never derived from timestamps.
ALTER TABLE tasks ADD COLUMN making_for INTEGER;
ALTER TABLE tasks ADD COLUMN made_for INTEGER;
