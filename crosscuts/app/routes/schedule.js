const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const { DATE_RE, mondayOf, addDays, sydneyMonday } = require("../lib/time");
const {
  DAY_KEYS,
  hueColors,
  rowToWorker,
  rowToJob,
  selectRowWithJob,
  selectBacklog,
  buildScheduleRow,
  buildWeek,
  getWeekRowOr404,
} = require("../lib/schedule");

const r = defineRoutes("/api");

// --- Workers ---

r.get("/workers", "board.view", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM workers ORDER BY archived ASC, sort_order ASC, id ASC")
    .all();
  res.json(rows.map(rowToWorker));
});

r.post("/workers", "workers.edit", (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  const total = db.prepare("SELECT COUNT(*) AS n FROM workers").get().n;
  const maxOrder = db.prepare("SELECT MAX(sort_order) AS m FROM workers").get().m;
  const hue = (total * 137) % 360;
  const info = db
    .prepare("INSERT INTO workers (name, hue, sort_order) VALUES (?, ?, ?)")
    .run(name, hue, (maxOrder ?? -1) + 1);
  res.status(201).json(rowToWorker(db.prepare("SELECT * FROM workers WHERE id = ?").get(info.lastInsertRowid)));
});

r.patch("/workers/:id", "workers.edit", (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM workers WHERE id = ?").get(id);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const name = typeof req.body.name === "string" ? req.body.name.trim() || row.name : row.name;
  const hue = Number.isInteger(req.body.hue) ? ((req.body.hue % 360) + 360) % 360 : row.hue;
  const archived = typeof req.body.archived === "boolean" ? (req.body.archived ? 1 : 0) : row.archived;
  db.prepare("UPDATE workers SET name = ?, hue = ?, archived = ? WHERE id = ?").run(name, hue, archived, id);
  res.json(rowToWorker(db.prepare("SELECT * FROM workers WHERE id = ?").get(id)));
});

// --- Jobs ---

r.get("/jobs", "board.view", (req, res) => {
  const rows = db.prepare("SELECT * FROM jobs WHERE archived = 0 ORDER BY name ASC").all();
  res.json(rows.map(rowToJob));
});

r.patch("/jobs/:id", ["board.edit", "jobs.edit"], (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const name = typeof req.body.name === "string" ? req.body.name.trim() || row.name : row.name;
  const notes = typeof req.body.notes === "string" ? req.body.notes : row.notes;
  db.prepare("UPDATE jobs SET name = ?, notes = ? WHERE id = ?").run(name, notes, id);
  res.json(rowToJob(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id)));
});

r.get("/schedule", "board.view", (req, res) => {
  // No ?week= means the current Sydney week (not the server's UTC date).
  const requested = typeof req.query.week === "string" && DATE_RE.test(req.query.week) ? req.query.week : null;
  const week1Start = requested ? mondayOf(requested) : sydneyMonday();
  const week2Start = addDays(week1Start, 7);
  const backlog = selectBacklog.all().map((b) => ({ id: b.id, jobId: b.job_id, name: b.name, notes: b.notes }));
  res.json({ weeks: [buildWeek(week1Start), buildWeek(week2Start)], backlog });
});

r.post("/rows", "board.edit", (req, res) => {
  const { weekStart, panel, jobId, jobName, notes } = req.body;
  if (typeof weekStart !== "string" || !DATE_RE.test(weekStart)) {
    res.status(400).json({ error: "weekStart must be a YYYY-MM-DD date" });
    return;
  }
  if (panel !== "manufacturing" && panel !== "installing") {
    res.status(400).json({ error: "panel must be 'manufacturing' or 'installing'" });
    return;
  }
  const snappedWeekStart = mondayOf(weekStart);

  let resolvedJobId = null;
  if (Number.isInteger(jobId)) {
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    resolvedJobId = job.id;
  } else {
    const name = typeof jobName === "string" ? jobName.trim() : "";
    if (!name) {
      res.status(400).json({ error: "jobId or jobName is required" });
      return;
    }
    const info = db
      .prepare("INSERT INTO jobs (name, notes) VALUES (?, ?)")
      .run(name, typeof notes === "string" ? notes : "");
    resolvedJobId = info.lastInsertRowid;
  }

  const maxOrder = db
    .prepare("SELECT MAX(sort_order) AS m FROM week_rows WHERE week_start = ? AND panel = ?")
    .get(snappedWeekStart, panel).m;
  const info = db
    .prepare("INSERT INTO week_rows (job_id, week_start, panel, sort_order) VALUES (?, ?, ?, ?)")
    .run(resolvedJobId, snappedWeekStart, panel, (maxOrder ?? -1) + 1);

  const weekRow = selectRowWithJob.get(info.lastInsertRowid);
  res.status(201).json(buildScheduleRow(weekRow));
});

