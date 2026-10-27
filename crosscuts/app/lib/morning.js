// The Morning check (0.2.5, docs/plans/m26-contracts.md section 2): on the Scheduling notes wall,
// the schedule manager (board.edit) goes through the previous working day's jobs, picks each one's
// production stage and adds a short note (production_days), sees what needs attention (rows with
// nobody on them, Ready to cut jobs not placed, installs this week without a promised date, open
// job issues) and presses Done for today (setting board.morning_last_done).
//
// Every function takes db first; nothing here requires ../db.
const audit = require("./audit");
const settings = require("./settings");
const production = require("./production");
const { bad, notFound } = require("./httperror");
const { DATE_RE, sydneyToday, sydneyMonday, addDays, parseDateUTC } = require("./time");

const DAY_KEYS = [null, "mon", "tue", "wed", "thu", "fri", null];
const NOTE_MAX = 300;
const userId = (req) => (req && req.user && req.user.id != null ? req.user.id : null);

function validDate(s) {
  return typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(parseDateUTC(s).getTime()) && parseDateUTC(s).toISOString().slice(0, 10) === s;
}

// The weekday before `today` (Monday's is the Friday before; at the weekend, Friday).
function previousWorkingDay(today = sydneyToday()) {
  let d = addDays(today, -1);
  while ([0, 6].includes(parseDateUTC(d).getUTCDay())) d = addDays(d, -1);
  return d;
}

function lastDone(db) {
  const raw = settings.get(db, "board.morning_last_done");
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    const u = v.by ? db.prepare("SELECT display_name FROM users WHERE id = ?").get(v.by) : null;
    return { date: v.date, doneOn: v.doneOn, at: v.at, by: v.by ? { id: v.by, name: u ? u.display_name : null } : null };
  } catch {
    return null;
  }
}

// True when nobody has pressed Done for today yet today.
function doneToday(db, today = sydneyToday()) {
  const d = lastDone(db);
  return !!d && d.doneOn === today;
}

function stageList(job) {
  return production.stagesFor(job).map((key) => ({ key, label: production.LABELS[key] }));
}

function check(db, date) {
  const day = date || previousWorkingDay();
  if (!validDate(day)) throw bad("date must be a valid YYYY-MM-DD date");
  const dow = parseDateUTC(day).getUTCDay();
  const dayKey = DAY_KEYS[dow];
  const week = sydneyMonday(day);
  const today = sydneyToday();
  const thisWeek = sydneyMonday();

  // The day's jobs: rows in that week with someone on that day.
  const rows = dayKey
    ? db
        .prepare(
          `SELECT wr.job_id, wr.panel, w.name AS worker FROM week_rows wr
             JOIN assignments a ON a.week_row_id = wr.id AND a.day = ?
             JOIN workers w ON w.id = a.worker_id
            WHERE wr.week_start = ? ORDER BY wr.panel, wr.sort_order, wr.id, w.sort_order, w.id`
        )
        .all(dayKey, week)
    : [];
  const byJob = new Map();
  for (const r of rows) {
    if (!byJob.has(r.job_id)) byJob.set(r.job_id, { panels: [], people: [] });
    const e = byJob.get(r.job_id);
    if (!e.panels.includes(r.panel)) e.panels.push(r.panel);
    if (!e.people.includes(r.worker)) e.people.push(r.worker);
  }
  const ids = [...byJob.keys()];
  const current = production.currentStages(db, ids);
  const dayRow = db.prepare("SELECT stage, note FROM production_days WHERE job_id = ? AND date = ?");
  const jobs = ids.map((id) => {
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    const d = dayRow.get(id, day);
    return {
      id,
      name: job.name,
      clientName: job.client_name || null,
      panels: byJob.get(id).panels,
      people: byJob.get(id).people,
      currentStage: current.get(id) || null,
      dayStage: d ? d.stage : null,
      note: d ? d.note : "",
      stages: stageList(job),
    };
  });

  const emptyRows = db
    .prepare(
      `SELECT wr.id AS rowId, wr.job_id AS jobId, j.name, wr.panel, wr.week_start AS weekStart FROM week_rows wr
         JOIN jobs j ON j.id = wr.job_id
        WHERE wr.week_start = ? AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.week_row_id = wr.id)
        ORDER BY wr.panel, wr.sort_order, wr.id`
    )
    .all(thisWeek);
  const readyNotPlaced = db
    .prepare(
      `SELECT j.id, j.name, j.client_name FROM jobs j
        WHERE j.archived = 0 AND j.stage = 'ready_to_cut'
          AND NOT EXISTS (SELECT 1 FROM week_rows wr WHERE wr.job_id = j.id AND wr.week_start >= ?)
        ORDER BY j.name COLLATE NOCASE, j.id`
    )
    .all(thisWeek)
    .map((j) => ({ id: j.id, name: j.name, clientName: j.client_name || null }));
  const installsNoPromised = db
    .prepare(
      `SELECT DISTINCT j.id, j.name, j.client_name FROM week_rows wr JOIN jobs j ON j.id = wr.job_id
        WHERE wr.week_start = ? AND wr.panel = 'installing' AND j.promised_install_date IS NULL
        ORDER BY j.name COLLATE NOCASE, j.id`
    )
    .all(thisWeek)
    .map((j) => ({ id: j.id, name: j.name, clientName: j.client_name || null }));
  const openIssues = db
    .prepare(
      `SELECT i.id, i.job_id, j.name, i.body, i.raised_at FROM job_issues i JOIN jobs j ON j.id = i.job_id
        WHERE i.status = 'open' ORDER BY i.raised_at, i.id`
    )
    .all()
    .map((i) => ({ id: i.id, jobId: i.job_id, jobName: i.name, body: i.body, raisedAt: i.raised_at }));

  return {
    date: day,
    today,
    done: lastDone(db),
    doneToday: doneToday(db, today),
    jobs,
    emptyRows,
    readyNotPlaced,
    installsNoPromised,
    openIssues,
  };
}

