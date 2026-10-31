-- Admin accounts folded into Supplier accounts (Todd 2026-10-31). Nothing is deleted: the rows keep
-- their ids, so statements, files and removed-month rows (all keyed on supplier_id) follow them.
UPDATE suppliers SET kind = 'supplier' WHERE kind = 'admin';
