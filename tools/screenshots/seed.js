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
  // M10: made-up order lines in every state on the first job, for the Orders and Deliveries pages:
  // overdue, due today, due this week (with a delivery note), no date yet, received, still to order.
  if (job && !(await api("GET", `/api/job-records/${job.id}/orders?all=1`)).length) {
    const day = (n) => new Date(Date.parse(today + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
    const lines = [
      ["Brightline Hardware", "Drawer runners", -2, "ordered"],
      ["Alder Timber Supplies", "Board pack", 0, "ordered"],
      ["Coastal Stone Co", "Benchtop", 4, "ordered", "Template done; slab on its way"],
      ["Evergreen Laminates", "Laminate sheets", null, "ordered"],
      ["Dovetail Hinges", "Soft-close hinges", -1, "received", "2 of 3 boxes; the rest next week"],
      ["Fairway Freight", "Delivery to site", null, "to_order"],
    ];
    for (const [supplier, description, due, status, deliveryNote] of lines) {
      const { order } = await api("POST", `/api/job-records/${job.id}/orders`, { supplier, description, expectedDate: due === null ? null : day(due) });
      if (status === "to_order") continue;
      await api("PATCH", `/api/orders/${order.id}`, { status: "ordered", orderedDate: day(-5) });
      if (status === "received") await api("PATCH", `/api/orders/${order.id}`, { status: "received", receivedDate: day(-1), deliveryNote });
      else if (deliveryNote) await api("PATCH", `/api/orders/${order.id}`, { deliveryNote });
    }
  }
  // M11: made-up Ordering data, all clearly fake (Demo / Example / Sample names). Drawers: the name
  // list, lines on jobs (checked, waiting for the check, changed in Joinr), two placed orders; the
  // monthly stock order; boards with prices, a valued month with an adjustment, this month counted;
  // paint items and orders. Everything goes through the real routes.
  // Joinr part: set SEED_CONFIG_DIR to the server's CONFIG_DIR (a path as seen from where you run
  // this) and the seed starts a stand-in Joinr (ci/fake-joinr.js, on SEED_JOINR_PORT, default 4891),
  // imports one won quote through the real intake, accepts it, then changes its drawer lines. The
  // config files it writes and the stand-in are removed again. Without SEED_CONFIG_DIR that job
  // gets a hand-typed grid and the Joinr box is not seeded.
  if (!(await api("GET", "/api/drawers/names")).names.length) {
    const jobsAll = await api("GET", "/api/job-records");
    const jobByName = n => (Array.isArray(jobsAll) ? jobsAll : jobsAll.rows || jobsAll.jobs || []).find(j => j.name === n);
    const day = n => new Date(Date.parse(today + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
    const smith = jobByName("Smith kitchen"), nguyen = jobByName("Nguyen laundry"), patel = jobByName("Patel robes"),
      harbour = jobByName("Harbour St vanity"), lee = jobByName("Lee bathroom");
    const c = (height, length, qty) => ({ height, length, qty });

    // The drawer name list: Joinr catalogue names -> brand, height, length; and one Ignore.
    for (const [name, brand, height, length] of [
      ["Demo Drawer Box Mid 500", "edge", 126, 500], ["Demo Drawer Box High 500", "edge", 174, 500], ["Demo Drawer Box Low 400", "edge", 93, 400],
      ["Demo Drawer Box Mid 450", "edge", 126, 450], ["Demo DTC Drawer 127 x 450", "dtc", 127, 450], ["Demo DTC Drawer 178 x 500", "dtc", 178, 500],
      ["Demo DTC Inner Drawer 95 x 400", "dtc", 95, 400]]) await api("POST", "/api/drawers/names", { name, brand, height, length });
    await api("POST", "/api/drawers/names", { name: "Demo Runner Set (not a drawer)", ignored: true });

    // A job that came from Joinr: accepted through the real intake, then Joinr changes a quantity, so
    // its job page shows the Joinr box (mapped, unmapped, ignored) and "Changed in Joinr".
    let joinrJob = null;
    const joinrStep = async () => {
    const cfg = process.env.SEED_CONFIG_DIR;
    if (cfg) {
      const fs = require("fs"), path = require("path"), { spawn } = require("child_process");
      const port = +(process.env.SEED_JOINR_PORT || 4891), key = "seed-demo-key-0001", jb = "http://127.0.0.1:" + port;
      const keyFile = path.join(cfg, "joinr-api-key"), baseFile = path.join(cfg, "joinr-base-url");
      const fake = spawn(process.execPath, [path.join(__dirname, "../../ci/fake-joinr.js"), String(port), key], { stdio: "ignore" });
      try {
        for (let k = 0; k < 40; k++) { try { await fetch(jb + "/_control/requests"); break; } catch { await new Promise(r => setTimeout(r, 150)); } }
        fs.writeFileSync(keyFile, key + "\n"); fs.writeFileSync(baseFile, jb + "\n");
        const root = "5eed0000-0000-4000-8000-000000000011";
        const quote = drawers => fetch(jb + "/_control/event", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          rootQuoteId: root, quoteId: root, quoteNumber: "Q-DEMO-0042", siteAddress: "Demo Cooper pantry", clientName: "Cooper (made up)",
          wonAt: "2026-10-01T01:00:00Z", updatedAt: "2026-10-01T01:00:00Z", drawers }) });
        const list = high => [{ section: "drawers", name: "Demo Drawer Box Mid 500", qty: 6 }, { section: "drawers", name: "Demo Drawer Box High 500", qty: high },
          { section: "drawers", name: "Demo Runner Set (not a drawer)", qty: 10 }, { section: "innerDrawers", name: "Demo Pot Drawer 600", qty: 2 }];
        await quote(list(4));
        await api("POST", "/api/joinr/import", {});
        const item = (await api("GET", "/api/joinr/intake")).rows.find(i => i.quoteNumber === "Q-DEMO-0042");
        joinrJob = (await api("POST", `/api/joinr/intake/${item.id}/accept`, {})).job;
        const jl = (await api("GET", `/api/job-records/${joinrJob.id}/drawers`)).lines;
        await api("POST", `/api/orders/${jl[0].id}/drawers/check`, { checked: true });
        await quote(list(5)); // Joinr now says 5 High 500, not 4
        await api("POST", "/api/joinr/import", {});
      } finally { fake.kill(); fs.rmSync(keyFile, { force: true }); fs.rmSync(baseFile, { force: true }); }
    }
    };
    const drawerLine = async (job, brand, counts, notes, checked) => (await api("POST", `/api/job-records/${job.id}/drawers`, { brand, counts, notes, checked: !!checked })).order.id;

    // Placed first, so they are history: an EDGE order for two jobs plus a stock row (stock still to
    // arrive), and a DTC order whose stock row has been received.
    const edgeIds = [
      await drawerLine(smith, "edge", [c(126, 500, 8), c(174, 500, 6), c(93, 400, 2)], "Soft-close, white. Check the inner depth.", true),
      await drawerLine(nguyen, "edge", [c(126, 450, 4), c(174, 500, 4)], "Laundry: two wide drawers.", true)];
    await api("PUT", "/api/drawers/stock", { brand: "edge", counts: [c(126, 500, 6), c(174, 500, 4), c(93, 400, 2)] });
    await api("POST", "/api/drawers/place", { brand: "edge", orderedDate: day(-6), expectedDate: day(3), orderIds: edgeIds });
    const dtcIds = [await drawerLine(patel, "dtc", [c(127, 450, 5), c(178, 500, 3)], "Robes: the deep drawers go in the centre run.", true)];
    await api("PUT", "/api/drawers/stock", { brand: "dtc", counts: [c(127, 450, 4)] });
    const dtcPlaced = await api("POST", "/api/drawers/place", { brand: "dtc", orderedDate: day(-12), expectedDate: day(-5), orderIds: dtcIds });
    await api("POST", `/api/drawers/placed/${dtcPlaced.drawerOrder.id}/stock-received`, { receivedDate: day(-4), deliveryNote: "Stock row came with the job boxes" });

    // Still to order. EDGE: the Joinr job (checked), the vanity (checked), the bathroom (waiting for
    // the check) and a stock row. DTC: the kitchen pull-outs (checked), the laundry (waiting).
    await joinrStep();
    if (!joinrJob) await drawerLine(harbour, "edge", [c(126, 500, 6), c(174, 500, 4)], "Typed in by hand", true);
    else await drawerLine(harbour, "edge", [c(126, 500, 3), c(238, 500, 2)], "Vanity: two deep drawers.", true);
    await drawerLine(lee, "edge", [c(174, 400, 6), c(126, 400, 6)], "Waiting on the handle choice", false);
    await api("PUT", "/api/drawers/stock", { brand: "edge", counts: [c(126, 500, 6), c(174, 500, 4), c(93, 400, 2), c(126, 450, 2)] });
    await drawerLine(smith, "dtc", [c(127, 450, 4), c(95, 400, 4)], "Pantry pull-outs", true);
    await drawerLine(nguyen, "dtc", [c(178, 500, 2)], "", false);
    await api("PUT", "/api/drawers/stock", { brand: "dtc", counts: [c(127, 450, 4), c(178, 500, 2)] });

    // Monthly stock order, three supplier groups. Last month is counted: Example Hardware ordered
    // and received, Sample Adhesives ordered and waiting, Demo Abrasives not yet ordered. This
    // month is being counted (the first seven items).
    const STOCK = [
      ["Example Hardware Co", [["EH-101", "Screws 4 x 30 (box)"], ["EH-114", "Cam locks 15 mm (bag)"], ["EH-120", "Edge nails (box)"], ["EH-133", "Shelf pins (bag)"], ["EH-140", "Hinge plates (box)"]]],
      ["Sample Adhesives", [["SA-20", "PVA glue 5 L"], ["SA-31", "Contact cement 1 L"], ["SA-35", "Silicone, clear (tube)"], ["SA-44", "Hot-melt sticks (bag)"]]],
      ["Demo Abrasives", [["DA-80", "Sanding discs 80 grit (pack)"], ["DA-120", "Sanding discs 120 grit (pack)"], ["DA-240", "Sanding sheets 240 (pack)"], ["DA-TP", "Masking tape 48 mm (roll)"]]]];
    const itemIds = [];
    for (const [supplier, items] of STOCK) for (const [code, item] of items) itemIds.push((await api("POST", "/api/stock/items", { supplier, code, item, link: code === "EH-101" ? "https://example.com/screws" : "" })).id);
    const have = k => (k * 7 + 3) % 11, want = k => (k % 3 === 0 ? 0 : (k * 5) % 9 + 2);
    await api("PUT", `/api/stock/orders/${lastMonth}/have`, { lines: itemIds.map((itemId, k) => ({ itemId, have: have(k) })) });
    await api("POST", `/api/stock/orders/${lastMonth}/counted`, {});
    await api("PUT", `/api/stock/orders/${lastMonth}/order`, { lines: itemIds.map((itemId, k) => ({ itemId, order: want(k) })) });
    await api("POST", `/api/stock/orders/${lastMonth}/groups`, { supplier: "Example Hardware Co", orderedDate: day(-14), expectedDate: day(-9) });
    await api("POST", `/api/stock/orders/${lastMonth}/groups/received`, { supplier: "Example Hardware Co", receivedDate: day(-8), deliveryNote: "All boxes; one bag of pins short" });
    await api("POST", `/api/stock/orders/${lastMonth}/groups`, { supplier: "Sample Adhesives", orderedDate: day(-7), expectedDate: day(-1) });
    await api("PUT", `/api/stock/orders/${thisMonth}/have`, { lines: itemIds.slice(0, 7).map((itemId, k) => ({ itemId, have: have(k + 2) })) });

    // Boards, with a price per sheet (ex GST); the last has none yet. Two months ago and last month
    // are valued (last month with an adjustment and its note); this month is counted, waiting for the value.
    const boardIds = [];
    for (const [supplier, thickness, name, finish, priceCents] of [
      ["Example Board Co", 16, "White melamine", "Matt", 5400], ["Example Board Co", 16, "Oak veneer", "Natural", 11800], ["Example Board Co", 18, "Black melamine", "Fine texture", 7900],
      ["Sample Panels", 16, "Grey melamine", "Matt", 6150], ["Sample Panels", 18, "Walnut laminate", "Gloss", 14250], ["Sample Panels", 3, "White hardboard", "", 1850],
      ["Demo Plywood", 12, "Birch ply", "Raw", 9600], ["Demo Plywood", 18, "Birch ply", "Raw", 12400], ["Demo Plywood", 18, "New sample board", "Test", null]]) {
      boardIds.push((await api("POST", "/api/boards", { supplier, thickness, name, finish, priceCents })).id);
    }
    const qty = (k, s) => ((k * 3 + s) % 7) + (k % 2 ? 0.5 : 0);
    for (const [period, s, adj] of [[P.addMonths(thisMonth, -2), 1, {}], [lastMonth, 4, { adjustmentCents: -45000, adjustmentNote: "Write-off: water-damaged sheets" }]]) {
      await api("PUT", `/api/boards/counts/${period}/lines`, { lines: boardIds.map((boardId, k) => ({ boardId, qty: k === boardIds.length - 1 ? 0 : qty(k, s) })) });
      await api("POST", `/api/boards/counts/${period}/counted`, {});
      await api("POST", `/api/boards/counts/${period}/value`, adj);
    }
    await api("PUT", `/api/boards/counts/${thisMonth}/lines`, { lines: boardIds.map((boardId, k) => ({ boardId, qty: qty(k, 2) })) });
    await api("POST", `/api/boards/counts/${thisMonth}/counted`, {});

    // Paint: the list, an ordered paint order with job lines and a no-job workshop line, and a draft.
    const paint = {};
    for (const [key, name, finish, manufacturer, kind, unit] of [
      ["white", "Demo White", "Satin", "Example Coatings", "colour", "kg"], ["grey", "Sample Grey", "Matt", "Example Coatings", "colour", "kg"],
      ["green", "Example Sage Green", "Satin", "Sample Paints", "colour", "kg"], ["hard", "Demo Hardener", "", "Example Coatings", "hardener", "each"],
      ["thin", "Demo Thinners 5 L", "", "Sample Paints", "thinners", "each"], ["prime", "Example Primer", "", "Sample Paints", "primer", "kg"],
      ["abr", "Demo Abrasive Pads", "", "Sample Paints", "abrasive", "each"]]) paint[key] = (await api("POST", "/api/paint/items", { name, finish, manufacturer, kind, unit })).id;
    const ordered = await api("POST", "/api/paint/orders", { supplier: "Example Coatings", notes: "Deliver to the workshop dock", expectedDate: day(4), lines: [
      { paintItemId: paint.white, qty: 8, jobId: smith.id }, { paintItemId: paint.hard, qty: 2, jobId: smith.id }, { paintItemId: paint.grey, qty: 5, jobId: patel.id },
      { paintItemId: paint.white, qty: 10 }, { paintItemId: paint.thin, qty: 3 }] });
    await api("POST", `/api/paint/orders/${ordered.id}/ordered`, { orderedDate: day(-2), expectedDate: day(4) });
    await api("POST", "/api/paint/orders", { supplier: "Sample Paints", notes: "Check the colour card first", lines: [
      { paintItemId: paint.green, qty: 4.5, jobId: nguyen.id }, { paintItemId: paint.prime, qty: 6 }, { paintItemId: paint.abr, qty: 20 },
      { name: "Demo one-off tint", unit: "each", qty: 1, jobId: lee.id }] });
  }
  console.log("seeded; week", wk, "workers", workers.length);
})().catch(e => { console.error(e.message); process.exit(1); });
