// Invoice follow-up settings and the accounts sweep (0.2.7, docs/plans/m28-contracts.md section 3).
// accounts.view reads; invoices.edit changes the default interval and each client's terms, and may
// run the sweep now. Rules in lib/followup.js and lib/accountsweep.js.
const db = require("../db");
const { defineRoutes } = require("../lib/routes");
const followup = require("../lib/followup");
const sweep = require("../lib/accountsweep");
const { bad, sendError } = require("../lib/httperror");
const { sydneyToday } = require("../lib/time");

const r = defineRoutes("/api/followup");

function handle(fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, "[followup]");
    }
  };
}
function body(req) {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("JSON body required");
  return b;
}

// 200 {defaultDays, clients: [{clientName, followUpDays, updatedAt}]}.
r.get("/", "accounts.view", handle((req, res) => {
  res.json(followup.overview(db));
}));

// {days} 1..365.
r.put("/default", "invoices.edit", handle((req, res) => {
  res.json(followup.setDefault(db, req, body(req)));
}));

// {clientName, followUpDays | null}.
r.put("/clients", "invoices.edit", handle((req, res) => {
  res.json(followup.setClient(db, req, body(req)));
}));

// Runs the accounts sweep now (rego/insurance bells and the follow-up bell), as of {today?}
// (never before today). 200 {date, vehicleBells, followUp, belled}.
r.post("/sweep", "invoices.edit", handle((req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const today = sydneyToday();
  let day = today;
  if (b.today !== undefined && b.today !== null) {
    if (typeof b.today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.today)) throw bad("today must be YYYY-MM-DD");
    if (b.today < today) throw bad("today can't be in the past");
    day = b.today;
  }
  res.json(sweep.run(db, { force: true, today: day }));
}));

module.exports = r.router;
