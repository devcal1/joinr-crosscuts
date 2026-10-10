// /api/job-records: the lifecycle job records (client, spec, value, dates, links).
// Contract: docs/plans/m1-contracts.md ("T3: /api/job-records"). Not to be
// confused with the board's /api/jobs routes in routes/schedule.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const audit = require("../lib/audit");
const jobstage = require("../lib/jobstage");
const orders = require("../lib/orders");
const { DATE_RE, parseDateUTC, formatDateUTC, sydneyToday } = require("../lib/time");

const r = defineRoutes("/api/job-records");

const STAGES = [
  "lead", "quoted", "won", "design_ordering", "ready_to_cut",
  "on_board", "complete", "invoiced", "lost", "archived",
];
// Stages a user may move a job to by hand. on_board / complete / invoiced are
// derived (board hooks, later accounts), so only users.admin may set them.
const MANUAL_STAGES = new Set(["lead", "quoted", "won", "design_ordering", "ready_to_cut", "lost", "archived"]);
const BENCHTOPS = new Set(["laminate", "stone", "none"]);

// Permission check. requirePerm has already guaranteed a logged-in user; a
// missing user is treated as having nothing.
function can(req, key) {
  if (!req.user) return false;
  const perms = req.user.perms;
  if (perms instanceof Set) return perms.has(key);
  if (Array.isArray(perms)) return perms.includes(key);
  return false;
}

// --- field table: body key -> column, kind -------------------------------
// kinds: text, date, int, bool, url, enum:<set>. All are nullable unless noted.
const FIELDS = {
  name: { col: "name", kind: "text", required: true },
  notes: { col: "notes", kind: "notes" },
  archived: { col: "archived", kind: "bool", notNull: true },
  externalRef: { col: "external_ref", kind: "text" },
  clientName: { col: "client_name", kind: "text" },
  clientPhone: { col: "client_phone", kind: "text" },
  clientEmail: { col: "client_email", kind: "text" },
  clientAbn: { col: "client_abn", kind: "text" },
  siteAddress: { col: "site_address", kind: "text" },
  sheetCount: { col: "sheet_count", kind: "int" },
  isTwoPac: { col: "is_two_pac", kind: "bool" },
  benchtop: { col: "benchtop", kind: "enum", set: BENCHTOPS },
  jobType: { col: "job_type", kind: "text" },
  quoteNumber: { col: "quote_number", kind: "text" },
  valueCents: { col: "value_cents", kind: "int", perm: "jobs.value" },
  enquiryDate: { col: "enquiry_date", kind: "date" },
  quotedDate: { col: "quoted_date", kind: "date" },
  wonDate: { col: "won_date", kind: "date" },
  designSignedOffDate: { col: "design_signed_off_date", kind: "date" },
  readyToCutDate: { col: "ready_to_cut_date", kind: "date" },
  promisedInstallDate: { col: "promised_install_date", kind: "date" },
  completedDate: { col: "completed_date", kind: "date" },
  designFolderUrl: { col: "design_folder_url", kind: "url" },
  joinrQuoteUrl: { col: "joinr_quote_url", kind: "url" },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

function validDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = parseDateUTC(s);
  return !Number.isNaN(d.getTime()) && formatDateUTC(d) === s; // rejects 2026-02-31
}

// Returns the value to store (null allowed) or throws a 400.
function coerce(key, f, v) {
  const nullish = v === null || (typeof v === "string" && v.trim() === "" && f.kind !== "notes");
  if (f.required && (nullish || typeof v !== "string")) throw bad(`${key} is required`);
  if (nullish) {
    if (f.kind === "notes") return ""; // jobs.notes is NOT NULL DEFAULT ''
    if (f.notNull) throw bad(`${key} cannot be empty`);
    return null;
  }
  switch (f.kind) {
    case "text":
      if (typeof v !== "string") throw bad(`${key} must be a string`);
      return v.trim();
    case "notes":
      if (typeof v !== "string") throw bad(`${key} must be a string`);
      return v;
    case "date":
      if (!validDate(v)) throw bad(`${key} must be a valid YYYY-MM-DD date`);
      return v;
    case "int":
      if (!Number.isInteger(v) || v < 0) throw bad(`${key} must be a non-negative integer`);
      return v;
    case "bool":
      if (typeof v !== "boolean" && v !== 0 && v !== 1) throw bad(`${key} must be true or false`);
      return v === true || v === 1 ? 1 : 0;
    case "url":
      if (typeof v !== "string" || !/^https?:\/\/\S+$/i.test(v.trim())) {
        throw bad(`${key} must be an http:// or https:// URL`);
      }
      return v.trim();
    case "enum":
      if (!f.set.has(v)) throw bad(`${key} must be one of ${[...f.set].join(", ")}`);
      return v;
    default:
      throw bad(`${key} is not supported`);
  }
}

