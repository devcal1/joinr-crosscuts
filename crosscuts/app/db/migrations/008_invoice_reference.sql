-- Invoice layout after Todd's sample (2026-10-11). Additive only: the job name, frozen at issue as the invoice's reference.
ALTER TABLE invoices ADD COLUMN reference TEXT;