// body: {date, stage (key or null), note?}. Upserts production_days; audited job.production_day.
function setDay(db, req, jobId, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!b) throw bad("JSON body required");
  if (!validDate(b.date)) throw bad("date must be a valid YYYY-MM-DD date");
  let stage = null;
  if (b.stage !== undefined && b.stage !== null && b.stage !== "") {
    if (!production.STAGES.includes(b.stage)) throw bad("stage must be one of " + production.STAGES.join(", "));
    stage = b.stage;
  }
  let note = "";
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string") throw bad("note must be text");
    note = b.note.trim();
    if (note.length > NOTE_MAX) throw bad(`A note is ${NOTE_MAX} characters at most`);
  }
  return db.transaction(() => {
    const job = db.prepare("SELECT id, is_two_pac, benchtop FROM jobs WHERE id = ?").get(jobId);
    if (!job) throw notFound();
    if (stage && !production.stagesFor(job).includes(stage)) throw bad("That stage doesn't apply to this job");
    const before = db.prepare("SELECT stage, note FROM production_days WHERE job_id = ? AND date = ?").get(jobId, b.date) || null;
    if (!stage && !note) {
      if (before) db.prepare("DELETE FROM production_days WHERE job_id = ? AND date = ?").run(jobId, b.date);
    } else {
      db.prepare(
        `INSERT INTO production_days (job_id, date, stage, note, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id, date) DO UPDATE SET stage = excluded.stage, note = excluded.note, set_by = excluded.set_by, set_at = excluded.set_at`
      ).run(jobId, b.date, stage, note, userId(req), new Date().toISOString());
    }
    audit.log(req, { action: "job.production_day", entityType: "job", entityId: jobId, before, after: { date: b.date, stage, note } });
    return { jobId, date: b.date, stage, note, currentStage: production.currentStages(db, [jobId]).get(jobId) || null };
  })();
}

// Done for today: records the day checked, today, when and who.
function markDone(db, req, body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const date = b.date === undefined ? previousWorkingDay() : b.date;
  if (!validDate(date)) throw bad("date must be a valid YYYY-MM-DD date");
  const v = { date, doneOn: sydneyToday(), at: new Date().toISOString(), by: userId(req) };
  settings.set(db, "board.morning_last_done", JSON.stringify(v), req);
  return lastDone(db);
}

module.exports = { previousWorkingDay, check, setDay, markDone, doneToday, lastDone, stageList };
