-- The Design/PM messages channel's stored name becomes Projects (0.2.2; approved by Todd as a data
-- change, 2026-10-26). One row's name only: no message, read marker or other channel is touched.
UPDATE channels SET name = 'Projects' WHERE slug = 'design' AND name = 'Design/PM';
