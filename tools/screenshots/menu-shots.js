// Local dev only. Menu bar (Menu 3.1) screenshots and checks through headless Edge (CDP).
// Start a local server (see CLAUDE.md "Local development"), seed it with seed.js, then:
//   node tools/screenshots/menu-shots.js <outDir> [base, default http://localhost:3997]
// It makes one throwaway test user per role (local database only), shoots the bar per role at
// 1920 and 1366, the open Scheduling and Design/PM menus, the collapsed Menu panel, the dashboard
// and the Photos header, measures the spare width of the full admin bar, checks the keyboard
// behaviour, and loads every menu page as admin looking for console errors.
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");
const OUT = process.argv[2], B = process.argv[3] || "http://localhost:3997";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = +(process.env.CDP_PORT || 9344), PROFILE = path.join(os.tmpdir(), "crosscuts-menu-edge-" + PORT);
const PW = "Menu-Local-Test-1", PW2 = "Menu-Local-Test-2"; // test-only passwords for throwaway local users
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, p, body, cookie) {
  const r = await fetch(B + p, { method, headers: { Origin: B, "Content-Type": "application/json", Cookie: cookie || "" }, body: body ? JSON.stringify(body) : undefined });
  const sid = (r.headers.getSetCookie() || []).find(c => c.startsWith("crosscuts_sid="));
  let j; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j, cookie: sid ? sid.split(";")[0] : null };
}
async function login(username, password) {
  const r = await api("POST", "/api/auth/login", { username, password });
  if (!r.cookie) throw new Error("login failed for " + username + " " + r.status);
  return r.cookie;
}
async function ensureUsers() {
  const admin = await login("admin", "Shots-Local-Test-1");
  const have = (await api("GET", "/api/users", null, admin)).body;
  const rows = Array.isArray(have) ? have : (have && (have.rows || have.users)) || [];
  const cookies = { admin };
  for (const role of ["accounts", "design_pm", "scheduling", "showroom", "workshop"]) {
    const u = "m-" + role.replace("_", "");
    if (!rows.find(x => x.username === u)) {
      const r = await api("POST", "/api/users", { username: u, displayName: role.replace("_", " ") + " test", password: PW, roles: [role] }, admin);
      if (r.status >= 300) throw new Error("create " + u + " " + r.status + JSON.stringify(r.body));
    }
    // A new user must choose their own password first: change it once, then sign in with that.
    let r = await api("POST", "/api/auth/login", { username: u, password: PW2 });
    if (!r.cookie) {
      r = await api("POST", "/api/auth/login", { username: u, password: PW });
      const c = await api("POST", "/api/auth/password", { currentPassword: PW, newPassword: PW2 }, r.cookie);
      if (c.status >= 300) throw new Error("password change " + u + " " + c.status + JSON.stringify(c.body));
      r = await api("POST", "/api/auth/login", { username: u, password: PW2 });
    }
    cookies[role] = r.cookie;
  }
  return cookies;
}

