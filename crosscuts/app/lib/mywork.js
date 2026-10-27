// Waiting on you (0.2.5, docs/plans/m26-contracts.md section 4): the dashboard's "Waiting on you"
// tile. One line per thing waiting on the signed-in person, by what their keys let them do; only
// lines with something in them are returned. Accounts keeps its own dashboard line.
//
// Every function takes db first; nothing here requires ../db.
const projectsteps = require("./projectsteps");
const handoffs = require("./handoffs");
const morning = require("./morning");
const completion = require("./completion");
const jobstage = require("./jobstage");
const { can } = require("./httperror");
const { sydneyToday, sydneyMonday, sydneyParts } = require("./time");

const DAYS = [null, "mon", "tue", "wed", "thu", "fri", null, null];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function projectLines(db, req, out) {
  const me = req.user.id;
  const owned = db.prepare("SELECT * FROM jobs WHERE archived = 0 AND project_owner_id = ?").all(me);
  let steps = 0;
  let noDate = 0;
  for (const j of owned) {
    const shown = jobstage.pipelineStage(j);
    if (shown === "won" || shown === "projects") {
      if (projectsteps.marksOf(db, j.id).marks.some((m) => !m.done)) steps++;
    }
    if (["won", "projects", "ordering"].includes(shown) && !j.requested_install_date) noDate++;
  }
  if (steps) out.push({ key: "steps", text: `${plural(steps, "project", "projects")} with steps to do`, count: steps, href: "/notes.html?dept=design" });
  if (noDate) out.push({ key: "noRequested", text: `${plural(noDate, "project", "projects")} with no requested install date`, count: noDate, href: "/notes.html?dept=design" });
  // Installs to confirm: your own jobs; an admin sees every one.
  const admin = can(req, "users.admin");
  const awaiting = db
    .prepare(`SELECT * FROM jobs WHERE installed_date IS NOT NULL ${admin ? "" : "AND project_owner_id = ?"}`)
    .all(...(admin ? [] : [me]))
    .filter(completion.awaitingConfirm);
  if (awaiting.length) {
    out.push({
      key: "toConfirm",
      text: `${plural(awaiting.length, "install", "installs")} to confirm complete`,
      count: awaiting.length,
      href: awaiting.length === 1 ? `/project.html?id=${awaiting[0].id}#confirmComplete` : "/pipeline.html",
    });
  }
  const issues = db
    .prepare("SELECT COUNT(*) AS n FROM job_issues i JOIN jobs j ON j.id = i.job_id WHERE i.status = 'open' AND j.project_owner_id = ?")
    .get(me).n;
  if (issues) out.push({ key: "myIssues", text: `${plural(issues, "open issue", "open issues")} on your projects`, count: issues, href: "/notes.html?dept=design" });
}

function orderLines(db, out) {
  const c = db
    .prepare(
      `SELECT SUM(CASE WHEN o.status = 'to_order' AND NOT EXISTS (SELECT 1 FROM stock_reservations r WHERE r.order_id = o.id
                     AND r.covers = 1 AND r.status IN ('reserved', 'confirmed', 'cut')) THEN 1 ELSE 0 END) AS toOrder,
              SUM(CASE WHEN o.status = 'ordered' AND o.expected_date IS NULL THEN 1 ELSE 0 END) AS noEta
         FROM orders o JOIN jobs j ON j.id = o.job_id WHERE j.archived = 0`
    )
    .get();
  const toOrder = Number(c.toOrder) || 0;
  const noEta = Number(c.noEta) || 0;
  if (toOrder) out.push({ key: "toOrder", text: `${plural(toOrder, "line", "lines")} to order`, count: toOrder, href: "/orders.html" });
  if (noEta) out.push({ key: "noEta", text: `${plural(noEta, "ordered line", "ordered lines")} with no expected date`, count: noEta, href: "/orders.html" });
}

