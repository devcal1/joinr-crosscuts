// Pipeline board (pipeline.html). Job cards in columns by stage; dragging a card (pointer
// events, no HTML5 drag-and-drop) or "Move to..." changes its stage through
// POST /api/job-records/:id/stage. Contract: docs/plans/m3-contracts.md section 6.
// The server is authoritative; allowedTargets() below mirrors lib/jobstage.js.
(function () {
  "use strict";

  // The Lead column was removed 2026-10-17: the pipeline starts at Quoted. A job still at
  // the retired 'lead' stage (the DB still allows it) shows in Quoted; see colKey().
  const COLUMNS = [
    ["quoted", "Quoted"],
    ["won", "Won"],
    ["design_ordering", "Design / ordering"],
    ["ready_to_cut", "Ready to cut"],
    ["on_board", "On board"],
    ["complete", "Complete"],
    ["invoiced", "Invoiced"],
    ["lost", "Lost"],
    ["archived", "Archived"],
  ];
  const LABEL = Object.fromEntries(COLUMNS);
  const MANUAL = ["quoted", "won", "design_ordering", "ready_to_cut", "lost", "archived"];
  // The column a stage is shown in: the retired 'lead' reads as Quoted.
  const colKey = (stage) => (stage === "lead" ? "quoted" : stage);
  // Stages where a near promised install date needs attention (not yet on the board).
  // ("lead" is the retired stage; old rows may still hold it.)
  const PRE_BOARD = new Set(["lead", "quoted", "won", "design_ordering", "ready_to_cut"]);
  // Complete and Invoiced show only the last 60 days until "Show all" is pressed.
  const CAPPED = new Set(["complete", "invoiced"]);
  const CAP_MS = 60 * 24 * 60 * 60 * 1000;
  const HINTS = {
    on_board: "Moves from the board",
    complete: "Archive only",
    invoiced: "Archive only",
  };
  const DRAG_PX = 6;
  const HOLD_MS = 400;     // a touch on a Quoted line drags only after this long a press
  const HOLD_SLOP_PX = 8;  // moving more than this before then is a scroll, not a drag
  const EDGE_PX = 48;
  const STORE_KEY = "pl.showLostArchived";

  // Mirror of jobstage.allowedTargets (docs/plans/m3-contracts.md section 2).
  function allowedTargets(from) {
    if (from === "on_board") return [];
    if (from === "complete" || from === "invoiced") return ["archived"];
    return MANUAL.filter((s) => s !== from);
  }

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }

  // ---- dates and money ------------------------------------------------------
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const sydneyFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const todayStr = () => sydneyFmt.format(new Date());
  function addDays(s, n) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
  }
  // This Sydney week's Monday (YYYY-MM-DD), to match lib/time.js sydneyMonday.
  function sydneyMondayStr() {
    const t = todayStr();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    const dow = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay(); // 0 = Sunday
    return addDays(t, -((dow + 6) % 7));
  }
  // The server refuses a hand move while the job has week rows this week or later,
  // whatever its stage (m3 review fix 3). onBoardWeeks lists its week starts.
  function boardLocked(j) {
    if (j.stage === "on_board") return true;
    // Complete and invoiced are exempt (finished rows; archived is their only target).
    if (j.stage === "complete" || j.stage === "invoiced") return false;
    const mon = sydneyMondayStr();
    return Array.isArray(j.onBoardWeeks) && j.onBoardWeeks.some((w) => w >= mon);
  }
  function targetsFor(j) {
    // Never offer the column the card is already in (a legacy lead job is in Quoted).
    return boardLocked(j) ? [] : allowedTargets(j.stage).filter((s) => s !== colKey(j.stage));
  }
  function fmtShort(s, thisYear) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return "";
    return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` + (m[1] !== thisYear ? " " + m[1] : "");
  }
  const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

  // ---- state ----------------------------------------------------------------
  const boardEl = document.getElementById("plBoard");
  const statusEl = document.getElementById("plStatus");
  const toggleEl = document.getElementById("plToggle");
  const newEl = document.getElementById("plNew");
  const liveEl = document.getElementById("plLive");

  const jobs = new Map(); // id -> job object from the API
  // Joinr quotes listed in Quoted (GET /api/pipeline/joinr-quotes). Read-only lines, not jobs:
  // sent and won quotes from Joinr's open-quotes list (J3), or, until Joinr offers that list,
  // the won quotes still waiting in the inbox. joinrMeta is the rest of that answer.
  let joinrQuotes = [];
  let joinrMeta = { source: "intake", configured: false, fetchedAt: null, truncated: false, unreachable: false };
  let refreshing = false;
  let agoTimer = null;
  const busy = new Set(); // ids with a move in flight
  const showAll = { complete: false, invoiced: false };
  const cols = {}; // stage -> { root, count, cards, foot, hint }
  let showLA = false;
  let loaded = false;
  let drag = null;
  let menu = null; // { el, btn }
  let toastTimer = null;

  try {
    showLA = localStorage.getItem(STORE_KEY) === "1";
  } catch (e) { /* storage unavailable: default off */ }

  const canEdit = () => !!(window.cc && window.cc.loaded && window.cc.can("jobs.edit"));

  function announce(msg) {
    liveEl.textContent = "";
    setTimeout(() => { liveEl.textContent = msg; }, 20);
  }

  function toast(msg, isErr) {
    const old = document.querySelector(".pl-toast");
    if (old) old.remove();
    clearTimeout(toastTimer);
    const t = el("div", { class: "pl-toast" + (isErr ? " pl-toast-err" : ""), role: isErr ? "alert" : "status", text: msg });
    document.body.append(t);
    toastTimer = setTimeout(() => t.remove(), 4500);
  }

  // Our own fetch: shared.js api() hides the status code, which the 409 path needs.
  // It keeps api()'s 401 -> login redirect.
  async function request(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !location.pathname.startsWith("/login.html")) {
      const b = await res.json().catch(() => ({}));
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = (b.locked ? "/login.html?locked=1&next=" : "/login.html?next=") + next;
      return new Promise(() => {}); // navigating away
    }
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: data || {} };
  }

  // ---- board skeleton -------------------------------------------------------
  function buildBoard() {
    boardEl.replaceChildren();
    for (const [stage, label] of COLUMNS) {
      const count = el("span", { class: "pl-count" });
      const head = el(
        "div",
        { class: "hs-sectionbar pl-col-head" },
        el("h2", { id: "pl-h-" + stage, text: label }),
        count
      );
      const hint = el("p", { class: "pl-hint", text: HINTS[stage] || "", hidden: !HINTS[stage] });
      const cards = el("div", { class: "pl-cards" });
      const foot = el("div", { class: "pl-foot", hidden: true });
      const root = el(
        "section",
        { class: "pl-col", "data-stage": stage, "aria-labelledby": "pl-h-" + stage },
        head, hint, cards, foot
      );
      boardEl.append(root);
      cols[stage] = { root, count, cards, foot, hint };
    }
  }

  // ---- data -----------------------------------------------------------------
  async function load() {
    statusEl.textContent = "Loading...";
    let list;
    try {
      const fetches = [api("/api/job-records?archived=0")];
      if (showLA) fetches.push(api("/api/job-records?stage=archived"));
      const results = await Promise.all(fetches);
      list = results.flat();
    } catch (e) {
      statusEl.textContent = "Could not load jobs: " + e.message;
      return;
    }
    // The Joinr lines are extra: if they fail to load the jobs still show.
    try {
      takeJoinr(await api("/api/pipeline/joinr-quotes"));
    } catch (e) {
      takeJoinr(null);
    }
    jobs.clear();
    for (const j of list) jobs.set(j.id, j);
    loaded = true;
    statusEl.textContent = "";
    renderAll();
  }

  // Keeps the Joinr answer: the lines and the facts about them.
  function takeJoinr(data) {
    if (data && Array.isArray(data.quotes)) {
      joinrQuotes = data.quotes;
      joinrMeta = {
        source: data.source === "cache" ? "cache" : "intake",
        configured: !!data.configured,
        fetchedAt: typeof data.fetchedAt === "string" ? data.fetchedAt : null,
        truncated: !!data.truncated,
        unreachable: !!data.unreachable,
      };
    } else {
      joinrQuotes = [];
      joinrMeta = { source: "intake", configured: false, fetchedAt: null, truncated: false, unreachable: false };
    }
  }

  // "3 min ago" for the Updated line.
  function ago(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const mins = Math.floor((Date.now() - t) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? " hour ago" : " hours ago");
    const days = Math.floor(hrs / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }
  function clockTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone: "Australia/Sydney" });
  }
  function joinrUpdatedText() {
    if (joinrMeta.source !== "cache" || !joinrMeta.fetchedAt) return "";
    if (joinrMeta.unreachable) return "Joinr not reachable — showing the list from " + clockTime(joinrMeta.fetchedAt);
    return "Updated " + ago(joinrMeta.fetchedAt);
  }

  // The "From Joinr" block's own line: when the list was fetched, and Refresh. Everyone with
  // jobs.view can press it (this page needs jobs.view); the server holds it to once a minute.
  function buildJoinrMeta() {
    const kids = [];
    const updated = joinrUpdatedText();
    if (updated) {
      kids.push(el("span", { class: "pl-joinr-updated" + (joinrMeta.unreachable ? " pl-joinr-warn" : ""), text: updated }));
    }
    if (joinrMeta.configured) {
      const btn = el("button", { type: "button", class: "hs-btn pl-joinr-refresh", text: refreshing ? "Refreshing..." : "Refresh" });
      btn.disabled = refreshing;
      btn.addEventListener("click", refreshJoinr);
      kids.push(btn);
    }
    const out = [];
    if (kids.length) out.push(el("div", { class: "pl-joinr-meta" }, ...kids));
    if (joinrMeta.truncated) out.push(el("p", { class: "pl-joinr-note", text: "Showing the newest quotes only" }));
    return out;
  }

  async function refreshJoinr() {
    if (refreshing) return;
    refreshing = true;
    renderColumn("quoted");
    let res;
    try {
      res = await request("POST", "/api/pipeline/joinr-quotes/refresh", {});
    } catch (e) {
      res = { ok: false, status: 0, body: {} };
    }
    refreshing = false;
    if (!res.ok) {
      renderColumn("quoted");
      toast("Could not refresh from Joinr", true);
      return;
    }
    takeJoinr(res.body);
    renderColumn("quoted");
    const rf = res.body.refresh || {};
    const wait = rf.retryAfterSeconds ? " Try again in " + rf.retryAfterSeconds + " s." : "";
    if (rf.status === "ok") toast("Updated from Joinr");
    else if (rf.status === "recent") toast("Just updated." + wait);
    else if (rf.status === "limited") toast("Joinr asked us to wait." + wait, true);
    else if (rf.status === "unavailable") toast("Joinr's list of sent quotes is not available yet", true);
    else toast("Could not reach Joinr", true);
  }

  // Keeps "Updated 3 min ago" honest while the page stays open.
  function startAgoTimer() {
    if (agoTimer) return;
    agoTimer = setInterval(() => {
      const node = document.querySelector(".pl-joinr-updated");
      if (node) node.textContent = joinrUpdatedText();
    }, 30000);
  }

  // ---- rendering ------------------------------------------------------------
  // On the board: not archived, except jobs in the archived stage (fetched on demand).
  function inColumn(j, stage) {
    return colKey(j.stage) === stage && (stage === "archived" || !j.archived);
  }

  function byInstallThenName(a, b) {
    const ad = a.promisedInstallDate || "";
    const bd = b.promisedInstallDate || "";
    if (ad !== bd) {
      if (!ad) return 1;
      if (!bd) return -1;
      return ad < bd ? -1 : 1;
    }
    return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
  }

  // The date the 60-day cap counts from. Complete: the completed date, else the last
  // board week, else none (treated as old: migration 003 sets stage_changed_at to the
  // cutover time on every backfilled job). Invoiced: stage_changed_at, which only a real
  // final-invoice issue sets.
  function recencyDate(j) {
    if (j.stage === "complete") {
      if (j.completedDate) return j.completedDate;
      const w = Array.isArray(j.onBoardWeeks) && j.onBoardWeeks.length ? j.onBoardWeeks[j.onBoardWeeks.length - 1] : null;
      return w || null;
    }
    return j.stageChangedAt || null;
  }
  function isRecent(j) {
    const t = Date.parse(recencyDate(j) || "");
    return Number.isFinite(t) && Date.now() - t <= CAP_MS;
  }

  function renderColumn(stage) {
    stage = colKey(stage); // the retired lead stage is shown in Quoted
    const c = cols[stage];
    const hiddenZone = !showLA && (stage === "lost" || stage === "archived");
    const all = [...jobs.values()].filter((j) => inColumn(j, stage)).sort(byInstallThenName);

    // The count is the full count; Archived is not fetched while its toggle is off.
    const extra = stage === "quoted" ? joinrQuotes.length : 0; // Joinr lines count too
    c.count.textContent = stage === "archived" && !showLA ? "" : String(all.length + extra);

    let list = all;
    let hidden = 0;
    if (hiddenZone) list = [];
    else if (CAPPED.has(stage) && !showAll[stage]) {
      list = all.filter(isRecent);
      hidden = all.length - list.length;
    }

    const today = todayStr();
    const soon = addDays(today, 14);
    const thisYear = today.slice(0, 4);
    const editable = canEdit();
    c.root.classList.toggle("pl-editable", editable);
    if (hiddenZone) {
      c.cards.replaceChildren(el("p", { class: "pl-empty", text: "Hidden. Drop a card here, or use Show lost and archived." }));
    } else if (stage === "quoted") {
      // Quoted is a list of single lines: Crosscuts jobs first (draggable), then the Joinr quotes.
      const kids = list.map((j) => buildLine(j, { today, soon, thisYear, editable }));
      const joinrMetaKids = buildJoinrMeta();
      if (joinrQuotes.length || joinrMetaKids.length) {
        if (kids.length || joinrMetaKids.length) kids.push(el("p", { class: "pl-sub", text: "From Joinr" }));
        kids.push(...joinrMetaKids, ...joinrQuotes.map(buildJoinrLine));
        startAgoTimer();
      }
      c.cards.replaceChildren(...(kids.length ? kids : [el("p", { class: "pl-empty", text: "No jobs." })]));
    } else if (!list.length) {
      c.cards.replaceChildren(
        el("p", { class: "pl-empty", text: all.length && hidden ? "Nothing in the last 60 days." : "No jobs." })
      );
    } else {
      c.cards.replaceChildren(...list.map((j) => buildCard(j, { today, soon, thisYear, editable })));
    }

    // Foot: "Show all N" on capped columns.
    c.foot.replaceChildren();
    if (CAPPED.has(stage) && (hidden > 0 || showAll[stage]) && all.length) {
      const btn = el("button", {
        type: "button",
        class: "hs-btn hs-btn-quiet",
        text: showAll[stage] ? "Show recent only" : `Show all ${all.length}`,
      });
      btn.addEventListener("click", () => {
        showAll[stage] = !showAll[stage];
        renderColumn(stage);
      });
      c.foot.append(btn);
      c.foot.hidden = false;
    } else {
      c.foot.hidden = true;
    }
  }

  function renderAll() {
    for (const [stage] of COLUMNS) renderColumn(stage);
    const editable = canEdit();
    newEl.hidden = !editable;
    const help = document.getElementById("plHelp");
    if (help) {
      help.hidden = editable;
      help.textContent = editable ? "" : "You can view the pipeline but not move jobs.";
    }
  }

  function buildCard(j, ctx) {
    const attend =
      PRE_BOARD.has(j.stage) && j.promisedInstallDate && j.promisedInstallDate <= ctx.soon;
    const card = el("article", {
      class: "pl-card hs-card" + (attend ? " pl-card-attend" : ""),
      "data-id": String(j.id),
      "data-stage": j.stage,
    });
    if (busy.has(j.id)) card.setAttribute("aria-busy", "true");

    const handle = el("div", { class: "pl-handle", text: j.name });
    if (ctx.editable) handle.title = "Drag to another column";
    card.append(handle);
    if (j.clientName) card.append(el("div", { class: "pl-client", text: j.clientName }));

    const meta = el("div", { class: "pl-meta" });
    if (j.promisedInstallDate) {
      meta.append(
        el("span", {
          class: attend ? "pl-install-attend" : "",
          text: "Install " + fmtShort(j.promisedInstallDate, ctx.thisYear),
        })
      );
    }
    if (j.sheetCount != null) meta.append(el("span", { text: `${j.sheetCount} ${j.sheetCount === 1 ? "sheet" : "sheets"}` }));
    if (j.valueCents != null) meta.append(el("span", { text: money.format(j.valueCents / 100) }));
    if (meta.childNodes.length) card.append(meta);

    const foot = el("div", { class: "pl-foot-row" });
    foot.append(el("a", { class: "hs-btn hs-btn-quiet", href: "/job.html?id=" + j.id, text: "Open" }));
    if (ctx.editable) foot.append(moveButton(j));
    card.append(foot);
    return card;
  }

  // The "Move to..." button (editors only). Shared by the cards and the Quoted lines.
  function moveButton(j) {
    const targets = targetsFor(j);
    const btn = el("button", {
      type: "button",
      class: "hs-btn hs-btn-quiet pl-moveto",
      text: "Move to…",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    });
    if (boardLocked(j)) {
      btn.disabled = true;
      btn.title = "Moves from the board";
    } else if (!targets.length || busy.has(j.id)) {
      btn.disabled = true;
    }
    btn.addEventListener("click", () => {
      if (menu && menu.btn === btn) closeMenu(true);
      else openMenu(btn, j.id);
    });
    btn.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" && !btn.disabled) {
        ev.preventDefault();
        if (!menu || menu.btn !== btn) openMenu(btn, j.id);
      }
    });
    return btn;
  }

  // Quoted lines: one compact line per job, the whole line a link to the job. Still
  // draggable (the .pl-handle) and movable (Move to...); a press without a drag opens it.
  function buildLine(j, ctx) {
    const attend =
      PRE_BOARD.has(j.stage) && j.promisedInstallDate && j.promisedInstallDate <= ctx.soon;
    const card = el("article", {
      class: "pl-card pl-line hs-card" + (attend ? " pl-card-attend" : ""),
      "data-id": String(j.id),
      "data-stage": j.stage,
    });
    if (busy.has(j.id)) card.setAttribute("aria-busy", "true");
    const text = j.clientName ? `${j.name} · ${j.clientName}` : j.name;
    const link = el(
      "a",
      { class: "pl-handle pl-line-link", href: "/job.html?id=" + j.id, draggable: "false", title: text },
      el("span", { class: "pl-line-text" }, j.name, j.clientName ? el("span", { class: "pl-line-client", text: " · " + j.clientName }) : null)
    );
    card.append(link);
    if (j.valueCents != null) card.append(el("span", { class: "pl-line-val", text: money.format(j.valueCents / 100) }));
    if (ctx.editable) card.append(moveButton(j));
    return card;
  }

  // A Joinr quote as one line: number, client, site, value, all one link to the quote in
  // Joinr (new tab). The Joinr status word sits small at the end ("Sent" or "Won").
  function buildJoinrLine(q) {
    const text = [q.quoteNumber, q.clientName, q.siteAddress || q.label].filter(Boolean).join(" · ") || "Joinr quote";
    const value = q.valueCents != null ? money.format(q.valueCents / 100) : "";
    const status = q.joinrStatus ? q.joinrStatus.charAt(0).toUpperCase() + q.joinrStatus.slice(1) : "";
    const kids = [el("span", { class: "pl-line-text", text })];
    if (value) kids.push(el("span", { class: "pl-line-val", text: value }));
    if (status) kids.push(el("span", { class: "pl-line-status", text: status }));
    const title = [text, value, status && "(" + status + " in Joinr)"].filter(Boolean).join(" · ");
    const props = { class: "pl-card pl-line pl-joinr hs-card", title };
    if (q.url) return el("a", { ...props, href: q.url, target: "_blank", rel: "noopener" }, ...kids);
    return el("div", props, ...kids);
  }

  // ---- moving ---------------------------------------------------------------
  async function moveJob(id, to, opts) {
    const j = jobs.get(id);
    if (!j || busy.has(id)) return;
    const from = j.stage;
    if (to === from || !targetsFor(j).includes(to)) return;

    // Optimistic: show the card in its new column now.
    busy.add(id);
    const prevArchived = j.archived;
    j.stage = to;
    j.archived = to === "archived";
    renderColumn(from);
    renderColumn(to);

    let res;
    try {
      res = await request("POST", `/api/job-records/${id}/stage`, { stage: to, from });
    } catch (e) {
      res = { ok: false, status: 0, body: { error: "Could not reach the server" } };
    }
    busy.delete(id);

    if (res.ok) {
      jobs.set(id, res.body);
      renderColumn(from);
      renderColumn(to);
      announce(`${res.body.name} moved to ${LABEL[to]}`);
      if (!showLA && (to === "lost" || to === "archived")) toast(`${res.body.name} moved to ${LABEL[to]} (hidden).`);
      else if (res.body.stage === "ready_to_cut" && res.body.inBacklog) toast(`${res.body.name} is in the To start list.`);
      if (opts && opts.focusMenuBtn) focusMoveBtn(id);
    } else if (res.status === 409) {
      toast(res.body.error || "Someone else has moved this job.", true);
      // Show the card where it really is.
      const fresh = await request("GET", `/api/job-records/${id}`).catch(() => null);
      if (fresh && fresh.ok) jobs.set(id, fresh.body);
      else if (fresh && fresh.status === 404) jobs.delete(id);
      else {
        j.stage = res.body.stage || from;
        j.archived = prevArchived;
      }
      renderColumn(from);
      renderColumn(to);
      const nowStage = jobs.get(id) && jobs.get(id).stage;
      if (nowStage && nowStage !== from && nowStage !== to) renderColumn(nowStage);
    } else {
      toast(res.body.error || "Could not move the job.", true);
      j.stage = from;
      j.archived = prevArchived;
      renderColumn(from);
      renderColumn(to);
    }
  }

  function focusMoveBtn(id) {
    const b = boardEl.querySelector(`.pl-card[data-id="${id}"] .pl-moveto`);
    if (b && !b.disabled) b.focus();
  }

  // ---- Move to... menu ------------------------------------------------------
  function closeMenu(refocus) {
    if (!menu) return;
    const { el: node, btn } = menu;
    menu = null;
    node.remove();
    btn.setAttribute("aria-expanded", "false");
    if (refocus && document.contains(btn)) btn.focus();
  }

  function openMenu(btn, id) {
    closeMenu(false);
    const j = jobs.get(id);
    if (!j) return;
    const targets = targetsFor(j);
    if (!targets.length) return;
    const node = el("div", { class: "pl-menu", role: "menu", "aria-label": `Move ${j.name} to` });
    for (const t of targets) {
      const item = el("button", { type: "button", class: "pl-menu-item", role: "menuitem", tabindex: "-1", text: LABEL[t] });
      item.addEventListener("click", () => {
        closeMenu(false);
        moveJob(id, t, { focusMenuBtn: true });
      });
      node.append(item);
    }
    document.body.append(node);
    // Under the button, or above it when there is no room below.
    const r = btn.getBoundingClientRect();
    const h = node.offsetHeight;
    const w = node.offsetWidth;
    const top = r.bottom + 4 + h > window.innerHeight && r.top - 4 - h > 0 ? r.top - 4 - h : r.bottom + 4;
    node.style.top = Math.max(4, top) + "px";
    node.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + "px";
    btn.setAttribute("aria-expanded", "true");
    menu = { el: node, btn };
    node.addEventListener("keydown", onMenuKey);
    node.querySelector(".pl-menu-item").focus();
  }

  function onMenuKey(ev) {
    const items = [...menu.el.querySelectorAll(".pl-menu-item")];
    const i = items.indexOf(document.activeElement);
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      items[(i + 1) % items.length].focus();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      items[(i - 1 + items.length) % items.length].focus();
    } else if (ev.key === "Home") {
      ev.preventDefault();
      items[0].focus();
    } else if (ev.key === "End") {
      ev.preventDefault();
      items[items.length - 1].focus();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu(true);
    } else if (ev.key === "Tab") {
      closeMenu(false);
    }
  }

  document.addEventListener("pointerdown", (ev) => {
    if (menu && !menu.el.contains(ev.target) && !menu.btn.contains(ev.target)) closeMenu(false);
  });
  window.addEventListener("resize", () => closeMenu(false));

  // ---- dragging -------------------------------------------------------------
  boardEl.addEventListener("pointerdown", onHandleDown);

  function onHandleDown(ev) {
    const handle = ev.target.closest && ev.target.closest(".pl-handle");
    if (!handle || drag) return;
    const card = handle.closest(".pl-card");
    const j = card && jobs.get(Number(card.dataset.id));
    if (!j) return;
    if (!canEdit()) return; // read-only: the click handler below opens the job
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    if (busy.has(j.id)) return;
    drag = {
      id: j.id,
      card,
      handle,
      pid: ev.pointerId,
      pointerType: ev.pointerType,
      sx: ev.clientX,
      sy: ev.clientY,
      x: ev.clientX,
      y: ev.clientY,
      active: false,
      ghost: null,
      ok: new Set(targetsFor(j)),
      over: null,
      raf: 0,
      offX: 0,
      offY: 0,
      hold: 0,
      armed: true,
    };
    // A Quoted line is nearly all handle, so a finger on it must be able to scroll the list: it
    // drags only after a long press, and moving first cancels (the browser then pans).
    if (ev.pointerType !== "mouse" && handle.closest(".pl-line")) {
      drag.armed = false;
      drag.hold = setTimeout(armHold, HOLD_MS);
    }
    try { handle.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable: events still arrive */ }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    handle.addEventListener("lostpointercapture", onLostCapture);
    document.addEventListener("keydown", onDragKey, true);
  }

  // Once a lifted line is being dragged, the finger must not also pan the page or the list. The
  // listener is registered up front (not when the press starts), so the browser knows before the
  // touch begins that a handler may cancel the scroll.
  boardEl.addEventListener("touchmove", (ev) => {
    if (drag && drag.active && ev.cancelable) ev.preventDefault();
  }, { passive: false });

  // Read-only users (and anyone whose pointerdown did not start a drag) open the job by click.
  let suppressClick = false;
  boardEl.addEventListener("click", (ev) => {
    if (suppressClick) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    const handle = ev.target.closest && ev.target.closest(".pl-handle");
    if (!handle || handle.tagName === "A" || canEdit()) return;
    const card = handle.closest(".pl-card");
    if (card) location.href = "/job.html?id=" + card.dataset.id;
  });

  boardEl.addEventListener("contextmenu", (ev) => {
    // A long press on a touch screen must not open the context menu mid-drag.
    if (drag && drag.pointerType === "touch") ev.preventDefault();
  });

  function startDrag() {
    const d = drag;
    d.active = true;
    const rect = d.card.getBoundingClientRect();
    d.offX = d.sx - rect.left;
    d.offY = d.sy - rect.top;
    const ghost = d.card.cloneNode(true);
    ghost.removeAttribute("data-id");
    ghost.removeAttribute("aria-busy");
    ghost.classList.add("pl-ghost");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.width = rect.width + "px";
    ghost.style.left = rect.left + "px";
    ghost.style.top = rect.top + "px";
    for (const n of ghost.querySelectorAll("a, button")) n.tabIndex = -1;
    document.body.append(ghost);
    d.ghost = ghost;
    d.card.classList.add("pl-lifted");
    boardEl.classList.add("pl-dragging");
    document.body.classList.add("pl-noselect");
    closeMenu(false);
    for (const [stage] of COLUMNS) cols[stage].root.classList.toggle("pl-col-ok", d.ok.has(stage));
    d.raf = requestAnimationFrame(autoScroll);
  }

  // The long press is complete: lift the line where the finger is.
  function armHold() {
    const d = drag;
    if (!d || d.armed) return;
    d.hold = 0;
    d.armed = true;
    startDrag();
    d.ghost.style.left = d.x - d.offX + "px";
    d.ghost.style.top = d.y - d.offY + "px";
    updateOver();
  }

  function onMove(ev) {
    const d = drag;
    if (!d || ev.pointerId !== d.pid) return;
    d.x = ev.clientX;
    d.y = ev.clientY;
    if (!d.armed) {
      // Before the long press is up, any real movement is the person scrolling.
      if (Math.hypot(d.x - d.sx, d.y - d.sy) > HOLD_SLOP_PX) endDrag();
      return;
    }
    if (!d.active) {
      if (Math.hypot(d.x - d.sx, d.y - d.sy) < DRAG_PX) return;
      startDrag();
    }
    ev.preventDefault();
    d.ghost.style.left = d.x - d.offX + "px";
    d.ghost.style.top = d.y - d.offY + "px";
    updateOver();
  }

  function updateOver() {
    const d = drag;
    const under = document.elementFromPoint(d.x, d.y);
    const col = under && under.closest ? under.closest(".pl-col") : null;
    const stage = col ? col.dataset.stage : null;
    if (stage === d.over) return;
    d.over = stage;
    for (const [s] of COLUMNS) cols[s].root.classList.toggle("pl-col-over", s === stage && d.ok.has(s));
  }

  // Scroll the board sideways while the pointer is near its left or right edge.
  function autoScroll() {
    const d = drag;
    if (!d || !d.active) return;
    const r = boardEl.getBoundingClientRect();
    let dx = 0;
    if (d.x < r.left + EDGE_PX) dx = -Math.ceil(Math.min(1, (r.left + EDGE_PX - d.x) / EDGE_PX) * 10);
    else if (d.x > r.right - EDGE_PX) dx = Math.ceil(Math.min(1, (d.x - (r.right - EDGE_PX)) / EDGE_PX) * 10);
    if (dx) {
      const before = boardEl.scrollLeft;
      boardEl.scrollLeft = before + dx;
      if (boardEl.scrollLeft !== before) {
        d.over = undefined; // columns moved under the pointer: re-evaluate
        updateOver();
      }
    }
    d.raf = requestAnimationFrame(autoScroll);
  }

  function onUp(ev) {
    const d = drag;
    if (!d || ev.pointerId !== d.pid) return;
    const wasActive = d.active;
    const to = d.over;
    const ok = to && d.ok.has(to);
    const id = d.id;
    const isLink = d.handle.tagName === "A";
    endDrag();
    if (!wasActive) {
      // A press without moving opens the job (a link line does it by its own click).
      if (!isLink) location.href = "/job.html?id=" + id;
    } else if (isLink) {
      // The click that follows a drag must not follow the link.
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    if (wasActive && ok) {
      moveJob(id, to);
    }
    // Dropped on the same column, a column that is not allowed, or nothing: nothing is sent.
  }

  function onCancel(ev) {
    if (drag && ev.pointerId === drag.pid) endDrag();
  }

  function onLostCapture(ev) {
    // Capture is released after pointerup (handled) or if the element goes away.
    if (drag && ev.pointerId === drag.pid) endDrag();
  }

  function onDragKey(ev) {
    if (drag && ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      endDrag();
    }
  }

  function endDrag() {
    const d = drag;
    if (!d) return;
    drag = null;
    clearTimeout(d.hold);
    cancelAnimationFrame(d.raf);
    d.handle.removeEventListener("pointermove", onMove);
    d.handle.removeEventListener("pointerup", onUp);
    d.handle.removeEventListener("pointercancel", onCancel);
    d.handle.removeEventListener("lostpointercapture", onLostCapture);
    document.removeEventListener("keydown", onDragKey, true);
    try { d.handle.releasePointerCapture(d.pid); } catch (e) { /* already released */ }
    if (d.ghost) d.ghost.remove();
    d.card.classList.remove("pl-lifted");
    boardEl.classList.remove("pl-dragging");
    document.body.classList.remove("pl-noselect");
    for (const [stage] of COLUMNS) cols[stage].root.classList.remove("pl-col-ok", "pl-col-over");
  }

  // ---- toggle and boot ------------------------------------------------------
  function syncToggle() {
    toggleEl.setAttribute("aria-pressed", showLA ? "true" : "false");
    toggleEl.classList.toggle("hs-btn-primary", showLA);
  }
  toggleEl.addEventListener("click", () => {
    showLA = !showLA;
    try { localStorage.setItem(STORE_KEY, showLA ? "1" : "0"); } catch (e) { /* ignore */ }
    syncToggle();
    load();
  });

  function onReady() {
    if (loaded) renderAll();
  }
  document.addEventListener("cc:ready", onReady);

  buildBoard();
  syncToggle();
  load();
})();
