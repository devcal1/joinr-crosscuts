// The job page's "From Joinr quote": GET /api/job-records/:id/joinr-quote (task J4; contract version 4,
// docs/integrations/joinr-crosscuts-intake.md). Viewing needs jobs.view. Money (rates, line and room
// totals, cost of goods, margin, markups, the tier, GST, totals, option prices and the warnings that
// speak of profit) is in the answer only for jobs.value holders: lib/joinr-quote.js view() leaves
// those fields out of the object altogether for everyone else.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const joinrQuote = require("../lib/joinr-quote");
const { notFound, sendError, can } = require("../lib/httperror");

const r = defineRoutes("/api");

// status: 'not-linked' (no accepted/linked Joinr record: the page shows nothing), 'none' (a record,
// but Joinr has sent no quote: an older Joinr, or none yet), 'too-large' (Joinr sent quote null), 'ok'.
r.get("/job-records/:id/joinr-quote", "jobs.view", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    if (!db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(id)) throw notFound();
    const rec = joinrQuote.forJob(db, id);
    if (!rec) return res.json({ status: "not-linked" });
    const base = { quoteNumber: rec.quoteNumber, joinrUrl: rec.url };
    const snap = rec.snapshot;
    if (!snap) return res.json({ status: "none", ...base });
    if (!snap.quote) return res.json({ status: "too-large", ...base, receivedAt: snap.receivedAt });
    const money = can(req, "jobs.value");
    res.json({ status: "ok", ...base, money, quote: joinrQuote.view(snap, { money }) });
  } catch (e) {
    sendError(res, e, "[joinr-quote]");
  }
});

module.exports = r.router;
