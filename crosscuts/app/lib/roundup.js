// The Friday 12:00 Sydney invoice round-up. See docs/plans/m2-contracts.md
// section 2. Once a week it tells every invoices.edit holder what is waiting
// to be issued, what is overdue and what is not yet in MYOB, and (M9,
// docs/plans/m9-contracts.md section 7.5) how many supplier statements are
// still waiting for the previous month.
const settings = require("./settings");
const notify = require("./notify");
const invoices = require("./invoices");
const suppliers = require("./suppliers");
const Periods = require("../public/periods");
const { latestFridayNoon, sydneyToday } = require("./time");

const CHECK_MS = 60 * 1000;
const OLDEST_N = 5;
const KIND_LABEL = { deposit: "deposit", progress: "progress", final: "final", extra: "extra" };

// The Friday date to run for, or null if this Friday's round-up already ran.
function shouldRun(now, lastRun) {
  const friday = latestFridayNoon(now);
  return friday === lastRun ? null : friday;
}

function dollars(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

// Counts and totals straight from the invoices table.
function buildSummary(db, today) {
  // A due invoice is still a draft: its amount is the sum of its custom lines,
  // or the suggested split of the job value.
  const dueRows = db
    .prepare(
      `SELECT i.id, i.kind, i.lines_custom, i.became_due_date, i.created_at,
              j.name AS job_name, j.value_cents,
              (SELECT SUM(amount_cents) FROM invoice_lines l WHERE l.invoice_id = i.id) AS lines_sum
         FROM invoices i JOIN jobs j ON j.id = i.job_id
        WHERE i.status = 'due'`
    )
    .all();
  let dueCents = 0;
  const waiting = [];
  for (const r of dueRows) {
    const amount = r.lines_custom === 1 ? r.lines_sum : invoices.suggestedCents(r.value_cents, r.kind);
    dueCents += amount || 0;
    waiting.push({
      invoiceId: r.id,
      jobName: r.job_name,
      kind: r.kind,
      status: "due",
      since: r.became_due_date || String(r.created_at).slice(0, 10),
    });
  }

  const overdueRows = db
    .prepare(
      `SELECT i.id, i.kind, i.due_date, i.total_cents, j.name AS job_name
         FROM invoices i JOIN jobs j ON j.id = i.job_id
        WHERE i.status = 'issued' AND i.due_date IS NOT NULL AND i.due_date < ?`
    )
    .all(today);
  let overdueCents = 0;
  for (const r of overdueRows) {
    overdueCents += r.total_cents || 0;
    waiting.push({
      invoiceId: r.id,
      jobName: r.job_name,
      kind: r.kind,
      status: "overdue",
      since: r.due_date,
    });
  }

  const notMyobCount = db
    .prepare(
      "SELECT COUNT(*) AS n FROM invoices WHERE status IN ('issued','paid') AND myob_entered_date IS NULL"
    )
    .get().n;

  // Deposits, progress and finals held back because the job has no value yet.
  const needsValueCount = db
    .prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'pending' AND kind IN ('deposit','progress','final')")
    .get().n;

  // Supplier statements still waiting for the previous month (m9-contracts.md section 7.5).
  const statementsPeriod = Periods.addMonths(Periods.currentPeriod(today), -1);
  const statementsWaitingCount = suppliers.waitingCount(db, statementsPeriod);

  // Oldest first: a due invoice by when it became due, an overdue one by its due date.
  waiting.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.invoiceId - b.invoiceId));

  return {
    dueCount: dueRows.length,
    dueCents,
    overdueCount: overdueRows.length,
    overdueCents,
    notMyobCount,
    needsValueCount,
    oldest: waiting.slice(0, OLDEST_N),
    statementsWaitingCount,
    statementsPeriod,
  };
}

function message(s) {
  const parts = [];
  if (s.dueCount) parts.push(`${s.dueCount} due`);
  if (s.overdueCount) parts.push(`${s.overdueCount} overdue`);
  if (s.notMyobCount) parts.push(`${s.notMyobCount} not in MYOB`);
  if (s.needsValueCount) parts.push(`${s.needsValueCount} need a job value`);
  if (s.statementsWaitingCount) {
    parts.push(`${s.statementsWaitingCount} ${s.statementsWaitingCount === 1 ? "statement" : "statements"} waiting`);
  }
  const title = `Friday round-up: ${parts.join(", ")}`;

  const lines = [];
  if (s.dueCount) {
    lines.push(`${s.dueCount} to issue, ${dollars(s.dueCents)} in total.`);
  }
  if (s.overdueCount) {
    lines.push(`${s.overdueCount} overdue, ${dollars(s.overdueCents)} in total.`);
  }
  if (s.notMyobCount) lines.push(`${s.notMyobCount} not yet entered in MYOB.`);
  if (s.needsValueCount) lines.push(`${s.needsValueCount} waiting for a job value before they can be invoiced.`);
  if (s.oldest.length) {
    lines.push(
      "Oldest: " + s.oldest.map((o) => `${o.jobName} (${KIND_LABEL[o.kind] || o.kind}, ${o.status})`).join("; ") + "."
    );
  }
  if (s.statementsWaitingCount) {
    const n = s.statementsWaitingCount;
    const monthName = Periods.longLabel(s.statementsPeriod).split(" ")[0];
    lines.push(`${n} supplier ${n === 1 ? "statement" : "statements"} still waiting for ${monthName}.`);
  }
  return { title, body: lines.join(" ") };
}

// Builds the summary and, unless every count is zero, notifies invoices.edit
// holders. Unless force, records the Friday so it does not run again; the
// notifications and the record commit together.
function run(db, { force = false, now = new Date(), friday } = {}) {
  return db.transaction(() => {
    const summary = buildSummary(db, sydneyToday(now));
    let sent = 0;
    const invoiceCounts = summary.dueCount || summary.overdueCount || summary.notMyobCount || summary.needsValueCount;
    if (invoiceCounts || summary.statementsWaitingCount) {
      const { title, body } = message(summary);
      // The supplier page only when the waiting statements are all there is to see.
      const link = invoiceCounts ? "/accounts.html" : `/suppliers.html?period=${summary.statementsPeriod}`;
      sent = notify.toKey(db, "invoices.edit", {
        kind: "invoice.roundup",
        title,
        body,
        link,
        entityType: "roundup",
        entityId: friday || latestFridayNoon(now),
      });
    }
    if (!force) settings.set(db, "roundup.last_run", friday || latestFridayNoon(now), null);
    return { sent, summary };
  })();
}

let started = false;

function start(db) {
  if (process.env.ROUNDUP_DISABLED === "1") return;
  if (started) return;
  started = true;
  try {
    // A fresh install or an upgrade must not fire a stale round-up.
    if (settings.get(db, "roundup.last_run") == null) {
      const friday = latestFridayNoon();
      settings.set(db, "roundup.last_run", friday, null);
      console.log(`[roundup] first start: last_run seeded to ${friday}, nothing sent`);
    }
  } catch (e) {
    console.error("[roundup] seeding last_run failed:", e && e.message ? e.message : e);
  }
  const timer = setInterval(() => {
    try {
      const now = new Date();
      const friday = shouldRun(now, settings.get(db, "roundup.last_run"));
      if (!friday) return;
      const { sent } = run(db, { now, friday });
      console.log(`[roundup] ran for ${friday}: ${sent} notification(s) sent`);
    } catch (e) {
      console.error("[roundup] run failed:", e && e.message ? e.message : e);
    }
  }, CHECK_MS);
  timer.unref();
}

module.exports = { shouldRun, run, start };
