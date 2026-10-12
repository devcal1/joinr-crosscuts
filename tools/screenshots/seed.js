// Local dev only. Seeds a local Crosscuts (dev shim) with sample workers, board rows, a flag and
// a note, for screenshots: node tools/screenshots/seed.js [base, default http://localhost:3997]
// The admin below is a test-only account for a throwaway local database (.dev or a temp dir).
const B = process.argv[2] || "http://localhost:3997";
const USER = "admin", PW = "Shots-Local-Test-1";
let cookie = "";
async function api(method, path, body) {
  const r = await fetch(B + path, { method, headers: { Origin: B, "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const sid = (r.headers.getSetCookie() || []).find(c => c.startsWith("crosscuts_sid=")); if (sid) cookie = sid.split(";")[0];
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 200)}`);
  return j;
}
(async () => {
  const st = await api("GET", "/api/auth/status");
  if (st.setupNeeded) await api("POST", "/api/auth/setup", { username: USER, displayName: "Todd (local)", password: PW });
  else await api("POST", "/api/auth/login", { username: USER, password: PW });
  let workers = await api("GET", "/api/workers");
  for (const n of ["Sam", "Priya", "Jordan", "Alex"]) if (!workers.find(w => w.name === n)) await api("POST", "/api/workers", { name: n });
  workers = await api("GET", "/api/workers");
  const sched = await api("GET", "/api/schedule");
  const wk = sched.weeks[0].start, wk2 = sched.weeks[1].start;
  const id = n => workers[n % workers.length].id;
  const jobs = [["Smith kitchen", "manufacturing"], ["Nguyen laundry", "manufacturing"], ["Harbour St vanity", "installing"], ["Patel robes", "installing"]];
  let i = 0;
  for (const [name, panel] of jobs) {
    const row = await api("POST", "/api/rows", { weekStart: wk, panel, jobName: name, notes: i === 0 ? "Check handle spec" : "" });
    for (const d of ["mon", "tue", "wed"]) await api("POST", `/api/rows/${row.rowId}/assignments`, { day: d, workerId: id(i) });
    await api("POST", `/api/rows/${row.rowId}/assignments`, { day: "thu", workerId: id(i + 1) });
    if (panel === "installing" && i === 2) await api("POST", `/api/rows/${row.rowId}/flags`, { day: "tue" });
    i++;
  }
  await api("POST", "/api/rows", { weekStart: wk2, panel: "manufacturing", jobName: "Lee bathroom" });

  // M4: tasks (one overdue, one on a job), a job comment, chat messages and a report.
  const me = (await api("GET", "/api/auth/me")).user;
  const jobsList = await api("GET", "/api/job-records");
  const job = (Array.isArray(jobsList) ? jobsList : jobsList.rows || jobsList.jobs || [])[0];
  const existing = (await api("GET", "/api/tasks?view=open")).rows;
  if (!existing.length) {
    await api("POST", "/api/tasks", { title: "Check BAS draft before lodging", assigneeId: me.id, dueDate: "2026-10-01" });
    await api("POST", "/api/tasks", { title: "Confirm handle spec with client", assigneeId: me.id, notes: "Brushed nickel or matt black?", jobId: job ? job.id : null });
    await api("POST", "/api/tasks", { title: "Book the stone template", assigneeId: me.id });
    if (job) await api("POST", "/api/comments", { entityType: "job", entityId: job.id, body: "Client asked to move install a week. See https://example.com/note." });
    const ch = (await api("GET", "/api/messages/channels")).rows;
    for (const body of ["Morning all. Truck is in at 10.", "Stone for Smith kitchen arrives Thursday."]) await api("POST", `/api/messages/channels/${ch[0].id}`, { body });
    const fd = new FormData();
    fd.append("file", new Blob([Buffer.from("%PDF-1.4\n% seed\n")], { type: "application/pdf" }), "BAS September 2026.pdf");
    fd.append("period", "2026-09"); fd.append("category", "bas"); fd.append("title", "BAS September 2026");
    const r = await fetch(B + "/api/reports", { method: "POST", headers: { Origin: B, Cookie: cookie }, body: fd });
    if (!r.ok) throw new Error(`POST /api/reports ${r.status}`);
  }

  // M5: a two-pac stone job with materials ordered, a sick day this week and a part-timer.
  if (job) {
    await api("PATCH", `/api/job-records/${job.id}`, { isTwoPac: true, benchtop: "stone" });
    const jr = await fetch(B + `/api/job-records/${job.id}/materials-ordered`, { method: "POST", headers: { Origin: B, Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
    if (!jr.ok && jr.status !== 409) throw new Error(`materials-ordered ${jr.status}`);
  }
  const av = await api("GET", "/api/availability");
  if (!av.leave.length) {
    const tue = new Date(Date.parse(wk + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
    await api("POST", "/api/availability/leave", { workerId: id(1), from: tue, to: tue, kind: "sick" });
    await api("PATCH", `/api/availability/workers/${id(0)}`, { daysPerWeek: 3 });
  }

  // M8: this fortnight's pay run (id 1 on a fresh database) with a pay-only person and two sheets
  // typed in, one ticked as typed in. Made-up hours only.
  if (!(await api("GET", "/api/payruns")).payRuns.length) {
    await api("POST", "/api/payruns/people", { name: "Casey (office)" });
    const run = await api("POST", "/api/payruns", {});
    const typed = [[420, 1020, 30], [420, 1080, 30], [420, 1110, 30], [420, 990, 30], [420, 840, 30]];
    const sheets = [];
    for (const s of run.timesheets) sheets.push(await api("GET", `/api/payruns/${run.id}/timesheets/${s.id}`));
    const onBoard = sheets.find(ts => ts !== sheets[0] && Object.values(ts.suggestions).some(g => g.job)) || sheets[1];
    for (const [n, ts] of [sheets[0], onBoard].entries()) {
      const days = ts.days.map((d, k) => {
        const g = ts.suggestions[d.date] || {};
        if (g.sickMin || g.arlMin || g.pholMin) return { date: d.date, sickMin: g.sickMin, arlMin: g.arlMin, pholMin: g.pholMin, job: "" };
        const [startMin, finishMin, lunchMin] = typed[(k + n) % typed.length];
        return { date: d.date, startMin, finishMin, lunchMin, onsiteMin: k === 2 ? 180 : null, job: g.job || "" };
      });
      await api("PUT", `/api/payruns/${run.id}/timesheets/${ts.id}`, { days, notes: n ? "" : "Sat 3 h at Smith kitchen", signed: true, entered: n === 0, updatedAt: ts.updatedAt });
    }
  }
  // M9: made-up BAS history (hand amounts, two months lodged) and a supplier month (last month,
  // mixed states). Made-up names and amounts only.
  const P = require("../../crosscuts/app/public/periods");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
  const thisMonth = P.currentPeriod(today), lastMonth = P.addMonths(thisMonth, -1);
  if (!(await api("GET", "/api/suppliers")).suppliers.length) {
    for (let k = 1; k <= 15; k++) {
      const period = P.addMonths(thisMonth, -k);
      const handCents = 3000000 + ((k * 7919) % 25) * 100000;
      await api("PUT", `/api/bas/months/${period}/hand`, { handCents, handGstCents: k % 4 ? Math.round(handCents / 11) : null, handNote: "From the old workbook" });
    }
    for (const k of [3, 2]) await api("POST", `/api/bas/months/${P.addMonths(thisMonth, -k)}/lodge`, {});
    const names = ["Alder Timber Supplies", "Brightline Hardware", "Coastal Stone Co", "Dovetail Hinges", "Evergreen Laminates", "Fairway Freight"];
    for (const name of names) await api("POST", "/api/suppliers", { name, fromPeriod: P.addMonths(thisMonth, -3) });
    const month = await api("GET", `/api/suppliers/months/${lastMonth}`);
    const lines = [
      { state: "have", totalCents: 482150, reconciled: true, paid: true, myob: true },
      { state: "have", totalCents: 129900, reconciled: true, paid: false, myob: false, note: "Query the freight charge" },
      { state: "waiting" },
      { state: "have", totalCents: -4500, reconciled: false, paid: false, myob: false, note: "Credit for a returned hinge" },
      { state: "na", note: "Nothing bought this month" },
      { state: "waiting" },
    ];
    for (const [n, line] of month.lines.entries()) {
      const want = lines[n % lines.length];
      if (want.state === "waiting") continue;
      await api("PUT", `/api/suppliers/months/${lastMonth}/${line.supplier.id}`, { totalCents: null, note: "", reconciled: false, paid: false, myob: false, ...want, updatedAt: line.updatedAt });
    }
  }
  console.log("seeded; week", wk, "workers", workers.length);
})().catch(e => { console.error(e.message); process.exit(1); });
