-- The quote number from Joinr (e.g. JRQ22961), typed on the job and quoted on invoices (Todd, 2026-10-11).
-- Additive only. Separate from external_ref, which stays the unique Joinr sync key.
ALTER TABLE jobs ADD COLUMN quote_number TEXT;
