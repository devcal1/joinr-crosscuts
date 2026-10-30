// Supplier accounts: the suppliers Accounts keep and each month's statement lines
// (docs/plans/m9-contracts.md section 7). Wave 1 B.
//
// Every function takes db first and nothing here requires ../db. All month arithmetic comes from
// ../public/periods. Every write runs in one db.transaction with its audit row.
//
// Who is listed in month P: every supplier with a supplier_statements row for P, plus every
// supplier with from_period <= P and (archived_from null or P < archived_from). A listed supplier
// with no row is Waiting with blanks (saved: false). Restoring skips the gap (Todd, 2026-10-13):
// see update().
const { HttpError, bad, notFound, conflict, forbidden, can } = require("./httperror");
const { sydneyToday } = require("./time");
const audit = require("./audit");
const files = require("./files");
const Periods = require("../public/periods");

const NAME_MAX = 100;
const NOTE_MAX = 500;
const TOTAL_LIMIT = 1000000000;
const STATES = ["have", "waiting", "na"];
const TICKS = ["reconciled", "paid", "myob"];
// Supplier accounts and Admin accounts (m9-contracts.md section 13) share these tables and this
// code; `kind` tells them apart and every query below filters by it. Names stay unique across both
// kinds (the column is UNIQUE). Each kind has its own audit names.
const KINDS = {
  supplier: {
    kind: "supplier",
    clash: "A supplier with that name already exists",
    entity: "supplier",
    statement: "supplier_statement",
  },
  admin: {
    kind: "admin",
    clash: "An account with that name already exists",
    entity: "admin_account",
    statement: "admin_account_statement",
  },
};
const STALE = "Someone else changed this line; reload it";
const REPLACED = "This statement was replaced meanwhile; reload the line";

// ---------------------------------------------------------------- helpers ---

// A timestamp strictly after `prev` (an ISO string or null), so a save in the same millisecond
// still moves updated_at and the stale-line check keeps working (as lib/payroll.js).
function nextStamp(prev) {
  const now = Date.now();
  const p = prev ? Date.parse(prev) : NaN;
  return new Date(Number.isFinite(p) && now <= p ? p + 1 : now).toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

function bool(v) {
  return v === 1 || v === true;
}

function boolField(name, v) {
  if (typeof v !== "boolean") throw bad(`${name} must be true or false`);
  return v;
}

function supplierName(v) {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t || t.length > NAME_MAX) throw bad(`Give a name of 1 to ${NAME_MAX} characters`);
  return t;
}

// A :period outside HISTORY_START .. MAX_AHEAD_MONTHS past the current month is a 404 (section 7.2;
// was next month only, widened so a supplier can be added to any month, Todd 2026-10-30).
function lastPeriod(today) {
  return Periods.addMonths(Periods.currentPeriod(today), Periods.MAX_AHEAD_MONTHS);
}
function periodOr404(period, today) {
  if (!Periods.validPeriod(period)) throw notFound();
  if (period < Periods.HISTORY_START || period > lastPeriod(today)) throw notFound();
  return period;
}