// Four move modes share this one endpoint deliberately (one route, one access
// rule, one place to keep in step with the board).
//   { direction: "up" | "down" }  — swap with the neighbour
//   { toIndex: n }                — drag-and-drop reorder inside the panel
//   { week: "prev" | "next" }     — move to the adjacent week, workers included
//   { backlog: true }             — send the row back to the To start list
r.patch("/rows/:id/move", "board.edit", (req, res) => {
  const id = Number(req.params.id);
  const row = getWeekRowOr404(id, res);
  if (!row) return;
  const { direction, toIndex, week } = req.body;

  // --- send the row back to the To start list ---
  if (req.body.backlog === true) {
    // Same scoped cleanup as DELETE /api/rows/:id: child rows (flags, then
    // assignments) go first in the same transaction so the FK check holds.
    // Only this row id is touched. The job itself stays, and goes onto the
    // backlog as a pointer, unless it is already waiting there.
    const send = db.transaction(() => {
      db.prepare("DELETE FROM day_flags WHERE week_row_id = ?").run(id);
      db.prepare("DELETE FROM assignments WHERE week_row_id = ?").run(id);
      db.prepare("DELETE FROM week_rows WHERE id = ?").run(id);
      const existing = db.prepare("SELECT id FROM backlog WHERE job_id = ?").get(row.job_id);
      if (existing) return { backlogId: existing.id, jobId: row.job_id };
      const maxOrder = db.prepare("SELECT MAX(sort_order) AS m FROM backlog").get().m;
      const info = db
        .prepare("INSERT INTO backlog (job_id, sort_order) VALUES (?, ?)")
        .run(row.job_id, (maxOrder ?? -1) + 1);
      return { backlogId: info.lastInsertRowid, jobId: row.job_id };
    });
    res.json(send());
    return;
  }

  // --- move the row to the adjacent week ---
  if (week === "prev" || week === "next") {
    const toWeekStart = addDays(row.week_start, week === "next" ? 7 : -7);
    const maxOrder = db
      .prepare("SELECT MAX(sort_order) AS m FROM week_rows WHERE week_start = ? AND panel = ?")
      .get(toWeekStart, row.panel).m;
    // assignments and day_flags both key off week_row_id, which doesn't change
    // here — so the assigned workers (and any locked-in flags) travel with the
    // row. Nothing is deleted or re-created; this is a single column update.
    db.prepare("UPDATE week_rows SET week_start = ?, sort_order = ? WHERE id = ?")
      .run(toWeekStart, (maxOrder ?? -1) + 1, id);
    res.json({ weekStart: toWeekStart });
    return;
  }

  const siblings = db
    .prepare(
      "SELECT id, sort_order FROM week_rows WHERE week_start = ? AND panel = ? ORDER BY sort_order ASC, id ASC"
    )
    .all(row.week_start, row.panel);
  const idx = siblings.findIndex((s) => s.id === id);

  // --- drop the row at an arbitrary position (drag and drop) ---
  if (Number.isInteger(toIndex)) {
    // toIndex is a POST-removal index: the row is lifted out first, then
    // inserted, which is exactly how the board computes the number it sends.
    const to = Math.max(0, Math.min(toIndex, siblings.length - 1));
    if (to === idx) {
      res.status(204).end();
      return;
    }
    const ids = siblings.map((s) => s.id);
    ids.splice(to, 0, ids.splice(idx, 1)[0]);
    // Renumbering the whole panel-week is what makes an arbitrary drop work
    // (a pairwise swap can't). sort_order is presentation-only — no job,
    // assignment or flag data is read or written here.
    const reorder = db.transaction(() => {
      const update = db.prepare("UPDATE week_rows SET sort_order = ? WHERE id = ?");
      ids.forEach((rowId, i) => update.run(i, rowId));
    });
    reorder();
    res.status(204).end();
    return;
  }

  // --- swap with the row above or below ---
  if (direction !== "up" && direction !== "down") {
    res.status(400).json({ error: "pass direction ('up'/'down'), toIndex, week ('prev'/'next'), or backlog (true)" });
    return;
  }
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) {
    res.status(204).end();
    return;
  }
  const a = siblings[idx];
  const b = siblings[swapIdx];
  const swap = db.transaction(() => {
    db.prepare("UPDATE week_rows SET sort_order = ? WHERE id = ?").run(b.sort_order, a.id);
    db.prepare("UPDATE week_rows SET sort_order = ? WHERE id = ?").run(a.sort_order, b.id);
  });
  swap();
  res.status(204).end();
});

