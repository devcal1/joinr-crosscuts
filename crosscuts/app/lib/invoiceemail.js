// Sending an invoice by email (0.2.13). The sender picks the invoice, checks the To, CC, subject and
// message, and the server makes the PDF, sends it through Resend, records the send in invoice_emails
// and marks the invoice sent (lib/followup.markSent) so the follow-up steps carry on.
//
// A send that fails (no key, the PDF, Resend) leaves the invoice exactly as it was and is audited
// as invoice.email_failed; only a send Resend accepted makes a row and an invoice.email_sent audit.
// Delivery is learned by polling (Umbrel can't receive webhooks): the sweep, or Check now, asks
// Resend for each row still 'sent' and maps its last_event to delivered / bounced / failed. A bounce
// bells everyone who can edit invoices. Rows older than 7 days stop being polled.
const audit = require("./audit");
const notify = require("./notify");
const settings = require("./settings");
const followup = require("./followup");
const invoices = require("./invoices");
const resend = require("./resend");
const invoicepdf = require("./invoicepdf");
const { bad, conflict, notFound, HttpError } = require("./httperror");

const FROM_KEY = "invoices.email_from";
const MAX_RECIPIENTS = 5;
const SUBJECT_MAX = 200;
const BODY_MAX = 10000;
const POLL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_MS = 3 * 60 * 1000;
const POLL_BATCH = 30;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// --- addresses -------------------------------------------------------------------------------------

const ADDR_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function validAddress(a) {
  if (typeof a !== "string" || a.length > 254) return false;
  const at = a.lastIndexOf("@");
  return at > 0 && at <= 64 && !a.includes("..") && !a.startsWith(".") && !a.slice(0, at).endsWith(".") && ADDR_RE.test(a);
}

// "a@x.com, b@y.com" (commas, semicolons or line breaks) -> ["a@x.com", "b@y.com"], de-duplicated.
function parseAddresses(v, label, { required = false } = {}) {
  if (v === undefined || v === null) v = "";
  if (Array.isArray(v)) v = v.join(",");
  if (typeof v !== "string") throw bad(`${label} must be text`);
  const parts = v.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) {
    if (required) throw bad(`${label} needs an email address`);
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (!validAddress(p)) throw bad(`${label}: "${p.slice(0, 60)}" is not a valid email address`);
    const k = p.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  if (out.length > MAX_RECIPIENTS) throw bad(`${label} can have at most ${MAX_RECIPIENTS} addresses`);
  return out;
}

// "TH Cabinets Accounts <accounts@thcabinets.com.au>" or a bare address -> {name, address, text}.
function parseFrom(v) {
  const s = String(v == null ? "" : v).trim();
  const m = /^(?:"?([^"<>]*?)"?\s*)?<([^<>\s]+)>$/.exec(s);
  const address = m ? m[2] : s;
  const name = m && m[1] ? m[1].trim() : "";
  if (!validAddress(address) || /[\r\n]/.test(name) || name.length > 100) return null;
  return { name, address, text: name ? `${name} <${address}>` : address };
}

function fromSetting(db) {
  return parseFrom(settings.get(db, FROM_KEY)) || parseFrom("TH Cabinets Accounts <accounts@thcabinets.com.au>");
}

// --- the template ----------------------------------------------------------------------------------

function longDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
}

