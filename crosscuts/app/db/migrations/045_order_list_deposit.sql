-- Board placement and money triggers (0.2.3, docs/plans/m24-contracts.md section 3). Additive only.
-- invoices.due_reason has a CHECK (migration 006) that can't take a new reason, so the deposit that
-- falls due at Send to Ordering keeps due_reason NULL and records why here.
ALTER TABLE invoices ADD COLUMN due_trigger TEXT CHECK (due_trigger IS NULL OR due_trigger IN ('order_list_sent'));
