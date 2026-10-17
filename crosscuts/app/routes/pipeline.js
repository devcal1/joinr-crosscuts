// /api/pipeline: read-only data for the Pipeline page that is not a Crosscuts job.
// Contract: docs/plans/m3-contracts.md section 6 and section 13 (Quoted column, 2026-10-17).
//
// GET  /api/pipeline/joinr-quotes -> the Joinr quotes the Quoted column lists as single-line
//   links, as {source, fetchedAt, generatedAt, truncated, unreachable, configured, quotes}.
//   - source 'cache': Joinr's open-quotes list (lib/joinr-open-quotes.js, migration 031) has
//     been fetched at least once. SENT and WON quotes, except any whose job Crosscuts has dealt
//     with (its intake record is accepted, linked, ignored or withdrawn), newest updatedAt first.
//   - source 'intake': the list has never been fetched (a Joinr that has not released J3, or no
//     key yet), so today's list: won quotes from joinr_intake still waiting (state new).
// POST /api/pipeline/joinr-quotes/refresh -> asks for a fetch now (never more than once a minute,
//   a 429 from Joinr is honoured), then answers as the GET does, plus {refresh: {status, ...}}.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { sendError, can } = require("../lib/httperror");
const intake = require("../lib/intake");
const config = require("../lib/joinr-config");
const openQuotes = require("../lib/joinr-open-quotes");

const r = defineRoutes("/api/pipeline");

// Fallback (source 'intake') only: which intake states are listed. 'new' only: won in Joinr and
// not yet dealt with. accepted and linked already have a Crosscuts job, which has its own card in
// the column of its stage (listing the quote as well would show it twice); ignored means someone
// chose not to take it; withdrawn means Joinr un-won or deleted it.
const LISTED_STATES = ["new"];
// Cache (source 'cache'): a line stops being listed once its job's intake record (matched by root
// id, or by quote id) is in one of these, WHATEVER the line's status (Todd, 2026-10-17: a won quote
// shows only until it is accepted or ignored; and Joinr lists one line per job, so a job Crosscuts
// already holds as won can still appear there as 'sent', e.g. a live sent revision beside an
// archived won root, or the last sent revision while a quote is being revised). A line with no
// intake record at all, or one still 'new', is listed.
const DEALT_WITH = ["accepted", "linked", "ignored", "withdrawn"];
const LIMIT = 500;
// A failed fetch only matters to the person looking once the list has gone this stale.
const STALE_MS = 15 * 60 * 1000;

function fromCache(showValue) {
  const marks = DEALT_WITH.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT c.* FROM joinr_open_quotes c
        WHERE NOT EXISTS (
                SELECT 1 FROM joinr_intake i
                 WHERE (i.root_quote_id = c.root_quote_id OR i.quote_id = c.quote_id)
                   AND i.state IN (${marks}))
        ORDER BY c.updated_at DESC, c.quote_id
        LIMIT ${LIMIT}`
    )
    .all(...DEALT_WITH);
  return rows.map((c) => {
    const line = {
      id: c.quote_id,
      quoteNumber: c.quote_number,
      clientName: c.client_name,
      siteAddress: c.site_address,
      label: c.label,
      joinrStatus: c.status,
      sentAt: c.sent_at,
      wonAt: c.won_at,
      updatedAt: c.updated_at,
      url: c.url,
    };
    if (showValue) line.valueCents = c.value_inc_gst_cents;
    return line;
  });
}

function fromIntake(showValue) {
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
  return out.slice(0, 200).map((l) => {
    delete l._sort;
    return l;
  });
}

function listPayload(req) {
  const showValue = can(req, "jobs.value");
  const configured = config.keyStatus().configured;
  const meta = db.prepare("SELECT * FROM joinr_open_quotes_meta WHERE id = 1").get();
  if (meta && meta.fetched_at) {
    const stale = Date.now() - Date.parse(meta.fetched_at) > STALE_MS;
    return {
      source: "cache",
      configured,
      fetchedAt: meta.fetched_at,
      generatedAt: meta.generated_at,
      truncated: !!meta.truncated,
      unreachable: !!(meta.last_error && stale),
      quotes: fromCache(showValue),
    };
  }
  return {
    source: "intake",
    configured,
    fetchedAt: null,
    generatedAt: null,
    truncated: false,
    unreachable: false,
    quotes: fromIntake(showValue),
  };
}

r.get("/joinr-quotes", "jobs.view", (req, res) => {
  try {
    res.json(listPayload(req));
  } catch (e) {
    sendError(res, e, "[pipeline]");
  }
});

r.post("/joinr-quotes/refresh", "jobs.view", async (req, res) => {
  try {
    const result = await openQuotes.refresh(db);
    const refresh = { status: result.status };
    if (result.retryAfterSeconds) refresh.retryAfterSeconds = result.retryAfterSeconds;
    res.json({ ...listPayload(req), refresh });
  } catch (e) {
    sendError(res, e, "[pipeline]");
  }
});

module.exports = r.router;
