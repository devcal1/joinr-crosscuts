// Board placement and money triggers (0.2.3, Todd 2026-10-26; docs/plans/m24-contracts.md).
//
// Send to Ordering (lib/projectjobs.js send) raises the 10% deposit and places the job on the board
// N weeks out (board.lead_weeks), in Manufacturing, with nobody on it. While a job on the board
// still has lines to order it shows as "On board (ordering)". When the last line is ordered (the
// all-ordered rule in lib/orders.js, which already makes the 50% due) a job still at Projects or
// Ordering moves to Ready to cut and the schedule managers (board.edit) are asked for an install
// date; the Scheduling notes wall lists the jobs that need one and confirms it. Every weekday at
// 7:00 the order managers are nudged about lines with no expected date and lines that are late.
//
// Every function takes db first; nothing here requires ../db.
const audit = require("./audit");
const notify = require("./notify");
const settings = require("./settings");
const invoices = require("./invoices");
const jobstage = require("./jobstage");
const { bad, notFound, HttpError } = require("./httperror");
const { sydneyToday, sydneyMonday, addDays } = require("./time");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const userId = (req) => (req && req.user && req.user.id != null ? req.user.id : null);

function dMonY(date) {
  const [y, m, d] = String(date).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

function leadWeeks(db) {
  const n = Number(settings.get(db, "board.lead_weeks"));
  return Number.isInteger(n) && n >= 0 && n <= 12 ? n : 2;
}

// ---- Send to Ordering -----------------------------------------------------------------------

// A manufacturing row in the week of Monday(today) + lead weeks, unless the lead is 0 or the job
// already has a row this week or later. Returns {weekStart, rowId} or null.
function autoPlace(db, req, jobId) {
  const lead = leadWeeks(db);
  if (lead === 0) return null;
  if (jobstage.hasCurrentOrFutureRows(db, jobId)) return null;
  const weekStart = addDays(sydneyMonday(), 7 * lead);
  const rowId = Number(require("./boardrows").addRow(db, req, jobId, weekStart, "manufacturing"));
  audit.log(req, { action: "board.autoplace", entityType: "job", entityId: jobId, after: { weekStart, rowId, panel: "manufacturing", leadWeeks: lead } });
  return { weekStart, rowId };
}

// Inside the send transaction, after the job has moved to Ordering: the deposit first (so the
// board-placement fallback finds it and stays quiet), then the board row.
function onSent(db, req, jobId) {
  const deposit = invoices.onOrderListSent(db, jobId, req);
  const placed = autoPlace(db, req, jobId);
  return { deposit, placed };
}

// ---- On board (ordering) -------------------------------------------------------------------

// True while a job on the board still has order lines to order.
function boardOrdering(db, job) {
  if (!job || job.stage !== "on_board") return false;
  return !!db.prepare("SELECT 1 AS x FROM orders WHERE job_id = ? AND status = 'to_order' LIMIT 1").get(job.id);
}

// ---- All ordered ---------------------------------------------------------------------------

// Called by the all-ordered rule the first time it fires for a job (lib/orders.js).
function onAllOrdered(db, req, jobId) {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) return;
  let moved = false;
  if (job.stage === "design_ordering") {
    try {
      moved = jobstage.moveStage(db, jobId, { stage: "ready_to_cut", from: "design_ordering" }, req).changed;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
  }
  const req2 = job.requested_install_date ? dMonY(job.requested_install_date) : "not given";
  notify.toKey(
    db,
    "board.edit",
    {
      kind: "job.all_ordered",
      title: `All ordered for ${job.name}. Requested install ${req2}: set the install date.`,
      link: "/notes.html?dept=scheduling#needsInstall",
      entityType: "job",
      entityId: jobId,
    },
    { exceptUserId: userId(req) }
  );
  return moved;
}

// ---- Needs install date --------------------------------------------------------------------

// Live jobs with every order line ordered (at least one, none to order) and no promised install
// date, by requested date (none last).
function needsInstall(db) {
  return db
    .prepare(
      `SELECT j.id, j.name, j.client_name, j.stage, j.sent_to_ordering_at, j.requested_install_date,
              (SELECT MAX(o.expected_date) FROM orders o WHERE o.job_id = j.id AND o.status IN ('ordered','received')) AS eta
         FROM jobs j
        WHERE j.archived = 0 AND j.promised_install_date IS NULL
          AND (j.stage IS NULL OR j.stage NOT IN ('complete','invoiced','lost','archived'))
          AND EXISTS (SELECT 1 FROM orders o WHERE o.job_id = j.id AND o.status <> 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.job_id = j.id AND o.status = 'to_order')
        ORDER BY (j.requested_install_date IS NULL), j.requested_install_date, j.name COLLATE NOCASE, j.id`
    )
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      clientName: r.client_name || null,
      pipelineStage: jobstage.pipelineStage(r),
      requestedInstallDate: r.requested_install_date || null,
      latestEta: r.eta || null,
      // 0.2.4 (docs/plans/m25-contracts.md section 4).
      openIssues: require("./issues").openCount(db, r.id),
    }));
}

// Sets the promised (confirmed) install date. Audited job.update.
function confirmInstall(db, req, jobId, date) {
  if (!invoices.validDate(date)) throw bad("date must be a valid YYYY-MM-DD date");
  return db.transaction(() => {
    const job = db.prepare("SELECT id, promised_install_date FROM jobs WHERE id = ?").get(jobId);
    if (!job) throw notFound();
    if (job.promised_install_date === date) return false;
    db.prepare("UPDATE jobs SET promised_install_date = ?, updated_at = ? WHERE id = ?").run(date, new Date().toISOString(), jobId);
    audit.log(req, {
      action: "job.update",
      entityType: "job",
      entityId: jobId,
      before: { promised_install_date: job.promised_install_date },
      after: { promised_install_date: date, via: "confirm_install" },
    });
    return true;
  })();
}

// ---- The 7:00 ETA nudge --------------------------------------------------------------------

// Counts of ordered lines with no expected date and of lines past their expected date and not
// received (live jobs only). When either is above 0, each order manager gets one bell row for the
// day. Returns how many were sent. Runs inside the task reminder's transaction (lib/tasks.js).
function etaNudge(db, today = sydneyToday()) {
  const c = db
    .prepare(
      `SELECT SUM(CASE WHEN o.status = 'ordered' AND o.expected_date IS NULL THEN 1 ELSE 0 END) AS missing,
              SUM(CASE WHEN o.status IN ('to_order','ordered') AND o.expected_date < ? THEN 1 ELSE 0 END) AS late
         FROM orders o JOIN jobs j ON j.id = o.job_id WHERE j.archived = 0`
    )
    .get(today);
  const missing = Number(c.missing) || 0;
  const late = Number(c.late) || 0;
  if (!missing && !late) return 0;
  const parts = [];
  if (missing) parts.push(`${missing} ordered ${missing === 1 ? "line has" : "lines have"} no expected date`);
  if (late) parts.push(`${late} ${late === 1 ? "line is" : "lines are"} past the expected date`);
  return notify.toUsers(
    db,
    notify.usersWithKey(db, "orders.mark_ordered"),
    { kind: "orders.eta_nudge", title: parts.join("; "), link: "/orders.html", entityType: "reminder", entityId: today },
    { dedupeUnread: true }
  );
}

module.exports = { leadWeeks, autoPlace, onSent, boardOrdering, onAllOrdered, needsInstall, confirmInstall, etaNudge };