r.delete("/rows/:id", "board.edit", (req, res) => {
  const id = Number(req.params.id);
  const row = getWeekRowOr404(id, res);
  if (!row) return;
  // Child rows (day_flags, assignments) must be removed before the week_rows
  // row, or they orphan (and trip the FK check). Scoped to this row's
  // id only — the flags describe a row that ceases to exist in the same
  // transaction, so nothing reachable is lost.
  const del = db.transaction(() => {
    db.prepare("DELETE FROM day_flags WHERE week_row_id = ?").run(id);
    db.prepare("DELETE FROM assignments WHERE week_row_id = ?").run(id);
    db.prepare("DELETE FROM week_rows WHERE id = ?").run(id);
  });
  del();
  res.status(204).end();
});

r.post("/rows/:id/duplicate", "board.edit", (req, res) => {
  const id = Number(req.params.id);
  const row = getWeekRowOr404(id, res);
  if (!row) return;
  const toWeekStart =
    typeof req.body.toWeekStart === "string" && DATE_RE.test(req.body.toWeekStart)
      ? mondayOf(req.body.toWeekStart)
      : addDays(row.week_start, 7);

  const maxOrder = db
    .prepare("SELECT MAX(sort_order) AS m FROM week_rows WHERE week_start = ? AND panel = ?")
    .get(toWeekStart, row.panel).m;

  const newRowId = db.transaction(() => {
    const info = db
      .prepare("INSERT INTO week_rows (job_id, week_start, panel, sort_order) VALUES (?, ?, ?, ?)")
      .run(row.job_id, toWeekStart, row.panel, (maxOrder ?? -1) + 1);
    const assignments = db
      .prepare("SELECT day, worker_id FROM assignments WHERE week_row_id = ?")
      .all(id);
    const insertAssignment = db.prepare(
      "INSERT INTO assignments (week_row_id, day, worker_id) VALUES (?, ?, ?)"
    );
    for (const a of assignments) insertAssignment.run(info.lastInsertRowid, a.day, a.worker_id);
    return info.lastInsertRowid;
  })();

  const weekRow = selectRowWithJob.get(newRowId);
  res.status(201).json(buildScheduleRow(weekRow));
});

r.post("/rows/:id/assignments", "board.edit", (req, res) => {
  const id = Number(req.params.id);
  const row = getWeekRowOr404(id, res);
  if (!row) return;
  const { day, workerId } = req.body;
  if (!DAY_KEYS.includes(day)) {
    res.status(400).json({ error: "day must be one of " + DAY_KEYS.join(", ") });
    return;
  }
  if (!Number.isInteger(workerId)) {
    res.status(400).json({ error: "workerId must be an integer" });
    return;
  }
  const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(workerId);
  if (!worker) {
    res.status(404).json({ error: "Worker not found" });
    return;
  }
  const { bg, fg } = hueColors(worker.hue);
  // The same worker twice in one cell is never meaningful on the board, and
  // assignments has no UNIQUE constraint — treat a repeat pick as idempotent.
  const existing = db
    .prepare("SELECT id FROM assignments WHERE week_row_id = ? AND day = ? AND worker_id = ?")
    .get(id, day, worker.id);
  if (existing) {
    res.json({ assignmentId: existing.id, workerId: worker.id, name: worker.name, bg, fg, day });
    return;
  }
  const info = db
    .prepare("INSERT INTO assignments (week_row_id, day, worker_id) VALUES (?, ?, ?)")
    .run(id, day, worker.id);
  res.status(201).json({ assignmentId: info.lastInsertRowid, workerId: worker.id, name: worker.name, bg, fg, day });
});

r.delete("/assignments/:id", "board.edit", (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM assignments WHERE id = ?").get(id);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  db.prepare("DELETE FROM assignments WHERE id = ?").run(id);
  res.status(204).end();
});

// --- Day flags (installing-only "locked in with client" marker) ---

r.post("/rows/:id/flags", "board.edit", (req, res) => {
  const id = Number(req.params.id);
  const row = getWeekRowOr404(id, res);
  if (!row) return;
  const { day } = req.body;
  if (!DAY_KEYS.includes(day)) {
    res.status(400).json({ error: "day must be one of " + DAY_KEYS.join(", ") });
    return;
  }
  if (row.panel !== "installing") {
    res.status(400).json({ error: "Only installing rows can be flagged" });
    return;
  }
  db.prepare("INSERT OR IGNORE INTO day_flags (week_row_id, day) VALUES (?, ?)").run(id, day);
  res.status(201).json({ day, flagged: true });
});

