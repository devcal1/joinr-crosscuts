// Local dev only. Full-page PNGs of every Crosscuts page through headless Edge (CDP), for style
// reviews. Start a local server (see CLAUDE.md "Local development"), seed it with seed.js, then:
//   node tools/screenshots/shoot.js <outDir> [base, default http://localhost:3997]
// Env: PAGES=login,dashboard (subset), CDP_PORT (default 9333). Logs in as the seed.js test admin.
// An entry may name a role (5th item): it is then shot as that role's throwaway local user (m-<role>,
// the same ones menu-shots.js makes; created here through the admin API if missing). An entry's url
// may be a function of the ids found after login (the seeded placed orders, paint orders, jobs).
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path");
const OUT = process.argv[2], B = process.argv[3] || "http://localhost:3997";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = +(process.env.CDP_PORT || 9333), PROFILE = path.join(require("os").tmpdir(), "crosscuts-shots-edge-" + PORT);
const P = require("../../crosscuts/app/public/periods");
const ONLY = (process.env.PAGES || "").split(",").filter(Boolean);
const PAGES = [
  ["login", "/login.html", 1440, false], ["dashboard", "/", 1440, true], ["search", "/search.html", 1440, true],
  ["photo-admin", "/admin.html", 1440, true], ["users", "/users.html", 1440, true], ["audit", "/audit.html", 1440, true],
  ["jobs", "/jobs.html", 1440, true], ["job", "/job.html?id=1", 1440, true], ["accounts", "/accounts.html", 1440, true],
  ["board-tv", "/schedule.html", 1920, true], ["workers", "/workers.html", 1440, true], ["phone-dashboard", "/", 390, true],
  ["setup", "/setup.html", 1440, false], ["design", "/design.html", 1440, true], ["scheduling", "/scheduling.html", 1440, true], ["board-laptop", "/schedule.html", 1440, true], ["phone-board", "/schedule.html", 390, true],
  ["tasks", "/tasks.html", 1440, true], ["messages", "/messages.html", 1440, true], ["reports", "/reports.html", 1440, true],
  ["availability", "/availability.html", 1440, true], ["lookahead", "/lookahead.html", 1440, true], ["phone-lookahead", "/lookahead.html", 375, true], ["phone-availability", "/availability.html", 375, true],
  ["phone-tasks", "/tasks.html", 375, true], ["phone-messages", "/messages.html", 375, true], ["phone-reports", "/reports.html", 375, true],
  ["planner", "/planner.html", 1440, true], ["planner-1100", "/planner.html", 1100, true], ["phone-planner", "/planner.html", 375, true],
  ["payruns", "/payruns.html", 1440, true], ["payrun", "/payrun.html?id=1", 1440, true], ["payrun-1100", "/payrun.html?id=1", 1100, true], ["phone-payruns", "/payruns.html", 375, true],
  ["bas", "/bas.html", 1440, true], ["bas-1100", "/bas.html", 1100, true], ["suppliers", "/suppliers.html", 1440, true], ["phone-bas", "/bas.html", 375, true], ["phone-suppliers", "/suppliers.html", 375, true],
  ["deliveries", "/deliveries.html", 1440, true], ["phone-deliveries", "/deliveries.html", 375, true], ["orders-1100", "/orders.html", 1100, true],
  // M11 Ordering pages (seed.js): [name, url, width, auth, role, section]; a section selector shoots just that part of a long page.
  ["drawers-edge", "/drawers.html#edge", 1440, true, "ordering"], ["drawers-dtc", "/drawers.html#dtc", 1440, true, "ordering"],
  ["drawers-placed", "/drawers.html#placed", 1440, true, "ordering"], ["drawers-placed-sheet", c => "/drawers.html?placed=" + c.placedEdge, 1440, true, "ordering"],
  ["drawers-placed-sheet-dtc", c => "/drawers.html?placed=" + c.placedDtc, 1440, true, "ordering"],
  ["drawers-names", "/drawers.html#names", 1440, true, "ordering"], ["drawers-settings", "/drawers.html#settings", 1440, true, "ordering"],
  ["phone-drawers", "/drawers.html#edge", 375, true, "ordering"], ["phone-drawers-placed-sheet", c => "/drawers.html?placed=" + c.placedEdge, 375, true, "ordering"],
  ["stock-count-wsmgr", "/stock.html#count", 1440, true, "workshop_manager"], ["stock-count-ordering", "/stock.html#count", 1440, true, "ordering"],
  ["stock-order", c => "/stock.html?period=" + c.lastMonth + "#order", 1440, true, "ordering"], ["stock-list", "/stock.html#list", 1440, true, "ordering"],
  ["phone-stock-count", "/stock.html#count", 375, true, "workshop_manager"],
  ["boards-count-wsmgr", c => "/boards.html?period=" + c.thisMonth + "#count", 1440, true, "workshop_manager"],
  ["boards-value", c => "/boards.html?period=" + c.thisMonth + "#value", 1440, true, "ordering"],
  ["boards-value-valued", c => "/boards.html?period=" + c.lastMonth + "#value", 1440, true, "ordering"], ["boards-list", "/boards.html#list", 1440, true, "ordering"],
  ["phone-boards-value", c => "/boards.html?period=" + c.thisMonth + "#value", 375, true, "ordering"],
  ["stockvalue", "/stockvalue.html", 1440, true, "accounts"], ["stockvalue-admin", "/stockvalue.html", 1440, true], ["phone-stockvalue", "/stockvalue.html", 375, true, "accounts"],
  ["paint", "/paint.html", 1440, true, "ordering"], ["paint-order", c => "/paint.html?id=" + c.paintOrdered, 1440, true, "ordering"],
  ["paint-draft", c => "/paint.html?id=" + c.paintDraft, 1440, true, "ordering"], ["paint-list", "/paint.html#list", 1440, true, "ordering"],
  ["paint-order-wsmgr", c => "/paint.html?id=" + c.paintOrdered, 1440, true, "workshop_manager"], ["phone-paint-order", c => "/paint.html?id=" + c.paintOrdered, 375, true, "ordering"],
  ["deliveries-wsmgr", "/deliveries.html", 1440, true, "workshop_manager"], ["deliveries-ordering", "/deliveries.html", 1440, true, "ordering"],
  ["job-drawers-joinr", c => "/job.html?id=" + c.jobJoinr + "#orders", 1440, true, undefined, "#orders"], ["job-drawers-waiting", c => "/job.html?id=" + c.jobLee + "#orders", 1440, true, undefined, "#orders"],
  ["job-drawers-placed", c => "/job.html?id=" + c.jobSmith + "#orders", 1440, true, undefined, "#orders"], ["phone-job-drawers", c => "/job.html?id=" + c.jobJoinr + "#orders", 375, true, undefined, "#orders"],
  ["dashboard-ordering", "/", 1440, true, "ordering"], ["dashboard-wsmgr", "/", 1440, true, "workshop_manager"], ["dashboard-accounts", "/", 1440, true, "accounts"],
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PW = "Menu-Local-Test-1", PW2 = "Menu-Local-Test-2"; // test-only passwords for throwaway local users (as menu-shots.js)
async function apiCall(method, p, body, cookie) {
  const r = await fetch(B + p, { method, headers: { Origin: B, "Content-Type": "application/json", Cookie: cookie || "" }, body: body ? JSON.stringify(body) : undefined });
  const c = (r.headers.getSetCookie() || []).find(x => x.startsWith("crosscuts_sid="));
  let j; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j, cookie: c ? c.split(";")[0] : null };
}
async function sid() {
  const r = await apiCall("POST", "/api/auth/login", { username: "admin", password: "Shots-Local-Test-1" });
  if (!r.cookie) throw new Error("login failed " + r.status); return r.cookie.split("=")[1];
}
// One throwaway user per role, as menu-shots.js: a new user must choose their own password first.
async function roleCookie(role, admin) {
  const u = "m-" + role.replace("_", "");
  let r = await apiCall("POST", "/api/auth/login", { username: u, password: PW2 });
  if (r.cookie) return r.cookie.split("=")[1];
  const have = (await apiCall("GET", "/api/users", null, "crosscuts_sid=" + admin)).body;
  const rows = Array.isArray(have) ? have : (have && (have.rows || have.users)) || [];
  if (!rows.find(x => x.username === u)) {
    const c = await apiCall("POST", "/api/users", { username: u, displayName: role.replace("_", " ") + " test", password: PW, roles: [role] }, "crosscuts_sid=" + admin);
    if (c.status >= 300) throw new Error("create " + u + " " + c.status + JSON.stringify(c.body));
  }
  r = await apiCall("POST", "/api/auth/login", { username: u, password: PW });
  const ch = await apiCall("POST", "/api/auth/password", { currentPassword: PW, newPassword: PW2 }, r.cookie);
  if (ch.status >= 300) throw new Error("password change " + u + " " + ch.status + JSON.stringify(ch.body));
  r = await apiCall("POST", "/api/auth/login", { username: u, password: PW2 });
  if (!r.cookie) throw new Error("login failed for " + u);
  return r.cookie.split("=")[1];
}
// The ids the M11 entries need, found through the admin API (seed.js made them).
async function findIds(admin) {
  const ck = "crosscuts_sid=" + admin, get = async p => (await apiCall("GET", p, null, ck)).body || {};
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
  const thisMonth = P.currentPeriod(today), c = { thisMonth, lastMonth: P.addMonths(thisMonth, -1) };
  const placed = (await get("/api/drawers/placed")).placed || [];
  c.placedEdge = (placed.find(p => p.brand === "edge") || {}).id; c.placedDtc = (placed.find(p => p.brand === "dtc") || {}).id;
  const paint = (await get("/api/paint/orders?status=all")).orders || [];
  c.paintOrdered = (paint.find(p => p.status === "ordered") || {}).id; c.paintDraft = (paint.find(p => p.status === "draft") || {}).id;
  const jr = await get("/api/job-records"), jobs = Array.isArray(jr) ? jr : jr.rows || jr.jobs || [];
  const byName = n => (jobs.find(j => j.name === n) || {}).id;
  c.jobJoinr = byName("Demo Cooper pantry") || byName("Harbour St vanity"); c.jobLee = byName("Lee bathroom"); c.jobSmith = byName("Smith kitchen");
  return c;
}
(async () => {
  fs.mkdirSync(OUT, { recursive: true }); fs.rmSync(PROFILE, { recursive: true, force: true });
  const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
  let targets; for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(250); } }
  const page = targets.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), waiters = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) waiters.forEach(w => w(m)); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const loaded = () => new Promise(r => { const w = m => { if (m.method === "Page.loadEventFired") { waiters.splice(waiters.indexOf(w), 1); r(); } }; waiters.push(w); });
  await send("Page.enable"); await send("Network.enable");
  const cookie = await sid(), todo = PAGES.filter(p => !ONLY.length || ONLY.includes(p[0]));
  const cookies = { admin: cookie }, ids = await findIds(cookie);
  for (const role of new Set(todo.map(p => p[4]).filter(Boolean))) cookies[role] = await roleCookie(role, cookie);
  for (const [name, urlOrFn, width, auth, role, section] of todo) {
    const url = typeof urlOrFn === "function" ? urlOrFn(ids) : urlOrFn;
    await send("Network.clearBrowserCookies");
    if (auth) await send("Network.setCookie", { name: "crosscuts_sid", value: cookies[role || "admin"], url: B, path: "/" });
    await send("Emulation.setDeviceMetricsOverride", { width, height: width === 1920 ? 1080 : 900, deviceScaleFactor: 1, mobile: width < 500 });
    // Via a blank page, so two entries that differ only in the #hash still load (a hash-only change
    // is a same-document navigation: no load event).
    const b = loaded(); await send("Page.navigate", { url: "about:blank" }); await b;
    const l = loaded(); await send("Page.navigate", { url: B + url }); await l; await sleep(1200);
    if (section) {
      // A long page (the job page): shoot just this section, tall enough to hold it, scrolled to its top.
      const r = await send("Runtime.evaluate", { expression: `(function(){var e=document.querySelector(${JSON.stringify(section)});if(!e)return null;var b=e.getBoundingClientRect();return{top:b.top+scrollY,h:b.height}})()`, returnByValue: true });
      const box = r.result.result.value;
      if (box) {
        const sh = Math.min(Math.ceil(box.h) + 140, 2600);
        await send("Emulation.setDeviceMetricsOverride", { width, height: sh, deviceScaleFactor: 1, mobile: width < 500 }); await sleep(300);
        await send("Runtime.evaluate", { expression: `scrollTo(0, ${Math.max(0, box.top - 90)})` }); await sleep(400);
        const sShot = await send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(sShot.result.data, "base64"));
        console.log(name, width + "x" + sh, "(section " + section + ")");
        continue;
      }
    }
    const { result } = await send("Page.getLayoutMetrics");
    const h = Math.min(Math.ceil(result.cssContentSize.height), 4000);
    const vh = width === 1920 ? 1080 : 900;
    if (h > vh) { await send("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: 1, mobile: width < 500 }); await sleep(400); }
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.max(h, 600), scale: 1 } });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(shot.result.data, "base64"));
    console.log(name, width + "x" + h);
  }
  ws.close(); edge.kill();
})().catch(e => { console.error(e); process.exit(1); });
