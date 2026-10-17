// Append-only audit trail. See docs/plans/m1-contracts.md ("Audit").
//
//   log(req, { action, entityType, entityId, before, after, actorId, actorLabel })
//
// Synchronous on purpose: callers inside db.transaction() stay atomic with the
// change they are recording. Never throws -- an audit failure must not break
// the request that triggered it; it is console.error'd instead.

let insertStmt = null;

function stmt() {
  if (!insertStmt) {
    // Required lazily to avoid a load-order cycle (db <- migrate <- ... <- audit).
    const db = require("../db");
    insertStmt = db.prepare(
      `INSERT INTO audit_log (actor_user_id, actor_label, action, entity_type, entity_id, before_json, after_json, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
  }
  return insertStmt;
}

// JSON.stringify that survives circular structures, BigInt and the like.
function toJson(value) {
  if (value === undefined) return null;
  try {
    const s = JSON.stringify(value);
    return s === undefined ? null : s;
  } catch (_) {
    try {
      const seen = new WeakSet();
      return JSON.stringify(value, (k, v) => {
        if (typeof v === "bigint") return v.toString();
        if (v && typeof v === "object") {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        return v;
      });
    } catch (e) {
      return JSON.stringify({ unserializable: String(e && e.message) });
    }
  }
}

function log(req, entry) {
  try {
    const e = entry || {};
    if (typeof e.action !== "string" || !e.action) {
      console.error("[audit] entry skipped: action is required");
      return;
    }
    const user = req && req.user ? req.user : null;
    let actorId = e.actorId !== undefined ? e.actorId : user ? user.id : null;
    if (actorId === undefined) actorId = null;
    const actorLabel =
      e.actorLabel !== undefined && e.actorLabel !== null
        ? String(e.actorLabel)
        : user && user.username
          ? String(user.username)
          : req && req.actorLabel
            ? String(req.actorLabel) // a system actor, e.g. lib/intake's SYSTEM_REQ
            : "system";
    const params = [
      actorId,
      actorLabel,
      e.action,
      e.entityType === undefined || e.entityType === null ? null : String(e.entityType),
      e.entityId === undefined || e.entityId === null ? null : String(e.entityId),
      toJson(e.before),
      toJson(e.after),
      req && req.ip ? String(req.ip) : null,
    ];
    try {
      stmt().run(...params);
    } catch (err) {
      // An actor id that is not a real user trips the FK; keep the record anyway.
      if (actorId !== null && /FOREIGN KEY/i.test(String(err && err.message))) {
        params[0] = null;
        params[1] = `${actorLabel} (id ${actorId})`;
        stmt().run(...params);
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error("[audit] failed to write audit entry:", err && err.message ? err.message : err);
  }
}

// M13 (docs/plans/m13-contracts.md section 3.6): entity types whose audit rows only the matching
// key's holders may read. A new private area needs only a line here.
const PRIVATE_ENTITY_TYPES = Object.freeze({
  bonus: "bonuses.manage",
  bonus_settings: "bonuses.manage",
  alarm_slot: "alarms.manage",
  alarm_company: "alarms.manage",
  alarm_times: "alarms.manage",
  loan: "loans.manage",
});

// The private entity types the user may NOT read (perms: a Set or an array of keys).
function hiddenEntityTypes(perms) {
  const has =
    perms instanceof Set
      ? (k) => perms.has(k)
      : Array.isArray(perms)
        ? (k) => perms.includes(k)
        : () => false;
  return Object.keys(PRIVATE_ENTITY_TYPES).filter((t) => !has(PRIVATE_ENTITY_TYPES[t]));
}

// Department notes (Todd, 2026-10-17): a note's audit rows (entity dept_note: note.create, update,
// remove, ack, unack) are shown only to readers who hold that note's department key
// (notes.<dept>). Every such row carries the department in its before or after JSON.
const NOTE_ENTITY_TYPE = "dept_note";

// The department ids whose notes the user may read (perms: a Set or an array of keys).
function heldNoteDepts(perms) {
  const has =
    perms instanceof Set
      ? (k) => perms.has(k)
      : Array.isArray(perms)
        ? (k) => perms.includes(k)
        : () => false;
  // Lazy, so audit.js stays free of a load-order cycle with notes.js (which requires audit).
  return require("./notes").DEPT_IDS.filter((d) => has("notes." + d));
}

// WHERE clause (for audit_log) that drops the note rows of departments the user does not hold;
// null when every department is held.
function noteDeptClause(perms) {
  const held = heldNoteDepts(perms);
  if (held.length === require("./notes").DEPT_IDS.length) return null;
  if (!held.length) return { sql: `entity_type IS NOT '${NOTE_ENTITY_TYPE}'`, args: [] };
  const dept = `COALESCE(json_extract(CASE WHEN json_valid(after_json) THEN after_json END, '$.dept'),
    json_extract(CASE WHEN json_valid(before_json) THEN before_json END, '$.dept'))`;
  return {
    sql: `(entity_type IS NOT '${NOTE_ENTITY_TYPE}' OR ${dept} IN (${held.map(() => "?").join(", ")}))`,
    args: held,
  };
}

module.exports = { log, PRIVATE_ENTITY_TYPES, hiddenEntityTypes, noteDeptClause };
