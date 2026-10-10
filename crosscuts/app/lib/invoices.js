// Invoices: event hooks, the suggested split, issuing, voiding and payment
// marks. See docs/plans/m2-contracts.md sections 2 and 3.
//
// Everything is synchronous, takes the better-sqlite3 handle first and is safe
// inside a caller's db.transaction. The three event hooks (onScheduled,
// onMaterialsOrdered, onCompleted) run in their own savepoint and never throw,
// so an invoice problem can never block a board edit. The other functions
// throw HttpError ({status, message}) on a rule break; the routes map those to
// 4xx.
const audit = require("./audit");
const notify = require("./notify");
const settings = require("./settings");
const { DATE_RE, sydneyToday, addDays, parseDateUTC, formatDateUTC } = require("./time");

// jobstage.js requires this file at load time, and issue() needs jobstage's
// setStage, so jobstage is required lazily inside issue() to avoid the cycle.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = () => new HttpError(404, "Not found");
const conflict = (msg) => new HttpError(409, msg);

const KINDS = ["deposit", "progress", "final", "extra"];
const KIND_LABEL = { deposit: "Deposit", progress: "Progress", final: "Final", extra: "Extra" };
const DUE_BODY = {
  scheduled: "The job has been scheduled.",
  materials_ordered: "Materials have been ordered.",
  completed: "The job is complete.",
  manual: "",
};

// --- small helpers ---------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function validDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = parseDateUTC(s);
  return !Number.isNaN(d.getTime()) && formatDateUTC(d) === s; // rejects 2026-02-31
}

// 1234567 -> "$12,345.67" (negative: "-$12.00").
function money(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

function camel(col) {
  return col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function getInvoice(db, id) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
  if (!inv) throw notFound();
  return inv;
}

function getJob(db, id) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
}

// --- amounts and lines -----------------------------------------------------

// The 10 / 50 / 40 split of a GST-inclusive value; the three always add up to
// the value exactly. A null value gives null; extras have no suggestion.
function suggestedCents(valueCents, kind) {
  if (valueCents == null) return null;
  const deposit = Math.round(valueCents * 0.1);
  const progress = Math.round(valueCents * 0.5);
  if (kind === "deposit") return deposit;
  if (kind === "progress") return progress;
  if (kind === "final") return valueCents - deposit - progress;
  return null;
}

// "Deposit (10%): Smith kitchen, 12 Rose St". `job` is a jobs row.
function standardLine(job, kind) {
  const label = { deposit: "Deposit (10%)", progress: "Progress payment (50%)", final: "Final payment (40%)" }[kind];
  if (!label) return "";
  const name = (job && job.name) || "";
  const site = job && (job.site_address || job.siteAddress);
  return `${label}: ${name}${site ? `, ${site}` : ""}`;
}

// Lines of an invoice. While it is not yet issued and lines_custom = 0, this is
// one standard line with the suggested amount from the CURRENT job (a job value
// edited before issue flows through). Otherwise the stored invoice_lines.
// `job` and `stored` (the stored rows) are optional, to save queries in bulk.
function linesOf(db, inv, job, stored) {
  const live = !inv.lines_custom && (inv.status === "pending" || inv.status === "due" || inv.status === "waived");
  if (live) {
    if (inv.kind === "extra") return [];
    const j = job || getJob(db, inv.job_id);
    const cents = suggestedCents(j ? j.value_cents : null, inv.kind);
    return [{ id: null, description: standardLine(j, inv.kind), amountCents: cents == null ? 0 : cents }];
  }
  const rows =
    stored ||
    db
      .prepare("SELECT id, description, amount_cents FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order ASC, id ASC")
      .all(inv.id);
  return rows.map((l) => ({ id: l.id, description: l.description, amountCents: l.amount_cents }));
}

function linesFor(db, invoice) {
  return linesOf(db, invoice);
}

function sumLines(lines) {
  return lines.reduce((s, l) => s + l.amountCents, 0);
}

function isOverdue(inv, today) {
  return inv.status === "issued" && !!inv.due_date && inv.due_date < today;
}

// --- presentation ----------------------------------------------------------

function presentJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    name: job.name,
    clientName: job.client_name,
    clientPhone: job.client_phone,
    clientEmail: job.client_email,
    siteAddress: job.site_address,
    clientAbn: job.client_abn,
    valueCents: job.value_cents,
    stage: job.stage,
  };
}