// The send dialog's starting values for an invoice row.
function defaults(db, inv) {
  const job = invoices.getJob(db, inv.job_id) || {};
  const total = inv.total_cents != null ? inv.total_cents : invoices.sumLines(invoices.linesOf(db, inv, job));
  const kind = { deposit: "Deposit", progress: "Progress", final: "Final", extra: "Extra" }[inv.kind] || "";
  const jobName = (job.name || "").trim();
  const client = (inv.bill_to_name || job.client_name || "").trim();
  const from = fromSetting(db);
  const sign = from && from.name ? from.name : "TH Cabinets Accounts";
  const due = longDate(inv.due_date);
  const email = (job.client_email || "").trim();
  const subject = `Invoice ${inv.number}${jobName ? ": " + jobName : ""}${kind ? " (" + kind + ")" : ""}`.slice(0, SUBJECT_MAX);
  const body =
    `${client ? "Hi " + client : "Hi"},\n\n` +
    `Please find attached invoice ${inv.number}${jobName ? " for " + jobName : ""}: ${invoices.money(total)}${due ? ", due " + due : ""}.\n\n` +
    `Thank you,\n${sign}`;
  return {
    to: validAddress(email) ? email : "",
    toFrom: validAddress(email) ? "the job's client" : "",
    cc: "",
    subject,
    body,
    filename: invoicepdf.fileName(inv),
  };
}

// --- history ---------------------------------------------------------------------------------------

function shape(r, now = Date.now()) {
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    to: r.to_addrs,
    cc: r.cc_addrs,
    subject: r.subject,
    sentAt: r.sent_at,
    sentBy: r.sent_by ? { id: r.sent_by, name: r.by_name || "" } : null,
    status: r.status,
    stale: r.status === "sent" && now - Date.parse(r.sent_at) > POLL_MAX_AGE_MS,
    error: r.error || null,
  };
}

// Newest first.
function history(db, invoiceId) {
  return db
    .prepare(
      `SELECT e.*, u.display_name AS by_name FROM invoice_emails e LEFT JOIN users u ON u.id = e.sent_by
       WHERE e.invoice_id = ? ORDER BY e.id DESC`
    )
    .all(invoiceId)
    .map((r) => shape(r));
}

// The orange alert: the newest bounced (or failed) email, unless a later one was delivered.
function alertOf(rows) {
  for (const r of rows) {
    if (r.status === "delivered") return null;
    if (r.status === "bounced" || r.status === "failed") {
      return {
        id: r.id,
        status: r.status,
        message:
          r.status === "bounced"
            ? `Email to ${r.to} bounced. Check the address and send again.`
            : `Email to ${r.to} could not be delivered. Check the address and send again.`,
      };
    }
  }
  return null;
}

// What GET /api/invoices/:id/email returns.
function overview(db, inv) {
  const rows = history(db, inv.id);
  const sendable = inv.status === "issued" || inv.status === "paid";
  const from = fromSetting(db);
  return {
    configured: resend.keyStatus().configured,
    from: from ? from.text : "",
    sendable,
    defaults: sendable ? defaults(db, inv) : null,
    history: rows,
    alert: alertOf(rows),
  };
}

// --- sending ---------------------------------------------------------------------------------------

const sending = new Set(); // invoice ids with a send under way

function parseBody(b) {
  b = b && typeof b === "object" && !Array.isArray(b) ? b : {};
  const to = parseAddresses(b.to, "To", { required: true });
  const cc = parseAddresses(b.cc, "CC").filter((a) => !to.some((t) => t.toLowerCase() === a.toLowerCase()));
  if (typeof b.subject !== "string" || !b.subject.trim()) throw bad("The subject can't be empty");
  if (/[\r\n]/.test(b.subject)) throw bad("The subject must be one line");
  if (b.subject.length > SUBJECT_MAX) throw bad(`The subject is too long (${SUBJECT_MAX} characters at most)`);
  if (typeof b.body !== "string" || !b.body.trim()) throw bad("The message can't be empty");
  if (b.body.length > BODY_MAX) throw bad(`The message is too long (${BODY_MAX} characters at most)`);
  return { to, cc, subject: b.subject.trim(), body: b.body.replace(/\r\n/g, "\n") };
}

function failed(req, inv, m, error) {
  audit.log(req, {
    action: "invoice.email_failed",
    entityType: "invoice",
    entityId: inv.id,
    after: { to: m.to.join(", "), cc: m.cc.join(", "), subject: m.subject, error },
  });
}

