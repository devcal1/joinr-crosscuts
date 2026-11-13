// Overdue invoice reminder emails (0.2.19, docs/plans/invoice-reminders-plan.md).
//
// Three reminders (default 7, 14 and 30 days overdue) go to the client of a sent, overdue invoice, with
// the invoice PDF attached again and a BCC to a preset address. One setting, three modes:
//   off       nothing is prepared or sent automatically (manual "Send reminder" still works);
//   approval  each weekday from the set hour the due steps are prepared in a queue and a person sends them;
//   auto      the same queue, sent by the server itself.
//
// invoice_reminders holds one row per invoice per step; UNIQUE (invoice_id, step) plus the claim
// (queued -> sending only while still queued) plus a fixed Idempotency-Key make a double send impossible.
// Every function takes db first; ../db is only required in start() (like lib/accountsweep.js).
//
// INVOICE_REMINDERS_DRY_RUN=1 turns every send into a log line: no PDF, no Resend call, no key check.
const crypto = require("crypto");
const audit = require("./audit");
const notify = require("./notify");
const settings = require("./settings");
const followup = require("./followup");
const invoices = require("./invoices");
const resend = require("./resend");
const invoicepdf = require("./invoicepdf");
const invoiceemail = require("./invoiceemail");
const { bad, conflict, notFound, HttpError } = require("./httperror");
const { sydneyParts, sydneyToday, parseDateUTC, addDays } = require("./time");

const K = {
  mode: "invoices.reminders_mode",
  days: "invoices.reminder_days",
  hour: "invoices.reminder_hour",
  bcc: "invoices.reminder_bcc",
  templates: "invoices.reminder_templates",
  lastRun: "invoices.reminders_last_run",
  onSince: "invoices.reminders_on_since",
};
const MODES = ["off", "approval", "auto"];
const DEFAULT_DAYS = [7, 14, 30];
const PLACEHOLDERS = ["client", "number", "job", "amount", "due", "days", "phone", "from"];
const CHECK_MS = 60 * 1000;
const MAX_TRIES = 3;
const MAX_PER_RUN = 20;
const SENDING_MAX_AGE_MS = 20 * 60 * 60 * 1000; // Resend remembers an Idempotency-Key for 24 hours
const SYSTEM = { actorLabel: "automatic reminders", user: null, ip: null };
const DONE_STATES = ["sent", "queued", "sending", "failed", "skipped", "dry"]; // a cancelled step can be prepared again
const RECENT_DAYS = 30;
const LINK = "/accounts.html?view=overdue";

const inflight = new Set(); // reminder ids being sent by this process right now
const manualRepeat = new Set(); // invoice ids with an extra (row-less) manual reminder under way

function nowIso() {
  return new Date().toISOString();
}
function userId(req) {
  return req && req.user ? req.user.id : null;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function isDry() {
  return process.env.INVOICE_REMINDERS_DRY_RUN === "1";
}
function idemKey(invoiceId, step) {
  return `crosscuts-reminder-${invoiceId}-${step}`;
}
function plain(b) {
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}
function daysBetween(from, to) {
  return Math.round((parseDateUTC(to) - parseDateUTC(from)) / 86400000);
}
// A step that falls on a weekend goes out on Monday.
function weekdayOnOrAfter(date) {
  const dow = parseDateUTC(date).getUTCDay();
  return dow === 6 ? addDays(date, 2) : dow === 0 ? addDays(date, 1) : date;
}
function validDate(s) {
  return invoices.validDate(s);
}

// --- the wording -----------------------------------------------------------------------------------

// The built-in messages (docs/plans/mockups/invoice-reminders-email.html): each gets firmer.
const DEFAULT_TEMPLATES = [
  {
    subject: "Reminder: invoice {number} is overdue",
    body:
      "Hi {client},\n\n" +
      "Just a friendly reminder that invoice {number} for {job}, {amount}, was due on {due} and hasn't been paid yet. " +
      "The invoice is attached again, with our bank details on it.\n\n" +
      "If you've already paid, thank you, and please ignore this email.\n\n" +
      "Thank you,\n{from}",
  },
  {
    subject: "Reminder: invoice {number} is now {days} days overdue",
    body:
      "Hi {client},\n\n" +
      "Invoice {number} for {job}, {amount}, was due on {due} and is now {days} days overdue. " +
      "Could you please arrange payment, or reply to let us know when to expect it?\n\n" +
      "The invoice is attached again, with our bank details on it. If you've already paid, thank you, and please ignore this email.\n\n" +
      "Thank you,\n{from}",
  },
  {
    subject: "Second reminder: invoice {number} is {days} days overdue",
    body:
      "Hi {client},\n\n" +
      "Invoice {number} for {job}, {amount}, is now {days} days overdue (it was due on {due}). " +
      "Please arrange payment this week, or call us on {phone} to talk about it.\n\n" +
      "The invoice is attached again. If you've already paid, thank you, and please let us know so we can update our records.\n\n" +
      "Thank you,\n{from}",
  },
];

// Throws 400 on any {placeholder} that isn't one of the eight.
function checkPlaceholders(text, label) {
  for (const m of String(text).matchAll(/\{([^{}]*)\}/g)) {
    if (!PLACEHOLDERS.includes(m[1])) {
      throw bad(`${label}: {${m[1].slice(0, 30)}} isn't a known placeholder. Use ${PLACEHOLDERS.map((p) => "{" + p + "}").join(", ")}.`);
    }
  }
}

// Fills a template. A blank job, phone or client drops its little phrase instead of leaving a gap.
function fill(text, vars) {
  let t = String(text);
  if (!vars.job) t = t.replace(/\s+for \{job\}/g, "");
  if (!vars.phone) t = t.replace(/\s+on \{phone\}/g, "");
  if (!vars.client) t = t.replace(/Hi \{client\},/g, "Hi,");
  if (String(vars.days) === "1") t = t.replace(/\{days\} days/g, "1 day");
  return t.replace(/\{([^{}]*)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
}

// --- settings --------------------------------------------------------------------------------------

function parseDays(v) {
  let list = v;
  if (typeof v === "string") list = v.split(/[,;\s]+/).filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : NaN));
  if (!Array.isArray(list) || list.length < 1 || list.length > 3) throw bad("Reminder days: give one to three whole numbers, like 7, 14, 30");
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (!Number.isInteger(n) || n < 1 || n > 120) throw bad("Reminder days must be whole numbers from 1 to 120");
    if (i > 0 && n <= list[i - 1]) throw bad("Reminder days must get larger each time, like 7, 14, 30");
  }
  return list.slice();
}