r.delete("/rows/:id/flags/:day", "board.edit", (req, res) => {
  const id = Number(req.params.id);
  const row = getWeekRowOr404(id, res);
  if (!row) return;
  const day = req.params.day;
  if (!DAY_KEYS.includes(day)) {
    res.status(400).json({ error: "day must be one of " + DAY_KEYS.join(", ") });
    return;
  }
  db.prepare("DELETE FROM day_flags WHERE week_row_id = ? AND day = ?").run(id, day);
  res.status(204).end();
});

// --- Backlog ('to start') ---
// Jobs waiting to be scheduled. A backlog row is just a pointer to a jobs row;
// placing it on a week creates a week_rows row and removes the backlog pointer.

r.post("/jobs/backlog", "board.edit", (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  const add = db.transaction(() => {
    const jobInfo = db.prepare("INSERT INTO jobs (name, notes) VALUES (?, '')").run(name);
    const maxOrder = db.prepare("SELECT MAX(sort_order) AS m FROM backlog").get().m;
    const backlogInfo = db
      .prepare("INSERT INTO backlog (job_id, sort_order) VALUES (?, ?)")
      .run(jobInfo.lastInsertRowid, (maxOrder ?? -1) + 1);
    return { backlogId: backlogInfo.lastInsertRowid, jobId: jobInfo.lastInsertRowid };
  });
  const { backlogId, jobId } = add();
  res.status(201).json({ id: backlogId, jobId, name, notes: "" });
});

r.delete("/jobs/backlog/:id", "board.edit", (req, res) => {
  const id = Number(req.params.id);
  const row = Number.isInteger(id) ? db.prepare("SELECT id FROM backlog WHERE id = ?").get(id) : null;
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Scoped to this one backlog row. The jobs row stays, so the job's name and
  // notes survive and it can be placed again later.
  db.prepare("DELETE FROM backlog WHERE id = ?").run(id);
  res.status(204).end();
});

r.post("/jobs/backlog/:id/place", "board.edit", (req, res) => {
  const id = Number(req.params.id);
  const backlogRow = Number.isInteger(id)
    ? db.prepare("SELECT * FROM backlog WHERE id = ?").get(id)
    : null;
  if (!backlogRow) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { weekStart, panel, toIndex } = req.body;
  if (typeof weekStart !== "string" || !DATE_RE.test(weekStart)) {
    res.status(400).json({ error: "weekStart must be a YYYY-MM-DD date" });
    return;
  }
  if (panel !== "manufacturing" && panel !== "installing") {
    res.status(400).json({ error: "panel must be 'manufacturing' or 'installing'" });
    return;
  }
  const hasIndex = toIndex !== undefined && toIndex !== null;
  if (hasIndex && !Number.isInteger(toIndex)) {
    res.status(400).json({ error: "toIndex must be an integer" });
    return;
  }
  const snappedWeekStart = mondayOf(weekStart);

  const newRowId = db.transaction(() => {
    const maxOrder = db
      .prepare("SELECT MAX(sort_order) AS m FROM week_rows WHERE week_start = ? AND panel = ?")
      .get(snappedWeekStart, panel).m;
    const info = db
      .prepare("INSERT INTO week_rows (job_id, week_start, panel, sort_order) VALUES (?, ?, ?, ?)")
      .run(backlogRow.job_id, snappedWeekStart, panel, (maxOrder ?? -1) + 1);
    const newId = info.lastInsertRowid;

    // Same renumbering approach as the toIndex branch of PATCH /api/rows/:id/move:
    // the new row is already last, so splice it into the requested position and
    // write the panel-week's sort_order back out. Presentation-only, as there.
    if (hasIndex) {
      const siblings = db
        .prepare("SELECT id FROM week_rows WHERE week_start = ? AND panel = ? ORDER BY sort_order ASC, id ASC")
        .all(snappedWeekStart, panel);
      const ids = siblings.map((s) => s.id);
      const to = Math.max(0, Math.min(toIndex, ids.length - 1));
      ids.splice(to, 0, ids.splice(ids.indexOf(newId), 1)[0]);
      const update = db.prepare("UPDATE week_rows SET sort_order = ? WHERE id = ?");
      ids.forEach((rowId, i) => update.run(i, rowId));
    }

    db.prepare("DELETE FROM backlog WHERE id = ?").run(id);
    return newId;
  })();

  const weekRow = selectRowWithJob.get(newRowId);
  res.status(201).json(buildScheduleRow(weekRow));
});

