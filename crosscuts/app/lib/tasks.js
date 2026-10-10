// Tasks: the shared queue (Todd <-> accounts, and tasks on jobs) and the weekday
// morning reminder. See docs/plans/m4-contracts.md sections 2 and 4.
// Scaffold (M4 · 2.2): countsFor is complete and frozen (the menu bar count uses it).
// Wave 1 A fills in the rest; the signatures are binding.
const { HttpError } = require("./httperror");

const notBuilt = () => {
  throw new HttpError(501, "Not built");
};

// {open, overdue}: the user's assigned open tasks, and those due before `today`.
function countsFor(db, userId, today) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS open,
              COALESCE(SUM(CASE WHEN due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END), 0) AS overdue
         FROM tasks WHERE assignee_id = ? AND status = 'open'`
    )
    .get(today, userId);
  return { open: Number(row.open) || 0, overdue: Number(row.overdue) || 0 };
}

function list(db, user, opts) { notBuilt(); }
function get(db, user, id) { notBuilt(); }
function create(db, req, body) { notBuilt(); }
function update(db, req, id, body) { notBuilt(); }
function setStatus(db, req, id, action) { notBuilt(); }
function attach(db, req, id, accepted) { notBuilt(); }
function detach(db, req, id, fileId) { notBuilt(); }
function runReminder(db, opts) { notBuilt(); }
// Called by server.js after listen; a no-op until Wave 1 A builds the timer.
function startReminder(db) {}

module.exports = {
  countsFor,
  list,
  get,
  create,
  update,
  setStatus,
  attach,
  detach,
  runReminder,
  startReminder,
};
