// /api/pipeline: read-only data for the Pipeline page that is not a Crosscuts job.
// Contract: docs/plans/m3-contracts.md section 6 (Quoted column, 2026-10-17).
//
// GET /api/pipeline/joinr-quotes -> the Joinr quotes the Quoted column lists as
// single-line links. Today Joinr only sends WON quotes (lib/joinr-sync.js fills
// joinr_intake), so these are the won quotes nobody has turned into a job yet.
// TODO "J3" (needs Todd's go under CLAUDE.md rule 12, Joinr is hands-off): once
// Joinr also supplies SENT quotes, they join this list with joinrStatus 'sent'
// and the page shows that word instead of 'Won'. Nothing else here changes.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { sendError, can } = require("../lib/httperror");
const intake = require("../lib/intake");

const r = defineRoutes("/api/pipeline");

// Which intake states are listed. 'new' only: won in Joinr and not yet dealt with.
// accepted and linked already have a Crosscuts job, which has its own card in the
// column of its stage (listing the quote as well would show it twice); ignored means
// someone chose not to take it; withdrawn means Joinr un-won or deleted it.
const LISTED_STATES = ["new"];
const LIMIT = 200;

r.get("/joinr-quotes", "jobs.view", (req, res) => {
  try {
    const showValue = can(req, "jobs.value");
    const marks = LISTED_STATES.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, quote_number, joinr_status, payload, last_seen_at
           FROM joinr_intake WHERE state IN (${marks}) AND last_event <> 'deleted'
          ORDER BY last_seen_at DESC, id DESC`
      )
      .all(...LISTED_STATES);
    const out = rows.map((row) => {
      const q = intake.quoteOf(row.payload, showValue);
      const line = {
        id: row.id,
        quoteNumber: row.quote_number,
        clientName: q.clientName,
        siteAddress: q.siteAddress,
        joinrStatus: row.joinr_status,
        wonAt: q.wonAt,
        url: q.url,
        _sort: q.wonAt || row.last_seen_at || "",
      };
      if (showValue) line.valueCents = q.valueIncGstCents;
      return line;
    });
    // Newest won first.
    out.sort((a, b) => (a._sort < b._sort ? 1 : a._sort > b._sort ? -1 : b.id - a.id));
    res.json(
      out.slice(0, LIMIT).map((l) => {
        delete l._sort;
        return l;
      })
    );
  } catch (e) {
    sendError(res, e, "[pipeline]");
  }
});

module.exports = r.router;
