// Local dev only. Adds department notes (0.1.19) to a seeded local Crosscuts, for screenshots:
//   DB_DIR=<the server's db dir> node tools/screenshots/seed-notes.js [base, default http://localhost:3997]
// Run after seed.js. Notes are inserted straight into dept_notes (the app only lets a note go on
// today or later, and its time is then "now"), by made-up Design/PM test users, on weekdays of
// last week, this week and next week, with some thumbs-ups (the viewer, the seed.js admin, gives
// two). Scheduling, Ordering, Accounts and Admin get a handful of this week's notes each, by made-up
// test users of their own. Runs once per department: skips a sheet that already has notes.
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const B = process.argv[2] || "http://localhost:3997";
let cookie = "";
async function api(method, p, body) {
  const r = await fetch(B + p, { method, headers: { Origin: B, "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const sid = (r.headers.getSetCookie() || []).find(c => c.startsWith("crosscuts_sid=")); if (sid) cookie = sid.split(";")[0];
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${t.slice(0, 200)}`);
  return j;
}
const SYD = new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
// The UTC ISO time of a Sydney wall-clock time ("YYYY-MM-DD", "HH:MM"), whichever offset applies.
function sydneyIso(date, hm) {
  for (const off of [10, 11]) {
    const d = new Date(Date.parse(date + "T" + hm + ":00Z") - off * 3600000);
    if (SYD.format(d) === hm) return d.toISOString();
  }
  throw new Error("no such Sydney time " + date + " " + hm);
}
const addDays = (date, n) => new Date(Date.parse(date + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
(async () => {
  const dbDir = process.env.DB_DIR; if (!dbDir) throw new Error("set DB_DIR to the server's db dir");
  await api("POST", "/api/auth/login", { username: "admin", password: "Shots-Local-Test-1" });
  const users = await api("GET", "/api/users"), rows = Array.isArray(users) ? users : users.rows || users.users || [];
  const mk = async (username, displayName, role) => rows.find(u => u.username === username)
    || await api("POST", "/api/users", { username, displayName, password: "Menu-Local-Test-1", roles: [role] });
  const me = (await api("GET", "/api/auth/me")).user;
  const db = new DatabaseSync(path.join(dbDir, "photos.db"));
  const thisWeek = (await api("GET", "/api/notes?dept=design")).thisWeek;
  const lastWeek = addDays(thisWeek, -7), nextWeek = addDays(thisWeek, 7);
  const ins = db.prepare("INSERT INTO dept_notes (dept, note_date, week_start, body, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const seeded = d => db.prepare("SELECT COUNT(*) n FROM dept_notes WHERE dept = ?").get(d).n;
  const ack = db.prepare("INSERT INTO dept_note_acks (note_id, user_id, created_at) VALUES (?, ?, ?)");
  // put(week, weekday 0..4 (Mon..Fri), "HH:MM" Sydney, author, text, [who gave a thumbs-up]): posted on the day
  // it is for unless `postedDay` (a weekday offset) says it was written earlier.
  const putIn = dept => (week, day, hm, author, text, acks, postedDay) => {
    const date = addDays(week, day), t = sydneyIso(addDays(week, postedDay === undefined ? day : postedDay), hm);
    const id = Number(ins.run(dept, date, week, text, author.id, t, t).lastInsertRowid);
    (acks || []).forEach((u, i) => ack.run(id, u.id, t.slice(0, 11) + "1" + i + t.slice(13)));
    return id;
  };
  if (seeded("design")) console.log("design notes already seeded");
  else {
    const put = putIn("design"), a = await mk("notes-dpm-a", "Design Test A", "design_pm"), b = await mk("notes-dpm-b", "Design Test B", "design_pm");
    put(lastWeek, 0, "09:30", a, "Harbour St vanity: client confirmed the matt black handles, drawings updated to rev C.", [b, me]);
    put(lastWeek, 1, "14:05", b, "Waiting on the stone template for the Lee bathroom before we release the cabinet drawings.", [a]);
    put(lastWeek, 3, "10:15", a, "Friday: all site measures for next week are in the shared folder.", [me]);
    put(thisWeek, 0, "09:10", a, "Harbour St vanity: client confirmed matt black handles.", [b, me]);
    put(thisWeek, 1, "10:40", b, "Smith kitchen: island depth now 900 mm. Check the cut list.", [a]);
    put(thisWeek, 1, "14:15", me, "Cooper pantry quote needs sign-off from Accounts by Thursday.", [a, b]);
    put(thisWeek, 2, "11:20", a, "Hinge samples on the design desk if anyone wants a look.", [me]);
    put(thisWeek, 3, "08:45", b, "Lee bathroom: stone template booked for next Tuesday.", []);
    put(thisWeek, 4, "08:30", a, "Reminder for the afternoon: site measure at Harbour St, bring the laser.", [b]);
    put(thisWeek, 4, "09:05", me, "Friday drawings review at 2 pm. Please have rev C ready.", [], 3);
    put(nextWeek, 0, "08:00", me, "Monday: new quote template goes live. Use it for everything from here.", [], 3);
    console.log("seeded design notes", lastWeek, thisWeek, nextWeek);
  }
  // This week's notes for the other four departments: [weekday 0..4, "HH:MM" Sydney, author index, text, thumbs-up givers, postedDay].
  const others = {
    scheduling: { role: "scheduling", label: "Scheduling", notes: [
      [0, "08:15", 0, "Smith kitchen install moved to Thursday. Board updated, installers told.", [1, "me"]],
      [1, "09:40", 1, "Lee bathroom: stone template Tuesday next week, hold the Friday slot.", [0]],
      [2, "13:20", 0, "Harbour St vanity needs two installers on the day, check leave before confirming.", []],
      [3, "08:50", 1, "Cooper pantry delivery is booked for Friday morning. Dock needs clearing first.", [0, "me"]],
      [4, "07:55", 0, "Friday: print the board for next week before 3 pm.", [], 3],
    ] },
    ordering: { role: "ordering", label: "Ordering", notes: [
      [0, "08:30", 0, "Edge drawer runs for Smith kitchen are ordered, due Wednesday week.", [1]],
      [1, "10:10", 1, "Paint for Lee bathroom: colour card still to be approved, do not place yet.", []],
      [2, "11:45", 0, "Cooper pantry: brushed brass handles on back-order, supplier says ten days.", [1, "me"]],
      [3, "14:30", 1, "Stock count Friday. Please have the board offcuts tidied first.", [0]],
    ] },
    accounts: { role: "accounts", label: "Accounts", notes: [
      [0, "09:00", 0, "Pay run closes Wednesday. Timesheets due by 3 pm Tuesday.", [1, "me"]],
      [1, "11:25", 1, "Cooper pantry quote signed off, invoice the deposit today.", [0]],
      [2, "15:05", 0, "BAS figures for last month are entered, ready for a second check.", []],
      [4, "08:40", 1, "Supplier statements due Monday. Match them against the delivery notes.", [0], 3],
    ] },
    admin: { role: "admin", label: "Admin", notes: [
      [0, "08:05", 0, "New starter's login set up. Password must be changed on first sign-in.", [1]],
      [1, "12:10", 1, "Nightly backup ran clean. Next restore test is due end of month.", [0, "me"]],
      [3, "09:35", 0, "Umbrel update waiting for the owner's OK, not before the weekend.", []],
      [4, "13:50", 1, "Review who still has the Ordering role before the holidays.", [0]],
    ] },
  };
  for (const [dept, c] of Object.entries(others)) {
    if (seeded(dept)) { console.log(dept + " notes already seeded"); continue; }
    const authors = [await mk("notes-" + dept + "-a", c.label + " Test A", c.role), await mk("notes-" + dept + "-b", c.label + " Test B", c.role)], put = putIn(dept);
    for (const [day, hm, who, text, acks, posted] of c.notes) put(thisWeek, day, hm, authors[who], text, acks.map(x => x === "me" ? me : authors[x]), posted);
    console.log("seeded " + dept + " notes", thisWeek);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
