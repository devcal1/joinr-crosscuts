// Stone orders and the benchtop sheet (docs/plans/m12-contracts.md sections 3 and 4): a job's stone
// benchtop orders, each sent revision frozen, the list, the Design/PM summary, the suggestions and
// the benchtop sheet. Wave 1 A.
//
// A stone order is not an order line (Decision 1): nothing here touches lib/orders.js. Every
// function takes db first and nothing here requires ../db. Every write runs in one db.transaction
// with its audit row. The routes declare only the coarse access value (jobs.view / jobs.edit /
// design.view); every rule about stone orders lives here.
//
// The form is stored field by field on stone_orders (the working copy); sending freezes the whole
// form as JSON in stone_order_revisions, so revision n reprints exactly as it was sent. A sent
// order that is edited stays "sent" and reads changedSinceSent until it is sent again.
const audit = require("./audit");
const settings = require("./settings");
const { bad, notFound, conflict, HttpError } = require("./httperror");
const { DATE_RE, sydneyToday, addDays, parseDateUTC, formatDateUTC } = require("./time");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LIST_STATUSES = ["open", "cancelled", "all"];
const SUGGESTIONS_MAX = 50;
const BENCHTOP_TEXT_MAX = 200;
const SOON_DAYS = 13; // installsSoon: today to today + 13 (two weeks)

// Section 3, in order: the order of form_json, the page and the print.
const FORM = [
  { key: "supplier", col: "supplier", kind: "text", max: 200, label: "Supplier", needed: true },
  { key: "jobReference", col: "job_reference", kind: "text", max: 200, label: "Job reference" },
  { key: "quoteNumber", col: "quote_number", kind: "text", max: 100, label: "Quote number" },
  { key: "siteAddress", col: "site_address", kind: "text", max: 300, label: "Site address" },
  { key: "siteAccess", col: "site_access", kind: "text", max: 1000, label: "Site access" },
  { key: "clientName", col: "client_name", kind: "text", max: 200, label: "Client" },
  { key: "clientPhone", col: "client_phone", kind: "text", max: 100, label: "Client phone" },
  { key: "ourContact", col: "our_contact", kind: "text", max: 200, label: "Our contact" },
  { key: "ourPhone", col: "our_phone", kind: "text", max: 100, label: "Our phone" },
  { key: "brand", col: "brand", kind: "text", max: 200, label: "Stone brand", needed: true },
  { key: "colour", col: "colour", kind: "text", max: 200, label: "Colour", needed: true },
  { key: "edgeHeight", col: "edge_height", kind: "text", max: 50, label: "Edge height", needed: true },
  { key: "edgeProfile", col: "edge_profile", kind: "text", max: 100, label: "Edge profile", needed: true },
  { key: "cabinetryInstallDate", col: "cabinetry_install_date", kind: "date", label: "Cabinetry install" },
  { key: "measureDate", col: "measure_date", kind: "date", label: "Measure / template" },
  { key: "requestedInstallDate", col: "requested_install_date", kind: "date", label: "Requested benchtop install", needed: true },
  { key: "notes", col: "notes", kind: "text", max: 4000, label: "Notes" },
];
const FIELD = new Map(FORM.map((f) => [f.key, f]));

// ---------------------------------------------------------------- helpers ---

function nowIso() {
  return new Date().toISOString();
}

function userId(req) {
  return req && req.user && req.user.id != null ? req.user.id : null;
}

function person(id, name) {
  return id == null ? null : { id, name: name || null };
}

function validDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && formatDateUTC(parseDateUTC(s)) === s;
}

