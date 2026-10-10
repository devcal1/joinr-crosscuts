// Invoices: the table, the invoice object, issue, paid, void, waive. Wave 1 A.
// See docs/plans/m2-contracts.md section 4. Literal paths (/table, /overdue,
// /summary, /job/:jobId) are registered before /:id.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const audit = require("../lib/audit");
const settings = require("../lib/settings");
const invoices = require("../lib/invoices");
const { sydneyToday, parseDateUTC } = require("../lib/time");

const { HttpError, KINDS } = invoices;
const r = defineRoutes("/api/invoices");

const bad = (msg) => new HttpError(400, msg);
const conflict = (msg) => new HttpError(409, msg);

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      if (e && /UNIQUE constraint failed: invoices\.number/.test(e.message)) {
        return res.status(409).json({ error: "That invoice number is already used" });
      }
      if (e && /UNIQUE constraint failed: invoices\.job_id/.test(e.message)) {
        return res.status(409).json({ error: "A live invoice of that kind already exists for this job" });
      }
      console.error("[invoices]", e);
      res.status(500).json({ error: "Server error" });
    }
  };
}

function parseId(v) {
  const id = Number(v);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function body(req) {
  const b = req.body;
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}

// The invoice, or a 404.
function load(req) {
  const id = parseId(req.params.id);
  const inv = id && db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
  if (!inv) throw new HttpError(404, "Not found");
  return inv;
}

// --- the table ---------------------------------------------------------------

const FILTERS = new Set(["all", "due", "unpaid", "overdue", "notmyob", "month"]);

r.get("/table", "accounts.view", handle((req, res) => {
  const filter = req.query.filter === undefined || req.query.filter === "" ? "all" : req.query.filter;
  if (!FILTERS.has(filter)) throw bad(`filter must be one of ${[...FILTERS].join(", ")}`);
  const ajq = req.query.allJobs;
  if (ajq !== undefined && ajq !== "" && ajq !== "0" && ajq !== "1") throw bad("allJobs must be 0 or 1");
  const allJobs = ajq === "1";
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";

  const today = sydneyToday();
  const month = today.slice(0, 7);
  const jobs = db
    .prepare("SELECT id, name, client_name, site_address, value_cents, stage, archived FROM jobs")
    .all();
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const storedBy = new Map();
  for (const l of db
    .prepare("SELECT id, invoice_id, description, amount_cents FROM invoice_lines ORDER BY invoice_id, sort_order, id")
    .all()) {
    if (!storedBy.has(l.invoice_id)) storedBy.set(l.invoice_id, []);
    storedBy.get(l.invoice_id).push(l);
  }
  const byJob = new Map();
  for (const inv of db.prepare("SELECT * FROM invoices WHERE status <> 'void' ORDER BY id").all()) {
    if (!byJob.has(inv.job_id)) byJob.set(inv.job_id, []);
    byJob.get(inv.job_id).push(inv);
  }

  // Does this invoice match the filter? A job is listed when any of its
  // invoices does, and is then shown whole.
  const live = (inv) => inv.status === "issued" || inv.status === "paid";
  const matches = {
    all: () => true,
    due: (inv) => inv.status === "due",
    unpaid: (inv) => inv.status === "issued",
    overdue: (inv) => invoices.isOverdue(inv, today),
    notmyob: (inv) => live(inv) && !inv.myob_entered_date,
    month: (inv) =>
      (inv.issue_date && inv.issue_date.startsWith(month)) || (inv.paid_date && inv.paid_date.startsWith(month)),
  }[filter];

  const totals = { outstandingCents: 0, overdueCents: 0, dueCount: 0, overdueCount: 0, notInMyobCount: 0 };
  const rows = [];
  for (const job of jobs) {
    const invs = byJob.get(job.id) || [];
    if (invs.length === 0 && !(allJobs && filter === "all" && !job.archived)) continue;
    if (filter !== "all" && !invs.some(matches)) continue;
    if (q) {
      const hay = [job.name, job.client_name, job.site_address, ...invs.map((i) => i.number)]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      if (!hay.includes(q)) continue;
    }
    const row = {
      job: { id: job.id, name: job.name, clientName: job.client_name, valueCents: job.value_cents, stage: job.stage },
      deposit: null,
      progress: null,
      final: null,
      extras: [],
    };
    for (const inv of invs) {
      const cell = invoices.cellOf(db, inv, job, storedBy.get(inv.id), today);
      if (inv.kind === "extra") row.extras.push(cell);
      else row[inv.kind] = cell;
      if (inv.status === "due") totals.dueCount += 1;
      if (inv.status === "issued") totals.outstandingCents += cell.totalCents;
      if (cell.overdue) {
        totals.overdueCount += 1;
        totals.overdueCents += cell.totalCents;
      }
      if (live(inv) && !inv.myob_entered_date) totals.notInMyobCount += 1;
    }
    rows.push(row);
  }
  rows.sort((a, b) => a.job.name.localeCompare(b.job.name, undefined, { sensitivity: "base" }) || a.job.id - b.job.id);
  res.json({ rows, totals });
}));

r.get("/overdue", "accounts.view", handle((req, res) => {
  const today = sydneyToday();
  const todayMs = parseDateUTC(today).getTime();
  const list = db
    .prepare("SELECT * FROM invoices WHERE status = 'issued' AND due_date IS NOT NULL AND due_date < ? ORDER BY due_date ASC, id ASC")
    .all(today);
  res.json(
    list.map((inv) => ({
      invoice: invoices.present(db, inv, today),
      daysOverdue: Math.round((todayMs - parseDateUTC(inv.due_date).getTime()) / 86400000),
    }))
  );
}));

r.get("/summary", "accounts.view", handle((req, res) => {
  const today = sydneyToday();
  const dueCount = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'due'").get().n;
  const overdueCount = db
    .prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'issued' AND due_date IS NOT NULL AND due_date < ?")
    .get(today).n;
  res.json({ dueCount, overdueCount });
}));

r.get("/job/:jobId", "accounts.view", handle((req, res) => {
  const jobId = parseId(req.params.jobId);
  if (!jobId || !invoices.getJob(db, jobId)) throw new HttpError(404, "Not found");
  const today = sydneyToday();
  res.json(
    db
      .prepare("SELECT * FROM invoices WHERE job_id = ? ORDER BY id")
      .all(jobId)
      .map((inv) => invoices.present(db, inv, today))
  );
}));

r.get("/:id", "accounts.view", handle((req, res) => {
  const inv = load(req);
  const job = invoices.getJob(db, inv.job_id);
  const invoiced = db
    .prepare(
      "SELECT COALESCE(SUM(total_cents), 0) AS s FROM invoices WHERE job_id = ? AND id <> ? AND status IN ('issued','paid')"
    )
    .get(inv.job_id, inv.id).s;
  res.json({
    invoice: invoices.present(db, inv),
    business: settings.business(db),
    contract: { valueCents: job ? job.value_cents : null, invoicedToDateCents: invoiced },
  });
}));

// --- creating ----------------------------------------------------------------

function parseLineText(v, what) {
  if (typeof v !== "string" || !v.trim()) throw bad(`${what} is required`);
  if (v.length > 500) throw bad(`${what} is too long (500 characters at most)`);
  return v.trim();
}
function parseCents(v, what) {
  if (!Number.isInteger(v) || Math.abs(v) > 10_000_000_000) throw bad(`${what} must be a whole number of cents`);
  return v;
}

function insertLines(invoiceId, lines) {
  const ins = db.prepare(
    "INSERT INTO invoice_lines (invoice_id, sort_order, description, amount_cents) VALUES (?, ?, ?, ?)"
  );
  lines.forEach((l, i) => ins.run(invoiceId, i, l.description, l.amountCents));
}

r.post("/", "invoices.edit", handle((req, res) => {
  const b = body(req);
  const jobId = b.jobId;
  if (!Number.isInteger(jobId) || jobId < 1) throw bad("jobId is required");
  if (!KINDS.includes(b.kind)) throw bad(`kind must be one of ${KINDS.join(", ")}`);
  const hasDesc = b.description !== undefined && b.description !== null;
  const hasAmount = b.amountCents !== undefined && b.amountCents !== null;
  const description = hasDesc ? parseLineText(b.description, "description") : null;
  const amount = hasAmount ? parseCents(b.amountCents, "amountCents") : null;
  if (b.kind === "extra" && (!hasDesc || !hasAmount)) throw bad("An extra needs a description and an amountCents");

  const id = db.transaction(() => {
    const job = invoices.getJob(db, jobId);
    if (!job) throw new HttpError(404, "Job not found");
    const today = sydneyToday();
    let newId;
    if (b.kind === "extra") {
      const status = job.stage === "complete" || job.stage === "invoiced" ? "due" : "pending";
      newId = Number(
        db
          .prepare(
            `INSERT INTO invoices (job_id, kind, status, lines_custom, became_due_date, due_reason)
             VALUES (?, 'extra', ?, 1, ?, ?)`
          )
          .run(jobId, status, status === "due" ? today : null, status === "due" ? "manual" : null).lastInsertRowid
      );
      insertLines(newId, [{ description, amountCents: amount }]);
    } else {
      if (
        db.prepare("SELECT 1 AS x FROM invoices WHERE job_id = ? AND kind = ? AND status <> 'void' LIMIT 1").get(jobId, b.kind)
      ) {
        throw conflict(`This job already has a ${b.kind} invoice`);
      }
      newId = invoices.insertDue(db, jobId, b.kind, "manual");
      if (hasDesc || hasAmount) {
        // A hand-typed line instead of the standard one.
        const sug = invoices.suggestedCents(job.value_cents, b.kind);
        db.prepare("UPDATE invoices SET lines_custom = 1 WHERE id = ?").run(newId);
        insertLines(newId, [
          {
            description: description || invoices.standardLine(job, b.kind),
            amountCents: hasAmount ? amount : sug == null ? 0 : sug,
          },
        ]);
      }
    }
    const inv = invoices.getInvoice(db, newId);
    audit.log(req, {
      action: "invoice.create",
      entityType: "invoice",
      entityId: newId,
      after: { jobId, kind: b.kind, status: inv.status, dueReason: inv.due_reason },
    });
    return newId;
  })();
  res.status(201).json(invoices.present(db, invoices.getInvoice(db, id)));
}));

// --- editing -----------------------------------------------------------------

// Draft-only fields: editable while pending or due.
const DRAFT_FIELDS = {
  dueDate: { col: "due_date", kind: "date" },
  billToName: { col: "bill_to_name", kind: "text" },
  billToAddress: { col: "bill_to_address", kind: "text" },
  billToAbn: { col: "bill_to_abn", kind: "text" },
  siteAddress: { col: "site_address", kind: "text" },
};
// Editable in any status.
const ANY_FIELDS = {
  notes: { col: "notes", kind: "notes" },
  lastContactedDate: { col: "last_contacted_date", kind: "date" },
  followUpNotes: { col: "follow_up_notes", kind: "notes" },
  externalId: { col: "external_id", kind: "text" },
};

function coerceField(key, f, v) {
  const empty = v === null || (typeof v === "string" && v.trim() === "");
  if (f.kind === "notes") {
    if (v === null) return "";
    if (typeof v !== "string") throw bad(`${key} must be a string`);
    if (v.length > 5000) throw bad(`${key} is too long`);
    return v;
  }
  if (empty) return null;
  if (typeof v !== "string") throw bad(`${key} must be a string`);
  if (f.kind === "date") {
    if (!invoices.validDate(v)) throw bad(`${key} must be a valid YYYY-MM-DD date`);
    return v;
  }
  if (v.length > 500) throw bad(`${key} is too long`);
  return v.trim();
}

function parseLines(v) {
  if (!Array.isArray(v) || v.length > 50) throw bad("lines must be an array of at most 50 lines");
  return v.map((l, i) => {
    if (!l || typeof l !== "object") throw bad(`line ${i + 1} must be an object`);
    return {
      description: parseLineText(l.description, `line ${i + 1} description`),
      amountCents: parseCents(l.amountCents, `line ${i + 1} amountCents`),
    };
  });
}

r.patch("/:id", "invoices.edit", handle((req, res) => {
  const b = body(req);
  const existing = load(req);
  const draftKeys = Object.keys(DRAFT_FIELDS).concat("lines").filter((k) => b[k] !== undefined);
  const anyKeys = Object.keys(ANY_FIELDS).filter((k) => b[k] !== undefined);
  if (draftKeys.length + anyKeys.length === 0) throw bad("Nothing to update");

  const isDraft = existing.status === "pending" || existing.status === "due";
  if (draftKeys.length && !isDraft) {
    throw conflict(`${draftKeys.join(", ")} can only be edited while the invoice is pending or due (this one is ${existing.status})`);
  }
  const lines = b.lines !== undefined ? parseLines(b.lines) : null;
  const values = {};
  for (const k of draftKeys) if (k !== "lines") values[DRAFT_FIELDS[k].col] = coerceField(k, DRAFT_FIELDS[k], b[k]);
  for (const k of anyKeys) values[ANY_FIELDS[k].col] = coerceField(k, ANY_FIELDS[k], b[k]);

  db.transaction(() => {
    const before = {};
    const after = {};
    for (const col of Object.keys(values)) {
      if (values[col] !== existing[col]) {
        before[col] = existing[col];
        after[col] = values[col];
      }
    }
    if (lines) {
      before.lines = invoices.linesFor(db, existing);
      db.prepare("DELETE FROM invoice_lines WHERE invoice_id = ?").run(existing.id);
      insertLines(existing.id, lines);
      after.lines = lines;
    }
    const cols = Object.keys(after).filter((c) => c !== "lines");
    if (cols.length === 0 && !lines) return; // nothing actually changed
    const sets = cols.map((c) => `${c} = ?`);
    if (lines) sets.push("lines_custom = 1");
    db.prepare(`UPDATE invoices SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(
      ...cols.map((c) => after[c]),
      new Date().toISOString(),
      existing.id
    );
    audit.log(req, { action: "invoice.update", entityType: "invoice", entityId: existing.id, before, after });
  })();
  res.json(invoices.present(db, invoices.getInvoice(db, existing.id)));
}));

// --- state changes -----------------------------------------------------------

r.post("/:id/issue", "invoices.edit", handle((req, res) => {
  const inv = load(req);
  const out = db.transaction(() => invoices.issue(db, inv.id, req))();
  res.json(invoices.present(db, out));
}));

r.post("/:id/paid", "invoices.edit", handle((req, res) => {
  const inv = load(req);
  const b = body(req);
  const paidDate = b.paidDate === undefined || b.paidDate === null || b.paidDate === "" ? null : b.paidDate;
  const out = db.transaction(() => invoices.markPaid(db, inv.id, paidDate, req))();
  res.json(invoices.present(db, out));
}));

r.post("/:id/unpaid", "invoices.edit", handle((req, res) => {
  const inv = load(req);
  const out = db.transaction(() => invoices.unmarkPaid(db, inv.id, req))();
  res.json(invoices.present(db, out));
}));

r.post("/:id/myob", "invoices.edit", handle((req, res) => {
  const inv = load(req);
  const b = body(req);
  if (typeof b.entered !== "boolean") throw bad("entered must be true or false");
  const out = db.transaction(() => invoices.setMyob(db, inv.id, b.entered ? sydneyToday() : null, req))();
  res.json(invoices.present(db, out));
}));

r.post("/:id/void", "invoices.edit", handle((req, res) => {
  const inv = load(req);
  const out = db.transaction(() => invoices.voidInvoice(db, inv.id, body(req).reason, req))();
  res.json({ voided: invoices.present(db, out.voided), replacement: invoices.present(db, out.replacement) });
}));

r.post("/:id/waive", "invoices.edit", handle((req, res) => {
  const inv = load(req);
  const out = db.transaction(() => invoices.waive(db, inv.id, body(req).reason, req))();
  res.json(invoices.present(db, out));
}));

module.exports = r.router;
