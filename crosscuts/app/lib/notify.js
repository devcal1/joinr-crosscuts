// In-app notifications (the bell). See docs/plans/m2-contracts.md section 2.
// Synchronous; safe inside a caller's db.transaction.
const { computeEffective } = require("./permissions");

function toUser(db, userId, { kind, title, body, link, entityType, entityId }) {
  db.prepare(
    `INSERT INTO notifications (user_id, kind, title, body, link, entity_type, entity_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    kind,
    title,
    body || "",
    link || null,
    entityType || null,
    entityId == null ? null : String(entityId)
  );
}

// Every enabled user whose effective permissions include featureKey. M13
// (docs/plans/m13-contracts.md section 3.2): the owner counts as a holder of every key.
function usersWithKey(db, featureKey) {
  const users = db.prepare("SELECT id, is_owner FROM users WHERE disabled = 0").all();
  const rolesOf = db.prepare("SELECT role FROM user_roles WHERE user_id = ?");
  const overridesOf = db.prepare(
    "SELECT feature_key, effect FROM permission_overrides WHERE user_id = ?"
  );
  return users
    .filter((u) => {
      const roles = rolesOf.all(u.id).map((r) => r.role);
      return computeEffective(roles, overridesOf.all(u.id), Number(u.is_owner) === 1).has(featureKey);
    })
    .map((u) => u.id);
}

// One row for each of those users; returns how many were notified.
// opts.exceptUserId (M3): skip that user even if they hold the key (the actor).
function toKey(db, featureKey, payload, opts = {}) {
  const except = opts && opts.exceptUserId != null ? opts.exceptUserId : null;
  return db.transaction(() => {
    const ids = usersWithKey(db, featureKey).filter((id) => except === null || Number(id) !== Number(except));
    for (const id of ids) toUser(db, id, payload);
    return ids.length;
  })();
}

// M4: one row for each id in userIds (duplicates and opts.exceptUserId skipped).
// opts.dedupeUnread: skip a user who already has an UNREAD row with the same kind,
// entity_type and entity_id. Returns how many were written.
function toUsers(db, userIds, payload, opts = {}) {
  const except = opts && opts.exceptUserId != null ? Number(opts.exceptUserId) : null;
  const entityType = payload.entityType || null;
  const entityId = payload.entityId == null ? null : String(payload.entityId);
  const hasUnread = db.prepare(
    `SELECT 1 FROM notifications
      WHERE user_id = ? AND kind = ? AND entity_type IS ? AND entity_id IS ? AND read_at IS NULL
      LIMIT 1`
  );
  return db.transaction(() => {
    const seen = new Set();
    let n = 0;
    for (const raw of userIds || []) {
      const id = Number(raw);
      if (!Number.isInteger(id) || seen.has(id) || id === except) continue;
      seen.add(id);
      if (opts && opts.dedupeUnread && hasUnread.get(id, payload.kind, entityType, entityId)) continue;
      toUser(db, id, payload);
      n++;
    }
    return n;
  })();
}

module.exports = { toUser, toKey, toUsers, usersWithKey };