(async () => {
  const ONLY_MEASURE = !!process.env.WIDTHS;
  fs.mkdirSync(OUT, { recursive: true }); fs.rmSync(PROFILE, { recursive: true, force: true });
  const cookies = await ensureUsers();
  const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
  let targets; for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(250); } }
  const page = targets.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), waiters = []; const consoleErrors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) {
      if (m.method === "Runtime.exceptionThrown") consoleErrors.push("exception: " + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrors.push("console.error: " + m.params.args.map(a => a.value || a.description).join(" "));
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error") consoleErrors.push("log: " + m.params.entry.text + " " + (m.params.entry.url || ""));
      waiters.forEach(w => w(m));
    }
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const loaded = () => new Promise(r => { const w = m => { if (m.method === "Page.loadEventFired") { waiters.splice(waiters.indexOf(w), 1); r(); } }; waiters.push(w); });
  const ev = async expr => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
  await send("Page.enable"); await send("Network.enable"); await send("Runtime.enable"); await send("Log.enable");
  async function open(role, url, width, height = 900) {
    await send("Network.clearBrowserCookies");
    if (role) await send("Network.setCookie", { name: "crosscuts_sid", value: cookies[role].split("=")[1], url: B, path: "/" });
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    const l = loaded(); await send("Page.navigate", { url: B + url }); await l; await sleep(900);
  }
  async function shot(name, clipH) {
    const r = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: await ev("innerWidth"), height: clipH || (await ev("innerHeight")), scale: 1 } });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.result.data, "base64")); console.log("shot", name);
  }
  const key = (k, code, extra = {}) => send("Input.dispatchKeyEvent", Object.assign({ type: "keyDown", key: k, code, windowsVirtualKeyCode: extra.vk || 0 }, extra)).then(() => send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: extra.vk || 0 }));
  const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);

  if (!ONLY_MEASURE) {
  // 1. Per-role bar at 1920 and 1366 (viewport-sized, top 420 px), plus the dashboard.
  for (const role of ["admin", "accounts", "design_pm", "scheduling", "showroom", "workshop"]) {
    for (const w of [1920, 1366]) { await open(role, "/", w, 700); await shot(`bar-${role}-${w}`, 420); }
  }
  // 2. Admin at 1440 with menus open.
  await open("admin", "/", 1440, 700); await click('[aria-controls="cc-dept-scheduling"]'); await sleep(200); await shot("admin-1440-scheduling-open", 420);
  await click('[aria-controls="cc-dept-design"]'); await sleep(200); await shot("admin-1440-design-open", 420);
  await open("admin", "/jobs.html", 1440, 700); await click('[aria-controls="cc-dept-design"]'); await sleep(200); await shot("admin-1440-jobs-design-open", 420);
  await open("admin", "/accounts.html", 1440, 700); await click('[aria-controls="cc-dept-accounts"]'); await sleep(200); await shot("admin-1440-accounts-open", 420);
  // 3. Collapsed Menu panel on phones.
  for (const role of ["admin", "scheduling"]) {
    await open(role, "/scheduling.html", 375, 812); await click(".cc-menu-btn"); await sleep(200); await shot(`phone-${role}-menu-open`, 812);
  }
  await open("admin", "/", 800, 900); await click(".cc-menu-btn"); await sleep(200); await shot("tablet-admin-menu-open", 900);
  // 4. Dashboards and the Photos page.
  await open("admin", "/", 1440, 900); await shot("dashboard-admin");
  await open("showroom", "/", 1440, 700); await shot("dashboard-showroom");
  await open("accounts", "/", 1440, 900); await shot("dashboard-accounts");
  await open("admin", "/search.html", 1440, 420); await shot("photos-header-1440", 420);
  await open("admin", "/search.html", 375, 500); await shot("photos-header-375", 500);
  }
  // 5. Spare width of the full admin bar.
  console.log("--- spare width (admin, dashboard): nav content end to right cluster start; overflow; wrapped controls");
  // Worst case: a long name and 99+ on every badge.
  for (const w of (process.env.WIDTHS || "800,900,1000,1024,1100,1280,1366,1440,1600,1920").split(",").map(Number)) {
    await open("admin", "/", w, 700);
    await ev(`(function(){document.querySelector('.cc-user-name').textContent='WWWWWWWWWWWWWWWWWWWWWWW';[].slice.call(document.querySelectorAll('.cc-right .cc-bell-badge')).forEach(function(b){b.hidden=false;b.textContent='99+'})})()`);
    const m = await ev(`(function(){
      var depts=document.querySelector('.cc-depts'), right=document.querySelector('.cc-right'), brand=document.querySelector('.cc-brand'), menuBtn=document.querySelector('.cc-menu-btn');
      var collapsed = getComputedStyle(menuBtn).display!=='none';
      var spare = collapsed ? null : Math.round(right.getBoundingClientRect().left - depts.getBoundingClientRect().right);
      var tall=[].slice.call(document.querySelectorAll('.cc-bar a, .cc-bar button')).filter(function(e){var r=e.getBoundingClientRect();return r.width>0 && r.height>34}).map(function(e){return e.textContent.trim()});
      var spareCollapsed = collapsed ? Math.round(right.getBoundingClientRect().left - menuBtn.getBoundingClientRect().right) : null;
      return {collapsed:collapsed, spare:spare, spareCollapsed:spareCollapsed, docOverflow: document.documentElement.scrollWidth - innerWidth, barH: document.querySelector('.cc-bar').offsetHeight, tall:tall, brandApp: getComputedStyle(document.querySelector('.cc-brand-app')).display};
    })()`);
    console.log(w, JSON.stringify(m));
  }
  if (ONLY_MEASURE) { ws.close(); edge.kill(); process.exit(0); }
  // 6. Keyboard and popup behaviour (admin, 1440).
  console.log("--- keyboard / popups");
  await open("admin", "/", 1440, 700);
  const state = () => ev(`JSON.stringify([].slice.call(document.querySelectorAll('#cc-shell [data-cc-toggle]')).filter(function(b){return b.getAttribute('aria-expanded')==='true'}).map(function(b){return b.getAttribute('aria-controls')}))`);
  const focused = () => ev(`document.activeElement.id + '|' + document.activeElement.textContent.trim().slice(0,20)`);
  await ev(`document.querySelector('[aria-controls="cc-dept-scheduling"]').focus()`);
  await key("Enter", "Enter", { vk: 13, text: "\r" }); await sleep(150);
  console.log("Enter opens:", await state());
  await key("Escape", "Escape", { vk: 27 }); await sleep(150);
  console.log("Escape closes:", await state(), "focus:", await ev(`document.activeElement.getAttribute('aria-controls')`));
  await key(" ", "Space", { vk: 32, text: " " }); await sleep(150);
  console.log("Space opens:", await state());
  await key("ArrowDown", "ArrowDown", { vk: 40 }); await sleep(100);
  console.log("ArrowDown in panel focus:", await ev(`document.activeElement.textContent`));
  await key("Escape", "Escape", { vk: 27 }); await sleep(150);
  console.log("Escape from link closes:", await state(), "focus:", await ev(`document.activeElement.getAttribute('aria-controls')`));
  await click('[aria-controls="cc-dept-scheduling"]'); await click('[aria-controls="cc-dept-accounts"]'); await sleep(150);
  console.log("only one open (accounts expected):", await state());
  await click("#cc-bell-btn"); await sleep(300);
  console.log("bell closes dept:", await state());
  await click('[aria-controls="cc-dept-scheduling"]'); await sleep(100);
  await ev(`document.querySelector('.dash').click()`); await sleep(150);
  console.log("outside click closes:", await state());
  await click('[aria-controls="cc-dept-scheduling"]'); await sleep(100);
  await ev(`document.querySelector('.cc-brand').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
  // (the brand click would navigate; the check above is only that the popup closes before leaving)
  await sleep(300);

  // 7. Every menu page loads with no console errors (admin).
  console.log("--- pages as admin (console errors)");
  const pages = ["/", "/schedule.html", "/scheduling.html", "/lookahead.html", "/availability.html", "/workers.html", "/design.html", "/jobs.html", "/pipeline.html", "/orders.html", "/intake.html", "/accounts.html", "/reports.html", "/search.html", "/admin.html", "/users.html", "/audit.html", "/planner.html", "/tasks.html", "/messages.html"];
  for (const p of pages) {
    consoleErrors.length = 0;
    await open("admin", p, 1440, 800);
    const here = await ev("location.pathname");
    const hasBar = await ev("!!document.querySelector('.cc-dept-btn')");
    const cur = await ev(`JSON.stringify([].slice.call(document.querySelectorAll('.cc-bar [aria-current]')).map(function(e){return e.textContent.trim()+':'+e.getAttribute('aria-current')}))`);
    console.log(p, "->", here, "bar:", hasBar, "current:", cur, "errors:", consoleErrors.length ? JSON.stringify(consoleErrors) : "none");
  }
  ws.close(); edge.kill();
})().catch(e => { console.error(e); process.exit(1); });
