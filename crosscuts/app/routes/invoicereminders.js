// Overdue invoice reminders (0.2.19): settings, paused clients, the approval queue and Run now.
// docs/plans/invoice-reminders-plan.md section 9. The Resend key never appears here (only whether it is set).
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const resend = require("../lib/resend");
const reminders = require("../lib/invoicereminders");
const { bad } = require("../lib/httperror");
const { sydneyToday } = require("../lib/time");
const invoices = require("../lib/invoices");

const r = defineRoutes("/api/invoice-reminders");

function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e && typeof e.status === "number" && e.status >= 400 && e.status <= 599 && e.status !== 500) {
        return res.status(e.status).json({ error: e.message });
      }
      console.error("[invoice-reminders]", e);
      res.status(500).json({ error: "Server error" });
    }
  };
}

function body(req) {
  const b = req.body;
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}

function settingsPayload() {
  return {
    ...reminders.getSettings(db),
    clients: reminders.listClientPauses(db),
    configured: !!resend.keyStatus().configured,
    dryRun: process.env.INVOICE_REMINDERS_DRY_RUN === "1",
  };
}

r.get("/settings", "accounts.view", wrap((req, res) => {
  res.json(settingsPayload());
}));

r.put("/settings", "invoices.edit", wrap((req, res) => {
  reminders.setSettings(db, req, body(req));
  res.json(settingsPayload());
}));

r.put("/clients", "invoices.edit", wrap((req, res) => {
  res.json({ clients: reminders.setClientPause(db, req, body(req)) });
}));

r.get("/queue", "accounts.view", wrap((req, res) => {
  res.json(reminders.queue(db));
}));

// {ids: [...]}: Approve and send, one at a time.
r.post("/queue/send", "invoices.edit", wrap(async (req, res) => {
  const ids = body(req).ids;
  // today? (the smoke tests' clock, same checks as POST /run): never before the Sydney today.
  let today;
  const t = body(req).today;
  if (t !== undefined && t !== null) {
    if (typeof t !== "string" || !invoices.validDate(t)) throw bad("today must be a valid YYYY-MM-DD date");
    if (t < sydneyToday()) throw bad("today can't be before today");
    today = t;
  }
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50) throw bad("ids must be a list of 1 to 50 reminder ids");
  if (!ids.every((n) => Number.isInteger(n) && n > 0)) throw bad("ids must be positive whole numbers");
  const seen = new Set();
  const results = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const out = await reminders.sendOne(db, req, id, today ? { how: "approved", today } : { how: "approved" });
      if (out.result === "sent" || out.result === "dry") results.push({ id, ok: true });
      else if (out.result === "busy") results.push({ id, ok: false, error: "That reminder is no longer waiting" });
      else if (out.result === "cancelled") results.push({ id, ok: false, error: `Not sent: ${out.note}` });
      else results.push({ id, ok: false, error: out.error || "The reminder couldn't be sent" });
    } catch (e) {
      if (e && typeof e.status === "number" && e.status >= 400 && e.status < 500) results.push({ id, ok: false, error: e.message });
      else {
        console.error("[invoice-reminders] send failed:", e);
        results.push({ id, ok: false, error: "Server error" });
      }
    }
  }
  res.json({ results, ...reminders.queue(db) });
}));

r.post("/queue/:id/skip", "invoices.edit", wrap((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw bad("Bad reminder id");
  reminders.skip(db, req, id);
  res.json(reminders.queue(db));
}));

// {today?}: prepare the queue now (in Automatic it also sends). today is never before the Sydney today.
r.post("/run", "invoices.edit", wrap(async (req, res) => {
  const b = body(req);
  let today;
  if (b.today !== undefined && b.today !== null) {
    if (typeof b.today !== "string" || !invoices.validDate(b.today)) throw bad("today must be a valid YYYY-MM-DD date");
    if (b.today < sydneyToday()) throw bad("today can't be before today");
    today = b.today;
  }
  const out = await reminders.run(db, { force: true, today, req });
  // queue()'s `queued` (the waiting list) wins over the run's count, which moves to `queuedNow`.
  res.json({ ...out, ...reminders.queue(db, today ? { today } : undefined), queuedNow: out.queued });
}));

module.exports = r.router;
