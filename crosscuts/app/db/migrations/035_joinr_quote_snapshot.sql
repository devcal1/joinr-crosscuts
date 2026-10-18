-- The whole Joinr quote, as its latest snapshot (task J4, Crosscuts side, 2026-10-18; contract version 4,
-- docs/integrations/joinr-crosscuts-intake.md "The quote object"). Additive only: one new table,
-- nothing existing is touched.
--
-- Why a table of its own and not the joinr_intake.payload column: the payload is what "Changed in
-- Joinr" compares, and Joinr prices the quote when it builds the item (GST, an unfrozen rate card), so
-- the same quote can come back with different figures and no edit. Keeping the quote out of the
-- payload means the payload, its comparison and every reader of it stay exactly as they were, and the
-- quote can be several kB to 1.5 MB without growing the inbox rows or their list queries.
--
-- One row per intake record (the latest snapshot). quote_json is the validated, normalised quote
-- (lib/joinr-quote.js); NULL means Joinr sent `quote: null` (it could not price the quote, or the
-- quote was too large to send): the job page then says so and links to Joinr. A record with no row
-- has never been sent a quote (an older Joinr). The snapshot changes only on a real item change
-- (lib/joinr-sync.js), never because a re-priced quote came round again.
CREATE TABLE joinr_quote_snapshots (
  intake_id INTEGER PRIMARY KEY REFERENCES joinr_intake(id) ON DELETE CASCADE,
  quote_id TEXT NOT NULL CHECK (length(quote_id) > 0),                  -- the Joinr revision this was priced for
  quote_json TEXT CHECK (quote_json IS NULL OR (json_valid(quote_json) AND length(quote_json) <= 1572864)),
  rate_card TEXT CHECK (rate_card IS NULL OR rate_card IN ('snapshot','live')),  -- the quote's pricedAt
  received_at TEXT NOT NULL CHECK (length(received_at) > 0),            -- ISO UTC: when Crosscuts stored it
  CHECK (quote_json IS NOT NULL OR rate_card IS NULL)
);
