// Invoice sent and follow-up (0.2.7, docs/plans/m28-contracts.md section 3).
//
// - Mark sent records invoices.sent_date (default today) and pre-fills invoices.followup_days from
//   the client's default terms (client_terms, keyed by the job's folded client name), else the
//   setting invoices.followup_days_default (7). Accounts can change it per invoice.
// - Contacted writes the invoice_contacts log and keeps invoices.last_contacted_date in step (the
//   latest contact date).
// - An overdue invoice whose last contact (or, never contacted, its due date) is at least its
//   interval ago is "needs follow-up". Never contacted counts from the due date, so a just-overdue
//   invoice isn't chased before its interval has run.
//
// Every function takes db first; nothing here requires ../db.
const { bad, notFound, conflict } = require("./httperror");
const { sydneyToday, parseDateUTC, formatDateUTC, addDays } = require("./time");
const audit = require("./audit");
const settings = require("./settings");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 1000;
const DEFAULT_KEY = "invoices.followup_days_default";

function nowIso() {
  return new Date().toISOString();
}
function userId(req) {
  return req && req.user ? req.user.id : null;
}
function validDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && formatDateUTC(parseDateUTC(s)) === s;
}
function days(v, what) {
  if (!Number.isInteger(v) || v < 1 || v > 365) throw bad(`${what} must be a whole number of days from 1 to 365`);
  return v;
}
// The key a client's terms are stored under: the name trimmed, spaces folded, case-blind.
function clientKey(name) {
  return String(name || "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-AU");
}

function defaultDays(db) {
  const n = Number(settings.get(db, DEFAULT_KEY));
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 7;
}

function clientDays(db, clientName) {
  const k = clientKey(clientName);
  if (!k) return null;
  const r = db.prepare("SELECT followup_days FROM client_terms WHERE client_key = ?").get(k);
  return r ? Number(r.followup_days) : null;
}

// {days, from: 'invoice' | 'client' | 'default'} for an invoice row (job client name passed in).
function intervalOf(db, inv, clientName) {
  if (inv.followup_days != null) return { days: Number(inv.followup_days), from: "invoice" };
  const c = clientDays(db, clientName);
  if (c != null) return { days: c, from: "client" };
  return { days: defaultDays(db), from: "default" };
}

function needsFollowUp(inv, interval, today) {
  if (inv.status !== "issued" || !inv.due_date || !(inv.due_date < today)) return false;
  const since = inv.last_contacted_date && inv.last_contacted_date > inv.due_date ? inv.last_contacted_date : inv.due_date;
  return addDays(since, interval) <= today;
}

// The extra fields present() adds to the invoice object.
function fieldsFor(db, inv, clientName, today = sydneyToday()) {
  const iv = intervalOf(db, inv, clientName);
  return {
    followUpDaysEffective: iv.days,
    followUpDaysFrom: iv.from,
    clientFollowUpDays: clientDays(db, clientName),
    needsFollowUp: needsFollowUp(inv, iv.days, today),
  };
}

function invoiceRow(db, id) {
  const r = db
    .prepare("SELECT i.*, j.client_name AS client_name FROM invoices i JOIN jobs j ON j.id = i.job_id WHERE i.id = ?")
    .get(id);
  if (!r) throw notFound();
  return r;
}

// Mark sent {date?} (default today; not in the future, not before issue), or {sent: false} to clear.
function markSent(db, req, id, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const today = sydneyToday();
  const clear = b.sent === false;
  let date = null;
  if (!clear) {
    date = b.date == null || b.date === "" ? today : b.date;
    if (!validDate(date)) throw bad("date must be a valid YYYY-MM-DD date");
    if (date > today) throw bad("The sent date can't be in the future");
  }
  return db.transaction(() => {
    const inv = invoiceRow(db, id);
    if (inv.status !== "issued" && inv.status !== "paid") {
      throw conflict(`Only an issued invoice can be marked sent (this one is ${inv.status})`);
    }
    if (date && inv.issue_date && date < inv.issue_date) throw bad("The sent date can't be before the issue date");
    let fill = inv.followup_days;
    if (date && fill == null) {
      const c = clientDays(db, inv.client_name);
      fill = c != null ? c : defaultDays(db);
    }
    db.prepare("UPDATE invoices SET sent_date = ?, followup_days = ?, updated_at = ? WHERE id = ?").run(date, fill, nowIso(), id);
    audit.log(req, {
      action: clear ? "invoice.unsent" : "invoice.sent",
      entityType: "invoice",
      entityId: id,
      before: { sentDate: inv.sent_date || null, followUpDays: inv.followup_days },
      after: { sentDate: date, followUpDays: fill },
    });
  })();
}

