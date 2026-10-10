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

// Every enabled user whose effective permissions include featureKey.
function usersWithKey(db, featureKey) {
  const users = db.prepare("SELECT id FROM users WHERE disabled = 0").all();
  const rolesOf = db.prepare("SELECT role FROM user_roles WHERE user_id = ?");
  const overridesOf = db.prepare(
    "SELECT feature_key, effect FROM permission_overrides WHERE user_id = ?"
  );
  return users
    .filter((u) => {
      const roles = rolesOf.all(u.id).map((r) => r.role);
      return computeEffective(roles, overridesOf.all(u.id)).has(featureKey);
    })
    .map((u) => u.id);
}

function toKey(db, featureKey, payload) {
  const ids = usersWithKey(db, featureKey);
  for (const id of ids) toUser(db, id, payload);
  return ids.length;
}

module.exports = { toUser, toKey, usersWithKey };
