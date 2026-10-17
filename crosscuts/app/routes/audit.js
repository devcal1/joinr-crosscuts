// /api/audit -- read-only view of audit_log (all routes need audit.view).
const { defineRoutes } = require("../lib/routes");
const db = require("../db");
const { hiddenEntityTypes, noteDeptClause } = require("../lib/audit");

const r = defineRoutes("/api/audit");

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Offset (ms) of Australia/Sydney from UTC at the given instant.
function sydneyOffsetMs(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// UTC ISO string of 00:00 Sydney time on YYYY-MM-DD (plus optional day shift).
function sydneyMidnightUtc(dateStr, addDays = 0) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const localMs = Date.UTC(y, m - 1, d + addDays);
  let utc = localMs - sydneyOffsetMs(localMs);
  utc = localMs - sydneyOffsetMs(utc); // second pass settles DST edges
  return new Date(utc).toISOString();
}

function parseJson(s) {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s);
  } catch (_) {
    return s;
  }
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

// M13 (docs/plans/m13-contracts.md section 3.6): the private entity types the caller may not read,
// as a WHERE clause and its arguments (null when nothing is hidden). Hidden rows count in neither
// rows nor total, and their action names aren't listed.
function hiddenClause(req) {
  const perms = req.user ? req.user.perms : [];
  const hidden = hiddenEntityTypes(perms);
  const parts = [];
  const args = [];
  if (hidden.length) {
    parts.push(`(entity_type IS NULL OR entity_type NOT IN (${hidden.map(() => "?").join(", ")}))`);
    args.push(...hidden);
  }
  // Department notes: only the readers of that note's department see its rows (2026-10-17).
  const notes = noteDeptClause(perms);
  if (notes) {
    parts.push(notes.sql);
    args.push(...notes.args);
  }
  return parts.length ? { sql: parts.join(" AND "), args } : null;
}

r.get("/", "audit.view", (req, res) => {
  const where = [];
  const args = [];
  const hidden = hiddenClause(req);
  if (hidden) {
    where.push(hidden.sql);
    args.push(...hidden.args);
  }

  const actor = str(req.query.actor);
  if (actor) {
    if (/^\d+$/.test(actor)) {
      where.push("actor_user_id = ?");
      args.push(Number(actor));
    } else {
      where.push("actor_label = ? COLLATE NOCASE");
      args.push(actor);
    }
  }
  const action = str(req.query.action);
  if (action) {
    where.push("substr(action, 1, ?) = ?");
    args.push(action.length, action);
  }
  const entityType = str(req.query.entityType);
  if (entityType) {
    where.push("entity_type = ?");
    args.push(entityType);
  }
  const entityId = str(req.query.entityId);
  if (entityId) {
    where.push("entity_id = ?");
    args.push(entityId);
  }

  const from = str(req.query.from);
  if (from) {
    if (DATE_ONLY.test(from)) {
      where.push("at >= ?");
      args.push(sydneyMidnightUtc(from));
    } else if (!Number.isNaN(Date.parse(from))) {
      where.push("at >= ?");
      args.push(new Date(from).toISOString());
    } else {
      return res.status(400).json({ error: "from must be YYYY-MM-DD or an ISO timestamp" });
    }
  }
  const to = str(req.query.to);
  if (to) {
    if (DATE_ONLY.test(to)) {
      // Date-only `to` is inclusive of that whole Sydney day.
      where.push("at < ?");
      args.push(sydneyMidnightUtc(to, 1));
    } else if (!Number.isNaN(Date.parse(to))) {
      where.push("at <= ?");
      args.push(new Date(to).toISOString());
    } else {
      return res.status(400).json({ error: "to must be YYYY-MM-DD or an ISO timestamp" });
    }
  }

  let limit = 100;
  if (req.query.limit !== undefined && req.query.limit !== "") {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1) return res.status(400).json({ error: "limit must be a positive integer" });
    limit = Math.min(limit, 500);
  }
  let offset = 0;
  if (req.query.offset !== undefined && req.query.offset !== "") {
    offset = Number(req.query.offset);
    if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: "offset must be a non-negative integer" });
  }

  const clause = where.length ? " WHERE " + where.join(" AND ") : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log${clause}`).get(...args).n;
  const rows = db
    .prepare(
      `SELECT id, at, actor_user_id, actor_label, action, entity_type, entity_id, before_json, after_json, ip
       FROM audit_log${clause} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset)
    .map((x) => ({
      id: x.id,
      at: x.at,
      actorUserId: x.actor_user_id,
      actorLabel: x.actor_label,
      action: x.action,
      entityType: x.entity_type,
      entityId: x.entity_id,
      before: parseJson(x.before_json),
      after: parseJson(x.after_json),
      ip: x.ip,
    }));
  res.json({ rows, total });
});

r.get("/actions", "audit.view", (req, res) => {
  const hidden = hiddenClause(req);
  const rows = hidden
    ? db.prepare(`SELECT DISTINCT action FROM audit_log WHERE ${hidden.sql} ORDER BY action`).all(...hidden.args)
    : db.prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all();
  res.json(rows.map((x) => x.action));
});

module.exports = r.router;
