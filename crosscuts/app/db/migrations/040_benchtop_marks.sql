-- Benchtop designer, Todd's drawing convention of 2026-10-25 (docs/plans/m21-benchtop-designer.md).
-- Additive: every edge is drawn as a thin unbroken line and its finish is shown by a mark repeated
-- across it: X unfinished (to a wall or panel), // finished and seen, [] seen and finished square.
-- line_style stays in the table but is no longer used for drawing.
ALTER TABLE benchtop_edge_finishes ADD COLUMN mark TEXT NOT NULL DEFAULT '//' CHECK (mark IN ('X', '//', '[]'));
UPDATE benchtop_edge_finishes SET mark = 'X' WHERE code = 'RAW';
INSERT INTO benchtop_edge_finishes (code, name, line_style, sort, mark, created_at, updated_at)
  SELECT 'SQ', 'Square', 'thin', 7, '[]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE NOT EXISTS (SELECT 1 FROM benchtop_edge_finishes WHERE code = 'SQ');
