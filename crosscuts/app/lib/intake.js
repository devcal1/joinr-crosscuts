// The "New from Joinr" inbox: list, accept, link, ignore (m6-contracts.md sections 2, 3 and 5).
// Records arrive from lib/joinr-sync.js (applyItem); this module reads them and records the
// decisions. Every write is one transaction and is audited. The wire shape of `payload` is
// docs/integrations/joinr-crosscuts-intake.md.
const audit = require("./audit");
const drawers = require("./drawers");
const invoices = require("./invoices");
const jobstage = require("./jobstage");
const materials = require("./materials");
const joinrQuote = require("./joinr-quote");
const teamTasks = require("./team-tasks");
const { HttpError, bad, notFound, conflict } = require("./httperror");
const { DATE_RE, sydneyToday } = require("./time");

const BENCHTOPS = new Set(["laminate", "stone", "none"]);
const VIEWS = ["new", "changed", "decided", "ignored", "withdrawn", "all"];
const LIST_LIMIT = 500;

// The actor for a decision Crosscuts makes itself (2026-10-18): a won quote becomes a job with no
// person clicking. No user (decided_by stays NULL); lib/audit.js writes actorLabel as the actor.
const SYSTEM_LABEL = "Joinr (automatic)";
const SYSTEM_REQ = Object.freeze({ user: null, ip: null, actorLabel: SYSTEM_LABEL });

function userCan(user, key) {
  if (!user) return false;
  const perms = user.perms;
  if (perms instanceof Set) return perms.has(key);
  if (Array.isArray(perms)) return perms.includes(key);
  return false;
}

// ---- reading a stored payload safely ---------------------------------------------------

const str = (v, max = 500) => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const cents = (v) => (Number.isInteger(v) && v >= 0 && v <= 99999999999 ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const strList = (v) =>
  Array.isArray(v)
    ? v.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 200)).slice(0, 30)
    : [];
// A real calendar date only (M6 · 4.3): 2026-02-30 is dropped, not rolled over to March.
const realYmd = (v) => {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return !Number.isNaN(t.getTime()) && t.getUTCFullYear() === y && t.toISOString().slice(0, 10) === v;
};
const isoDate = (v) => (realYmd(v) ? v : null);
// A date-time whose date part is real (it feeds won_date).
const isoDateTime = (v) => (typeof v === "string" && realYmd(v.slice(0, 10)) && !Number.isNaN(Date.parse(v)) ? v : null);
// Only http(s) links reach the page.
const httpUrl = (v) => (typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim()) && v.length <= 2000 ? v.trim() : null);

// The part of the Joinr item the inbox and Accept use, defensively normalised.
function quoteOf(payload, showValue) {
  let p;
  try {
    p = JSON.parse(payload);
  } catch (_) {
    p = null;
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) p = {};
  const spec = p.spec && typeof p.spec === "object" ? p.spec : {};
  const raw = p.raw && typeof p.raw === "object" ? p.raw : {};
  const h = p.estimatedHours && typeof p.estimatedHours === "object" ? p.estimatedHours : null;
  const hours = h
    ? { office: num(h.office), factory: num(h.factory), site: num(h.site), travel: num(h.travel) }
    : null;
  const sheets = num(spec.sheetCount);
  return {
    clientName: str(p.clientName, 200),
    clientPhone: str(p.clientPhone, 100),
    clientEmail: str(p.clientEmail, 200),
    siteAddress: str(p.siteAddress, 300),
    label: str(p.label, 200),
    reference: str(p.reference, 200),
    quoteDate: isoDate(p.quoteDate),
    wonAt: isoDateTime(p.wonAt),
    valueIncGstCents: showValue ? cents(p.valueIncGstCents) : null,
    estimatedHours: hours && Object.values(hours).some((x) => x !== null) ? hours : null,
    spec: {
      sheetCount: sheets === null ? null : Math.ceil(sheets),
      twoPac: typeof spec.twoPac === "boolean" ? spec.twoPac : null,
      benchtop: BENCHTOPS.has(spec.benchtop) ? spec.benchtop : null,
      jobType: str(spec.jobType, 200),
    },
    raw: { doorsPanels: strList(raw.doorsPanels), benchtops: strList(raw.benchtops), jobTypes: strList(raw.jobTypes) },
    url: httpUrl(p.url),
  };
}