// POST /:id/email. Throws HttpError (4xx; 502 for Resend or the PDF); returns {email, markedSent}.
async function send(db, req, id, body) {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
  if (!inv) throw notFound();
  if (inv.status !== "issued" && inv.status !== "paid") {
    throw conflict(`Only an issued invoice can be sent (this one is ${inv.status})`);
  }
  const m = parseBody(body);
  if (!resend.keyStatus().configured) throw conflict(resend.NOT_SET_UP);
  const from = fromSetting(db);
  if (!from) throw conflict("The From address for invoice emails isn't valid. An administrator needs to fix it.");
  if (sending.has(id)) throw conflict("This invoice is already being sent. Wait a moment and check the email history.");
  sending.add(id);
  try {
    let pdf;
    try {
      pdf = await invoicepdf.renderInvoicePdf(db, id);
    } catch (e) {
      if (e instanceof HttpError || (e && typeof e.status === "number" && e.status >= 400 && e.status <= 499)) throw e;
      console.error("[invoice-email] PDF failed:", e && e.message ? e.message : e);
      const msg = `The invoice PDF couldn't be made (${e && e.message ? e.message : "unknown problem"}). Nothing was sent.`;
      failed(req, inv, m, msg);
      throw new HttpError(502, msg);
    }
    const filename = invoicepdf.fileName(inv);
    let resendId;
    try {
      resendId = await resend.sendEmail(
        { from: from.text, replyTo: from.address, to: m.to, cc: m.cc, subject: m.subject, text: m.body, attachments: [{ filename, content: pdf }] },
        require("crypto").randomUUID()
      );
    } catch (e) {
      const msg = e instanceof resend.ResendError ? e.message : "The email couldn't be sent. Nothing was sent.";
      if (!(e instanceof resend.ResendError)) console.error("[invoice-email] send failed:", e && e.message ? e.message : e);
      failed(req, inv, m, msg);
      throw new HttpError(502, msg + (e instanceof resend.ResendError && e.status > 0 && e.status < 500 ? " Nothing was sent." : ""));
    }
    const userId = req && req.user ? req.user.id : null;
    const rowId = Number(
      db
        .prepare(
          `INSERT INTO invoice_emails (invoice_id, to_addrs, cc_addrs, subject, body, attachment_name, resend_id, status, sent_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?)`
        )
        .run(id, m.to.join(", "), m.cc.join(", "), m.subject, m.body, filename, resendId, userId).lastInsertRowid
    );
    audit.log(req, {
      action: "invoice.email_sent",
      entityType: "invoice",
      entityId: id,
      after: { emailId: rowId, to: m.to.join(", "), cc: m.cc.join(", "), subject: m.subject, resendId, attachment: filename },
    });
    // The email has left: whatever happens to the sent mark, the row above stays.
    let markedSent = true;
    try {
      followup.markSent(db, req, id, {});
    } catch (e) {
      markedSent = false;
      console.error("[invoice-email] mark sent failed:", e && e.message ? e.message : e);
    }
    const row = db
      .prepare("SELECT e.*, u.display_name AS by_name FROM invoice_emails e LEFT JOIN users u ON u.id = e.sent_by WHERE e.id = ?")
      .get(rowId);
    return { email: shape(row), markedSent };
  } finally {
    sending.delete(id);
  }
}

// --- delivery status -------------------------------------------------------------------------------

// Resend's last_event -> our status, or null while it is still in flight.
function mapEvent(ev) {
  switch (ev) {
    case "delivered":
    case "opened":
    case "clicked":
    case "complained": // delivered, then marked as spam
      return "delivered";
    case "bounced":
      return "bounced";
    case "failed":
    case "canceled":
    case "suppressed":
      return "failed";
    default:
      return null; // queued, scheduled, sent, delivery_delayed
  }
}