// Validate a request body into { col: value } for the keys present. Throws
// HttpError (400 validation, 403 for valueCents without jobs.value).
function parseBody(req, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("JSON body required");
  // Not a plain field: it is set by POST /:id/materials-ordered, which also
  // makes the progress invoice due. It is still returned in the job object.
  if (body.materialsOrderedDate !== undefined) throw bad("Use Materials ordered");
  const out = {};
  for (const [key, f] of Object.entries(FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(body, key) || body[key] === undefined) continue;
    if (f.perm && !can(req, f.perm)) throw new HttpError(403, "Forbidden");
    out[f.col] = coerce(key, f, body[key]);
  }
  return out;
}

function parseStage(req, v) {
  if (typeof v !== "string" || !STAGES.includes(v)) throw bad(`stage must be one of ${STAGES.join(", ")}`);
  if (!MANUAL_STAGES.has(v) && !can(req, "users.admin")) {
    throw bad(`stage '${v}' is set automatically and cannot be changed by hand`);
  }
  return v;
}

// --- output ---------------------------------------------------------------

function camel(col) {
  return col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function toJob(req, row, boardWeeks, inBacklog) {
  const showValue = can(req, "jobs.value");
  const out = {};
  for (const [col, v] of Object.entries(row)) {
    if (col === "value_cents" && !showValue) continue;
    out[camel(col)] = v;
  }
  out.archived = !!row.archived;
  out.isTwoPac = row.is_two_pac == null ? null : !!row.is_two_pac;
  out.onBoardWeeks = boardWeeks;
  out.inBacklog = inBacklog;
  return out;
}

function weeksMap(jobId) {
  const q = jobId == null
    ? db.prepare("SELECT DISTINCT job_id, week_start FROM week_rows ORDER BY week_start ASC")
    : db.prepare("SELECT DISTINCT job_id, week_start FROM week_rows WHERE job_id = ? ORDER BY week_start ASC");
  const rows = jobId == null ? q.all() : q.all(jobId);
  const m = new Map();
  for (const w of rows) {
    if (!m.has(w.job_id)) m.set(w.job_id, []);
    m.get(w.job_id).push(w.week_start);
  }
  return m;
}

function backlogSet(jobId) {
  const rows = jobId == null
    ? db.prepare("SELECT job_id FROM backlog").all()
    : db.prepare("SELECT job_id FROM backlog WHERE job_id = ?").all(jobId);
  return new Set(rows.map((b) => b.job_id));
}

function loadOne(req, id) {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  if (!row) return null;
  return toJob(req, row, weeksMap(id).get(id) || [], backlogSet(id).has(id));
}

function parseId(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      if (e && /UNIQUE constraint failed: jobs\.external_ref/.test(e.message)) {
        return res.status(409).json({ error: "externalRef is already used by another job" });
      }
      console.error("[job-records]", e);
      res.status(500).json({ error: "Server error" });
    }
  };
}

// --- routes ---------------------------------------------------------------

r.get("/", "jobs.view", handle((req, res) => {
  const where = [];
  const args = [];
  if (req.query.stage !== undefined && req.query.stage !== "") {
    if (!STAGES.includes(req.query.stage)) throw bad(`stage must be one of ${STAGES.join(", ")}`);
    where.push("stage = ?");
    args.push(req.query.stage);
  }
  if (req.query.archived !== undefined && req.query.archived !== "") {
    if (req.query.archived !== "0" && req.query.archived !== "1") throw bad("archived must be 0 or 1");
    where.push("archived = ?");
    args.push(Number(req.query.archived));
  }
  const text = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
    where.push(
      "(name LIKE ? ESCAPE '\\' OR client_name LIKE ? ESCAPE '\\' OR site_address LIKE ? ESCAPE '\\' " +
        "OR external_ref LIKE ? ESCAPE '\\' OR job_type LIKE ? ESCAPE '\\')"
    );
    args.push(like, like, like, like, like);
  }
  const sql =
    "SELECT * FROM jobs" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY name COLLATE NOCASE ASC, id ASC";
  const rows = db.prepare(sql).all(...args);
  const weeks = weeksMap(null);
  const backlog = backlogSet(null);
  res.json(rows.map((row) => toJob(req, row, weeks.get(row.id) || [], backlog.has(row.id))));
}));

