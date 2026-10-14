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
  "/design.html": "design.view",
  "/scheduling.html": "scheduling.view",
  "/tasks.html": "tasks.use",
  "/messages.html": "messages.use",
  "/reports.html": "accounts.view",
  "/availability.html": "scheduling.view",
  "/lookahead.html": "scheduling.view",
  "/intake.html": "design.view",
  "/planner.html": "planner.view",
  "/payruns.html": "accounts.view",
  "/payrun.html": "accounts.view",
  "/payprint.html": "accounts.view",
  "/bas.html": "accounts.view",
  "/suppliers.html": "accounts.view",
  // M11 (docs/plans/m11-contracts.md section 10).
  "/drawers.html": "stock.order",
  "/stock.html": ["stock.count", "stock.order"],
  "/boards.html": ["stock.count", "stock.order"],
  "/paint.html": ["stock.order", "orders.receive"],
  "/stockvalue.html": "accounts.view",
  // M12 (docs/plans/m12-contracts.md section 8).
  "/stone.html": "design.view",
  "/stoneprint.html": ["jobs.view", "design.view"],
  "/battens.html": "design.view",
};

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