function parseHour(v) {
  const n = typeof v === "string" && /^\d{1,2}$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isInteger(n) || n < 0 || n > 23) throw bad("The send hour must be a whole number from 0 to 23");
  return n;
}

function parseBcc(v) {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") throw bad("The BCC address must be text");
  const s = v.trim();
  if (!s) return "";
  if (!invoiceemail.validAddress(s)) throw bad("The BCC must be one valid email address, or blank for no BCC");
  return s;
}

function parseTemplates(v) {
  if (v === null || v === "") return null;
  if (!Array.isArray(v) || v.length !== 3) throw bad("The wording needs three messages (reminder 1, 2 and 3)");
  return v.map((t, i) => {
    const label = `Reminder ${i + 1}`;
    t = plain(t);
    if (typeof t.subject !== "string" || !t.subject.trim()) throw bad(`${label}: the subject can't be empty`);
    if (/[\r\n]/.test(t.subject)) throw bad(`${label}: the subject must be one line`);
    if (t.subject.length > invoiceemail.SUBJECT_MAX) throw bad(`${label}: the subject is too long`);
    if (typeof t.body !== "string" || !t.body.trim()) throw bad(`${label}: the message can't be empty`);
    if (t.body.length > invoiceemail.BODY_MAX) throw bad(`${label}: the message is too long`);
    checkPlaceholders(t.subject, `${label} subject`);
    checkPlaceholders(t.body, `${label} message`);
    return { subject: t.subject.trim(), body: t.body.replace(/\r\n/g, "\n") };
  });
}

function readDays(db) {
  try {
    return parseDays(settings.get(db, K.days));
  } catch {
    return DEFAULT_DAYS.slice();
  }
}

function readTemplates(db) {
  let stored = null;
  try {
    stored = JSON.parse(settings.get(db, K.templates));
  } catch {
    stored = null;
  }
  const ok = (t) => t && typeof t.subject === "string" && t.subject && typeof t.body === "string" && t.body;
  return {
    custom: Array.isArray(stored) && stored.length === 3 && stored.every(ok),
    list: [0, 1, 2].map((i) => (Array.isArray(stored) && ok(stored[i]) ? { subject: stored[i].subject, body: stored[i].body } : { ...DEFAULT_TEMPLATES[i] })),
  };
}

function getSettings(db) {
  const mode = settings.get(db, K.mode);
  const hour = Number(settings.get(db, K.hour));
  const t = readTemplates(db);
  return {
    mode: MODES.includes(mode) ? mode : "off",
    onSince: settings.get(db, K.onSince) || null,
    days: readDays(db),
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 10,
    bcc: (settings.get(db, K.bcc) || "").trim(),
    templates: t.list,
    templatesCustom: t.custom,
    defaultTemplates: DEFAULT_TEMPLATES.map((x) => ({ ...x })),
    placeholders: PLACEHOLDERS.slice(),
    lastRun: settings.get(db, K.lastRun) || null,
  };
}

// Everything is checked before anything is written. {mode?, days?, hour?, bcc?, templates?}.
// Leaving Off stamps the switch-on date (every re-enable resets it); going to Off drops the queue.
function setSettings(db, req, body, { today = sydneyToday() } = {}) {
  const b = plain(body);
  const patch = {};
  if (b.mode !== undefined) {
    if (!MODES.includes(b.mode)) throw bad("mode must be off, approval or auto");
    patch.mode = b.mode;
  }
  if (b.days !== undefined) patch.days = parseDays(b.days);
  if (b.hour !== undefined) patch.hour = parseHour(b.hour);
  if (b.bcc !== undefined) patch.bcc = parseBcc(b.bcc);
  if (b.templates !== undefined) patch.templates = parseTemplates(b.templates);
  db.transaction(() => {
    const before = getSettings(db).mode;
    if (patch.days) settings.set(db, K.days, patch.days.join(","), req);
    if (patch.hour !== undefined) settings.set(db, K.hour, String(patch.hour), req);
    if (patch.bcc !== undefined) settings.set(db, K.bcc, patch.bcc, req);
    if (patch.templates !== undefined) settings.set(db, K.templates, patch.templates ? JSON.stringify(patch.templates) : null, req);
    if (patch.mode !== undefined) {
      settings.set(db, K.mode, patch.mode, req);
      if (before === "off" && patch.mode !== "off") {
        settings.set(db, K.onSince, today, req);
        // the first automatic run is held to the next weekday
        settings.set(db, K.lastRun, today, null, { audit: false });
      }
      if (patch.mode === "off" && before !== "off") cancelQueued(db, req, "reminders switched off");
    }
  })();
  return getSettings(db);
}

function cancelQueued(db, req, why, where = "", args = []) {
  const rows = db.prepare(`SELECT id, invoice_id, step FROM invoice_reminders WHERE state = 'queued' ${where}`).all(...args);
  for (const r of rows) {
    db.prepare("UPDATE invoice_reminders SET state = 'cancelled', note = ?, updated_at = ? WHERE id = ? AND state = 'queued'").run(why, nowIso(), r.id);
    audit.log(req, { action: "invoice.reminder_skipped", entityType: "invoice", entityId: r.invoice_id, after: { step: r.step, reason: why } });
  }
  return rows.length;
}

// --- pauses ----------------------------------------------------------------------------------------

function pauseActive(until, today) {
  return !until || today <= until; // "until Fri 20" still holds on Friday
}

function clientPauseRows(db) {
  return db.prepare("SELECT * FROM client_reminder_pauses").all();
}

function listClientPauses(db) {
  return db
    .prepare("SELECT client_key, client_name, until_date, note, updated_at FROM client_reminder_pauses ORDER BY client_name COLLATE NOCASE")
    .all()
    .map((r) => ({ clientName: r.client_name, until: r.until_date || null, note: r.note || "", updatedAt: r.updated_at }));
}

function untilOf(v, today) {
  if (v === undefined || v === null || v === "") return null;
  if (!validDate(v)) throw bad("until must be a valid YYYY-MM-DD date");
  if (v < today) throw bad("The until date can't be in the past");
  return v;
}