// Contacted {date?, note?}: one log row; last_contacted_date becomes the latest contact date.
function addContact(db, req, id, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const today = sydneyToday();
  const date = b.date == null || b.date === "" ? today : b.date;
  if (!validDate(date)) throw bad("date must be a valid YYYY-MM-DD date");
  if (date > today) throw bad("The contact date can't be in the future");
  if (b.note != null && typeof b.note !== "string") throw bad("The note must be text");
  const note = (b.note || "").trim();
  if (note.length > NOTE_MAX) throw bad(`The note must be ${NOTE_MAX} characters or fewer`);
  return db.transaction(() => {
    const inv = invoiceRow(db, id);
    if (inv.status !== "issued" && inv.status !== "paid") {
      throw conflict(`Only an issued invoice has contacts (this one is ${inv.status})`);
    }
    const info = db
      .prepare("INSERT INTO invoice_contacts (invoice_id, date, note, by_user, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, date, note, userId(req), nowIso());
    const last = !inv.last_contacted_date || date > inv.last_contacted_date ? date : inv.last_contacted_date;
    db.prepare("UPDATE invoices SET last_contacted_date = ?, updated_at = ? WHERE id = ?").run(last, nowIso(), id);
    audit.log(req, {
      action: "invoice.contacted",
      entityType: "invoice",
      entityId: id,
      before: { lastContactedDate: inv.last_contacted_date || null },
      after: { contactId: Number(info.lastInsertRowid), date, note, lastContactedDate: last },
    });
    return contacts(db, id);
  })();
}

function contacts(db, id) {
  invoiceRow(db, id);
  return db
    .prepare(
      `SELECT c.id, c.date, c.note, c.by_user, u.display_name AS by_name, c.created_at
         FROM invoice_contacts c LEFT JOIN users u ON u.id = c.by_user
        WHERE c.invoice_id = ? ORDER BY c.date DESC, c.id DESC`
    )
    .all(id)
    .map((r) => ({ id: r.id, date: r.date, note: r.note, by: r.by_user == null ? null : { id: r.by_user, name: r.by_name || null }, createdAt: r.created_at }));
}

// ------------------------------------------------------------ settings ---

function overview(db) {
  return {
    defaultDays: defaultDays(db),
    clients: db
      .prepare("SELECT client_name, followup_days, updated_at FROM client_terms ORDER BY client_name COLLATE NOCASE")
      .all()
      .map((r) => ({ clientName: r.client_name, followUpDays: Number(r.followup_days), updatedAt: r.updated_at })),
  };
}

function setDefault(db, req, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const d = days(b.days, "days");
  settings.set(db, DEFAULT_KEY, String(d), req);
  return overview(db);
}

// {clientName, followUpDays | null}: null removes the client's terms.
function setClient(db, req, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const name = typeof b.clientName === "string" ? b.clientName.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 200) throw bad("Give the client's name");
  const k = clientKey(name);
  const d = b.followUpDays === null ? null : days(b.followUpDays, "followUpDays");
  db.transaction(() => {
    const was = db.prepare("SELECT followup_days FROM client_terms WHERE client_key = ?").get(k);
    if (d === null) {
      if (!was) return;
      db.prepare("DELETE FROM client_terms WHERE client_key = ?").run(k);
    } else {
      db.prepare(
        `INSERT INTO client_terms (client_key, client_name, followup_days, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(client_key) DO UPDATE SET client_name = excluded.client_name, followup_days = excluded.followup_days,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      ).run(k, name, d, userId(req), nowIso());
    }
    audit.log(req, {
      action: "client_terms.update",
      entityType: "client_terms",
      entityId: k,
      before: { followUpDays: was ? Number(was.followup_days) : null },
      after: { clientName: name, followUpDays: d },
    });
  })();
  return overview(db);
}

// ------------------------------------------------------------- counts ---

// The overdue invoices that need follow-up today.
function needingFollowUp(db, today = sydneyToday()) {
  const rows = db
    .prepare(
      `SELECT i.*, j.client_name AS client_name FROM invoices i JOIN jobs j ON j.id = i.job_id
        WHERE i.status = 'issued' AND i.due_date IS NOT NULL AND i.due_date < ?`
    )
    .all(today);
  return rows.filter((inv) => needsFollowUp(inv, intervalOf(db, inv, inv.client_name).days, today));
}

// Accounts' Waiting on you counts.
function counts(db, today = sydneyToday()) {
  const toIssue = Number(db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'due'").get().n) || 0;
  const notSent = Number(db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'issued' AND sent_date IS NULL").get().n) || 0;
  return { toIssue, notSent, followUp: needingFollowUp(db, today).length };
}

module.exports = {
  clientKey,
  defaultDays,
  clientDays,
  intervalOf,
  needsFollowUp,
  fieldsFor,
  markSent,
  addContact,
  contacts,
  overview,
  setDefault,
  setClient,
  needingFollowUp,
  counts,
};