// "2026-10-03" -> "3 Oct 2026".
function dayLabel(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

// A 400 that also names the form keys it is about, so the page can mark them.
function fieldError(message, keys) {
  return new HttpError(400, message, { fields: keys });
}

// A stored or frozen value as the form holds it: text is a string ('' when missing), a date is a
// YYYY-MM-DD string or null.
function storedValue(f, v) {
  if (f.kind === "date") return typeof v === "string" && v !== "" ? v : null;
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// One body value, validated and normalised as stored (section 3).
function inputValue(f, v) {
  if (f.kind === "date") {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" && v.trim() === "") return null;
    if (typeof v !== "string" || !validDate(v.trim())) throw fieldError(`${f.label} must be a date`, [f.key]);
    return v.trim();
  }
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") throw fieldError(`${f.label} must be text`, [f.key]);
  const s = v.trim();
  if (s.length > f.max) throw fieldError(`${f.label} must be ${f.max} characters or fewer`, [f.key]);
  return s;
}

// The keys present in a body, validated: {key: value}. Unknown keys are refused.
function formInput(body) {
  const out = {};
  for (const k of Object.keys(body)) {
    if (!FIELD.has(k)) throw bad(`Unknown field: ${k}`);
  }
  for (const f of FORM) {
    if (Object.prototype.hasOwnProperty.call(body, f.key)) out[f.key] = inputValue(f, body[f.key]);
  }
  return out;
}

// The first max UTF-16 units of s (lengths count as the browser's maxlength does), never ending
// on the first half of a surrogate pair.
function cut(s, max) {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

// A prefill value cut to fit (the job's own columns have no length limit of their own).
function fit(f, v) {
  if (f.kind === "date") return validDate(v) ? v : null;
  return typeof v === "string" ? cut(v.trim(), f.max) : "";
}

// A body with no keys allowed (cancel and restore): any key is refused.
function noFields(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  for (const k of Object.keys(b)) throw bad(`Unknown field: ${k}`);
}

function formOfRow(row) {
  const form = {};
  for (const f of FORM) form[f.key] = storedValue(f, row[f.col]);
  return form;
}

// A frozen form_json as a section 3 form (keys missing from an older revision read as empty).
function formOfJson(json) {
  const p = parseJson(json);
  const src = p && typeof p === "object" && !Array.isArray(p) ? p : {};
  const form = {};
  for (const f of FORM) form[f.key] = storedValue(f, src[f.key]);
  return form;
}

function sameForm(a, b) {
  return FORM.every((f) => a[f.key] === b[f.key]);
}

// --- reading -----------------------------------------------------------------------------------

function jobRow(db, jobId) {
  return db
    .prepare(
      `SELECT id, name, archived, benchtop, quote_number, site_address, client_name, client_phone, promised_install_date
       FROM jobs WHERE id = ?`
    )
    .get(jobId);
}

function jobOr404(db, jobId) {
  const job = jobRow(db, jobId);
  if (!job) throw notFound();
  return job;
}

const ORDER_SQL = `SELECT so.*, j.name AS job_name, j.archived AS job_archived,
    uc.display_name AS created_by_name, uu.display_name AS updated_by_name, ux.display_name AS cancelled_by_name,
    r.form_json AS rev_form_json, r.sent_date AS rev_sent_date, r.sent_by AS rev_sent_by, us.display_name AS rev_sent_by_name
  FROM stone_orders so
  JOIN jobs j ON j.id = so.job_id
  LEFT JOIN users uc ON uc.id = so.created_by
  LEFT JOIN users uu ON uu.id = so.updated_by
  LEFT JOIN users ux ON ux.id = so.cancelled_by
  LEFT JOIN stone_order_revisions r ON r.stone_order_id = so.id AND r.revision = so.revision
  LEFT JOIN users us ON us.id = r.sent_by`;

function orderRow(db, id) {
  return db.prepare(`${ORDER_SQL} WHERE so.id = ?`).get(id);
}

function orderRowOr404(db, id) {
  const row = orderRow(db, id);
  if (!row) throw notFound();
  return row;
}

// Section 4.1, without revisions.
function toOrder(row) {
  const form = formOfRow(row);
  const revision = Number(row.revision) || 0;
  const sent = revision > 0 && row.rev_form_json != null;
  return {
    id: row.id,
    jobId: row.job_id,
    jobName: row.job_name,
    jobArchived: Number(row.job_archived) !== 0,
    status: row.status,
    revision,
    changedSinceSent: sent ? !sameForm(form, formOfJson(row.rev_form_json)) : false,
    sentDate: sent ? row.rev_sent_date : null,
    sentBy: sent ? person(row.rev_sent_by, row.rev_sent_by_name) : null,
    form,
    createdAt: row.created_at,
    createdBy: person(row.created_by, row.created_by_name),
    updatedAt: row.updated_at,
    updatedBy: person(row.updated_by, row.updated_by_name),
    cancelledAt: row.cancelled_at || null,
    cancelledBy: person(row.cancelled_by, row.cancelled_by_name),
  };
}

function revisionsOf(db, orderId) {
  return db
    .prepare(
      `SELECT r.revision, r.sent_date, r.sent_at, r.sent_by, u.display_name AS sent_by_name
       FROM stone_order_revisions r LEFT JOIN users u ON u.id = r.sent_by
       WHERE r.stone_order_id = ? ORDER BY r.revision`
    )
    .all(orderId)
    .map((r) => ({ revision: r.revision, sentDate: r.sent_date, sentAt: r.sent_at, sentBy: person(r.sent_by, r.sent_by_name) }));
}

function withRevisions(db, row) {
  return { ...toOrder(row), revisions: revisionsOf(db, row.id) };
}

function fullOrder(db, id) {
  return withRevisions(db, orderRowOr404(db, id));
}

// --- the prefill and the benchtop text (section 4.5) -------------------------------------------

function prefillFor(db, req, job) {
  const user = req && req.user ? req.user : {};
  const business = settings.business(db);
  const from = {
    jobReference: job.name,
    quoteNumber: job.quote_number,
    siteAddress: job.site_address,
    clientName: job.client_name,
    clientPhone: job.client_phone,
    ourContact: user.displayName,
    ourPhone: business.phone,
    cabinetryInstallDate: job.promised_install_date,
  };
  const form = {};
  for (const f of FORM) form[f.key] = Object.prototype.hasOwnProperty.call(from, f.key) ? fit(f, from[f.key]) : storedValue(f, null);
  return form;
}

function benchtopText(db, jobId) {
  const row = db
    .prepare(
      `SELECT payload FROM joinr_intake WHERE job_id = ? AND state IN ('accepted', 'linked')
       ORDER BY last_seen_at DESC, id DESC LIMIT 1`
    )
    .get(jobId);
  if (!row) return [];
  const p = parseJson(row.payload);
  const raw = p && typeof p === "object" && !Array.isArray(p) ? p.raw : null;
  const list = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.benchtops : null;
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const v of list) {
    if (typeof v !== "string") continue;
    const s = cut(v.trim(), BENCHTOP_TEXT_MAX);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function forJob(db, req, jobId) {
  const job = jobOr404(db, jobId);
  const rows = db.prepare(`${ORDER_SQL} WHERE so.job_id = ? ORDER BY CASE WHEN so.status = 'cancelled' THEN 1 ELSE 0 END, so.id`).all(jobId);
  return {
    job: { id: job.id, name: job.name, archived: Number(job.archived) !== 0, benchtop: job.benchtop || null },
    orders: rows.map((r) => withRevisions(db, r)),
    prefill: prefillFor(db, req, job),
    benchtopText: benchtopText(db, jobId),
  };
}

function benchtopSheet(db, req, jobId) {
  const job = jobOr404(db, jobId);
  const s = (v) => (v == null ? null : String(v));
  return {
    job: { id: job.id, name: job.name, clientName: s(job.client_name), siteAddress: s(job.site_address), quoteNumber: s(job.quote_number) },
    benchtopText: benchtopText(db, jobId),
  };
}

// --- one stone order ---------------------------------------------------------------------------

function notArchived(job) {
  if (Number(job.archived) !== 0) throw conflict("The job is archived");
}

// An order that may be edited or sent: not cancelled, its job not archived.
function editable(row) {
  if (row.status === "cancelled") throw conflict("This stone order is cancelled");
  if (Number(row.job_archived) !== 0) throw conflict("The job is archived");
}

function create(db, req, jobId, body) {
  return db.transaction(() => {
    const job = jobOr404(db, jobId);
    notArchived(job);
    const input = formInput(body);
    const form = { ...prefillFor(db, req, job), ...input };
    const now = nowIso();
    const uid = userId(req);
    const cols = FORM.map((f) => f.col);
    const info = db
      .prepare(
        `INSERT INTO stone_orders (job_id, status, revision, ${cols.join(", ")}, created_at, created_by, updated_at, updated_by)
         VALUES (?, 'draft', 0, ${cols.map(() => "?").join(", ")}, ?, ?, ?, ?)`
      )
      .run(jobId, ...FORM.map((f) => form[f.key]), now, uid, now, uid);
    const id = Number(info.lastInsertRowid);
    audit.log(req, { action: "stone.create", entityType: "stone_order", entityId: id, after: form });
    return fullOrder(db, id);
  })();
}

function get(db, req, id) {
  return fullOrder(db, id);
}

function update(db, req, id, body) {
  return db.transaction(() => {
    const row = orderRowOr404(db, id);
    editable(row);
    const input = formInput(body);
    const current = formOfRow(row);
    const changed = FORM.filter((f) => Object.prototype.hasOwnProperty.call(input, f.key) && input[f.key] !== current[f.key]);
    if (!changed.length) return withRevisions(db, row);
    db.prepare(
      `UPDATE stone_orders SET ${changed.map((f) => `${f.col} = ?`).join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`
    ).run(...changed.map((f) => input[f.key]), nowIso(), userId(req), id);
    const before = {};
    const after = {};
    for (const f of changed) {
      before[f.key] = current[f.key];
      after[f.key] = input[f.key];
    }
    audit.log(req, { action: "stone.update", entityType: "stone_order", entityId: id, before, after });
    return fullOrder(db, id);
  })();
}

const SEND_KEYS = ["sentDate", "expectUpdatedAt"];

// A send body's shape (section 4.3): {sentDate?, expectUpdatedAt?}, expectUpdatedAt text.
function sendBody(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  for (const k of Object.keys(b)) {
    if (!SEND_KEYS.includes(k)) throw bad(`Unknown field: ${k}`);
  }
  if (Object.prototype.hasOwnProperty.call(b, "expectUpdatedAt") && typeof b.expectUpdatedAt !== "string") {
    throw bad("expectUpdatedAt must be text");
  }
  return b;
}

// The sent date of a send body: a YYYY-MM-DD string, or null for today.
function sentDateInput(b) {
  const v = b.sentDate;
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  if (typeof v !== "string" || !validDate(v.trim())) throw fieldError("Sent date must be a date", ["sentDate"]);
  return v.trim();
}

// Check order (section 4.3): 404; 409 cancelled or archived; 400 the body's shape; 409 a stale
// copy; 400 the date rules and missing fields; 409 nothing changed.
function send(db, req, id, body) {
  return db.transaction(() => {
    const row = orderRowOr404(db, id);
    editable(row);
    const b = sendBody(body);
    if (b.expectUpdatedAt !== undefined && b.expectUpdatedAt !== row.updated_at) {
      throw conflict("This stone order was changed by someone else");
    }
    const sentDate = sentDateInput(b);
    const today = sydneyToday();
    const date = sentDate || today;
    if (date > today) throw fieldError("The sent date can't be in the future", ["sentDate"]);
    const n = Number(row.revision) || 0;
    if (n === 0) {
      // §12.16: the first send is not before the order was started (created_at as a Sydney date).
      const started = sydneyToday(new Date(row.created_at));
      if (date < started) throw fieldError(`The sent date can't be before the order was started (${dayLabel(started)})`, ["sentDate"]);
    }
    if (n > 0 && row.rev_sent_date && date < row.rev_sent_date) {
      throw fieldError(`The sent date can't be before revision ${n} (${dayLabel(row.rev_sent_date)})`, ["sentDate"]);
    }
    const form = formOfRow(row);
    const missing = FORM.filter((f) => f.needed && (f.kind === "date" ? form[f.key] === null : form[f.key] === ""));
    if (missing.length) {
      throw fieldError(`Fill in before sending: ${missing.map((f) => f.label).join(", ")}`, missing.map((f) => f.key));
    }
    if (n > 0 && row.rev_form_json != null && sameForm(form, formOfJson(row.rev_form_json))) {
      throw conflict(`Nothing has changed since revision ${n} was sent`);
    }
    const now = nowIso();
    const uid = userId(req);
    db.prepare(
      `INSERT INTO stone_order_revisions (stone_order_id, revision, form_json, sent_date, sent_at, sent_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, n + 1, JSON.stringify(form), date, now, uid);
    db.prepare("UPDATE stone_orders SET status = 'sent', revision = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(n + 1, now, uid, id);
    audit.log(req, { action: "stone.send", entityType: "stone_order", entityId: id, after: { revision: n + 1, sentDate: date } });
    return fullOrder(db, id);
  })();
}

function cancel(db, req, id, body = {}) {
  return db.transaction(() => {
    const row = orderRowOr404(db, id);
    if (row.status === "cancelled") throw conflict("This stone order is already cancelled");
    noFields(body);
    const now = nowIso();
    const uid = userId(req);
    db.prepare(
      "UPDATE stone_orders SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, updated_at = ?, updated_by = ? WHERE id = ?"
    ).run(now, uid, now, uid, id);
    audit.log(req, { action: "stone.cancel", entityType: "stone_order", entityId: id, before: { status: row.status }, after: { status: "cancelled" } });
    return fullOrder(db, id);
  })();
}

function restore(db, req, id, body = {}) {
  return db.transaction(() => {
    const row = orderRowOr404(db, id);
    if (row.status !== "cancelled") throw conflict("Only a cancelled stone order can be restored");
    if (Number(row.job_archived) !== 0) throw conflict("The job is archived");
    noFields(body);
    const status = (Number(row.revision) || 0) >= 1 ? "sent" : "draft";
    const now = nowIso();
    db.prepare(
      "UPDATE stone_orders SET status = ?, cancelled_at = NULL, cancelled_by = NULL, updated_at = ?, updated_by = ? WHERE id = ?"
    ).run(status, now, userId(req), id);
    audit.log(req, { action: "stone.restore", entityType: "stone_order", entityId: id, before: { status: "cancelled" }, after: { status } });
    return fullOrder(db, id);
  })();
}

function revision(db, req, id, rev) {
  const row = orderRowOr404(db, id);
  const r = db
    .prepare(
      `SELECT r.revision, r.form_json, r.sent_date, r.sent_at, r.sent_by, u.display_name AS sent_by_name
       FROM stone_order_revisions r LEFT JOIN users u ON u.id = r.sent_by
       WHERE r.stone_order_id = ? AND r.revision = ?`
    )
    .get(id, rev);
  if (!r) throw notFound();
  return {
    orderId: row.id,
    jobId: row.job_id,
    jobName: row.job_name,
    status: row.status,
    revision: r.revision,
    sentDate: r.sent_date,
    sentAt: r.sent_at,
    sentBy: person(r.sent_by, r.sent_by_name),
    form: formOfJson(r.form_json),
  };
}

// --- the list, summary and suggestions (sections 4.4 and 4.6) ----------------------------------

const OPEN_WHERE = "so.status IN ('draft', 'sent') AND j.archived = 0";

// The form keys left out of the list for a caller without jobs.view (section 4.4, §12.18).
const CLIENT_KEYS = ["clientName", "clientPhone", "siteAddress", "siteAccess"];

function list(db, { status = "open", withClient = true } = {}) {
  if (!LIST_STATUSES.includes(status)) throw bad(`status must be one of ${LIST_STATUSES.join(", ")}`);
  const where = status === "open" ? `WHERE ${OPEN_WHERE}` : status === "cancelled" ? "WHERE so.status = 'cancelled'" : "";
  const orders = db
    .prepare(`${ORDER_SQL} ${where} ORDER BY so.requested_install_date IS NULL, so.requested_install_date, so.id`)
    .all()
    .map(toOrder);
  if (!withClient) {
    for (const o of orders) for (const k of CLIENT_KEYS) delete o.form[k];
  }
  return orders;
}

function summary(db, today = sydneyToday()) {
  const until = addDays(today, SOON_DAYS);
  let drafts = 0;
  let changed = 0;
  let installsSoon = 0;
  for (const row of db.prepare(`${ORDER_SQL} WHERE ${OPEN_WHERE}`).all()) {
    const o = toOrder(row);
    if (o.status === "draft") drafts++;
    else if (o.changedSinceSent) changed++;
    // §12.21: installsSoon counts only orders still needing sending (draft, or changed since sent).
    const needsSending = o.status === "draft" || o.changedSinceSent;
    const d = o.form.requestedInstallDate;
    if (needsSending && d && d >= today && d <= until) installsSoon++;
  }
  return { date: today, drafts, changed, installsSoon };
}

// The distinct non-empty values of one column, case-blind, the most recently updated spelling,
// most recent first.
function distinctRecent(db, col) {
  const rows = db.prepare(`SELECT ${col} AS v FROM stone_orders WHERE ${col} <> '' ORDER BY updated_at DESC, id DESC`).all();
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const k = String(r.v).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r.v);
    if (out.length >= SUGGESTIONS_MAX) break;
  }
  return out;
}

function suggestions(db) {
  return { suppliers: distinctRecent(db, "supplier"), brands: distinctRecent(db, "brand") };
}

module.exports = {
  forJob,
  create,
  get,
  update,
  send,
  cancel,
  restore,
  revision,
  list,
  summary,
  suggestions,
  benchtopSheet,
  benchtopText,
};
