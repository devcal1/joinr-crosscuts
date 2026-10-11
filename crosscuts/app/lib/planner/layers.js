// Planner layers: the single source of who sees, posts to and edits each layer
// (docs/plans/m7-contracts.md section 5). Every planner route and the reminder sweep decide
// visibility, posting and editing here; no other file compares role names or layer ids for access.
//
// "Admin" means the admin ROLE (user.roles includes 'admin'), not the users.admin key. Layers follow
// roles: a per-user key override never adds a department layer. planner.view gates seeing anything,
// planner.edit gates any write, and Personal is visible exactly when the user holds planner.edit
// (so workshop logins have no Personal layer). Personal events are the owner's alone, admin included.
//
// Nothing here requires ../../db: the two functions that read take db as their first argument.
const { computeEffective } = require("../permissions");

const LAYERS = ["company", "install", "accounts", "design_pm", "scheduling", "workshop", "personal"];
const LABELS = {
  company: "Company-wide",
  install: "Install & hardware",
  accounts: "Accounts",
  design_pm: "Design/PM",
  scheduling: "Scheduling/Production",
  workshop: "Workshop",
  personal: "Personal",
};

// The department rules (section 5.2). `null` means "everyone with the key"; Personal is handled on
// its own (visible and postable with planner.edit, owner only).
const SEE_ROLES = {
  company: null,
  install: null,
  accounts: ["accounts", "admin"],
  design_pm: ["design_pm", "admin"],
  scheduling: ["scheduling", "admin"],
  workshop: ["scheduling", "workshop", "admin"],
};
const POST_ROLES = {
  company: null,
  install: ["design_pm", "scheduling", "admin"],
  accounts: ["accounts", "admin"],
  design_pm: ["design_pm", "admin"],
  scheduling: ["scheduling", "admin"],
  workshop: ["scheduling", "admin"],
};

// The default layer for a new event, in preference order after admin.
const DEFAULT_ORDER = ["accounts", "design_pm", "scheduling"];

function has(user, key) {
  if (!user) return false;
  const perms = user.perms;
  if (perms instanceof Set) return perms.has(key);
  if (Array.isArray(perms)) return perms.includes(key);
  return false;
}

function rolesOf(user) {
  return user && Array.isArray(user.roles) ? user.roles : [];
}

function holdsAny(user, roles) {
  if (roles === null) return true;
  const mine = rolesOf(user);
  return roles.some((r) => mine.includes(r));
}

function isAdmin(user) {
  return rolesOf(user).includes("admin");
}

// Layer ids the user may see, in LAYERS order.
function visibleLayers(user) {
  if (!user || !has(user, "planner.view")) return [];
  return LAYERS.filter((id) => (id === "personal" ? has(user, "planner.edit") : holdsAny(user, SEE_ROLES[id])));
}

// Layer ids the user may post to, in LAYERS order (always a subset of the visible ones).
function postableLayers(user) {
  if (!user || !has(user, "planner.edit")) return [];
  const visible = visibleLayers(user);
  return visible.filter((id) => (id === "personal" ? true : holdsAny(user, POST_ROLES[id])));
}

// admin -> 'company'; else the first of accounts, design_pm, scheduling that is postable; else
// 'company' if postable; else null.
function defaultLayer(user) {
  const postable = postableLayers(user);
  if (isAdmin(user) && postable.includes("company")) return "company";
  for (const id of DEFAULT_ORDER) if (postable.includes(id)) return id;
  return postable.includes("company") ? "company" : null;
}

function ownerOf(ev) {
  if (!ev) return null;
  if (ev.owner_id !== undefined) return ev.owner_id;
  return ev.ownerId !== undefined ? ev.ownerId : null;
}

// ev: a planner_events row ({layer, owner_id}) or {layer, ownerId}.
function canSee(user, ev) {
  if (!user || !ev || !visibleLayers(user).includes(ev.layer)) return false;
  return ev.layer !== "personal" || ownerOf(ev) === user.id;
}

function canEdit(user, ev) {
  if (!has(user, "planner.edit") || !canSee(user, ev)) return false;
  if (ev.layer === "personal") return ownerOf(ev) === user.id;
  if (ev.layer === "company") return ownerOf(ev) === user.id || isAdmin(user);
  return postableLayers(user).includes(ev.layer);
}

// SQL fragment for the hand-made events query: the visible layers (narrowed by `wanted`, an array of
// ids, when given) and the personal-owner rule. An empty layer set gives {clause: '0', args: []}.
function sqlFilter(user, wanted, alias = "e") {
  let layers = visibleLayers(user);
  if (Array.isArray(wanted)) layers = layers.filter((id) => wanted.includes(id));
  if (layers.length === 0) return { clause: "0", args: [] };
  const a = alias || "e";
  return {
    clause: `(${a}.layer IN (${layers.map(() => "?").join(",")}) AND (${a}.layer <> 'personal' OR ${a}.owner_id = ?))`,
    args: [...layers, user.id],
  };
}

// For GET /api/planner/layers: the visible layers only, in LAYERS order.
function describe(user) {
  const postable = postableLayers(user);
  return {
    layers: visibleLayers(user).map((id) => ({ id, label: LABELS[id], canPost: postable.includes(id) })),
    default: defaultLayer(user),
    canEdit: has(user, "planner.edit"),
  };
}

// For the sweep (no req.user there). Same rule as lib/auth.js loadUser: null when missing or
// disabled.
function userById(db, id) {
  const row = db.prepare("SELECT id FROM users WHERE id = ? AND disabled = 0").get(id);
  if (!row) return null;
  const roles = db
    .prepare("SELECT role FROM user_roles WHERE user_id = ? ORDER BY role")
    .all(row.id)
    .map((r) => r.role);
  const overrides = db
    .prepare("SELECT feature_key, effect FROM permission_overrides WHERE user_id = ?")
    .all(row.id);
  return { id: row.id, roles, perms: computeEffective(roles, overrides) };
}

// Enabled users who can see a non-personal layer, ids ascending. Throws on 'personal' (its only
// reader is the owner) and on an unknown layer.
function usersWhoSee(db, layer) {
  if (layer === "personal") throw new Error("usersWhoSee: the personal layer has no audience");
  if (!LAYERS.includes(layer)) throw new Error(`usersWhoSee: unknown layer ${layer}`);
  const ids = db.prepare("SELECT id FROM users WHERE disabled = 0 ORDER BY id").all().map((r) => r.id);
  if (ids.length === 0) return [];
  const roles = new Map(ids.map((id) => [id, []]));
  for (const r of db.prepare("SELECT user_id, role FROM user_roles ORDER BY role").all()) {
    if (roles.has(r.user_id)) roles.get(r.user_id).push(r.role);
  }
  const overrides = new Map(ids.map((id) => [id, []]));
  for (const o of db.prepare("SELECT user_id, feature_key, effect FROM permission_overrides").all()) {
    if (overrides.has(o.user_id)) overrides.get(o.user_id).push(o);
  }
  return ids.filter((id) => {
    const user = { id, roles: roles.get(id), perms: computeEffective(roles.get(id), overrides.get(id)) };
    return visibleLayers(user).includes(layer);
  });
}

module.exports = {
  LAYERS,
  LABELS,
  visibleLayers,
  postableLayers,
  defaultLayer,
  canSee,
  canEdit,
  sqlFilter,
  describe,
  userById,
  usersWhoSee,
};
