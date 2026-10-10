// Names of other users for pickers and author labels. See docs/plans/m4-contracts.md
// section 2. Returns only id and display name: never usernames, roles or permissions.
const { usersWithKey } = require("./notify");

// Enabled users holding featureKey, as [{id, displayName}] sorted by displayName.
function withKey(db, featureKey) {
  const ids = new Set(usersWithKey(db, featureKey).map(Number));
  return db
    .prepare("SELECT id, display_name FROM users WHERE disabled = 0 ORDER BY display_name COLLATE NOCASE, id")
    .all()
    .filter((u) => ids.has(Number(u.id)))
    .map((u) => ({ id: u.id, displayName: u.display_name }));
}

// The display name for a user id, or 'Unknown'.
function nameOf(db, userId) {
  if (userId == null) return "Unknown";
  const row = db.prepare("SELECT display_name FROM users WHERE id = ?").get(userId);
  return row ? row.display_name : "Unknown";
}

module.exports = { withKey, nameOf };
