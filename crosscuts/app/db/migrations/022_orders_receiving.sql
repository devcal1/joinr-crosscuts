-- M10 receiving deliveries (docs/plans/m10-contracts.md section 2.2). Additive only: four new
-- columns on orders. No existing row changes (the new columns start NULL or '').
ALTER TABLE orders ADD COLUMN received_by INTEGER REFERENCES users(id);   -- who marked it received
ALTER TABLE orders ADD COLUMN updated_by INTEGER REFERENCES users(id);    -- who last changed the line
ALTER TABLE orders ADD COLUMN delivery_note TEXT NOT NULL DEFAULT '';     -- short, damaged, part delivered
ALTER TABLE orders ADD COLUMN delivery_note_at TEXT;                      -- when the note was last set (UTC ISO)