function make(cfg) {
const KIND = cfg.kind;
const CLASH = cfg.clash;

function toSupplier(row) {
  return {
    id: row.id,
    name: row.name,
    fromPeriod: row.from_period,
    archivedFrom: row.archived_from || null,
    archived: row.archived_from != null,
  };
}

function supplierRow(db, id) {
  return db.prepare("SELECT * FROM suppliers WHERE id = ? AND kind = ?").get(id, KIND);
}

function supplierOr404(db, id) {
  const row = supplierRow(db, id);
  if (!row) throw notFound();
  return row;
}

// A name folded for the clash check: Unicode case-blind (the column's COLLATE NOCASE folds A-Z
// only), and NFC so a composed and a decomposed accent compare equal.
function foldName(name) {
  return String(name).normalize("NFC").toLocaleLowerCase("en-AU");
}

// A name clash with another supplier: the DB's COLLATE NOCASE, then the folded names of all the
// others in JS (so "Ébéniste" clashes with "ébéniste"). exceptId is the supplier being renamed,
// so a case-only rename of itself is allowed.
function assertNoClash(db, name, exceptId) {
  const except = exceptId == null ? null : exceptId;
  const clash = db.prepare("SELECT id FROM suppliers WHERE name = ? AND id IS NOT ?").get(name, except);
  if (clash) throw conflict(CLASH);
  const folded = foldName(name);
  for (const r of db.prepare("SELECT id, name FROM suppliers WHERE id IS NOT ?").all(except)) {
    if (foldName(r.name) === folded) throw conflict(CLASH);
  }
}

function isUniqueError(e) {
  return /UNIQUE/i.test(String(e && e.message));
}

// The suppliers listed in `period`, by name: [{supplier row, statement row|null}].
// The statement columns are prefixed st_; the file and user columns are joined in.
const LISTED_SQL = `
  SELECT s.id, s.name, s.from_period, s.archived_from,
         st.period AS st_period, st.state AS st_state, st.total_cents AS st_total_cents, st.note AS st_note,
         st.reconciled AS st_reconciled, st.paid AS st_paid, st.myob AS st_myob, st.file_id AS st_file_id,
         st.updated_by AS st_updated_by, st.updated_at AS st_updated_at,
         uu.display_name AS st_updated_by_name,
         f.id AS f_id, f.original_name AS f_original_name, f.size AS f_size, f.mime AS f_mime,
         f.uploaded_at AS f_uploaded_at, f.uploaded_by AS f_uploaded_by, fu.display_name AS f_uploaded_by_name
    FROM suppliers s
    LEFT JOIN supplier_statements st ON st.supplier_id = s.id AND st.period = @period
    LEFT JOIN users uu ON uu.id = st.updated_by
    LEFT JOIN files f ON f.id = st.file_id AND f.removed_at IS NULL
    LEFT JOIN users fu ON fu.id = f.uploaded_by
   WHERE s.kind = @kind
     AND (st.supplier_id IS NOT NULL
          OR (s.from_period <= @period AND (s.archived_from IS NULL OR @period < s.archived_from)))
     AND NOT EXISTS (SELECT 1 FROM supplier_month_removed rm WHERE rm.supplier_id = s.id AND rm.period = @period)`;

function listedRows(db, period) {
  return db.prepare(`${LISTED_SQL} ORDER BY s.name, s.id`).all({ period, kind: KIND });
}

function listedRow(db, period, supplierId) {
  return db.prepare(`${LISTED_SQL} AND s.id = @id`).get({ period, id: supplierId, kind: KIND }) || null;
}

// A joined row (LISTED_SQL) -> line (section 7.3).
function toLine(r, period) {
  const saved = r.st_period != null;
  const file =
    r.f_id == null
      ? null
      : files.toFile({
          id: r.f_id,
          original_name: r.f_original_name,
          size: r.f_size,
          mime: r.f_mime,
          uploaded_at: r.f_uploaded_at,
          uploaded_by: r.f_uploaded_by,
          uploaded_by_name: r.f_uploaded_by_name,
        });
  return {
    supplier: { id: r.id, name: r.name },
    period,
    state: saved ? r.st_state : "waiting",
    totalCents: saved && r.st_total_cents != null ? Number(r.st_total_cents) : null,
    note: saved ? r.st_note || "" : "",
    reconciled: saved ? bool(r.st_reconciled) : false,
    paid: saved ? bool(r.st_paid) : false,
    myob: saved ? bool(r.st_myob) : false,
    file,
    saved,
    updatedAt: saved ? r.st_updated_at : null,
    updatedBy:
      saved && r.st_updated_by != null ? { id: r.st_updated_by, name: r.st_updated_by_name || "Unknown" } : null,
  };
}

// The line of a listed supplier, or 404 (no such supplier, or not listed in that month).
function lineOr404(db, period, supplierId) {
  const r = listedRow(db, period, supplierId);
  if (!r) throw notFound();
  return toLine(r, period);
}

// The editable fields of a line, as stored.
function fieldsOf(line) {
  return {
    state: line.state,
    totalCents: line.totalCents,
    note: line.note,
    reconciled: line.reconciled,
    paid: line.paid,
    myob: line.myob,
  };
}

// Writes the line's row: an insert for a never-saved line, else an update. `fields` are the
// editable fields; `fileId` the file to link (undefined keeps the current one).
function upsertLine(db, req, period, supplierId, line, fields, fileId) {
  const stamp = nextStamp(line.updatedAt);
  const userId = req && req.user ? req.user.id : null;
  const fid = fileId === undefined ? (line.file ? line.file.id : null) : fileId;
  const values = [
    fields.state,
    fields.totalCents,
    fields.note,
    fields.reconciled ? 1 : 0,
    fields.paid ? 1 : 0,
    fields.myob ? 1 : 0,
    fid,
    userId,
    stamp,
  ];
  if (line.saved) {
    db.prepare(
      `UPDATE supplier_statements
          SET state = ?, total_cents = ?, note = ?, reconciled = ?, paid = ?, myob = ?, file_id = ?,
              updated_by = ?, updated_at = ?
        WHERE supplier_id = ? AND period = ?`
    ).run(...values, supplierId, period);
  } else {
    db.prepare(
      `INSERT INTO supplier_statements
         (state, total_cents, note, reconciled, paid, myob, file_id, updated_by, updated_at, created_at,
          supplier_id, period)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...values, stamp, supplierId, period);
  }
}

// -------------------------------------------------------------- suppliers ---

function list(db, { all = false } = {}) {
  const sql = all
    ? "SELECT * FROM suppliers WHERE kind = ? ORDER BY name, id"
    : "SELECT * FROM suppliers WHERE kind = ? AND archived_from IS NULL ORDER BY name, id";
  return db.prepare(sql).all(KIND).map(toSupplier);
}

function create(db, req, { name, fromPeriod } = {}) {
  const n = supplierName(name);
  const current = Periods.currentPeriod(sydneyToday());
  let from = current;
  if (fromPeriod !== undefined && fromPeriod !== null) {
    if (
      typeof fromPeriod !== "string" ||
      !Periods.validPeriod(fromPeriod) ||
      fromPeriod < Periods.HISTORY_START ||
      fromPeriod > lastPeriod(sydneyToday())
    ) {
      throw bad(`Choose a month from ${Periods.label(Periods.HISTORY_START)} to ${Periods.label(lastPeriod(sydneyToday()))}`);
    }
    from = fromPeriod;
  }
  let id;
  try {
    id = db.transaction(() => {
      assertNoClash(db, n, null);
      const now = nowIso();
      const info = db
        .prepare("INSERT INTO suppliers (name, from_period, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(n, from, KIND, now, now);
      const newId = Number(info.lastInsertRowid);
      audit.log(req, {
        action: `${cfg.entity}.create`,
        entityType: cfg.entity,
        entityId: newId,
        after: { name: n, fromPeriod: from },
      });
      return newId;
    })();
  } catch (e) {
    if (!(e instanceof HttpError) && isUniqueError(e)) throw conflict(CLASH);
    throw e;
  }
  return toSupplier(supplierRow(db, id));
}

// The months from `from` to `to` (inclusive) that have no line for the supplier get a 'waiting'
// line with blanks, stamped by the user (so they show saved: true). Returns how many.
function fillWaiting(db, req, supplierId, from, to) {
  const userId = req && req.user ? req.user.id : null;
  const has = db.prepare("SELECT 1 AS x FROM supplier_statements WHERE supplier_id = ? AND period = ?");
  const ins = db.prepare(
    `INSERT INTO supplier_statements (supplier_id, period, state, updated_by, updated_at, created_at)
     VALUES (?, ?, 'waiting', ?, ?, ?)`
  );
  const now = nowIso();
  let n = 0;
  for (let p = from; p <= to; p = Periods.addMonths(p, 1)) {
    if (has.get(supplierId, p)) continue;
    ins.run(supplierId, p, userId, now, now);
    n += 1;
  }
  return n;
}

// {name?, archived?}. Archiving lists the supplier until the current month (archived_from = the
// current month). Restoring skips the gap (contracts §7.1, Todd 2026-10-13): every month from the
// old from_period to the month before the old archived_from (and before the current month) that
// has no line gets a 'waiting' line, so the months before the archive keep listing it; then
// from_period becomes the current month and archived_from is cleared, so the months it was
// archived gain nothing. A save that changes nothing writes nothing.
function update(db, req, id, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const next = {};
  if (b.name !== undefined) next.name = supplierName(b.name);
  if (b.archived !== undefined) next.archived = boolField("archived", b.archived);
  try {
    db.transaction(() => {
      const row = supplierOr404(db, id);
      const before = {};
      const after = {};
      let name = row.name;
      let archivedFrom = row.archived_from || null;
      let fromPeriod = row.from_period;
      if ("name" in next && next.name !== row.name) {
        assertNoClash(db, next.name, id);
        before.name = row.name;
        after.name = next.name;
        name = next.name;
      }
      if ("archived" in next && next.archived !== (row.archived_from != null)) {
        const current = Periods.currentPeriod(sydneyToday());
        before.archivedFrom = row.archived_from || null;
        if (next.archived) {
          archivedFrom = current;
        } else {
          const lastKept = Periods.addMonths(row.archived_from, -1);
          const prev = Periods.addMonths(current, -1);
          fillWaiting(db, req, id, row.from_period, lastKept < prev ? lastKept : prev);
          before.fromPeriod = row.from_period;
          fromPeriod = current;
          after.fromPeriod = fromPeriod;
          archivedFrom = null;
        }
        after.archivedFrom = archivedFrom;
      }
      if (!Object.keys(after).length) return;
      db.prepare("UPDATE suppliers SET name = ?, from_period = ?, archived_from = ?, updated_at = ? WHERE id = ?").run(
        name,
        fromPeriod,
        archivedFrom,
        nextStamp(row.updated_at),
        id
      );
      audit.log(req, { action: `${cfg.entity}.update`, entityType: cfg.entity, entityId: id, before, after });
    })();
  } catch (e) {
    if (!(e instanceof HttpError) && isUniqueError(e)) throw conflict(CLASH);
    throw e;
  }
  return toSupplier(supplierRow(db, id));
}

// ------------------------------------------------------------------ months ---

// What is still owing, by month, either side of the current month: lines with a total, not 'na',
// not ticked Paid, on a supplier of this kind, and not removed from that month. Months with nothing
// owing are left out.
function outstanding(db, today = sydneyToday()) {
  const current = Periods.currentPeriod(today);
  const rows = db
    .prepare(
      `SELECT st.period AS period, SUM(st.total_cents) AS cents, COUNT(*) AS n
         FROM supplier_statements st
         JOIN suppliers s ON s.id = st.supplier_id
        WHERE s.kind = @kind AND st.period <> @current
          AND st.total_cents > 0 AND st.state <> 'na' AND st.paid = 0
          AND NOT EXISTS (SELECT 1 FROM supplier_month_removed rm WHERE rm.supplier_id = s.id AND rm.period = st.period)
        GROUP BY st.period
        ORDER BY st.period`
    )
    .all({ kind: KIND, current });
  const out = { current, before: [], after: [], beforeCents: 0, afterCents: 0 };
  for (const r of rows) {
    const e = { period: r.period, label: Periods.longLabel(r.period), cents: Number(r.cents), count: Number(r.n) };
    if (r.period < current) {
      out.before.push(e);
      out.beforeCents += e.cents;
    } else {
      out.after.push(e);
      out.afterCents += e.cents;
    }
  }
  return out;
}

function month(db, period, today = sydneyToday()) {
  periodOr404(period, today);
  const lines = listedRows(db, period).map((r) => toLine(r, period));
  const counts = { have: 0, waiting: 0, na: 0, listed: lines.length };
  const ticks = { reconciled: 0, paid: 0, myob: 0 };
  let totalCents = 0;
  for (const l of lines) {
    counts[l.state] += 1;
    if (l.totalCents != null) totalCents += l.totalCents;
    for (const t of TICKS) if (l[t]) ticks[t] += 1;
  }
  const last = lastPeriod(today);
  return {
    period,
    label: Periods.longLabel(period),
    prev: period > Periods.HISTORY_START ? Periods.addMonths(period, -1) : null,
    next: period < last ? Periods.addMonths(period, 1) : null,
    lines,
    counts,
    totalCents,
    ticks,
  };
}

// PUT body {state, totalCents, note, reconciled, paid, myob, updatedAt}. A field left out keeps
// its value. updatedAt must equal the line's (null for a never-saved line), else 409 with the
// line. Nothing is written when nothing changes.
function saveLine(db, req, period, supplierId, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  return db.transaction(() => {
    periodOr404(period, sydneyToday());
    const line = lineOr404(db, period, supplierId);
    const sentStamp = b.updatedAt === undefined ? null : b.updatedAt;
    if (sentStamp !== line.updatedAt) throw conflict(STALE, { line });

    // Validate everything before writing anything.
    const was = fieldsOf(line);
    const next = { ...was };
    if (b.state !== undefined) {
      if (typeof b.state !== "string" || !STATES.includes(b.state)) {
        throw bad("The state must be have, waiting or na");
      }
      next.state = b.state;
    }
    if (b.totalCents !== undefined) {
      const t = b.totalCents;
      if (t !== null && !Number.isInteger(t)) throw bad("The total must be a whole number of cents, or null");
      if (t !== null && (t < -TOTAL_LIMIT || t > TOTAL_LIMIT)) throw bad("The total is too large");
      next.totalCents = t;
    }
    if (b.note !== undefined) {
      if (b.note !== null && typeof b.note !== "string") throw bad("The note must be text");
      const n = b.note == null ? "" : b.note.trim();
      if (n.length > NOTE_MAX) throw bad(`The note must be ${NOTE_MAX} characters or fewer`);
      next.note = n;
    }
    for (const t of TICKS) if (b[t] !== undefined) next[t] = boolField(t, b[t]);

    const before = {};
    const after = {};
    for (const k of Object.keys(next)) {
      if (next[k] !== was[k]) {
        before[k] = was[k];
        after[k] = next[k];
      }
    }
    if (!Object.keys(after).length) return line;
    // 0.2.7 (docs/plans/m28-contracts.md section 2): on Supplier accounts, Paid is ticked by
    // users.admin holders only. Admin accounts stays as it is.
    if (KIND === "supplier" && "paid" in after && !can(req, "users.admin")) throw forbidden();

    upsertLine(db, req, period, supplierId, line, next, undefined);
    audit.log(req, {
      action: `${cfg.statement}.update`,
      entityType: cfg.statement,
      entityId: `${supplierId}:${period}`,
      before,
      after,
    });
    return lineOr404(db, period, supplierId);
  })();
}

// Links an accepted file (lib/files accept()) to the line, replacing (soft-removing) any file
// already there. The caller discards the accepted file when this throws.
function attach(db, req, period, supplierId, accepted) {
  const userId = req && req.user ? req.user.id : null;
  return db.transaction(() => {
    periodOr404(period, sydneyToday());
    const line = lineOr404(db, period, supplierId);
    const old = line.file;
    const fileId = files.insert(db, accepted, userId);
    if (old) files.remove(db, old.id, userId);
    // The old link goes first: file_id is UNIQUE, and the new id is different anyway.
    upsertLine(db, req, period, supplierId, line, fieldsOf(line), fileId);
    audit.log(req, {
      action: `${cfg.statement}.file`,
      entityType: cfg.statement,
      entityId: `${supplierId}:${period}`,
      before: old ? { fileId: old.id, name: old.name } : null,
      after: { fileId, name: accepted.originalName },
    });
    return lineOr404(db, period, supplierId);
  })();
}

// Soft-removes the line's file. 404 when there is none. `fileId` (optional, the file the caller saw)
// closes the Remove race: when given and not the line's current file, 409 with the line, so a
// statement someone else attached meanwhile isn't removed (M9 · 4.3, review P4).
function detach(db, req, period, supplierId, fileId) {
  const userId = req && req.user ? req.user.id : null;
  return db.transaction(() => {
    periodOr404(period, sydneyToday());
    const line = lineOr404(db, period, supplierId);
    if (!line.file) throw notFound();
    if (fileId !== undefined && fileId !== line.file.id) throw conflict(REPLACED, { line });
    files.remove(db, line.file.id, userId);
    upsertLine(db, req, period, supplierId, line, fieldsOf(line), null);
    audit.log(req, {
      action: `${cfg.statement}.file`,
      entityType: cfg.statement,
      entityId: `${supplierId}:${period}`,
      before: { fileId: line.file.id, name: line.file.name },
      after: null,
    });
    return lineOr404(db, period, supplierId);
  })();
}

// Takes the supplier off one month's list (Todd 2026-10-30). Nothing is deleted: the line and its
// file stay in supplier_statements and a supplier_month_removed row hides them. 404 when the
// supplier isn't listed in that month.
function removeLine(db, req, period, supplierId) {
  const userId = req && req.user ? req.user.id : null;
  db.transaction(() => {
    periodOr404(period, sydneyToday());
    const line = lineOr404(db, period, supplierId);
    db.prepare("INSERT INTO supplier_month_removed (supplier_id, period, removed_by, removed_at) VALUES (?, ?, ?, ?)").run(
      supplierId,
      period,
      userId,
      nowIso()
    );
    audit.log(req, {
      action: `${cfg.statement}.remove`,
      entityType: cfg.statement,
      entityId: `${supplierId}:${period}`,
      before: { name: line.supplier.name, ...fieldsOf(line), fileId: line.file ? line.file.id : null },
      after: null,
    });
  })();
  return { ok: true };
}

// How many suppliers listed in `period` are still Waiting (a listed supplier with no row is
// Waiting). For the Friday round-up.
function waitingCount(db, period) {
  if (!Periods.validPeriod(period)) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM suppliers s
         LEFT JOIN supplier_statements st ON st.supplier_id = s.id AND st.period = @period
        WHERE s.kind = @kind
          AND (st.supplier_id IS NOT NULL
               OR (s.from_period <= @period AND (s.archived_from IS NULL OR @period < s.archived_from)))
          AND NOT EXISTS (SELECT 1 FROM supplier_month_removed rm WHERE rm.supplier_id = s.id AND rm.period = @period)
          AND COALESCE(st.state, 'waiting') = 'waiting'`
    )
    .get({ period, kind: KIND });
  return Number(row.n);
}

return { list, create, update, month, outstanding, saveLine, removeLine, attach, detach, waitingCount };
}

// The suppliers (the default export, as before) and the admin accounts (.admin). Only suppliers
// feed the Friday round-up.
module.exports = { ...make(KINDS.supplier), admin: make(KINDS.admin) };