function noteOf(v) {
  if (v !== undefined && v !== null && typeof v !== "string") throw bad("The note must be text");
  const n = (v || "").trim();
  if (n.length > 500) throw bad("The note must be 500 characters or fewer");
  return n;
}

// {paused: true, until?, note?} or {paused: false}. Queued rows of a paused invoice are dropped.
function setInvoicePause(db, req, invoiceId, body, { today = sydneyToday() } = {}) {
  const b = plain(body);
  if (typeof b.paused !== "boolean") throw bad("paused must be true or false");
  const until = b.paused ? untilOf(b.until, today) : null;
  const note = b.paused ? noteOf(b.note) : "";
  db.transaction(() => {
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
    if (!inv) throw notFound();
    if (inv.status !== "issued") throw conflict(`Only an issued invoice can have reminders paused (this one is ${inv.status})`);
    db.prepare("UPDATE invoices SET reminders_paused = ?, reminders_paused_until = ?, reminders_pause_note = ?, updated_at = ? WHERE id = ?").run(
      b.paused ? 1 : 0,
      until,
      b.paused ? note : null,
      nowIso(),
      invoiceId
    );
    audit.log(req, {
      action: b.paused ? "invoice.reminders_paused" : "invoice.reminders_resumed",
      entityType: "invoice",
      entityId: invoiceId,
      before: { paused: !!inv.reminders_paused, until: inv.reminders_paused_until || null },
      after: { paused: b.paused, until, note },
    });
    if (b.paused) cancelQueued(db, req, "paused", "AND invoice_id = ?", [invoiceId]);
  })();
  return overviewFor(db, db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId), { today });
}

