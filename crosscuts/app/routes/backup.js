// Backups (docs/plans/backup-contracts.md section 9). Both routes need users.admin (no new key).
// SCAFFOLD STUBS: both answer 501 until Wave 2 D builds them on lib/backup (status, requestRun).
const { defineRoutes } = require("../lib/routes");

const r = defineRoutes("/api/backup");

const ACCESS = "users.admin";
const NOT_BUILT = { error: "Backups are not built yet." };

// 200 status(db) once built.
r.get("/status", ACCESS, (req, res) => {
  res.status(501).json(NOT_BUILT);
});

// Back up now: 202 / 409 / 429 once built.
r.post("/run", ACCESS, (req, res) => {
  res.status(501).json(NOT_BUILT);
});

module.exports = r.router;
