// Local dev only. Adds department notes (0.1.19) to a seeded local Crosscuts, for screenshots:
//   DB_DIR=<the server's db dir> node tools/screenshots/seed-notes.js [base, default http://localhost:3997]
// Run after seed.js. Notes are inserted straight into dept_notes (the app only writes the current
// week, and a note's time is then "now"), by made-up Design/PM test users. Runs once: skips if the
// Design/PM sheet already has notes.
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
(async () => {
  const dbDir = process.env.DB_DIR; if (!dbDir) throw new Error("set DB_DIR to the server's db dir");
  await api("POST", "/api/auth/login", { username: "admin", password: "Shots-Local-Test-1" });
  const users = await api("GET", "/api/users"), rows = Array.isArray(users) ? users : users.rows || users.users || [];
  const mk = async (username, displayName) => rows.find(u => u.username === username)
    || await api("POST", "/api/users", { username, displayName, password: "Menu-Local-Test-1", roles: ["design_pm"] });
  const a = await mk("notes-dpm-a", "Design Test A"), b = await mk("notes-dpm-b", "Design Test B");
  const me = (await api("GET", "/api/auth/me")).user;
  const db = new DatabaseSync(path.join(dbDir, "photos.db"));
  if (db.prepare("SELECT COUNT(*) n FROM dept_notes WHERE dept = 'design'").get().n) { console.log("design notes already seeded"); return; }
  const mon = (await api("GET", "/api/notes?dept=design")).weeks.map(w => w.weekStart);
  const ins = db.prepare("INSERT INTO dept_notes (dept, week_start, body, author_id, created_at, updated_at) VALUES ('design', ?, ?, ?, ?, ?)");
  const at = (week, day, hm) => { const d = new Date(Date.parse(week + "T00:00:00Z") + day * 86400000); return d.toISOString().slice(0, 10) + "T" + hm + ":00.000Z"; };
  const put = (week, day, hm, author, text) => { const t = at(week, day, hm); ins.run(week, text, author.id, t, t); };
  put(mon[1], 1, "22:10", a, "Harbour St vanity: client confirmed the matt black handles, drawings updated to rev C.");
  put(mon[1], 3, "04:30", b, "Waiting on the stone template for the Lee bathroom before we release the cabinet drawings.");
  put(mon[1], 4, "01:05", a, "Friday: all site measures for next week are in the shared folder.");
  put(mon[0], 0, "23:40", b, "Smith kitchen: island depth changed to 900 mm. Please check the cut list again.");
  put(mon[0], 1, "03:15", me, "Reminder: the Cooper pantry quote needs sign-off from accounts by Thursday.");
  put(mon[0], 2, "00:20", a, "Hinge samples arrived. They are on the design desk if anyone wants to look.");
  console.log("seeded design notes", mon.join(" "));
})().catch(e => { console.error(e.message); process.exit(1); });