const SYSTEM_REQ = { actorLabel: "email delivery check", user: null, ip: null };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Asks Resend about each email still 'sent' (and under 7 days old); one invoice's, or all.
// Returns {checked, changed}. Never throws.
async function pollInFlight(db, { invoiceId = null, now = Date.now() } = {}) {
  const out = { checked: 0, changed: 0 };
  try {
    if (!resend.keyStatus().configured) return out;
    const cutoff = new Date(now - POLL_MAX_AGE_MS).toISOString();
    const rows = db
      .prepare(
        `SELECT e.*, i.number AS inv_number FROM invoice_emails e JOIN invoices i ON i.id = e.invoice_id
         WHERE e.status = 'sent' AND e.resend_id IS NOT NULL AND e.sent_at >= ? ${invoiceId ? "AND e.invoice_id = ?" : ""}
         ORDER BY e.id LIMIT ${POLL_BATCH}`
      )
      .all(...(invoiceId ? [cutoff, invoiceId] : [cutoff]));
    const gap = Number(process.env.INVOICE_EMAIL_POLL_GAP_MS);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (i > 0) await sleep(Number.isFinite(gap) && gap >= 0 ? gap : 600); // Resend allows about two requests a second
      const at = new Date().toISOString();
      let ev;
      try {
        ev = (await resend.getEmail(r.resend_id)).lastEvent;
      } catch (e) {
        db.prepare("UPDATE invoice_emails SET status_checked_at = ? WHERE id = ?").run(at, r.id);
        if (e && e.status === 429) break;
        continue;
      }
      out.checked++;
      const st = mapEvent(ev);
      if (!st) {
        db.prepare("UPDATE invoice_emails SET status_checked_at = ?, last_event = ? WHERE id = ?").run(at, ev, r.id);
        continue;
      }
      out.changed++;
      db.transaction(() => {
        db.prepare("UPDATE invoice_emails SET status = ?, last_event = ?, status_checked_at = ?, status_changed_at = ? WHERE id = ?").run(
          st,
          ev,
          at,
          at,
          r.id
        );
        if (st === "bounced" || st === "failed") {
          audit.log(SYSTEM_REQ, {
            action: "invoice.email_" + st,
            entityType: "invoice",
            entityId: r.invoice_id,
            after: { emailId: r.id, to: r.to_addrs, lastEvent: ev },
          });
          notify.toKey(db, "invoices.edit", {
            kind: "invoice.email_" + st,
            title: `Invoice email ${st === "bounced" ? "bounced" : "not delivered"}: ${r.inv_number || "invoice " + r.invoice_id}`,
            body: `Email to ${r.to_addrs} ${st === "bounced" ? "bounced" : "could not be delivered"}. Check the address and send again.`,
            link: `/accounts.html?invoice=${r.invoice_id}`,
            entityType: "invoice",
            entityId: r.invoice_id,
          });
        } else {
          audit.log(SYSTEM_REQ, {
            action: "invoice.email_delivered",
            entityType: "invoice",
            entityId: r.invoice_id,
            after: { emailId: r.id, to: r.to_addrs, lastEvent: ev },
          });
        }
      })();
    }
  } catch (e) {
    console.error("[invoice-email] delivery check failed:", e && e.message ? e.message : e);
  }
  return out;
}

let started = false;
let running = false;
// Every few minutes (INVOICE_EMAIL_SWEEP_DISABLED=1 turns it off).
function start(db) {
  if (process.env.INVOICE_EMAIL_SWEEP_DISABLED === "1" || started) return;
  started = true;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const out = await pollInFlight(db);
      if (out.changed) console.log(`[invoice-email] delivery check: ${out.changed} of ${out.checked} changed`);
    } finally {
      running = false;
    }
  }, SWEEP_MS);
  timer.unref();
}

module.exports = {
  validAddress,
  parseAddresses,
  parseFrom,
  fromSetting,
  defaults,
  history,
  overview,
  send,
  mapEvent,
  pollInFlight,
  start,
  FROM_KEY,
};
