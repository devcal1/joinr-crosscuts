const path = require("path");
const express = require("express");
const { UPLOADS_DIR } = require("./lib/config");
const auth = require("./lib/auth");
const { assertAllRoutesGuarded } = require("./lib/routes");

// Opening ./db also runs the migrations (and the first-run worker seed), so a
// bad migration stops the process here, before it listens.
require("./db");

const app = express();
// umbrelOS 2.0's app gateway is exactly one hop in front of us and SETS (not
// appends) X-Forwarded-For to the real client socket address, so trusting one
// hop gives req.ip = the real device (used for login rate limits and audit).
app.set("trust proxy", 1);

// Middleware order is part of the contract (docs/plans/m1-contracts.md).
app.use(express.json());
app.get("/healthz", (req, res) => res.json({ ok: true }));
app.use(auth.originCheck);
app.use(auth.authenticate);
app.use(auth.pageGate);
// /photos serves top-level image files only (M4, docs/plans/m4-contracts.md section 8).
// UPLOADS_DIR also holds the private files/ folder, which must never be reachable here:
// anything that isn't a plain image name (subfolders, dotfiles, directories) is 404.
const PHOTO_PATH = /^\/[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp|gif)$/i;
app.use(
  "/photos",
  auth.requireLogin,
  (req, res, next) => (PHOTO_PATH.test(req.path) ? next() : res.status(404).type("text/plain").send("Not found")),
  express.static(UPLOADS_DIR, {
    cacheControl: false,
    index: false,
    redirect: false,
    dotfiles: "ignore",
    setHeaders: (res) => res.setHeader("Cache-Control", "private, max-age=2592000, immutable"),
  })
);
app.use(express.static(path.join(__dirname, "public")));

// Each router module is a defineRoutes() router and carries its own prefix.
// Order matters within /api: photos first, then schedule (as in the old
// single-file server).
const routers = [
  require("./routes/photos"),
  require("./routes/schedule"),
  require("./routes/auth"),
  require("./routes/users"),
  require("./routes/jobs"),
  require("./routes/audit"),
  require("./routes/dashboard"),
  require("./routes/meta"),
  require("./routes/invoices"),
  require("./routes/notifications"),
  require("./routes/settings"),
  require("./routes/orders"),
  require("./routes/inspections"),
  require("./routes/scheduling"),
  require("./routes/people"),
  require("./routes/files"),
  require("./routes/tasks"),
  require("./routes/comments"),
  require("./routes/messages"),
  require("./routes/reports"),
  require("./routes/availability"),
  require("./routes/joinr"),
  require("./routes/backup"),
  require("./routes/planner"),
  require("./routes/payruns"),
  require("./routes/bas"),
  require("./routes/suppliers"),
  // M11 (docs/plans/m11-contracts.md sections 6-8).
  require("./routes/drawers"),
  require("./routes/stock"),
  require("./routes/boards"),
  require("./routes/paint"),
];
for (const router of routers) app.use(router.ccPrefix, router);

// Refuse to start if any /api route was registered without an access rule.
try {
  assertAllRoutesGuarded(app);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Crosscuts web listening on port ${PORT}`);
  // The Friday invoice round-up timer (ROUNDUP_DISABLED=1 turns it off).
  require("./lib/roundup").start(require("./db"));
  // The weekday 7:00 Sydney task reminder (REMINDER_DISABLED=1 turns it off).
  require("./lib/tasks").startReminder(require("./db"));
  // The Joinr intake pull, every 5 minutes once a key is set (JOINR_SYNC_DISABLED=1 turns it off).
  require("./lib/joinr-sync").start(require("./db"));
  // Backups: the nightly snapshot and the Saturday copy to the NAS (BACKUP_DISABLED=1 turns it
  // all off). Wrapped so nothing it does at start can ever stop the board: only a safe error code
  // is logged (docs/plans/backup-contracts.md section 11.3).
  try {
    Promise.resolve(require("./lib/backup").start(require("./db"))).catch((e) =>
      console.error(`[backup] start failed (${safeCode(e)})`)
    );
  } catch (e) {
    console.error(`[backup] start failed (${safeCode(e)})`);
  }
  // The planner reminder sweep, every 60 s (PLANNER_REMINDER_DISABLED=1 turns it off). Wrapped so a
  // fault at start can never stop the board (docs/plans/m7-contracts.md section 10).
  try {
    require("./lib/planner/reminders").startReminders(require("./db"));
  } catch (e) {
    console.error(`[planner] reminder sweep failed to start: ${e && e.message ? e.message : safeCode(e)}`);
  }
});

// An error's system code or class name when it has that shape, else "unknown": never a message.
function safeCode(e) {
  if (e && typeof e.code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(e.code)) return e.code;
  if (e && typeof e.name === "string" && /^[A-Z][A-Za-z]{0,38}Error$/.test(e.name)) return e.name;
  return "unknown";
}
