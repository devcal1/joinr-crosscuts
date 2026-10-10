-- M2 review fix (docs/plans/m2-contracts.md section 10.2). Additive only: two nullable columns frozen at issue.
ALTER TABLE invoices ADD COLUMN contract_value_cents INTEGER;
ALTER TABLE invoices ADD COLUMN invoiced_before_cents INTEGER;