r.get("/:id", "jobs.view", handle((req, res) => {
  const id = parseId(req);
  const job = id && loadOne(req, id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
}));

r.post("/", "jobs.edit", handle((req, res) => {
  const body = req.body;
  const values = parseBody(req, body);
  if (!values.name) throw bad("name is required");
  const stage = body.stage === undefined || body.stage === null ? "lead" : parseStage(req, body.stage);

  const now = new Date().toISOString();
  const id = db.transaction(() => {
    const cols = Object.keys(values);
    const info = db
      .prepare(
        `INSERT INTO jobs (${[...cols, "source", "stage", "stage_changed_at", "updated_at"].join(", ")})
         VALUES (${[...cols.map(() => "?"), "'manual'", "?", "?", "?"].join(", ")})`
      )
      .run(...cols.map((c) => values[c]), stage, now, now);
    const newId = info.lastInsertRowid;
    audit.log(req, {
      action: "job.create",
      entityType: "job",
      entityId: newId,
      after: { ...values, source: "manual", stage },
    });
    if (stage === "ready_to_cut") jobstage.onDesignReadyToCut(db, newId, req);
    return newId;
  })();
  res.status(201).json(loadOne(req, id));
}));

r.patch("/:id", "jobs.edit", handle((req, res) => {
  const id = parseId(req);
  const existing = id && db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const body = req.body;
  const values = parseBody(req, body);
  if ("name" in values && !values.name) throw bad("name is required");
  const newStage = body.stage === undefined ? undefined : parseStage(req, body.stage);

  db.transaction(() => {
    // Only fields whose value actually changes are written and audited.
    const changed = Object.keys(values).filter((c) => values[c] !== existing[c]);
    if (changed.length) {
      db.prepare(`UPDATE jobs SET ${changed.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
        ...changed.map((c) => values[c]),
        new Date().toISOString(),
        id
      );
      const before = {};
      const after = {};
      for (const c of changed) {
        before[c] = existing[c];
        after[c] = values[c];
      }
      audit.log(req, { action: "job.update", entityType: "job", entityId: id, before, after });
    }
    if (newStage !== undefined) {
      if (newStage === "ready_to_cut") {
        // Sets the stage (audited as job.stage) and puts the job on the backlog.
        jobstage.onDesignReadyToCut(db, id, req);
      } else if (newStage === "complete" && existing.stage !== "invoiced") {
        // Same as Finish week -> Complete: completed_date, and the final invoice
        // falls due. A completedDate sent in the same PATCH is kept.
        // (invoiced -> complete is an admin override: plain setStage.)
        jobstage.onFinishedComplete(db, id, req, values.completed_date || undefined);
      } else {
        jobstage.setStage(db, id, newStage, req);
      }
    }
  })();
  res.json(loadOne(req, id));
}));

// "Materials ordered": sets materials_ordered_date and makes the progress
// invoice due (orders.markMaterialsOrdered; the M3 orders path calls it too).
r.post("/:id/materials-ordered", "orders.mark_ordered", handle((req, res) => {
  const id = parseId(req);
  const existing = id && db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const date = b.date === undefined || b.date === null || b.date === "" ? sydneyToday() : b.date;
  if (!validDate(date)) throw bad("date must be a valid YYYY-MM-DD date");
  // The update, audit and invoice hook live in lib/orders.js (M3), shared with
  // the orders path. It returns false when the date was already set.
  if (!orders.markMaterialsOrdered(db, id, req, date)) throw new HttpError(409, "Materials already marked ordered");
  res.json(loadOne(req, id));
}));

module.exports = r.router;
