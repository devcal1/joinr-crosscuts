// Team tasks: a task for a whole team rather than one person (docs/plans/m4-contracts.md
// section 13, 2026-10-18). Today the only team is 'design': the people who hold notes.design
// (the Design/PM notes wall's people; admins add or remove them on the Users page) and tasks.use.
//
// They live in their own table (migration 032) because `tasks` needs a person in assignee_id and
// created_by. Their ids are 1000000000 or more, so one id means one task across /api/tasks, the
// comment threads, follows and alerts. lib/tasks.js hands every team id to this module and merges
// the team rows into its lists, counts and reminder. Only members see a team task (a non-member gets
// a 404); any member may edit, finish or reopen it, and whoever finishes it closes it for everyone.
//
// A team task has no files (task_files points at `tasks`). It is made by the Joinr intake
// (createFromJoinr, a system actor) or by a member who picks "Design/PM team" as the assignee.
const audit = require("./audit");
const notify = require("./notify");
const { bad, notFound, forbidden, conflict } = require("./httperror");
const { sydneyToday } = require("./time");

const TEAM_BASE = 1000000000;
const TEAMS = { design: { key: "notes.design", name: "Design/PM team" } };
const TEAM_KEYS = ["tasks.use", "notes.design"];
const SYSTEM_LABEL = "Joinr (automatic)";

function nowIso() {
  return new Date().toISOString();
}

function nextStamp(prev) {
  const now = Date.now();
  const p = Date.parse(prev);
  return new Date(Number.isFinite(p) && p >= now ? p + 1 : now).toISOString();
}

const isTeamId = (id) => Number.isInteger(id) && id >= TEAM_BASE;

function isAdmin(user) {
  return !!(user && Array.isArray(user.roles) && user.roles.includes("admin"));
}

// Is the user on the team (holds notes.design and tasks.use)?
function isMember(user, team = "design") {
  const perms = user && user.perms;
  if (!perms || !TEAMS[team]) return false;
  const has = perms instanceof Set ? (k) => perms.has(k) : (k) => Array.isArray(perms) && perms.includes(k);
  return has("tasks.use") && has(TEAMS[team].key);
}

// The enabled users on the team, as ids.
function memberIds(db, team = "design") {
  const t = TEAMS[team];
  const tasksUse = new Set(notify.usersWithKey(db, "tasks.use").map(Number));
  return notify.usersWithKey(db, t.key).map(Number).filter((id) => tasksUse.has(id));
}

function teamLabel(team) {
  return TEAMS[team] ? TEAMS[team].name : "Team";
}

const SELECT = `SELECT t.*, c.display_name AS creator_name, d.display_name AS done_by_name, j.name AS job_name
    FROM team_tasks t
    LEFT JOIN users c ON c.id = t.created_by
    LEFT JOIN users d ON d.id = t.done_by
    LEFT JOIN jobs j ON j.id = t.job_id`;

function loadRow(db, user, id) {
  const row = db.prepare(`${SELECT} WHERE t.id = ?`).get(id);
  // A non-member is told there is no such task.
  if (!row || !isMember(user, row.team)) throw notFound();
  return row;
}

function present(db, user, row, today) {
  const comments = db
    .prepare("SELECT COUNT(*) AS n FROM comments WHERE entity_type = 'task' AND entity_id = ? AND removed_at IS NULL")
    .get(row.id).n;
  const following = !!db
    .prepare("SELECT 1 FROM follows WHERE user_id = ? AND entity_type = 'task' AND entity_id = ?")
    .get(user.id, row.id);
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    dueDate: row.due_date || null,
    overdue: row.status === "open" && !!row.due_date && row.due_date < today,
    team: row.team,
    assignee: { id: null, name: teamLabel(row.team) },
    createdBy: { id: row.created_by == null ? null : row.created_by, name: row.created_by == null ? row.created_label || "System" : row.creator_name || "Unknown" },
    job: row.job_id == null ? null : { id: row.job_id, name: row.job_name },
    doneAt: row.done_at || null,
    doneBy: row.done_by == null ? null : { id: row.done_by, name: row.done_by_name || "Unknown" },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    files: [],
    commentCount: Number(comments) || 0,
    following,
    canEdit: row.status === "open",
  };
}

// ------------------------------------------------------------------ reads ---

function get(db, user, id, today) {
  return present(db, user, loadRow(db, user, id), today);
}

// The user's team tasks for a list view, as presented tasks (the caller merges and orders them).
// view: mine | open | done | job; `raised` is the user's own creations. A non-member gets none.
function listFor(db, user, view, { jobId, limit, today }) {
  if (!isMember(user)) return [];
  let sql;
  let args;
  if (view === "mine" || view === "open") {
    sql = `${SELECT} WHERE t.status = 'open' ORDER BY t.id LIMIT ?`;
    args = [limit];
  } else if (view === "raised") {
    sql = `${SELECT} WHERE t.created_by = ? AND t.status = 'open' ORDER BY t.id LIMIT ?`;
    args = [user.id, limit];
  } else if (view === "done") {
    sql = `${SELECT} WHERE t.status IN ('done','cancelled') ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`;
    args = [limit];
  } else {
    sql = `${SELECT} WHERE t.job_id = ? ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`;
    args = [jobId, limit];
  }
  return db
    .prepare(sql)
    .all(...args)
    .map((row) => present(db, user, row, today));
}

