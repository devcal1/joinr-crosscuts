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
// A body express.json can't parse answers as the routes do, and is never logged: Express's
// default handler would log part of the body, which may hold an alarm code (M13 contracts §1).
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "JSON body required" });
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Request too large" });
  return next(err);
});
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
// 0.2.0 (Todd, 2026-10-24): the Projects dashboard now sits under the Projects notes wall.
app.get("/design.html", (req, res) => res.redirect(302, "/notes.html?dept=design"));
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
  require("./routes/jobnotes"), // jobs-tradify-contracts 4.1
  require("./routes/audit"),
  require("./routes/dashboard"),
  require("./routes/meta"),
  require("./routes/invoices"),
  require("./routes/notifications"),
  require("./routes/settings"),
  require("./routes/orders"),
  require("./routes/inspections"),
  require("./routes/people"),
  require("./routes/files"),
  require("./routes/tasks"),
  require("./routes/comments"),
  require("./routes/messages"),
  require("./routes/reports"),
  require("./routes/availability"),
  require("./routes/joinr"),
  require("./routes/pipeline"),
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
  // M12 (docs/plans/m12-contracts.md section 5).
  require("./routes/stone"),
  // M13 (docs/plans/m13-contracts.md section 7).
  require("./routes/bonuses"),
  require("./routes/alarms"),
  require("./routes/loans"),
  // Department notes (docs/plans/notes-contracts.md).
  require("./routes/notes"),
  // The job's Materials list (docs/plans/materials-contracts.md).
  require("./routes/materials"),
  // The job's "From Joinr quote" (task J4; money only for jobs.value).
  require("./routes/joinr-quote"),
  // Recurring tasks, Admin > Tasks (0.2.0, docs/plans/m20-recurring-tasks.md).
  require("./routes/recurring"),
  // Benchtop designer (0.2.0, docs/plans/m21-benchtop-designer.md).
  require("./routes/benchtop"),
  // Project jobs (0.2.1, docs/plans/m22-project-jobs.md).
  require("./routes/projectjobs"),
  // Projects steps and hand-offs (0.2.2, docs/plans/m23-contracts.md).
  require("./routes/projectsteps"),
  // Board placement and money triggers (0.2.3, docs/plans/m24-contracts.md).
  require("./routes/handoffs"),
  // Workshop end-of-shift report and job issues (0.2.4, docs/plans/m25-contracts.md).
  require("./routes/shift"),
  // Morning check, Confirm complete and Waiting on you (0.2.5, docs/plans/m26-contracts.md).
  require("./routes/morning"),
  // Workshop manager: maintenance, board and edge stock, reservations (0.2.6, docs/plans/m27-contracts.md).
  require("./routes/maintenance"),
  require("./routes/reservations"),
  // 0.2.7 (docs/plans/m28-contracts.md): vehicles, individual invoices, follow-up.
  require("./routes/vehicles"),
  require("./routes/payables"),
  require("./routes/followup"),
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
  // The weekday end-of-shift reminder (SHIFT_REMINDER_DISABLED=1 turns it off).
  require("./lib/shift").start(require("./db"));
  // Recurring tasks: make the due occurrences at boot and hourly (RECURRING_DISABLED=1 turns it off).
  try {
    require("./lib/recurring").start(require("./db"));
  } catch (e) {
    console.error(`[recurring] failed to start (${safeCode(e)})`);
  }
  // 0.2.7: the 7:00 weekday accounts sweep (ACCOUNTS_SWEEP_DISABLED=1 turns it off).
  try {
    require("./lib/accountsweep").start(require("./db"));
  } catch (e) {
    console.error(`[accounts] sweep failed to start (${safeCode(e)})`);
  }
  // The "needs a project owner" sweep, at boot and every 5 minutes (OWNER_SWEEP_DISABLED=1 turns it off).
  require("./lib/projectsteps").start(require("./db"));
  // The Joinr intake pull, every 5 minutes once a key is set (JOINR_SYNC_DISABLED=1 turns it off).
  require("./lib/joinr-sync").start(require("./db"));
  // Joinr's open-quotes list (sent and won quotes for the Pipeline), same schedule (J3, 0.1.20).
  require("./lib/joinr-open-quotes").start(require("./db"));
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