// {clientName, paused: true, until?, note?} or {clientName, paused: false}. Returns the paused list.
function setClientPause(db, req, body, { today = sydneyToday() } = {}) {
  const b = plain(body);
  const name = typeof b.clientName === "string" ? b.clientName.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 200) throw bad("Give the client's name");
  if (typeof b.paused !== "boolean") throw bad("paused must be true or false");
  const key = followup.clientKey(name);
  if (!key) throw bad("Give the client's name");
  const until = b.paused ? untilOf(b.until, today) : null;
  const note = b.paused ? noteOf(b.note) : "";
  db.transaction(() => {
    const was = db.prepare("SELECT * FROM client_reminder_pauses WHERE client_key = ?").get(key);
    if (b.paused) {
      db.prepare(
        `INSERT INTO client_reminder_pauses (client_key, client_name, until_date, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_key) DO UPDATE SET client_name = excluded.client_name, until_date = excluded.until_date, note = excluded.note,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      ).run(key, name, until, note, userId(req), nowIso());
      // drop what is already queued for this client's invoices
      const queued = db
        .prepare(
          `SELECT r.id, r.invoice_id, j.client_name FROM invoice_reminders r JOIN invoices i ON i.id = r.invoice_id
             JOIN jobs j ON j.id = i.job_id WHERE r.state = 'queued'`
        )
        .all()
        .filter((r) => followup.clientKey(r.client_name) === key);
      for (const r of queued) cancelQueued(db, req, "client paused", "AND id = ?", [r.id]);
    } else if (was) {
      db.prepare("DELETE FROM client_reminder_pauses WHERE client_key = ?").run(key);
    }
    audit.log(req, {
      action: "client_reminder_pause.update",
      entityType: "client_reminder_pause",
      entityId: key,
      before: { paused: !!was, until: was ? was.until_date || null : null },
      after: { clientName: name, paused: b.paused, until },
    });
  })();
  return listClientPauses(db);
}

// --- eligibility -----------------------------------------------------------------------------------

// Shared by a run, so settings and the paused clients are read once.
function makeCtx(db, today = sydneyToday(), cfg = getSettings(db)) {
  const pauses = new Map();
  for (const r of clientPauseRows(db)) pauses.set(r.client_key, r);
  return { today, cfg, pauses };
}

function rowsOf(db, invoiceId) {
  return db.prepare("SELECT * FROM invoice_reminders WHERE invoice_id = ? ORDER BY step").all(invoiceId);
}

// Who the reminder goes to: the job's client email, else the To of the last delivered email.
function recipientsOf(db, inv, job) {
  const email = ((job && job.client_email) || "").trim();
  if (invoiceemail.validAddress(email)) return { to: [email], from: "client" };
  const last = db
    .prepare("SELECT to_addrs FROM invoice_emails WHERE invoice_id = ? AND status = 'delivered' ORDER BY id DESC LIMIT 1")
    .get(inv.id);
  if (last) {
    try {
      const to = invoiceemail.parseAddresses(last.to_addrs, "To");
      if (to.length) return { to, from: "lastEmail" };
    } catch {
      // an old odd address: treat as none
    }
  }
  return { to: [], from: "" };
}

// Everything the rules say about one invoice on `ctx.today`.
//   reason     why the AUTOMATIC queue skips it (null when it would pick it up, or is simply waiting):
//              notIssued, notOverdue, notSent, paused, clientPaused, noEmail, bounced, beforeSwitchOn, allSent
//   manualWhy  why a person can't send one by hand: notIssued, notOverdue, notSent, bounced, else null
// The switch-on rule (due date on or after reminders_on_since) is the automatic queue's only.
function evaluate(db, inv, ctx, job) {
  const { today, cfg } = ctx;
  job = job || invoices.getJob(db, inv.job_id) || {};
  const issued = inv.status === "issued";
  const overdue = invoices.isOverdue(inv, today);
  const daysOverdue = overdue ? daysBetween(inv.due_date, today) : 0;
  const stepCount = cfg.days.length;
  const rows = rowsOf(db, inv.id);
  const byStep = new Map(rows.map((r) => [r.step, r]));
  const done = (s) => {
    const r = byStep.get(s);
    return !!r && DONE_STATES.includes(r.state);
  };
  let dueStep = null;
  let nextStep = null;
  for (let s = 1; s <= stepCount; s++) {
    if (done(s)) continue;
    if (nextStep === null) nextStep = s;
    if (overdue && cfg.days[s - 1] <= daysOverdue) dueStep = s; // the highest step reached
  }
  if (dueStep !== null) nextStep = dueStep;
  const allDone = nextStep === null && dueStep === null;
  const nextDate = nextStep && inv.due_date ? weekdayOnOrAfter(addDays(inv.due_date, cfg.days[nextStep - 1])) : null;
  const rec = recipientsOf(db, inv, job);
  const alert = issued ? invoiceemail.alertOf(invoiceemail.history(db, inv.id)) : null;
  const invPaused = !!inv.reminders_paused && pauseActive(inv.reminders_paused_until, today);
  const cp = ctx.pauses.get(followup.clientKey(job.client_name));
  const clientPaused = !!cp && pauseActive(cp.until_date, today);
  const beforeSwitchOn = !!(cfg.onSince && inv.due_date && inv.due_date < cfg.onSince);
  const notSent = issued && !inv.sent_date;
  let reason = null;
  if (!issued) reason = "notIssued";
  else if (!overdue) reason = "notOverdue";
  else if (notSent) reason = "notSent";
  else if (invPaused) reason = "paused";
  else if (clientPaused) reason = "clientPaused";
  else if (!rec.to.length) reason = "noEmail";
  else if (alert) reason = "bounced";
  else if (beforeSwitchOn) reason = "beforeSwitchOn";
  else if (allDone) reason = "allSent";
  let manualWhy = null;
  if (!issued) manualWhy = "notIssued";
  else if (!overdue) manualWhy = "notOverdue";
  else if (notSent) manualWhy = "notSent";
  else if (alert) manualWhy = "bounced";
  return {
    job,
    daysOverdue,
    reason,
    manualWhy,
    dueStep,
    nextStep,
    nextDate,
    rows,
    byStep,
    to: rec.to,
    toFrom: rec.from,
    paused: invPaused,
    clientPaused,
    beforeSwitchOn,
    noEmail: issued && overdue && !notSent && !rec.to.length,
    notSent,
    bounced: !!alert,
  };
}

// The words the dialog and the email use for each invoice's step.
function messageFor(db, inv, ev, step, cfg) {
  const job = ev.job || {};
  const total = inv.total_cents != null ? inv.total_cents : invoices.sumLines(invoices.linesOf(db, inv, job));
  const from = invoiceemail.fromSetting(db);
  const phone = ((settings.business(db).phone) || "").trim();
  const vars = {
    client: (inv.bill_to_name || job.client_name || "").trim(),
    number: inv.number || "",
    job: (job.name || "").trim(),
    amount: invoices.money(total),
    due: invoiceemail.longDate(inv.due_date),
    days: ev.daysOverdue,
    phone,
    from: from && from.name ? from.name : "TH Cabinets Accounts",
  };
  const t = cfg.templates[Math.min(Math.max(step, 1), 3) - 1];
  return { subject: fill(t.subject, vars).slice(0, invoiceemail.SUBJECT_MAX), body: fill(t.body, vars) };
}

function bccList(db) {
  const s = (settings.get(db, K.bcc) || "").trim();
  if (!s) return [];
  if (!invoiceemail.validAddress(s)) {
    console.error("[invoice-reminders] the BCC setting isn't a valid address; sending without it");
    return [];
  }
  return [s];
}

// --- preparing the queue ---------------------------------------------------------------------------

// Inserts (or revives a cancelled row as) a step in `state`. True when this call made it.
function claimStep(db, invoiceId, step, days, state, note, how) {
  const ins = db
    .prepare(
      `INSERT OR IGNORE INTO invoice_reminders (invoice_id, step, days_overdue, state, idem_key, note, how) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(invoiceId, step, days, state, idemKey(invoiceId, step), note, how || null);
  if (ins.changes) return true;
  const up = db
    .prepare(
      "UPDATE invoice_reminders SET state = ?, days_overdue = ?, note = ?, tries = 0, updated_at = ? WHERE invoice_id = ? AND step = ? AND state = 'cancelled'"
    )
    .run(state, days, note, nowIso(), invoiceId, step);
  return up.changes > 0;
}

// Works out every invoice's due step on `today`. Only the highest due step is queued; lower unsent steps
// are recorded as skipped (caught up). Safe to repeat: UNIQUE (invoice_id, step) allows no duplicates.
// Does nothing when the mode is Off. {today, now, req, how}.
function prepare(db, { today, now = new Date(), req = SYSTEM, how = "auto run" } = {}) {
  const day = today || sydneyToday(now);
  const out = { date: day, queued: 0, skipped: 0, belled: 0 };
  const cfg = getSettings(db);
  if (cfg.mode === "off") return out;
  if (!cfg.onSince) {
    // reminders are on but no switch-on date was ever stamped: nothing already overdue may qualify
    settings.set(db, K.onSince, day, req);
    cfg.onSince = day;
  }
  const ctx = makeCtx(db, day, cfg);
  const candidates = db
    .prepare("SELECT * FROM invoices WHERE status = 'issued' AND sent_date IS NOT NULL AND due_date IS NOT NULL AND due_date < ? ORDER BY id")
    .all(day);
  for (const inv of candidates) {
    db.transaction(() => {
      const ev = evaluate(db, inv, ctx);
      if (ev.reason !== null || !ev.dueStep) return;
      for (let s = 1; s < ev.dueStep; s++) {
        if (ev.byStep.has(s) && DONE_STATES.includes(ev.byStep.get(s).state)) continue;
        if (claimStep(db, inv.id, s, ev.daysOverdue, "skipped", "caught up", null)) {
          out.skipped++;
          audit.log(req, { action: "invoice.reminder_skipped", entityType: "invoice", entityId: inv.id, after: { step: s, reason: "caught up" } });
        }
      }
      if (claimStep(db, inv.id, ev.dueStep, ev.daysOverdue, "queued", null, cfg.mode === "auto" ? "auto" : null)) {
        out.queued++;
        audit.log(req, {
          action: "invoice.reminder_queued",
          entityType: "invoice",
          entityId: inv.id,
          after: { step: ev.dueStep, daysOverdue: ev.daysOverdue, how },
        });
      }
    })();
  }
  if (cfg.mode === "approval" && out.queued > 0) {
    out.belled = notify.toKey(db, "invoices.edit", {
      kind: "invoice.reminders_ready",
      title: `${out.queued} reminder ${out.queued === 1 ? "email is" : "emails are"} ready to send`,
      body: "Overdue invoices have a reminder waiting for approval.",
      link: LINK,
    });
  }
  return out;
}

// --- sending ---------------------------------------------------------------------------------------

function setRow(db, id, fields) {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE invoice_reminders SET ${cols.map((c) => c + " = ?").join(", ")}, updated_at = ? WHERE id = ?`).run(
    ...cols.map((c) => fields[c]),
    nowIso(),
    id
  );
}

function failBell(db, inv, step, error) {
  notify.toKey(db, "invoices.edit", {
    kind: "invoice.reminder_failed",
    title: `Reminder ${step} email failed: ${inv.number || "invoice " + inv.id}`,
    body: error,
    link: `/accounts.html?invoice=${inv.id}`,
    entityType: "invoice",
    entityId: inv.id,
  });
}

// The whole send of one reminder. `row` is its invoice_reminders row (already claimed, state 'sending'), or
// null for an extra manual reminder after every step went (that one is only recorded in invoice_emails).
// Returns {result: 'sent'|'dry'|'cancelled'|'failed'|'retry'|'notConfigured', ...}; never throws.
async function deliver(db, req, p) {
  const { row, inv, step, how, override } = p;
  const rowId = row ? row.id : null;
  const key = p.key || (row ? row.idem_key : idemKey(inv.id, step));
  const today = p.today || sydneyToday();
  const cfg = getSettings(db);
  const drop = (note) => {
    if (rowId) setRow(db, rowId, { state: "cancelled", note });
    audit.log(req, { action: "invoice.reminder_skipped", entityType: "invoice", entityId: inv.id, after: { step, reason: note } });
    return { result: "cancelled", step, note };
  };
  try {
    // Checked again right before sending: paid, voided or paused in the meantime.
    const fresh = db.prepare("SELECT * FROM invoices WHERE id = ?").get(inv.id);
    if (!fresh || fresh.status !== "issued") return drop("no longer issued (paid, waived or void)");
    if (!invoices.isOverdue(fresh, today)) return drop("no longer overdue");
    const ev = evaluate(db, fresh, makeCtx(db, today, cfg));
    if (how !== "manual" && (ev.paused || ev.clientPaused)) return drop("paused");
    let m = override;
    if (!m) {
      if (!ev.to.length) return drop("no email address on file");
      const msg = messageFor(db, fresh, ev, step, cfg);
      m = { to: ev.to, cc: [], subject: msg.subject, body: msg.body };
    }
    const bcc = bccList(db);
    const label = row ? `Reminder ${step}` : "Extra reminder";

    if (isDry()) {
      console.log(`[invoice-reminders] DRY RUN: ${label} for ${fresh.number || "invoice " + fresh.id} would go to ${m.to.join(", ")}: "${m.subject}" (BCC: ${bcc.length ? "set" : "none"})`);
      if (rowId) setRow(db, rowId, { state: "dry", note: "dry run" });
      audit.log(req, {
        action: "invoice.reminder_dry",
        entityType: "invoice",
        entityId: inv.id,
        after: { step, to: m.to.join(", "), subject: m.subject },
      });
      return { result: "dry", step, to: m.to, subject: m.subject };
    }

    if (!resend.keyStatus().configured) {
      if (rowId) setRow(db, rowId, { state: "queued", tries: Math.max((row.tries || 1) - 1, 0), note: "email isn't set up" });
      return { result: "notConfigured", step, error: resend.NOT_SET_UP };
    }
    const from = invoiceemail.fromSetting(db);
    if (!from) {
      if (rowId) setRow(db, rowId, { state: "queued", tries: Math.max((row.tries || 1) - 1, 0), note: "the From address isn't valid" });
      return { result: "notConfigured", step, error: "The From address for invoice emails isn't valid." };
    }

    const transient = (error, status) => {
      const tries = row ? row.tries || 1 : MAX_TRIES;
      if (rowId && tries < MAX_TRIES) {
        setRow(db, rowId, { state: "queued", note: error });
        return { result: "retry", step, error, status };
      }
      return refuse(error, status);
    };
    const refuse = (error, status) => {
      if (rowId) setRow(db, rowId, { state: "failed", note: error });
      audit.log(req, { action: "invoice.reminder_failed", entityType: "invoice", entityId: inv.id, after: { step, error } });
      failBell(db, inv, step, error);
      return { result: "failed", step, error, status };
    };

    let pdf;
    try {
      pdf = await invoicepdf.renderInvoicePdf(db, inv.id);
    } catch (e) {
      const status = e && typeof e.status === "number" ? e.status : 0;
      const msg = `The invoice PDF couldn't be made (${e && e.message ? e.message : "unknown problem"}). Nothing was sent.`;
      console.error("[invoice-reminders] PDF failed:", e && e.message ? e.message : e);
      return status >= 400 && status <= 499 ? refuse(msg, status) : transient(msg, 0);
    }
    const filename = invoicepdf.fileName(fresh);
    let resendId;
    try {
      resendId = await resend.sendEmail(
        { from: from.text, replyTo: from.address, to: m.to, cc: m.cc, bcc, subject: m.subject, text: m.body, attachments: [{ filename, content: pdf }] },
        key
      );
    } catch (e) {
      if (!(e instanceof resend.ResendError)) {
        console.error("[invoice-reminders] send failed:", e && e.message ? e.message : e);
        return transient("The email couldn't be sent.", 0);
      }
      // 4xx other than 429: Resend refused it. Timeouts, network trouble, 429 and 5xx are retried with the same key.
      if (e.status >= 400 && e.status < 500 && e.status !== 429) return refuse(e.message, e.status);
      return transient(e.message, e.status);
    }

    // The email has left. Record it; whatever fails after this must not lose the record.
    const label2 = how === "auto" ? `Automatic reminder ${step}` : `Reminder ${step}`;
    const emailId = db.transaction(() => {
      const id = Number(
        db
          .prepare(
            `INSERT INTO invoice_emails (invoice_id, to_addrs, cc_addrs, subject, body, attachment_name, resend_id, status, sent_by, kind, reminder_step, bcc_addrs)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?, 'reminder', ?, ?)`
          )
          .run(inv.id, m.to.join(", "), m.cc.join(", "), m.subject, m.body, filename, resendId, userId(req), step, bcc.join(", ")).lastInsertRowid
      );
      if (rowId) setRow(db, rowId, { state: "sent", email_id: id, note: null });
      audit.log(req, {
        action: "invoice.reminder_sent",
        entityType: "invoice",
        entityId: inv.id,
        after: { step, how, emailId: id, to: m.to.join(", "), cc: m.cc.join(", "), subject: m.subject, resendId, extra: !row },
      });
      return id;
    })();
    try {
      // A sent reminder counts as contact (resets "needs follow-up").
      const note = row ? `${label2} emailed (${ev.daysOverdue} days overdue)` : `Extra reminder emailed (${ev.daysOverdue} days overdue)`;
      followup.addContact(db, req, inv.id, { note });
    } catch (e) {
      console.error("[invoice-reminders] contact log failed:", e && e.message ? e.message : e);
    }
    return { result: "sent", step, emailId, resendId };
  } catch (e) {
    // A bug or a database problem. The row must not stay 'sending' for no reason we can name.
    console.error("[invoice-reminders] send crashed:", e && e.stack ? e.stack : e);
    return { result: "error", step, error: e && e.message ? e.message : "unexpected problem" };
  }
}

// Claims a queued row and sends it. {how: 'auto'|'approved'|'manual', override: {to[], cc[], subject, body}}.
// A row that is not (or no longer) queued is left alone: {result: 'busy'}.
async function sendOne(db, req, reminderId, { how = "approved", override = null, today = null } = {}) {
  const claim = db
    .prepare(
      "UPDATE invoice_reminders SET state = 'sending', how = ?, acted_by = ?, tries = tries + 1, updated_at = ? WHERE id = ? AND state = 'queued'"
    )
    .run(how, userId(req), nowIso(), reminderId);
  const row = db.prepare("SELECT * FROM invoice_reminders WHERE id = ?").get(reminderId);
  if (!row) throw notFound();
  if (!claim.changes) return { result: "busy", step: row.step, state: row.state };
  return run1(db, req, row, how, override, today);
}

async function run1(db, req, row, how, override, today) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(row.invoice_id);
  inflight.add(row.id);
  try {
    return await deliver(db, req, { row, inv, step: row.step, how, override, today });
  } finally {
    inflight.delete(row.id);
  }
}

