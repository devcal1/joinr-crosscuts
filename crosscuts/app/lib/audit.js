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

module.exports = { log };