function scheduleLines(db, out, now) {
  const p = sydneyParts(now);
  if (p.weekday <= 5 && !morning.doneToday(db, p.date)) {
    out.push({ key: "morning", text: "Morning check not done today", count: 1, href: "/notes.html?dept=scheduling#morningCheck" });
  }
  const need = handoffs.needsInstall(db).length;
  if (need) out.push({ key: "needsInstall", text: `${plural(need, "job needs", "jobs need")} an install date`, count: need, href: "/notes.html?dept=scheduling#needsInstall" });
  const issues = db.prepare("SELECT COUNT(*) AS n FROM job_issues WHERE status = 'open'").get().n;
  if (issues) out.push({ key: "issues", text: `${plural(issues, "open job issue", "open job issues")}`, count: issues, href: "/notes.html?dept=scheduling#morningCheck" });
}

function shiftLines(db, req, out, now) {
  const p = sydneyParts(now);
  const day = DAYS[p.weekday];
  const u = db.prepare("SELECT worker_id FROM users WHERE id = ?").get(req.user.id);
  if (!day || !u || u.worker_id == null) return;
  const onBoard = db
    .prepare(
      `SELECT 1 FROM assignments a JOIN week_rows wr ON wr.id = a.week_row_id
        WHERE a.worker_id = ? AND a.day = ? AND wr.week_start = ? LIMIT 1`
    )
    .get(u.worker_id, day, sydneyMonday(p.date));
  if (!onBoard) return;
  const sent = db.prepare("SELECT 1 FROM shift_reports WHERE user_id = ? AND date = ?").get(req.user.id, p.date);
  if (!sent) out.push({ key: "shiftReport", text: "End-of-shift report not sent today", count: 1, href: "/shift.html" });
}

// 0.2.6 (docs/plans/m27-contracts.md section 6): the workshop manager's lines, for
// maintenance.manage holders (the workshop manager and admins). Vehicle bookings come with M28.
function workshopLines(db, out, now) {
  const today = sydneyToday(now);
  const due = require("./stock").stockCountDue(db, today);
  if (due) {
    out.push({ key: "stockCount", text: `Stock count ${due.label}${due.overdue ? " overdue" : " due"}`, count: 1, href: `/stock.html?period=${due.period}#count` });
  }
  const m = require("./maintenance").dueCounts(db, today);
  if (m.overdue) out.push({ key: "maintenanceOverdue", text: `${plural(m.overdue, "maintenance item", "maintenance items")} overdue`, count: m.overdue, href: "/maintenance.html" });
  if (m.due) out.push({ key: "maintenanceDue", text: `${plural(m.due, "maintenance item", "maintenance items")} due today`, count: m.due, href: "/maintenance.html" });
  const r = require("./reservations").counts(db);
  if (r.toLabel) out.push({ key: "toLabel", text: `${plural(r.toLabel, "reservation", "reservations")} to label as reserved`, count: r.toLabel, href: "/reserve.html" });
  if (r.toCut) out.push({ key: "toCut", text: `${plural(r.toCut, "job", "jobs")} to mark cut 100% at end of shift`, count: r.toCut, href: "/reserve.html#cut" });
  const d = require("./orders").deliveries(db, today);
  const n = (Number(d.counts.overdue) || 0) + (Number(d.counts.today) || 0);
  if (n) out.push({ key: "deliveries", text: `${plural(n, "delivery", "deliveries")} to receive`, count: n, href: "/deliveries.html" });
}

function linesFor(db, req, now = new Date()) {
  const out = [];
  if (can(req, "design.view")) projectLines(db, req, out);
  if (can(req, "orders.mark_ordered")) orderLines(db, out);
  if (can(req, "board.edit")) scheduleLines(db, out, now);
  if (can(req, "shift.report")) shiftLines(db, req, out, now);
  if (can(req, "maintenance.manage")) workshopLines(db, out, now);
  return { date: sydneyToday(now), items: out };
}

module.exports = { linesFor };