// POST /api/invoices/:id/reminders: a person sends the next step now, with the dialog's {to, cc, subject, body}.
// Works in every mode and on invoices that went overdue before the switch-on. Throws HttpError.
async function sendManual(db, req, invoiceId, body, { today = sydneyToday() } = {}) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
  if (!inv) throw notFound();
  const cfg = getSettings(db);
  const ev = evaluate(db, inv, makeCtx(db, today, cfg));
  const why = {
    notIssued: `Only an issued invoice can be reminded (this one is ${inv.status})`,
    notOverdue: "This invoice isn't overdue",
    notSent: "This invoice hasn't been sent yet. Send it first.",
    bounced: "The last email to this client bounced. Fix the address and send the invoice again first.",
  }[ev.manualWhy];
  if (why) throw conflict(why);
  const m = invoiceemail.parseBody(body);
  if (!isDry()) {
    if (!resend.keyStatus().configured) throw conflict(resend.NOT_SET_UP);
    if (!invoiceemail.fromSetting(db)) throw conflict("The From address for invoice emails isn't valid. An administrator needs to fix it.");
  }
  const n = cfg.days.length;
  // The next step still open (no row, or one that was queued, failed or cancelled); else the last step again.
  let step = null;
  for (let s = 1; s <= n; s++) {
    const r = ev.byStep.get(s);
    if (r && r.state === "sending") throw conflict("This reminder is already being sent. Check the email history in a moment.");
    if (step === null && (!r || ["queued", "failed", "cancelled"].includes(r.state))) step = s;
  }
  let out;
  if (step === null) {
    if (manualRepeat.has(invoiceId)) throw conflict("A reminder is already being sent for this invoice.");
    manualRepeat.add(invoiceId);
    try {
      out = await deliver(db, req, {
        row: null,
        inv,
        step: n,
        how: "manual",
        override: m,
        today,
        key: `${idemKey(invoiceId, n)}-${crypto.randomUUID()}`,
      });
    } finally {
      manualRepeat.delete(invoiceId);
    }
  } else {
    const r = ev.byStep.get(step);
    if (!r) {
      const ins = db
        .prepare("INSERT OR IGNORE INTO invoice_reminders (invoice_id, step, days_overdue, state, idem_key) VALUES (?, ?, ?, 'queued', ?)")
        .run(invoiceId, step, ev.daysOverdue, idemKey(invoiceId, step));
      if (!ins.changes) throw conflict("This reminder is already being sent. Check the email history in a moment.");
    } else if (r.state !== "queued") {
      // revive a failed or cancelled row; a repeat after a refusal gets a new key (the text may differ)
      const k = r.tries > 0 ? `${idemKey(invoiceId, step)}-${crypto.randomUUID()}` : r.idem_key;
      db.prepare(
        "UPDATE invoice_reminders SET state = 'queued', days_overdue = ?, idem_key = ?, tries = 0, note = NULL, updated_at = ? WHERE id = ? AND state IN ('failed','cancelled')"
      ).run(ev.daysOverdue, k, nowIso(), r.id);
    }
    const id = db.prepare("SELECT id FROM invoice_reminders WHERE invoice_id = ? AND step = ?").get(invoiceId, step).id;
    out = await sendOne(db, req, id, { how: "manual", override: m, today });
    if (out.result === "busy") throw conflict("This reminder is already being sent. Check the email history in a moment.");
  }
  if (out.result === "sent" || out.result === "dry") {
    const emailRow = out.emailId
      ? db.prepare("SELECT e.*, u.display_name AS by_name FROM invoice_emails e LEFT JOIN users u ON u.id = e.sent_by WHERE e.id = ?").get(out.emailId)
      : null;
    return { step: out.step, dry: out.result === "dry", email: emailRow ? invoiceemail.shape(emailRow) : null };
  }
  if (out.result === "cancelled") throw conflict(`The reminder wasn't sent: ${out.note}.`);
  if (out.result === "notConfigured") throw conflict(out.error);
  const msg = out.error || "The reminder couldn't be sent.";
  throw new HttpError(502, msg + (out.result === "failed" ? " Nothing was sent." : ""));
}