// The invoice object (contracts section 4).
function present(db, inv, today) {
  const t = today || sydneyToday();
  const job = getJob(db, inv.job_id);
  const lines = linesOf(db, inv, job);
  const total = inv.total_cents != null ? inv.total_cents : sumLines(lines);
  const out = {};
  for (const [col, v] of Object.entries(inv)) out[camel(col)] = v;
  const replacedBy = db
    .prepare("SELECT id FROM invoices WHERE replaces_id = ? ORDER BY id DESC LIMIT 1")
    .get(inv.id);
  out.lines = lines;
  out.totalCents = total;
  out.gstCents = inv.gst_cents != null ? inv.gst_cents : Math.round(total / 11);
  out.suggestedCents = job ? suggestedCents(job.value_cents, inv.kind) : null;
  out.overdue = isOverdue(inv, t);
  out.job = presentJob(job);
  out.replacedById = replacedBy ? replacedBy.id : null;
  return out;
}

// The table cell (contracts section 4).
function cellOf(db, inv, job, stored, today) {
  const lines = linesOf(db, inv, job, stored);
  return {
    id: inv.id,
    kind: inv.kind,
    status: inv.status,
    number: inv.number,
    totalCents: inv.total_cents != null ? inv.total_cents : sumLines(lines),
    issueDate: inv.issue_date,
    dueDate: inv.due_date,
    paidDate: inv.paid_date,
    overdue: isOverdue(inv, today),
    myobEntered: !!inv.myob_entered_date,
    description: lines.length ? lines[0].description : "",
  };
}

// --- event hooks -----------------------------------------------------------

// Run `fn` in a savepoint; on any error log and return false. Never throws.
function hook(db, label, fn) {
  try {
    return db.transaction(fn)();
  } catch (e) {
    console.error(`[invoices] ${label} failed:`, e && e.message);
    return false;
  }
}

// Audit the invoice.due event and put one notification in the bell of everyone
// with invoices.edit.
function announceDue(db, invoiceId, req) {
  const inv = getInvoice(db, invoiceId);
  const job = getJob(db, inv.job_id);
  const total = sumLines(linesOf(db, inv, job));
  const hasAmount = inv.kind === "extra" || (job && job.value_cents != null);
  audit.log(req, {
    action: "invoice.due",
    entityType: "invoice",
    entityId: invoiceId,
    after: { jobId: inv.job_id, kind: inv.kind, status: "due", dueReason: inv.due_reason, amountCents: hasAmount ? total : null },
  });
  notify.toKey(db, "invoices.edit", {
    kind: "invoice.due",
    title: `${KIND_LABEL[inv.kind]} due: ${job ? job.name : "job " + inv.job_id}${hasAmount ? ", " + money(total) : ""}`,
    body: DUE_BODY[inv.due_reason] || "",
    link: `/accounts.html?invoice=${invoiceId}`,
    entityType: "invoice",
    entityId: invoiceId,
  });
}

function insertDue(db, jobId, kind, reason) {
  const info = db
    .prepare(
      `INSERT INTO invoices (job_id, kind, status, became_due_date, due_reason)
       VALUES (?, ?, 'due', ?, ?)`
    )
    .run(jobId, kind, sydneyToday(), reason);
  return Number(info.lastInsertRowid);
}

// A row was placed on the board. The first placement of a job that has no
// deposit in any status and no earlier week rows makes the deposit due.
function onScheduled(db, jobId, weekStart, req) {
  return hook(db, "onScheduled", () => {
    if (typeof weekStart !== "string" || !DATE_RE.test(weekStart)) return false;
    if (!getJob(db, jobId)) return false;
    if (db.prepare("SELECT 1 AS x FROM invoices WHERE job_id = ? AND kind = 'deposit' LIMIT 1").get(jobId)) return false;
    if (db.prepare("SELECT 1 AS x FROM week_rows WHERE job_id = ? AND week_start < ? LIMIT 1").get(jobId, weekStart)) {
      return false;
    }
    announceDue(db, insertDue(db, jobId, "deposit", "scheduled"), req);
    return true;
  });
}

// "Materials ordered": the progress invoice becomes due (unless one is live).
function onMaterialsOrdered(db, jobId, date, req) {
  return hook(db, "onMaterialsOrdered", () => {
    if (!getJob(db, jobId)) return false;
    if (
      db.prepare("SELECT 1 AS x FROM invoices WHERE job_id = ? AND kind = 'progress' AND status <> 'void' LIMIT 1").get(jobId)
    ) {
      return false;
    }
    announceDue(db, insertDue(db, jobId, "progress", "materials_ordered"), req);
    return true;
  });
}

