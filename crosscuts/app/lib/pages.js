// Page -> access table for HTML pages (used by auth.pageGate). Access values
// are the same vocabulary as route access: 'public', 'login', a feature key,
// or an array of keys (any one suffices).
const PAGE_ACCESS = {
  "/": "login",
  "/index.html": "login",
  "/login.html": "public",
  "/setup.html": "public",
  "/schedule.html": "board.view",
  "/workers.html": "workers.edit",
  "/search.html": "photos.search",
  "/admin.html": "photos.admin",
  "/jobs.html": "jobs.view",
  "/job.html": "jobs.view",
  "/pipeline.html": "jobs.view",
  "/orders.html": "orders.view",
  "/deliveries.html": "orders.receive",
  "/users.html": "users.admin",
  "/audit.html": "audit.view",
  "/accounts.html": "accounts.view",
  "/invoice.html": "accounts.view",
  // 0.2.0 (Todd, 2026-10-24): the Projects dashboard moved under the Projects notes wall; the old
  // address redirects there (server.js), still gated by design.view.
  "/design.html": "design.view",
  // 0.2.0 (docs/plans/m20-recurring-tasks.md): recurring tasks, admins only.
  "/admintasks.html": "users.admin",
  // 0.2.0 (docs/plans/m21-benchtop-designer.md): the benchtop designer, its print and its lists.
  "/benchtop.html": "jobs.view",
  "/benchtopprint.html": "jobs.view",
  "/benchtopadmin.html": "users.admin",
  // 0.2.1 (docs/plans/m22-project-jobs.md): a job's project page and its printed order list.
  "/project.html": "jobs.view",
  "/projectorder.html": "jobs.view",
  "/tasks.html": "tasks.use",
  "/messages.html": "messages.use",
  "/reports.html": "accounts.view",
  "/availability.html": "users.admin",
  "/intake.html": "design.view",
  "/planner.html": "planner.view",
  "/payruns.html": "accounts.view",
  "/payrun.html": "accounts.view",
  "/payprint.html": "accounts.view",
  "/bas.html": "accounts.view",
  "/suppliers.html": "accounts.view",
  "/adminaccounts.html": "accounts.view",
  // M11 (docs/plans/m11-contracts.md section 10).
  "/drawers.html": "stock.order",
  "/stock.html": ["stock.count", "stock.order"],
  "/boards.html": ["stock.count", "stock.order"],
  "/paint.html": ["stock.order", "orders.receive"],
  // M12 (docs/plans/m12-contracts.md section 8).
  "/stone.html": "design.view",
  "/stoneprint.html": ["jobs.view", "design.view"],
  "/battens.html": "design.view",
  // 2026-10-18 (Todd): the Projects tools page, which links to the batten calculator.
  "/tools.html": "design.view",
  // M13 (docs/plans/m13-contracts.md section 9).
  "/bonuses.html": "bonuses.manage",
  "/bonusprint.html": "bonuses.manage",
  "/alarms.html": "alarms.manage",
  "/loans.html": "loans.manage",
  "/loanprint.html": "loans.manage",
  // 0.2.4 (docs/plans/m25-contracts.md section 3).
  "/shift.html": "shift.report",
};

// Department notes (docs/plans/notes-contracts.md): anyone holding any of the five department keys
// may open the page; the API checks the key for the department asked for.
// 0.2.0: design.view too, as the Projects page (dept=design) also carries the Projects dashboard.
PAGE_ACCESS["/notes.html"] = [...require("./notes").DEPT_KEYS, "design.view"];

// Any .html page not listed above.
const DEFAULT_PAGE_ACCESS = "login";

function normalise(pathname) {
  let p = String(pathname || "/");
  try {
    p = decodeURIComponent(p);
  } catch {
    // leave undecodable paths as they are; they will not match the table
  }
  return p.toLowerCase();
}

// True for the paths pageGate applies to: "/" or anything ending in .html.
function isPagePath(pathname) {
  const p = normalise(pathname);
  return p === "/" || p.endsWith(".html");
}

// Access required for a page path. Returns null for non-page paths (static
// assets and the like), which are never gated.
function pageAccess(pathname) {
  if (!isPagePath(pathname)) return null;
  const p = normalise(pathname);
  return Object.prototype.hasOwnProperty.call(PAGE_ACCESS, p) ? PAGE_ACCESS[p] : DEFAULT_PAGE_ACCESS;
}

module.exports = { PAGE_ACCESS, DEFAULT_PAGE_ACCESS, isPagePath, pageAccess };