// A row left in 'sending' (the process died mid-send): under 20 hours old it is retried with the same
// Idempotency-Key (Resend then sends it or answers with the email it already sent); older it is failed.
async function recover(db, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const today = sydneyToday(new Date(nowMs));
  const stuck = db.prepare("SELECT * FROM invoice_reminders WHERE state = 'sending' ORDER BY id").all();
  const out = { retried: 0, failed: 0 };
  for (const row of stuck) {
    if (inflight.has(row.id)) continue;
    const age = nowMs - Date.parse(row.updated_at);
    if (age < SENDING_MAX_AGE_MS) {
      db.prepare("UPDATE invoice_reminders SET tries = tries + 1, updated_at = ? WHERE id = ? AND state = 'sending'").run(nowIso(), row.id);
      const fresh = db.prepare("SELECT * FROM invoice_reminders WHERE id = ?").get(row.id);
      out.retried++;
      await run1(db, SYSTEM, fresh, row.how || "auto", null, today);
    } else {
      const msg = "Crosscuts restarted while sending; check with the client before sending again";
      const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(row.invoice_id);
      db.prepare("UPDATE invoice_reminders SET state = 'failed', note = ?, updated_at = ? WHERE id = ? AND state = 'sending'").run(msg, nowIso(), row.id);
      audit.log(SYSTEM, { action: "invoice.reminder_failed", entityType: "invoice", entityId: row.invoice_id, after: { step: row.step, error: msg } });
      if (inv) failBell(db, inv, row.step, msg);
      out.failed++;
    }
  }
  return out;
}