// The job is complete. Only for jobs that already have an invoice row (jobs
// that predate tracking get none): the final becomes due, and pending extras
// become due.
function onCompleted(db, jobId, req) {
  return hook(db, "onCompleted", () => {
    if (!getJob(db, jobId)) return false;
    if (!db.prepare("SELECT 1 AS x FROM invoices WHERE job_id = ? LIMIT 1").get(jobId)) return false;
    let made = false;
    if (
      !db.prepare("SELECT 1 AS x FROM invoices WHERE job_id = ? AND kind = 'final' AND status <> 'void' LIMIT 1").get(jobId)
    ) {
      announceDue(db, insertDue(db, jobId, "final", "completed"), req);
      made = true;
    }
    const pending = db
      .prepare("SELECT id FROM invoices WHERE job_id = ? AND kind = 'extra' AND status = 'pending' ORDER BY id")
      .all(jobId);
    for (const { id } of pending) {
      db.prepare(
        "UPDATE invoices SET status = 'due', became_due_date = ?, due_reason = 'completed', updated_at = ? WHERE id = ?"
      ).run(sydneyToday(), nowIso(), id);
      announceDue(db, id, req);
      made = true;
    }
    return made;
  });
}

// --- issuing and the state changes -----------------------------------------

// Issue a due invoice: number, frozen lines/total/GST, bill-to snapshot, dates.
// Issuing a final moves the job to the invoiced stage. Returns the new row.
function issue(db, id, req) {
  return db.transaction(() => {
    const inv = getInvoice(db, id);
    if (inv.status !== "due") throw conflict(`Only a due invoice can be issued (this one is ${inv.status})`);
    if (!settings.businessReady(db)) {
      throw conflict("Business details are not set up yet (trading name, ABN and address are needed in Settings)");
    }
    const job = getJob(db, inv.job_id);
    const lines = linesOf(db, inv, job);
    const total = sumLines(lines);
    if (!(total > 0)) throw conflict("The invoice total must be more than zero");
    const gst = Math.round(total / 11);

    // Take the next number (the series is locked once issuing starts).
    const prefixSetting = settings.get(db, "invoice.prefix");
    const prefix = prefixSetting == null ? "CC-" : prefixSetting;
    const pad = parseInt(settings.get(db, "invoice.pad"), 10) || 4;
    let n = parseInt(settings.get(db, "invoice.next_number"), 10) || 1;
    let number;
    do {
      number = prefix + String(n).padStart(pad, "0");
      n += 1;
    } while (db.prepare("SELECT 1 AS x FROM invoices WHERE number = ?").get(number));
    settings.set(db, "invoice.next_number", n, req);

    // Materialise the lines (a live standard line becomes stored rows).
    if (!inv.lines_custom) {
      db.prepare("DELETE FROM invoice_lines WHERE invoice_id = ?").run(id);
      const ins = db.prepare(
        "INSERT INTO invoice_lines (invoice_id, sort_order, description, amount_cents) VALUES (?, ?, ?, ?)"
      );
      lines.forEach((l, i) => ins.run(id, i, l.description, l.amountCents));
    }

    const today = sydneyToday();
    const days = parseInt(settings.get(db, "invoice.default_days"), 10);
    const dueDate = inv.due_date || addDays(today, Number.isFinite(days) ? days : 10);
    const billName = inv.bill_to_name || (job && job.client_name) || null;
    const billAddress = inv.bill_to_address || (job && job.site_address) || null;
    const billAbn = inv.bill_to_abn || (job && job.client_abn) || null;
    const siteAddress = inv.site_address || (job && job.site_address) || null;
    db.prepare(
      `UPDATE invoices SET status = 'issued', number = ?, total_cents = ?, gst_cents = ?,
         bill_to_name = ?, bill_to_address = ?, bill_to_abn = ?, site_address = ?,
         issue_date = ?, due_date = ?, updated_at = ? WHERE id = ?`
    ).run(number, total, gst, billName, billAddress, billAbn, siteAddress, today, dueDate, nowIso(), id);

    audit.log(req, {
      action: "invoice.issue",
      entityType: "invoice",
      entityId: id,
      before: { status: "due" },
      after: { status: "issued", number, kind: inv.kind, jobId: inv.job_id, totalCents: total, gstCents: gst, issueDate: today, dueDate },
    });
    if (inv.kind === "final") require("./jobstage").setStage(db, inv.job_id, "invoiced", req);
    return getInvoice(db, id);
  })();
}

function needReason(reason) {
  const r = typeof reason === "string" ? reason.trim() : "";
  if (!r) throw bad("reason is required");
  if (r.length > 1000) throw bad("reason is too long");
  return r;
}

