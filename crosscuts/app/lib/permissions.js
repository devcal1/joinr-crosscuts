// Feature keys and role presets. Role -> key mappings live in code (they ship
// with releases); the DB only stores which roles a user has and per-user
// grant/revoke overrides. See docs/plans/m1-contracts.md.
const KEYS = [
  "board.view",
  "board.edit",
  "workers.edit",
  "jobs.view",
  "jobs.edit",
  "jobs.value",
  "photos.search",
  "photos.admin",
  "accounts.view",
  "invoices.edit",
  "reports.upload",
  "design.view",
  "orders.edit",
  "orders.mark_ordered",
  "inspections.edit",
  "scheduling.view",
  "leave.edit",
  "tasks.use",
  "messages.use",
  "planner.view",
  "planner.edit",
  "users.admin",
  "audit.view",
  // M10 (docs/plans/m10-contracts.md section 3): see order lines without the job pages; receive
  // deliveries and write delivery notes.
  "orders.view",
  "orders.receive",
  // M11 (docs/plans/m11-contracts.md section 3): count stock and boards; run the ordering pages
  // (drawer order, stock order, paint order, the lists and board prices).
  "stock.count",
  "stock.order",
  // M13 (docs/plans/m13-contracts.md section 3): owner-only keys (OWNER_ONLY_KEYS below).
  "bonuses.manage",
  "alarms.manage",
  "loans.manage",
  // Department notes (docs/plans/notes-contracts.md section 2): one key per department, so the
  // weekly Notes sheet is open only to that department.
  "notes.scheduling",
  "notes.design",
  "notes.ordering",
  "notes.accounts",
  "notes.admin",
];

// M13 (docs/plans/m13-contracts.md section 3): owner-only keys. The admin preset doesn't get them;
// the owner holds every key; only the owner grants or revokes them.
const OWNER_ONLY_KEYS = ["bonuses.manage", "alarms.manage", "loans.manage"];
const OWNER_ONLY_SET = new Set(OWNER_ONLY_KEYS);

const ROLES = ["admin", "accounts", "design_pm", "scheduling", "showroom", "workshop", "ordering", "workshop_manager"];

const PRESETS = {
  // M13: every key except the owner-only ones (32 keys).
  admin: KEYS.filter((k) => !OWNER_ONLY_SET.has(k)),
  accounts: [
    "board.view", "jobs.view", "jobs.value", "photos.search", "accounts.view",
    "invoices.edit", "reports.upload", "tasks.use", "messages.use",
    "planner.view", "planner.edit", "orders.view", "notes.accounts",
  ],
  design_pm: [
    "board.view", "jobs.view", "jobs.edit", "jobs.value", "photos.search",
    "photos.admin", "design.view", "orders.edit", "inspections.edit",
    "scheduling.view", "tasks.use", "messages.use", "planner.view", "planner.edit",
    "orders.view", "orders.receive", "notes.design",
  ],
  scheduling: [
    "board.view", "board.edit", "workers.edit", "jobs.view", "photos.search",
    "scheduling.view", "leave.edit", "tasks.use", "messages.use",
    "planner.view", "planner.edit", "orders.view", "notes.scheduling",
  ],
  showroom: ["photos.search"],
  // M7: the workshop TV and workshop logins (docs/plans/m7-contracts.md section 4).
  workshop: ["board.view", "planner.view"],
  // M10 (docs/plans/m10-contracts.md section 3): Ordering places orders (marking a job's last line
  // ordered makes its progress invoice due); the Workshop Manager receives them, without the job pages.
  ordering: [
    "board.view", "jobs.view", "design.view", "photos.search", "orders.view", "orders.edit",
    "orders.mark_ordered", "orders.receive", "tasks.use", "messages.use", "planner.view", "planner.edit",
    "stock.count", "stock.order", "notes.ordering",
  ],
  workshop_manager: [
    "board.view", "orders.view", "orders.receive", "tasks.use", "messages.use",
    "planner.view", "planner.edit", "stock.count", "notes.ordering",
  ],
};

const KEY_SET = new Set(KEYS);

// roles: array of role names. overrides: array of {feature_key, effect} where
// effect is 'grant' or 'revoke'. Unknown roles and unknown keys are ignored.
// isOwner true (M13, docs/plans/m13-contracts.md section 3.1): every key, whatever the roles and
// overrides.
function computeEffective(roles, overrides, isOwner = false) {
  if (isOwner) return new Set(KEYS);
  const effective = new Set();
  for (const role of roles || []) {
    for (const key of PRESETS[role] || []) effective.add(key);
  }
  for (const o of overrides || []) {
    if (!o || !KEY_SET.has(o.feature_key)) continue;
    if (o.effect === "grant") effective.add(o.feature_key);
    else if (o.effect === "revoke") effective.delete(o.feature_key);
  }
  return effective;
}

module.exports = { KEYS, ROLES, PRESETS, OWNER_ONLY_KEYS, computeEffective };