function gapMs() {
  const g = Number(process.env.INVOICE_REMINDERS_GAP_MS);
  return Number.isFinite(g) && g >= 0 ? g : 600;
}

// Sends queued rows one by one (about two a second), at most 20; a 429 ends the batch.
async function sendQueued(db, req = SYSTEM, limit = MAX_PER_RUN, today = null) {
  const out = { sent: 0, dry: 0, failed: 0, cancelled: 0, retry: 0 };
  const ids = db.prepare("SELECT id FROM invoice_reminders WHERE state = 'queued' ORDER BY id LIMIT ?").all(limit);
  let first = true;
  for (const { id } of ids) {
    if (!first) await sleep(gapMs());
    first = false;
    const r = await sendOne(db, req, id, { how: "auto", today });
    if (r.result === "notConfigured") break;
    if (r.result === "busy") continue;
    if (out[r.result] !== undefined) out[r.result]++;
    if (r.result === "retry" && r.status === 429) break;
  }
  return out;
}

// --- the clock -------------------------------------------------------------------------------------

// The Sydney date when a scheduled run is due now (a weekday, from the set hour, not yet run today).
function due(now, lastRun, hour) {
  const p = sydneyParts(now);
  if (p.weekday < 1 || p.weekday > 5 || p.hour < hour) return null;
  return p.date === lastRun ? null : p.date;
}

// {force, today, now, req}. Without force (and no explicit `today`) it obeys due() and records the day.
// An explicit `today` (never before the real today) is Run now: it skips the weekday and hour gates.
// Recovers stuck sends, prepares the queue, and in Automatic sends it.
async function run(db, { force = false, today, now = new Date(), req } = {}) {
  const cfg = getSettings(db);
  const out = { date: today || sydneyToday(now), ran: false, mode: cfg.mode, queued: 0, skipped: 0, belled: 0, sent: 0, recovered: 0 };
  if (cfg.mode === "off") return out;
  if (today !== undefined) {
    if (!validDate(today)) throw bad("today must be a valid YYYY-MM-DD date");
    if (today < sydneyToday()) throw bad("today can't be before today");
    force = true;
  }
  const day = out.date;
  const actor = req || SYSTEM;
  if (!force) {
    const p = sydneyParts(now);
    if (!due(now, cfg.lastRun, cfg.hour)) {
      // Already prepared today: keep sending what is still queued (a batch over 20, or retries).
      if (cfg.mode === "auto" && cfg.lastRun === p.date && p.weekday <= 5 && p.hour >= cfg.hour && !isDry()) {
        const r = await sendQueued(db, SYSTEM, MAX_PER_RUN, p.date);
        out.sent = r.sent;
        out.ran = r.sent + r.failed + r.cancelled + r.retry > 0;
      }
      return out;
    }
    settings.set(db, K.lastRun, day, null, { audit: false });
  }
  const rec = await recover(db, now);
  out.recovered = rec.retried + rec.failed;
  const prep = prepare(db, { today: day, now, req: actor, how: force ? "run now" : "auto run" });
  out.queued = prep.queued;
  out.skipped = prep.skipped;
  out.belled = prep.belled;
  out.ran = true;
  if (cfg.mode === "auto") {
    const r = await sendQueued(db, actor, MAX_PER_RUN, day);
    out.sent = r.sent + r.dry;
  }
  return out;
}

let started = false;
let running = false;
// Every minute (INVOICE_REMINDERS_SWEEP_DISABLED=1 turns it off; mode Off does nothing).
function start(db) {
  if (process.env.INVOICE_REMINDERS_SWEEP_DISABLED === "1" || started) return;
  started = true;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const out = await run(db);
      if (out.ran) console.log(`[invoice-reminders] run for ${out.date}: ${out.queued} queued, ${out.skipped} skipped, ${out.sent} sent`);
    } catch (e) {
      console.error("[invoice-reminders] run failed:", e && e.message ? e.message : e);
    } finally {
      running = false;
    }
  }, CHECK_MS);
  timer.unref();
}

// --- what the screens read -------------------------------------------------------------------------

function emailStatusOf(db, emailId) {
  if (!emailId) return null;
  const r = db.prepare("SELECT status, sent_at FROM invoice_emails WHERE id = ?").get(emailId);
  return r || null;
}

