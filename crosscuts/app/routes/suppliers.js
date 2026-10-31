// The supplier accounts API (docs/plans/m9-contracts.md section 7.2). The routes are built by
// lib/statement-routes.js, shared with nothing now (admin accounts were folded in by migration 054).
const suppliers = require("../lib/suppliers");
const build = require("../lib/statement-routes");

module.exports = build("/api/suppliers", suppliers, "[suppliers]");
