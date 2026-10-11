// Local dev only. Full-page PNGs of every Crosscuts page through headless Edge (CDP), for style
// reviews. Start a local server (see CLAUDE.md "Local development"), seed it with seed.js, then:
//   node tools/screenshots/shoot.js <outDir> [base, default http://localhost:3997]
// Env: PAGES=login,dashboard (subset), CDP_PORT (default 9333). Logs in as the seed.js test admin.
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path");
const OUT = process.argv[2], B = process.argv[3] || "http://localhost:3997";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = +(process.env.CDP_PORT || 9333), PROFILE = path.join(require("os").tmpdir(), "crosscuts-shots-edge-" + PORT);
const ONLY = (process.env.PAGES || "").split(",").filter(Boolean);
const PAGES = [
  ["login", "/login.html", 1440, false], ["dashboard", "/", 1440, true], ["search", "/search.html", 1440, true],
  ["photo-admin", "/admin.html", 1440, true], ["users", "/users.html", 1440, true], ["audit", "/audit.html", 1440, true],
  ["jobs", "/jobs.html", 1440, true], ["job", "/job.html?id=1", 1440, true], ["accounts", "/accounts.html", 1440, true],
  ["board-tv", "/schedule.html", 1920, true], ["workers", "/workers.html", 1440, true], ["phone-dashboard", "/", 390, true],
  ["setup", "/setup.html", 1440, false], ["design", "/design.html", 1440, true], ["scheduling", "/scheduling.html", 1440, true], ["board-laptop", "/schedule.html", 1440, true], ["phone-board", "/schedule.html", 390, true],
  ["tasks", "/tasks.html", 1440, true], ["messages", "/messages.html", 1440, true], ["reports", "/reports.html", 1440, true],
  ["availability", "/availability.html", 1440, true], ["lookahead", "/lookahead.html", 1440, true],
  ["phone-tasks", "/tasks.html", 375, true], ["phone-messages", "/messages.html", 375, true], ["phone-reports", "/reports.html", 375, true],
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function sid() {
  const r = await fetch(B + "/api/auth/login", { method: "POST", headers: { Origin: B, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "Shots-Local-Test-1" }) });
  const c = (r.headers.getSetCookie() || []).find(c => c.startsWith("crosscuts_sid="));
  if (!c) throw new Error("login failed " + r.status); return c.split(";")[0].split("=")[1];
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
  const cookie = await sid();
  for (const [name, url, width, auth] of PAGES.filter(p => !ONLY.length || ONLY.includes(p[0]))) {
    await send("Network.clearBrowserCookies");
    if (auth) await send("Network.setCookie", { name: "crosscuts_sid", value: cookie, url: B, path: "/" });
    await send("Emulation.setDeviceMetricsOverride", { width, height: width === 1920 ? 1080 : 900, deviceScaleFactor: 1, mobile: width < 500 });
    const l = loaded(); await send("Page.navigate", { url: B + url }); await l; await sleep(1200);
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