// {open, overdue} of the open team tasks the user can see (nothing for a non-member).
function countsFor(db, today) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS open,
              COALESCE(SUM(CASE WHEN due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END), 0) AS overdue
         FROM team_tasks WHERE status = 'open'`
    )
    .get(today);
  return { open: Number(row.open) || 0, overdue: Number(row.overdue) || 0 };
}

// Open team tasks due on or before `today`, for the 07:00 reminder.
function dueRows(db, today) {
  return db
    .prepare(
      `SELECT title, due_date FROM team_tasks
        WHERE status = 'open' AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date, id`
    )
    .all(today);
}

// ----------------------------------------------------------------- writes ---

function insert(db, { team, title, notes, jobId, dueDate, createdBy, createdLabel, source }) {
  const id = Math.max(TEAM_BASE, Number(db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM team_tasks").get().m) + 1);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO team_tasks (id, team, title, notes, job_id, due_date, created_by, created_label, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, team, title, notes || "", jobId == null ? null : jobId, dueDate || null, createdBy, createdLabel || null, source || null, ts, ts);
  return id;
}

function follow(db, userId, taskId) {
  db.prepare("INSERT OR IGNORE INTO follows (user_id, entity_type, entity_id) VALUES (?, 'task', ?)").run(userId, taskId);
}

// A member raises a task for the whole team (the "Design/PM team" choice in the assignee picker).
// `fields` are the already-validated title, notes, dueDate, jobId from lib/tasks.js.
function create(db, req, team, fields) {
  const user = req.user;
  if (!TEAMS[team]) throw bad("Unknown team");
  if (!isMember(user, team)) throw forbidden();
  return db.transaction(() => {
    const id = insert(db, { team, ...fields, createdBy: user.id });
    follow(db, user.id, id);
    audit.log(req, {
      action: "task.create",
      entityType: "task",
      entityId: id,
      after: { title: fields.title, team, dueDate: fields.dueDate || null, jobId: fields.jobId == null ? null : fields.jobId },
    });
    notify.toUsers(
      db,
      memberIds(db, team),
      {
        kind: "task.assigned",
        title: `${user.displayName} gave the ${teamLabel(team)} a task`,
        body: fields.title,
        link: `/tasks.html?task=${id}`,
        entityType: "task",
        entityId: id,
      },
      { exceptUserId: user.id }
    );
    return id;
  })();
}

// The Joinr intake made or linked a job: one open task for the design team, alerting each member
// (one alert; it links to the job). `req` is the system actor. Returns the task id.
function createFromJoinr(db, req, { jobId, jobName, mode, quoteNumber }) {
  const team = "design";
  const linked = mode === "linked";
  const name = String(jobName || `Job ${jobId}`).slice(0, 150);
  const title = linked ? `Joinr quote linked to ${name} - check the job` : `New job from Joinr: ${name} - set up the job`;
  const notes = linked
    ? `The won quote${quoteNumber ? " " + quoteNumber : ""} in Joinr was linked to this existing job. Check what was filled in.`
    : `The won quote${quoteNumber ? " " + quoteNumber : ""} in Joinr became this job automatically. Check it and set the job up.`;
  return db.transaction(() => {
    const id = insert(db, {
      team,
      title,
      notes,
      jobId,
      createdBy: null,
      createdLabel: SYSTEM_LABEL,
      source: "joinr",
    });
    audit.log(req, {
      action: "task.create",
      entityType: "task",
      entityId: id,
      after: { title, team, jobId, source: "joinr" },
    });
    const members = memberIds(db, team);
    for (const m of members) follow(db, m, id);
    notify.toUsers(db, members, {
      kind: "joinr.job",
      title: linked ? `Joinr linked to ${name}` : `Job created from Joinr: ${name}`,
      body: linked ? "A won quote was linked to this job. It is on the team's task list." : "Set the job up. It is on the team's task list.",
      link: `/job.html?id=${jobId}`,
      entityType: "job",
      entityId: jobId,
    });
    return id;
  })();
}

function update(db, req, id, body, { parseDue, parseJob, textField, TITLE_MAX, NOTES_MAX }) {
  const user = req.user;
  if (typeof body.updatedAt !== "string" || !body.updatedAt) throw bad("updatedAt is required");
  const row = loadRow(db, user, id);
  if (row.status !== "open") throw conflict("This task is closed");
  const today = sydneyToday();
  if (body.updatedAt !== row.updated_at) {
    throw conflict("Someone else changed this task. Reload to see it.", { task: get(db, user, id, today) });
  }
  // A team task stays with its team; it can't be given to one person.
  if (body.assigneeId !== undefined && body.assigneeId !== null) {
    throw bad("A team task can't be given to one person");
  }
  const changes = {};
  const before = {};
  if (body.title !== undefined) {
    const v = textField("title", body.title, { max: TITLE_MAX, required: true });
    if (v !== row.title) {
      before.title = row.title;
      changes.title = v;
    }
  }
  if (body.notes !== undefined) {
    const v = textField("notes", body.notes, { max: NOTES_MAX });
    if (v !== row.notes) {
      before.notes = row.notes;
      changes.notes = v;
    }
  }
  if (body.dueDate !== undefined) {
    const v = parseDue(body.dueDate);
    if (v !== (row.due_date || null)) {
      before.dueDate = row.due_date || null;
      changes.dueDate = v;
    }
  }
  if (body.jobId !== undefined) {
    const v = parseJob(db, body.jobId);
    if (v !== (row.job_id == null ? null : row.job_id)) {
      before.jobId = row.job_id == null ? null : row.job_id;
      changes.jobId = v;
    }
  }
  if (Object.keys(changes).length === 0) return get(db, user, id, today);
  db.transaction(() => {
    const next = {
      title: changes.title !== undefined ? changes.title : row.title,
      notes: changes.notes !== undefined ? changes.notes : row.notes,
      due_date: changes.dueDate !== undefined ? changes.dueDate : row.due_date || null,
      job_id: changes.jobId !== undefined ? changes.jobId : row.job_id == null ? null : row.job_id,
    };
    const info = db
      .prepare(`UPDATE team_tasks SET title = ?, notes = ?, due_date = ?, job_id = ?, updated_at = ? WHERE id = ? AND updated_at = ?`)
      .run(next.title, next.notes, next.due_date, next.job_id, nextStamp(row.updated_at), id, row.updated_at);
    if (info.changes !== 1) throw conflict("Someone else changed this task. Reload to see it.", { task: get(db, user, id, today) });
    audit.log(req, { action: "task.update", entityType: "task", entityId: id, before, after: changes });
  })();
  return get(db, user, id, today);
}

// action: 'done' | 'reopen' | 'cancel'. Whoever finishes it closes it for the whole team.
function setStatus(db, req, id, action) {
  const user = req.user;
  const today = sydneyToday();
  db.transaction(() => {
    const row = loadRow(db, user, id);
    const ts = nextStamp(row.updated_at);
    if (action === "done") {
      if (row.status !== "open") throw conflict("This task isn't open");
      db.prepare("UPDATE team_tasks SET status = 'done', done_at = ?, done_by = ?, updated_at = ? WHERE id = ?").run(nowIso(), user.id, ts, id);
      audit.log(req, { action: "task.done", entityType: "task", entityId: id, before: { status: "open" }, after: { status: "done", team: row.team } });
      if (row.created_by != null && Number(row.created_by) !== Number(user.id)) {
        notify.toUser(db, row.created_by, {
          kind: "task.done",
          title: `${user.displayName} finished a task`,
          body: row.title,
          link: `/tasks.html?task=${id}`,
          entityType: "task",
          entityId: id,
        });
      }
    } else if (action === "reopen") {
      if (row.status !== "done") throw conflict("Only a finished task can be reopened");
      db.prepare("UPDATE team_tasks SET status = 'open', done_at = NULL, done_by = NULL, updated_at = ? WHERE id = ?").run(ts, id);
      audit.log(req, { action: "task.reopen", entityType: "task", entityId: id, before: { status: "done" }, after: { status: "open", team: row.team } });
      notify.toUsers(
        db,
        memberIds(db, row.team),
        {
          kind: "task.reopened",
          title: `${user.displayName} reopened a task`,
          body: row.title,
          link: `/tasks.html?task=${id}`,
          entityType: "task",
          entityId: id,
        },
        { exceptUserId: user.id }
      );
    } else {
      // Cancel: an admin, or the member who raised it.
      if (!isAdmin(user) && !(row.created_by != null && Number(row.created_by) === Number(user.id))) throw forbidden();
      if (row.status !== "open") throw conflict("This task isn't open");
      db.prepare("UPDATE team_tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(ts, id);
      audit.log(req, { action: "task.cancel", entityType: "task", entityId: id, before: { status: "open" }, after: { status: "cancelled" } });
    }
  })();
  return get(db, user, id, today);
}

// The title of a team task for the comment thread, or null when there is none.
function labelOf(db, id) {
  const row = db.prepare("SELECT title FROM team_tasks WHERE id = ?").get(id);
  return row ? row.title : null;
}

module.exports = {
  TEAM_BASE,
  TEAMS,
  TEAM_KEYS,
  SYSTEM_LABEL,
  isTeamId,
  isMember,
  memberIds,
  teamLabel,
  get,
  listFor,
  countsFor,
  dueRows,
  create,
  createFromJoinr,
  update,
  setStatus,
  labelOf,
};