function fmtMoney(c) {
  return "$" + (c / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Where the job and the Joinr quote disagree, for a record Joinr changed after a decision.
// Joinr-side fields that are empty are skipped. Value only for users who may see it.
function differences(quote, job, showValue) {
  if (!job) return [];
  const out = [];
  const text = (label, joinr, mine) => {
    if (joinr != null && joinr !== "" && String(joinr).trim().toLowerCase() !== String(mine == null ? "" : mine).trim().toLowerCase()) {
      out.push({ label, job: mine == null || mine === "" ? "Empty" : String(mine), joinr: String(joinr) });
    }
  };
  text("Client", quote.clientName, job.client_name);
  text("Site", quote.siteAddress, job.site_address);
  text("Phone", quote.clientPhone, job.client_phone);
  text("Email", quote.clientEmail, job.client_email);
  if (showValue && quote.valueIncGstCents != null && quote.valueIncGstCents !== job.value_cents) {
    out.push({
      label: "Value inc GST",
      job: job.value_cents == null ? "Empty" : fmtMoney(job.value_cents),
      joinr: fmtMoney(quote.valueIncGstCents),
    });
  }
  text("Sheets", quote.spec.sheetCount, job.sheet_count);
  if (quote.spec.twoPac !== null) {
    const mine = job.is_two_pac == null ? null : job.is_two_pac ? "Yes" : "No";
    text("Two-pac", quote.spec.twoPac ? "Yes" : "No", mine);
  }
  text("Benchtop", quote.spec.benchtop, job.benchtop);
  text("Job type", quote.spec.jobType, job.job_type);
  return out;
}

// ---- the intake object ------------------------------------------------------------------

const SELECT = `
  SELECT i.*, j.name AS job_name, u.display_name AS decided_by_name,
    (SELECT COUNT(*) FROM jobs m
      WHERE i.state = 'new' AND i.quote_number IS NOT NULL AND TRIM(i.quote_number) <> ''
        AND m.quote_number = TRIM(i.quote_number) COLLATE NOCASE
        AND (m.external_ref IS NULL OR m.external_ref = '')
        AND m.archived = 0 AND m.stage NOT IN ('lost','archived')) AS match_count
  FROM joinr_intake i
  LEFT JOIN jobs j ON j.id = i.job_id
  LEFT JOIN users u ON u.id = i.decided_by`;

function toObject(db, user, row) {
  const showValue = userCan(user, "jobs.value");
  const quote = quoteOf(row.payload, showValue);
  const changed = !!row.changed;
  const obj = {
    id: row.id,
    rootQuoteId: row.root_quote_id,
    quoteId: row.quote_id,
    quoteNumber: row.quote_number,
    joinrStatus: row.joinr_status,
    lastEvent: row.last_event,
    state: row.state,
    changed,
    job: row.job_id != null ? { id: row.job_id, name: row.job_name } : null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    // A decision Crosscuts made itself (decided_by NULL) says so; an undecided record has no decider.
    decidedBy:
      row.decided_by != null
        ? { id: row.decided_by, name: row.decided_by_name }
        : row.decided_at && (row.state === "accepted" || row.state === "linked")
          ? { id: null, name: SYSTEM_LABEL }
          : null,
    decidedAt: row.decided_at,
    matches: Number(row.match_count) || 0,
    quote,
  };
  if (changed && (row.state === "accepted" || row.state === "linked") && row.job_id != null) {
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(row.job_id);
    obj.differences = differences(quote, job, showValue);
  } else {
    obj.differences = [];
  }
  return obj;
}

function parseId(id) {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function loadRow(db, id) {
  const n = parseId(id);
  const row = n && db.prepare(SELECT + " WHERE i.id = ?").get(n);
  if (!row) throw notFound();
  return row;
}

function viewWhere(state) {
  switch (state) {
    case "new": return "i.state = 'new'";
    case "changed": return "i.changed = 1";
    case "decided": return "i.state IN ('accepted','linked')";
    case "ignored": return "i.state = 'ignored'";
    case "withdrawn": return "i.state = 'withdrawn'";
    case "all": return "1 = 1";
    default: throw bad(`state must be one of ${VIEWS.join(", ")}`);
  }
}

function list(db, user, opts) {
  const state = opts && opts.state != null && opts.state !== "" ? String(opts.state) : "new";
  const where = viewWhere(state);
  const rows = db
    .prepare(`${SELECT} WHERE ${where} ORDER BY i.last_seen_at DESC, i.id DESC LIMIT ${LIST_LIMIT}`)
    .all();
  return rows.map((r) => toObject(db, user, r));
}

// How many records each view holds (the page's tab counts).
function counts(db) {
  const r = db
    .prepare(
      `SELECT
         COALESCE(SUM(state = 'new'), 0) AS n_new,
         COALESCE(SUM(changed = 1), 0) AS n_changed,
         COALESCE(SUM(state IN ('accepted','linked')), 0) AS n_decided,
         COALESCE(SUM(state = 'ignored'), 0) AS n_ignored,
         COALESCE(SUM(state = 'withdrawn'), 0) AS n_withdrawn
       FROM joinr_intake`
    )
    .get();
  return {
    new: Number(r.n_new),
    changed: Number(r.n_changed),
    decided: Number(r.n_decided),
    ignored: Number(r.n_ignored),
    withdrawn: Number(r.n_withdrawn),
  };
}

function get(db, user, id) {
  return toObject(db, user, loadRow(db, id));
}

// A job Link may tie to (M6 · 4.3): not archived, not lost.
const isLiveJob = (job) => !job.archived && job.stage !== "lost" && job.stage !== "archived";

// Live jobs that carry this record's quote number and have not been tied to a Joinr quote.
function matches(db, id) {
  const row = db.prepare("SELECT quote_number FROM joinr_intake WHERE id = ?").get(parseId(id) || 0);
  if (!row) throw notFound();
  const qn = row.quote_number == null ? "" : String(row.quote_number).trim();
  if (!qn) return [];
  return db
    .prepare(
      `SELECT id, name, client_name, stage FROM jobs
        WHERE quote_number = ? COLLATE NOCASE AND (external_ref IS NULL OR external_ref = '')
          AND archived = 0 AND stage NOT IN ('lost','archived')
        ORDER BY id`
    )
    .all(qn)
    .map((j) => ({ id: j.id, name: j.name, clientName: j.client_name, stage: j.stage }));
}

function forJob(db, user, jobId) {
  const n = parseId(jobId);
  const row = n && db.prepare(SELECT + " WHERE i.job_id = ? ORDER BY i.id DESC LIMIT 1").get(n);
  return row ? toObject(db, user, row) : null;
}

// ---- decisions ---------------------------------------------------------------------------

function clip(s, n) {
  return s.length > n ? s.slice(0, n) : s;
}

const hourText = (n) => String(Math.round(n * 100) / 100);

// "From Joinr JRQ1: Doors/panels: a, b; Benchtop: x; Job type: y; Estimated hours: office 1, factory 2."
function notesFor(quoteNumber, q) {
  const parts = [];
  if (q.raw.doorsPanels.length) parts.push("Doors/panels: " + [...new Set(q.raw.doorsPanels)].join(", "));
  if (q.raw.benchtops.length) parts.push("Benchtop: " + [...new Set(q.raw.benchtops)].join(", "));
  if (q.raw.jobTypes.length) parts.push("Job type: " + [...new Set(q.raw.jobTypes)].join(", "));
  const h = q.estimatedHours;
  if (h) {
    const hs = ["office", "factory", "site", "travel"].filter((k) => h[k] !== null).map((k) => `${k} ${hourText(h[k])}`);
    if (hs.length) parts.push("Estimated hours: " + hs.join(", "));
  }
  const head = "From Joinr" + (quoteNumber ? " " + quoteNumber : "");
  return parts.length ? `${head}: ${parts.join("; ")}.` : head + ".";
}

function wonDateOf(q) {
  if (q.wonAt) {
    try {
      return sydneyToday(new Date(q.wonAt));
    } catch (_) {
      /* fall through */
    }
  }
  return sydneyToday();
}

function camelJob(user, row) {
  const showValue = userCan(user, "jobs.value");
  const out = {};
  for (const [col, v] of Object.entries(row)) {
    if (col === "value_cents" && !showValue) continue;
    out[col.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  out.archived = !!row.archived;
  out.isTwoPac = row.is_two_pac == null ? null : !!row.is_two_pac;
  return out;
}

const isEmpty = (v) => v == null || v === "";

// M11 (docs/plans/m11-contracts.md section 4.5): the stored payload's drawer lines when Joinr
// reported them (a list), else null (an older Joinr, or a record stored before M11).
function payloadDrawers(payload) {
  try {
    const p = JSON.parse(payload);
    return p && typeof p === "object" && Array.isArray(p.drawers) ? p.drawers : null;
  } catch (_) {
    return null;
  }
}

// The job's Materials list is prefilled from the quote (lib/materials.js; 2026-10-18). A failure here
// is logged and rolled back to its own savepoint: it must never stop the job being made.
function fillMaterials(db, req, jobId, payload, intakeId) {
  try {
    const snap = intakeId != null ? joinrQuote.latest(db, intakeId) : null; // J4: the whole quote, when Joinr sent one
    materials.fillFromJoinr(db, jobId, payload, req, { quote: snap ? snap.quote : null });
  } catch (e) {
    console.error("[joinr] could not fill the materials list for job " + jobId + ": " + String(e && e.message).slice(0, 200));
  }
}

// Accept's work, in the caller's transaction (a savepoint when nested): creates the Won job from
// the record and marks it accepted. `req` is a request or SYSTEM_REQ (no user: decided_by NULL).
// Returns the new job's id.
function acceptTx(db, req, id) {
  const user = req && req.user;
  return db.transaction(() => {
    const row = loadRow(db, id);
    if (row.state !== "new") throw conflict("This quote has already been dealt with");
    // Accept builds the job from the stored values, whoever may see them.
    const q = quoteOf(row.payload, true);
    const dup = db.prepare("SELECT id FROM jobs WHERE external_ref = ?").get(row.root_quote_id);
    if (dup) throw conflict("A job already has this Joinr quote", { jobId: dup.id });

    const name = clip(q.siteAddress || q.label || q.clientName || str(row.quote_number, 200) || "Joinr quote", 200);
    const now = new Date().toISOString();
    const values = {
      name,
      stage: "won",
      won_date: wonDateOf(q),
      quoted_date: q.quoteDate,
      source: "joinr",
      external_ref: row.root_quote_id,
      quote_number: str(row.quote_number, 100),
      client_name: q.clientName,
      client_phone: q.clientPhone,
      client_email: q.clientEmail,
      site_address: q.siteAddress,
      sheet_count: q.spec.sheetCount,
      is_two_pac: q.spec.twoPac === null ? null : q.spec.twoPac ? 1 : 0,
      benchtop: q.spec.benchtop,
      job_type: q.spec.jobType,
      value_cents: q.valueIncGstCents,
      joinr_quote_url: q.url,
      notes: notesFor(row.quote_number, q),
    };
    const cols = Object.keys(values);
    let newId;
    try {
      const info = db
        .prepare(
          `INSERT INTO jobs (${[...cols, "stage_changed_at", "updated_at"].join(", ")})
           VALUES (${[...cols.map(() => "?"), "?", "?"].join(", ")})`
        )
        .run(...cols.map((c) => values[c]), now, now);
      newId = Number(info.lastInsertRowid);
    } catch (e) {
      if (/UNIQUE constraint failed: jobs\.external_ref/.test(String(e && e.message))) {
        throw conflict("A job already has this Joinr quote");
      }
      throw e;
    }
    const upd = db
      .prepare(
        `UPDATE joinr_intake SET state = 'accepted', job_id = ?, decided_by = ?, decided_at = ?
          WHERE id = ? AND state = 'new'`
      )
      .run(newId, user ? user.id : null, now, row.id);
    if (upd.changes !== 1) throw conflict("This quote has already been dealt with");

    audit.log(req, { action: "job.create", entityType: "job", entityId: newId, after: values });
    audit.log(req, {
      action: "joinr.accept",
      entityType: "joinr_intake",
      entityId: row.id,
      after: { jobId: newId, rootQuoteId: row.root_quote_id, quoteNumber: row.quote_number },
    });
    // M11: the quote's drawer lines become the job's drawer grid(s), unchecked.
    const lines = payloadDrawers(row.payload);
    if (lines) drawers.fillFromJoinr(db, newId, lines, req, { quoteNumber: str(row.quote_number, 100) });
    fillMaterials(db, req, newId, row.payload, row.id);
    return newId;
  })();
}

function accept(db, req, id) {
  const user = req && req.user;
  const jobId = acceptTx(db, req, id);
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  return { item: get(db, user, id), job: camelJob(user, job) };
}

// Job columns Link fills when they are empty: [job column, value from the quote].
function linkFills(q, row) {
  return [
    ["joinr_quote_url", q.url],
    ["quote_number", str(row.quote_number, 100)],
    // Integrator (M6 · 4.1): the contract's list left out the client name; an empty one is filled too.
    ["client_name", q.clientName],
    ["client_phone", q.clientPhone],
    ["client_email", q.clientEmail],
    ["site_address", q.siteAddress],
    ["sheet_count", q.spec.sheetCount],
    ["is_two_pac", q.spec.twoPac === null ? null : q.spec.twoPac ? 1 : 0],
    ["benchtop", q.spec.benchtop],
    ["job_type", q.spec.jobType],
    ["value_cents", q.valueIncGstCents],
  ];
}

// Link's work, in the caller's transaction (a savepoint when nested). Returns the job's id.
function linkTx(db, req, id, jid) {
  const user = req && req.user;
  return db.transaction(() => {
    const row = loadRow(db, id);
    if (row.state !== "new") throw conflict("This quote has already been dealt with");
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jid);
    if (!job) throw new HttpError(404, "Job not found");
    if (!isLiveJob(job)) throw conflict("Link only to a live job");
    if (!isEmpty(job.external_ref)) throw conflict("That job is already tied to a Joinr quote");
    const qn = row.quote_number == null ? "" : String(row.quote_number).trim().toLowerCase();
    if (!qn || String(job.quote_number == null ? "" : job.quote_number).trim().toLowerCase() !== qn) {
      throw conflict("That job does not have this quote number");
    }
    const q = quoteOf(row.payload, true);
    const before = { external_ref: job.external_ref };
    const after = { external_ref: row.root_quote_id };
    for (const [col, v] of linkFills(q, row)) {
      if (v != null && isEmpty(job[col])) {
        before[col] = job[col];
        after[col] = v;
      }
    }
    // 2026-10-18: a won quote makes a job still at Quoted (or the retired Lead) a Won job. A job
    // already further along stays where it is. A move the pipeline rules refuse (the job has week
    // rows) is skipped: the link still stands, and the job gets no won date (it did not become Won).
    // The move comes first, so the won date is written only when the stage really moves; the Joinr
    // won date then replaces the one moveStage stamped (today).
    let moved = false;
    if (job.stage === "quoted" || job.stage === "lead") {
      try {
        moved = jobstage.moveStage(db, jid, { stage: "won", from: job.stage }, req).changed;
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
      }
    }
    if (moved && isEmpty(job.won_date)) {
      before.won_date = job.won_date;
      after.won_date = wonDateOf(q);
    }
    const now = new Date().toISOString();
    const cols = Object.keys(after);
    try {
      db.prepare(`UPDATE jobs SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
        ...cols.map((c) => after[c]),
        now,
        jid
      );
    } catch (e) {
      if (/UNIQUE constraint failed: jobs\.external_ref/.test(String(e && e.message))) {
        throw conflict("A job already has this Joinr quote");
      }
      throw e;
    }
    const upd = db
      .prepare(
        `UPDATE joinr_intake SET state = 'linked', job_id = ?, decided_by = ?, decided_at = ?
          WHERE id = ? AND state = 'new'`
      )
      .run(jid, user ? user.id : null, now, row.id);
    if (upd.changes !== 1) throw conflict("This quote has already been dealt with");

    audit.log(req, { action: "job.update", entityType: "job", entityId: jid, before, after });
    audit.log(req, {
      action: "joinr.link",
      entityType: "joinr_intake",
      entityId: row.id,
      after: { jobId: jid, rootQuoteId: row.root_quote_id, filled: cols.filter((c) => c !== "external_ref"), ...(moved ? { stage: "won" } : {}) },
    });
    // Link filled an empty value: an invoice waiting for one falls due.
    if ("value_cents" in after) invoices.onValueSet(db, jid, req);
    // M11: as Accept; a brand the job already has a to_order drawer line for is skipped.
    const lines = payloadDrawers(row.payload);
    if (lines) drawers.fillFromJoinr(db, jid, lines, req, { quoteNumber: str(row.quote_number, 100) });
    fillMaterials(db, req, jid, row.payload, row.id);
    return jid;
  })();
}

function link(db, req, id, jobId) {
  const user = req && req.user;
  const jid = parseId(jobId);
  if (!jid) throw bad("jobId is required");
  const result = linkTx(db, req, id, jid);
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(result);
  return { item: get(db, user, id), job: camelJob(user, job) };
}

// A won quote that has just arrived (2026-10-18, Todd): no person decides. Exactly one live job
// with the same quote number and no Joinr link is linked (as Link does); none: a Won job is
// made (as Accept does). Two or more: nothing is made, the record stays `new` for a person to
// choose which job to link. Then one task for the design team and an alert to its members.
// Runs as one unit: if anything fails, nothing is kept and the record stays `new` for a person
// (the caller catches). Returns {state: 'accepted' | 'linked', jobId}, {state: 'inbox', matches}
// for the 2+ case, or null if the record is not waiting.
function autoDecide(db, id) {
  const req = SYSTEM_REQ;
  return db.transaction(() => {
    const row = loadRow(db, id);
    if (row.state !== "new") return null;
    const found = matches(db, row.id);
    if (found.length >= 2) return { state: "inbox", matches: found.length };
    let state;
    let jobId;
    if (found.length === 1) {
      jobId = linkTx(db, req, row.id, found[0].id);
      state = "linked";
    } else {
      jobId = acceptTx(db, req, row.id);
      state = "accepted";
    }
    const job = db.prepare("SELECT name FROM jobs WHERE id = ?").get(jobId);
    teamTasks.createFromJoinr(db, req, {
      jobId,
      jobName: job && job.name,
      mode: state === "linked" ? "linked" : "created",
      quoteNumber: str(row.quote_number, 100),
    });
    return { state, jobId };
  })();
}

function ignore(db, req, id) {
  const user = req && req.user;
  db.transaction(() => {
    const row = loadRow(db, id);
    if (row.state !== "new" && row.state !== "withdrawn") throw conflict("This quote has already been dealt with");
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE joinr_intake SET state = 'ignored', decided_by = ?, decided_at = ? WHERE id = ?`
    ).run(user ? user.id : null, now, row.id);
    audit.log(req, {
      action: "joinr.ignore",
      entityType: "joinr_intake",
      entityId: row.id,
      before: { state: row.state },
      after: { state: "ignored", quoteNumber: row.quote_number },
    });
  })();
  return get(db, user, id);
}

function acknowledge(db, req, id) {
  const user = req && req.user;
  db.transaction(() => {
    const row = loadRow(db, id);
    if (!row.changed) return; // nothing to clear
    db.prepare("UPDATE joinr_intake SET changed = 0 WHERE id = ?").run(row.id);
    audit.log(req, {
      action: "joinr.acknowledge",
      entityType: "joinr_intake",
      entityId: row.id,
      after: { quoteNumber: row.quote_number, lastEvent: row.last_event },
    });
  })();
  return get(db, user, id);
}

module.exports = { list, counts, get, matches, accept, link, autoDecide, ignore, acknowledge, forJob, quoteOf, httpUrl, SYSTEM_REQ, VIEWS };