// GET /api/invoices/:id/reminders. `eligible` says whether the automatic reminders apply to this invoice
// (why: the reason code when not); manualAllowed / manualWhy say whether a person can send one now.
function overviewFor(db, inv, { today = sydneyToday() } = {}) {
  const ctx = makeCtx(db, today);
  const ev = evaluate(db, inv, ctx);
  const cfg = ctx.cfg;
  const steps = [];
  for (let s = 1; s <= cfg.days.length; s++) {
    const r = ev.byStep.get(s);
    const e = r ? emailStatusOf(db, r.email_id) : null;
    steps.push({
      step: s,
      days: cfg.days[s - 1],
      state: r ? r.state : null,
      how: r ? r.how : null,
      note: r ? r.note : null,
      sentAt: e ? e.sent_at : null,
      emailId: r && r.email_id ? r.email_id : null,
      emailStatus: e ? e.status : null,
    });
  }
  const manualStep = (() => {
    for (let s = 1; s <= cfg.days.length; s++) {
      const r = ev.byStep.get(s);
      if (!r || ["queued", "failed", "cancelled"].includes(r.state)) return s;
    }
    return cfg.days.length;
  })();
  let draft = null;
  if (inv.status === "issued") {
    const msg = messageFor(db, inv, ev, manualStep, cfg);
    draft = { step: manualStep, to: ev.to.join(", "), toFrom: ev.toFrom, cc: "", subject: msg.subject, body: msg.body, bcc: bccList(db).join(", ") };
  }
  const cp = ctx.pauses.get(followup.clientKey(ev.job.client_name));
  return {
    mode: cfg.mode,
    dry: isDry(),
    eligible: ev.reason === null,
    why: ev.reason,
    nextStep: ev.nextStep,
    nextDate: ev.nextDate,
    daysOverdue: ev.daysOverdue,
    paused: !!inv.reminders_paused,
    pausedUntil: inv.reminders_paused_until || null,
    pauseNote: inv.reminders_pause_note || "",
    pausedNow: ev.paused,
    clientPaused: ev.clientPaused,
    clientName: ((ev.job && ev.job.client_name) || "").trim(),
    clientPausedUntil: cp ? cp.until_date || null : null,
    beforeSwitchOn: ev.beforeSwitchOn,
    onSince: cfg.onSince,
    manualAllowed: ev.manualWhy === null,
    manualWhy: ev.manualWhy,
    steps,
    draft,
  };
}

// The `reminder` object on each invoice of GET /api/invoices/overdue.
function reminderSummary(db, inv, today = sydneyToday(), ctx = null) {
  ctx = ctx || makeCtx(db, today);
  const ev = evaluate(db, inv, ctx);
  let last = null;
  for (const r of ev.rows) if (r.state === "sent" || r.state === "dry") last = r;
  const e = last && last.email_id ? emailStatusOf(db, last.email_id) : null;
  return {
    lastStep: last ? last.step : null,
    lastSentAt: e ? e.sent_at : last ? last.updated_at : null,
    lastStatus: last ? (last.state === "dry" ? "dry" : e ? e.status : "sent") : null,
    nextStep: ev.nextStep,
    nextDate: ev.nextDate,
    queued: ev.rows.some((r) => r.state === "queued"),
    queuedId: (ev.rows.find((r) => r.state === "queued") || {}).id || null,
    paused: ev.paused,
    clientPaused: ev.clientPaused,
    noEmail: ev.noEmail,
    notSent: ev.notSent,
    beforeSwitchOn: ev.beforeSwitchOn,
    bounced: ev.bounced,
    reason: ev.reason,
  };
}

function shapeRow(db, r, ctx) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(r.invoice_id);
  const job = (inv && invoices.getJob(db, inv.job_id)) || {};
  const out = {
    id: r.id,
    invoiceId: r.invoice_id,
    number: inv ? inv.number : null,
    jobId: inv ? inv.job_id : null,
    jobName: job.name || "",
    clientName: (inv && inv.bill_to_name) || job.client_name || "",
    totalCents: inv ? (inv.total_cents != null ? inv.total_cents : null) : null,
    step: r.step,
    daysOverdue: r.days_overdue,
    state: r.state,
    how: r.how,
    note: r.note,
    tries: r.tries,
    emailId: r.email_id || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    email: null,
  };
  if (inv && r.state === "queued") {
    const ev = evaluate(db, inv, ctx, job);
    const msg = messageFor(db, inv, ev, r.step, ctx.cfg);
    out.daysOverdue = ev.daysOverdue;
    out.email = { to: ev.to.join(", "), cc: "", bcc: bccList(db).join(", "), subject: msg.subject, body: msg.body };
  }
  return out;
}

// GET /api/invoice-reminders/queue: what waits for a person (with the exact email), and the last 30 days.
function queue(db, { today = sydneyToday() } = {}) {
  const ctx = makeCtx(db, today);
  const queued = db.prepare("SELECT * FROM invoice_reminders WHERE state IN ('queued','sending') ORDER BY id").all().map((r) => shapeRow(db, r, ctx));
  const cutoff = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();
  const recent = db
    .prepare("SELECT * FROM invoice_reminders WHERE state IN ('sent','failed','skipped','dry','cancelled') AND updated_at >= ? ORDER BY updated_at DESC, id DESC")
    .all(cutoff)
    .map((r) => shapeRow(db, r, ctx));
  return { mode: ctx.cfg.mode, queued, recent };
}

// Skips a queued reminder (POST /queue/:id/skip). Returns true when this call did it.
function skip(db, req, reminderId) {
  const r = db.prepare("SELECT * FROM invoice_reminders WHERE id = ?").get(reminderId);
  if (!r) throw notFound();
  const name = (req && req.user && (req.user.displayName || req.user.display_name || req.user.username)) || "a person";
  const info = db
    .prepare("UPDATE invoice_reminders SET state = 'skipped', note = ?, acted_by = ?, updated_at = ? WHERE id = ? AND state = 'queued'")
    .run(`skipped by ${name}`, userId(req), nowIso(), reminderId);
  if (!info.changes) throw conflict("That reminder is no longer waiting");
  audit.log(req, { action: "invoice.reminder_skipped", entityType: "invoice", entityId: r.invoice_id, after: { step: r.step, reason: `skipped by ${name}` } });
  return true;
}

function queuedCount(db) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM invoice_reminders WHERE state = 'queued'").get().n) || 0;
}

module.exports = {
  MODES,
  PLACEHOLDERS,
  DEFAULT_TEMPLATES,
  SYSTEM,
  isDry,
  fill,
  parseDays,
  getSettings,
  setSettings,
  listClientPauses,
  setInvoicePause,
  setClientPause,
  makeCtx,
  evaluate,
  messageFor,
  prepare,
  sendOne,
  sendManual,
  sendQueued,
  recover,
  due,
  run,
  start,
  overviewFor,
  reminderSummary,
  queue,
  skip,
  queuedCount,
};
