-- Admin accounts (docs/plans/m9-contracts.md section 13, Todd 2026-10-16): accounts that are not
-- regular suppliers (BAS, Workcover policies, insurance payments) kept on their own page with the
-- same monthly statement lines. They share the suppliers and supplier_statements tables; kind
-- tells them apart. Additive: every existing row is a supplier.
ALTER TABLE suppliers ADD COLUMN kind TEXT NOT NULL DEFAULT 'supplier' CHECK (kind IN ('supplier','admin'));
CREATE INDEX idx_suppliers_kind ON suppliers(kind);
