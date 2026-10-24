-- Benchtop designer, Todd's changes of 2026-10-24 (docs/plans/m21-benchtop-designer.md). Additive:
-- an edge finish may be a waterfall (the designer then asks for its drop height), and a Waterfall
-- finish to start with. The waterfall leg piece is gone; it is now this finish on an end edge.
ALTER TABLE benchtop_edge_finishes ADD COLUMN waterfall INTEGER NOT NULL DEFAULT 0 CHECK (waterfall IN (0, 1));
INSERT INTO benchtop_edge_finishes (code, name, line_style, sort, waterfall, created_at, updated_at) VALUES
  ('WF', 'Waterfall', 'double', 6, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
