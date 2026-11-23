// The job page's "From Joinr quote": GET /api/job-records/:id/joinr-quote (task J4; contract version 4,
// docs/integrations/joinr-crosscuts-intake.md). Viewing needs jobs.view. Money (rates, line and room
// totals, cost of goods, margin, markups, the tier, GST, totals, option prices and the warnings that
// speak of profit) is in the answer only for jobs.value holders: lib/joinr-quote.js view() leaves
// those fields out of the object altogether for everyone else.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const joinrQuote = require("../lib/joinr-quote");
const joinrPdf = require("../lib/joinr-pdf");
const { notFound, forbidden, sendError, can } = require("../lib/httperror");

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

// ---- the quote PDF (docs/plans/jobpage-contracts.md section B; lib/joinr-pdf.js) ------------------------
// The PDF shows prices, so all three routes need jobs.view AND jobs.value (the access list is
// "any of", so jobs.value is checked in the handler).

// The accepted/linked intake record of a job, after the permission and job checks.
function pdfRecord(req) {
  if (!can(req, "jobs.value")) throw forbidden();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  if (!db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(id)) throw notFound();
  const rec = joinrQuote.forJob(db, id);
  if (!rec) throw notFound();
  return rec;
}

// Brings the copy up to date if it needs it (first view, another revision, a flagged change), then
// says where things stand. `fetch` is what the fetch did: fresh | ok | recent | limited | unavailable |
// failed | not-set-up.
r.get("/job-records/:id/joinr-quote/pdf-status", "jobs.view", async (req, res) => {
  try {
    const rec = pdfRecord(req);
    const f = await joinrPdf.ensure(db, rec.intakeId);
    res.json({ fetch: f.status, ...joinrPdf.status(db, rec.intakeId) });
  } catch (e) {
    sendError(res, e, "[joinr-quote pdf-status]");
  }
});

// The PDF itself, inline in the page's frame (?download=1 for a save). Never fetches: pdf-status does.
r.get("/job-records/:id/joinr-quote/pdf", "jobs.view", (req, res) => {
  try {
    const rec = pdfRecord(req);
    const copy = joinrPdf.copyOf(db, rec.intakeId);
    if (!copy) throw notFound();
    const base = ("Quote " + (rec.quoteNumber || "from Joinr")).replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_").slice(0, 120) + ".pdf";
    const ascii = base.replace(/[^\x20-\x7e]/g, "_");
    const kind = req.query.download === "1" ? "attachment" : "inline";
    // Chrome's PDF viewer fails under a sandbox CSP (lib/files.js says the same), so none is set; the
    // type is fixed and the first bytes were checked when it was stored. Same-origin, so the page's own
    // iframe may show it (no X-Frame-Options or frame-ancestors is sent anywhere in this app).
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.sendFile(copy.name, { root: copy.root, dotfiles: "deny", cacheControl: false, lastModified: false }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Not found" });
    });
  } catch (e) {
    sendError(res, e, "[joinr-quote pdf]");
  }
});

// Refresh: fetch now, even if the copy looks current (still not past the once-a-minute guard or a 429).
r.post("/job-records/:id/joinr-quote/pdf/refresh", "jobs.view", async (req, res) => {
  try {
    const rec = pdfRecord(req);
    const f = await joinrPdf.ensure(db, rec.intakeId, { force: true });
    const st = joinrPdf.status(db, rec.intakeId);
    res.json({ ...st, fetch: f.status, retryAfterSeconds: f.retryAfterSeconds || st.retryAfterSeconds });
  } catch (e) {
    sendError(res, e, "[joinr-quote pdf refresh]");
  }
});

module.exports = r.router;