// Void an issued (not paid) invoice. Its number is never reused. A new due
// copy (same kind, job and lines, replaces_id = this one) is made for fixing.
function voidInvoice(db, id, reason, req) {
  const why = needReason(reason);
  return db.transaction(() => {
    const inv = getInvoice(db, id);
    if (inv.status === "paid") throw conflict("A paid invoice can't be voided");
    if (inv.status !== "issued") throw conflict(`Only an issued invoice can be voided (this one is ${inv.status})`);
    const lines = linesOf(db, inv);
    db.prepare("UPDATE invoices SET status = 'void', void_reason = ?, updated_at = ? WHERE id = ?").run(why, nowIso(), id);
    // The old row is void first, so the one-live-per-kind index lets the copy in.
    const info = db
      .prepare(
        `INSERT INTO invoices (job_id, kind, status, lines_custom, became_due_date, due_reason, replaces_id)
         VALUES (?, ?, 'due', 1, ?, 'manual', ?)`
      )
      .run(inv.job_id, inv.kind, sydneyToday(), id);
    const newId = Number(info.lastInsertRowid);
    const ins = db.prepare(
      "INSERT INTO invoice_lines (invoice_id, sort_order, description, amount_cents) VALUES (?, ?, ?, ?)"
    );
    lines.forEach((l, i) => ins.run(newId, i, l.description, l.amountCents));
    audit.log(req, {
      action: "invoice.void",
      entityType: "invoice",
      entityId: id,
      before: { status: "issued", number: inv.number },
      after: { status: "void", reason: why, replacementId: newId },
    });
    audit.log(req, {
      action: "invoice.create",
      entityType: "invoice",
      entityId: newId,
      after: { jobId: inv.job_id, kind: inv.kind, status: "due", replacesId: id },
    });
    return { voided: getInvoice(db, id), replacement: getInvoice(db, newId) };
  })();
}

// "Not needed": a pending or due invoice is set aside, with a reason.
function waive(db, id, reason, req) {
  const why = needReason(reason);
  return db.transaction(() => {
    const inv = getInvoice(db, id);
    if (inv.status !== "pending" && inv.status !== "due") {
      throw conflict(`Only a pending or due invoice can be waived (this one is ${inv.status})`);
    }
    db.prepare("UPDATE invoices SET status = 'waived', waive_reason = ?, updated_at = ? WHERE id = ?").run(
      why,
      nowIso(),
      id
    );
    audit.log(req, {
      action: "invoice.waive",
      entityType: "invoice",
      entityId: id,
      before: { status: inv.status },
      after: { status: "waived", reason: why },
    });
    return getInvoice(db, id);
  })();
}

function markPaid(db, id, paidDate, req) {
  if (paidDate != null && !validDate(paidDate)) throw bad("paidDate must be a valid YYYY-MM-DD date");
  return db.transaction(() => {
    const inv = getInvoice(db, id);
    if (inv.status !== "issued") throw conflict(`Only an issued invoice can be marked paid (this one is ${inv.status})`);
    const date = paidDate || sydneyToday();
    db.prepare("UPDATE invoices SET status = 'paid', paid_date = ?, updated_at = ? WHERE id = ?").run(date, nowIso(), id);
    audit.log(req, {
      action: "invoice.paid",
      entityType: "invoice",
      entityId: id,
      before: { status: "issued" },
      after: { status: "paid", paidDate: date },
    });
    return getInvoice(db, id);
  })();
}

function unmarkPaid(db, id, req) {
  return db.transaction(() => {
    const inv = getInvoice(db, id);
    if (inv.status !== "paid") throw conflict(`Only a paid invoice can be marked unpaid (this one is ${inv.status})`);
    db.prepare("UPDATE invoices SET status = 'issued', paid_date = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id);
    audit.log(req, {
      action: "invoice.paid",
      entityType: "invoice",
      entityId: id,
      before: { status: "paid", paidDate: inv.paid_date },
      after: { status: "issued" },
    });
    return getInvoice(db, id);
  })();
}

// Tick or untick "Entered in MYOB" (dateOrNull: the date, or null to clear).
function setMyob(db, id, dateOrNull, req) {
  if (dateOrNull != null && !validDate(dateOrNull)) throw bad("date must be a valid YYYY-MM-DD date");
  return db.transaction(() => {
    const inv = getInvoice(db, id);
    if (inv.status !== "issued" && inv.status !== "paid") {
      throw conflict(`Only an issued or paid invoice can be entered in MYOB (this one is ${inv.status})`);
    }
    db.prepare("UPDATE invoices SET myob_entered_date = ?, updated_at = ? WHERE id = ?").run(
      dateOrNull || null,
      nowIso(),
      id
    );
    audit.log(req, {
      action: "invoice.myob",
      entityType: "invoice",
      entityId: id,
      before: { myobEnteredDate: inv.myob_entered_date },
      after: { myobEnteredDate: dateOrNull || null },
    });
    return getInvoice(db, id);
  })();
}

module.exports = {
  // contract
  onScheduled,
  onMaterialsOrdered,
  onCompleted,
  suggestedCents,
  standardLine,
  linesFor,
  issue,
  voidInvoice,
  waive,
  markPaid,
  unmarkPaid,
  setMyob,
  isOverdue,
  // shared with routes/invoices.js
  HttpError,
  KINDS,
  validDate,
  money,
  getInvoice,
  getJob,
  linesOf,
  sumLines,
  present,
  presentJob,
  cellOf,
  insertDue,
};
