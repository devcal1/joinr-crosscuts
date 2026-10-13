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
];

const ROLES = ["admin", "accounts", "design_pm", "scheduling", "showroom", "workshop", "ordering", "workshop_manager"];

const PRESETS = {
  admin: [...KEYS],
  accounts: [
    "board.view", "jobs.view", "jobs.value", "photos.search", "accounts.view",
    "invoices.edit", "reports.upload", "tasks.use", "messages.use",
    "planner.view", "planner.edit", "orders.view",
  ],
  design_pm: [
    "board.view", "jobs.view", "jobs.edit", "jobs.value", "photos.search",
    "photos.admin", "design.view", "orders.edit", "inspections.edit",
    "scheduling.view", "tasks.use", "messages.use", "planner.view", "planner.edit",
    "orders.view", "orders.receive",
  ],
  scheduling: [
    "board.view", "board.edit", "workers.edit", "jobs.view", "photos.search",
    "scheduling.view", "leave.edit", "tasks.use", "messages.use",
    "planner.view", "planner.edit", "orders.view",
  ],
  showroom: ["photos.search"],
  // M7: the workshop TV and workshop logins (docs/plans/m7-contracts.md section 4).
  workshop: ["board.view", "planner.view"],
  // M10 (docs/plans/m10-contracts.md section 3): Ordering places orders (marking a job's last line
  // ordered makes its progress invoice due); the Workshop Manager receives them, without the job pages.
  ordering: [
    "board.view", "jobs.view", "design.view", "photos.search", "orders.view", "orders.edit",
    "orders.mark_ordered", "orders.receive", "tasks.use", "messages.use", "planner.view", "planner.edit",
    "stock.count", "stock.order",
  ],
  workshop_manager: [
    "board.view", "orders.view", "orders.receive", "tasks.use", "messages.use",
    "planner.view", "planner.edit", "stock.count",
  ],
};

const KEY_SET = new Set(KEYS);

// roles: array of role names. overrides: array of {feature_key, effect} where
// effect is 'grant' or 'revoke'. Unknown roles and unknown keys are ignored.
function computeEffective(roles, overrides) {
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

module.exports = { KEYS, ROLES, PRESETS, computeEffective };