// Finishing a week carries work forward into the next week. This route only
// ever INSERTs: it never updates or deletes existing rows, and the finished
// week itself is left untouched as a record. Every input is validated before
// the transaction opens, so a bad request writes nothing.
const FINISH_OUTCOMES = new Set(["not_started", "manufacturing", "install", "complete"]);

r.post("/rows/finish-week", "board.edit", (req, res) => {
  const { weekStart, results } = req.body;
  if (typeof weekStart !== "string" || !DATE_RE.test(weekStart)) {
    res.status(400).json({ error: "weekStart must be a YYYY-MM-DD date" });
    return;
  }
  if (!Array.isArray(results) || results.length === 0 || results.length > 200) {
    res.status(400).json({ error: "results must be a non-empty array of at most 200 items" });
    return;
  }
  const seenJobIds = new Set();
  for (const r of results) {
    if (!r || typeof r !== "object" || !Number.isInteger(r.jobId)) {
      res.status(400).json({ error: "each result needs an integer jobId" });
      return;
    }
    if (!FINISH_OUTCOMES.has(r.outcome)) {
      res.status(400).json({ error: "outcome must be one of " + [...FINISH_OUTCOMES].join(", ") });
      return;
    }
    if (seenJobIds.has(r.jobId)) {
      res.status(400).json({ error: `duplicate jobId ${r.jobId}` });
      return;
    }
    if (!db.prepare("SELECT id FROM jobs WHERE id = ?").get(r.jobId)) {
      res.status(400).json({ error: `job ${r.jobId} does not exist` });
      return;
    }
    seenJobIds.add(r.jobId);
  }

  const sourceWeek = mondayOf(weekStart);
  const nextWeek = addDays(sourceWeek, 7);
  const created = [];
  const skipped = [];
  const completed = [];

  db.transaction(() => {
    for (const { jobId, outcome } of results) {
      if (outcome === "complete") {
        completed.push(jobId);
        continue;
      }

      if (outcome === "not_started") {
        if (db.prepare("SELECT id FROM backlog WHERE job_id = ?").get(jobId)) {
          skipped.push({ jobId, outcome, reason: "already in backlog" });
          continue;
        }
        const maxOrder = db.prepare("SELECT MAX(sort_order) AS m FROM backlog").get().m;
        const info = db
          .prepare("INSERT INTO backlog (job_id, sort_order) VALUES (?, ?)")
          .run(jobId, (maxOrder ?? -1) + 1);
        created.push({ jobId, outcome, backlogId: info.lastInsertRowid });
        continue;
      }

      // 'manufacturing' or 'install' — both target a panel of the next week.
      const panel = outcome === "manufacturing" ? "manufacturing" : "installing";
      if (
        db
          .prepare("SELECT id FROM week_rows WHERE week_start = ? AND panel = ? AND job_id = ?")
          .get(nextWeek, panel, jobId)
      ) {
        skipped.push({ jobId, outcome, reason: "already on next week in this panel" });
        continue;
      }
      const maxOrder = db
        .prepare("SELECT MAX(sort_order) AS m FROM week_rows WHERE week_start = ? AND panel = ?")
        .get(nextWeek, panel).m;
      const info = db
        .prepare("INSERT INTO week_rows (job_id, week_start, panel, sort_order) VALUES (?, ?, ?, ?)")
        .run(jobId, nextWeek, panel, (maxOrder ?? -1) + 1);
      const newRowId = info.lastInsertRowid;

      // Copy assignments only, from the job's lowest-id row in the SAME panel of
      // the source week. day_flags are deliberately never copied: a
      // "locked in with client" marker belongs to that week's booking.
      const source = db
        .prepare(
          "SELECT id FROM week_rows WHERE week_start = ? AND panel = ? AND job_id = ? ORDER BY id ASC LIMIT 1"
        )
        .get(sourceWeek, panel, jobId);
      if (source) {
        const assignments = db
          .prepare("SELECT day, worker_id FROM assignments WHERE week_row_id = ? ORDER BY id ASC")
          .all(source.id);
        const insertAssignment = db.prepare(
          "INSERT INTO assignments (week_row_id, day, worker_id) VALUES (?, ?, ?)"
        );
        for (const a of assignments) insertAssignment.run(newRowId, a.day, a.worker_id);
      }
      created.push({ jobId, outcome, rowId: newRowId });
    }
  })();

  res.json({ created, skipped, completed });
});

module.exports = r.router;
