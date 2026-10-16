// The admin accounts API (docs/plans/m9-contracts.md section 13): the same routes as supplier
// accounts, on /api/admin-accounts, for the accounts that aren't regular suppliers (BAS, Workcover,
// insurance). Built by lib/statement-routes.js over lib/suppliers.js's admin kind.
const suppliers = require("../lib/suppliers");
const build = require("../lib/statement-routes");

module.exports = build("/api/admin-accounts", suppliers.admin, "[admin-accounts]");
