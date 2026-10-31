// Jobs layout D (docs/plans/jobs-tradify-plan.md, "Layout change", Todd 2026-10-30).
// Loaded by jobs.html and job.html. It runs the job list on the left, the breadcrumb trail and Jump to job.
// Talks to /api/job-records (routes/jobs.js); no API of its own.
//
// Switching jobs is a full page load of job.html?id=N, not an in-place swap: the job's section scripts
// (job.js and a dozen others) were written for one job per page load and keep state in closures, so
// re-running them in place is not safe. The list keeps its filter, search, stage and scroll position in
// sessionStorage across the load, so the switch looks like the right side changing.
(function () {
  const STAGES = [
    ["quoted", "Quoted"],
    ["won", "Won"],
    // 0.2.1 (docs/plans/m22-project-jobs.md section 2): design_ordering shows as Projects or Ordering.
    ["projects", "Projects"],
    ["ordering", "Ordering"],
    ["ready_to_cut", "Ready to cut"],
    ["on_board", "On board"],
    ["complete", "Complete"],
    ["invoiced", "Invoiced"],
    ["lost", "Lost"],
    ["archived", "Archived"],
  ];
  const STAGE_LABEL = { ...Object.fromEntries(STAGES), lead: "Quoted" }; // lead is retired: old rows read as Quoted
  const FILTER_LABEL = { mine: "My jobs", unassigned: "Unassigned", all: "All jobs" };
  const TAB_LABEL = {
    overview: "Overview", quote: "Quote", notes: "Notes", photos: "Photos", invoices: "Invoices",
    orders: "Orders & materials", planner: "Planner & tasks", workshop: "Workshop",
  };

  const $ = (id) => document.getElementById(id);
  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }
  // Storage can be blocked (private windows): every read and write is guarded.
  function sget(store, k) { try { return window[store].getItem(k); } catch (e) { return null; } }
  function sset(store, k, v) { try { window[store].setItem(k, v); } catch (e) { /* blocked */ } }
  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : true;
  }
  const phone = window.matchMedia ? window.matchMedia("(max-width: 719px)") : { matches: false };

  const params = new URLSearchParams(location.search);
  const onJobPage = /\/job\.html$/.test(location.pathname);
  const rawId = Number(params.get("id"));
  const jobId = onJobPage && Number.isInteger(rawId) && rawId > 0 ? rawId : null;
  if (jobId) {
    document.body.classList.add("jd-hasjob");
    sset("localStorage", "cc.jobs.last", String(jobId));
  }

  const qEl = $("q");
  const stageEl = $("stage");
  const archEl = $("showArchived");
  const rowsEl = $("rows");
  const countEl = $("count");
  const newBtn = $("newJob");
  const filtersEl = $("joFilters");
  const listEl = $("jdList");
  const trailEl = $("jdTrail");
  const bcEl = $("jdCrumbs");
  if (!rowsEl || !listEl) return;

  for (const [v, label] of STAGES) stageEl.append(el("option", { value: v, text: label }));

  function refreshNewButton() { newBtn.hidden = !can("jobs.edit"); }
  refreshNewButton();
  window.addEventListener("load", refreshNewButton);
  document.addEventListener("cc:ready", refreshNewButton);

  // ---- the bars' heights, for the sticky breadcrumb, list and job header ----
  function heights() {
    const sh = $("cc-shell");
    if (!document.body.classList.contains("jo-tabbed")) {
      document.documentElement.style.setProperty("--shell-h", `${sh ? Math.round(sh.getBoundingClientRect().height) : 0}px`);
    }
    if (bcEl) document.documentElement.style.setProperty("--jd-bc-h", `${Math.round(bcEl.getBoundingClientRect().height)}px`);
  }
  heights();
  window.addEventListener("resize", heights);
  window.addEventListener("load", heights);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(heights);
    if ($("cc-shell")) ro.observe($("cc-shell"));
    if (bcEl) ro.observe(bcEl);
  }

  // ---- filter: My jobs | Unassigned | All, remembered per browser (cc.jobs.filter) ----
  const FKEY = "cc.jobs.filter";
  const FILTERS = ["mine", "unassigned", "all"];
  let filter = null;
  function savedFilter() {
    const v = sget("localStorage", FKEY);
    return FILTERS.includes(v) ? v : null;
  }
  function setFilter(f, remember) {
    filter = f;
    for (const b of filtersEl.querySelectorAll("[data-filter]")) {
      b.setAttribute("aria-pressed", b.getAttribute("data-filter") === f ? "true" : "false");
    }
    if (remember) sset("localStorage", FKEY, f);
    trail();
  }
  filtersEl.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest("[data-filter]");
    if (!b) return;
    setFilter(b.getAttribute("data-filter"), true);
    load();
  });

  // ---- search, stage and scroll kept across page loads (sessionStorage cc.jobs.list) ----
  const LKEY = "cc.jobs.list";
  function saveList() {
    sset("sessionStorage", LKEY, JSON.stringify({ q: qEl.value, stage: stageEl.value, arch: archEl.checked, scroll: listEl.scrollTop, win: !onJobPage ? window.scrollY : (prevWin || 0) }));
  }
  let pendingScroll = null;
  let pendingWin = null; // on a phone the list scrolls with the page
  let prevWin = 0;
  (function restoreList() {
    let s = null;
    try { s = JSON.parse(sget("sessionStorage", LKEY) || "null"); } catch (e) { s = null; }
    if (!s) return;
    qEl.value = s.q || "";
    if (STAGE_LABEL[s.stage]) stageEl.value = s.stage;
    archEl.checked = !!s.arch;
    pendingScroll = Number(s.scroll) || 0;
    prevWin = Number(s.win) || 0;
    if (!onJobPage) pendingWin = prevWin;
  })();
  window.addEventListener("pagehide", saveList);

  // ---- the list ----
  const ATTEND = new Set(["ready_to_cut"]);
  let seq = 0;
  let lastJobs = [];
  async function load() {
    const mine = ++seq;
    const p = new URLSearchParams();
    if (stageEl.value) p.set("stage", stageEl.value);
    if (qEl.value.trim()) p.set("q", qEl.value.trim());
    if (!archEl.checked) p.set("archived", "0");
    if (filter === "mine") p.set("mine", "1");
    else if (filter === "unassigned") p.set("unassigned", "1");
    let jobs;
    try {
      jobs = await api("/api/job-records?" + p);
    } catch (e) {
      if (mine !== seq) return;
      rowsEl.replaceChildren(el("li", { class: "jd-empty-row", text: "Could not load jobs: " + e.message }));
      return;
    }
    if (mine !== seq) return; // a newer request superseded this one
    lastJobs = jobs.slice().sort((a, b) => String(b.lastActivityAt || "").localeCompare(String(a.lastActivityAt || "")) || b.id - a.id);
    render();
    saveList();
    return lastJobs;
  }

  function render() {
    const jobs = lastJobs;
    if (jobs.length === 0) {
      const msg = filter === "mine" ? "No jobs are assigned to you here (as project manager or named on a Pipeline tile)." : filter === "unassigned" ? "Every live job has a project manager." : "No jobs match.";
      const kids = [el("li", { class: "jd-empty-row", text: msg })];
      if (filter === "mine") {
        const b = el("button", { type: "button", class: "jd-allbtn", text: "Show all jobs" });
        b.addEventListener("click", () => { setFilter("all", true); load(); });
        kids.push(el("li", { class: "jd-empty-row" }, b));
      }
      rowsEl.replaceChildren(...kids);
      countEl.textContent = "";
      return;
    }
    rowsEl.replaceChildren(...jobs.map((j) => {
      const st = j.pipelineStage || j.stage;
      const open = j.id === jobId;
      const li = el("li", { class: "jd-row" + (open ? " is-open" : "") + (j.archived ? " is-archived" : "") });
      const a = el("a", { href: "/job.html?id=" + j.id, "data-id": String(j.id) },
        el("span", { class: "jd-rowtop" },
          j.jobNumber ? el("span", { class: "jd-rowno", text: j.jobNumber }) : null,
          el("span", { class: "jd-rowname", text: j.name })),
        el("span", { class: "jd-rowstage" + (ATTEND.has(st) ? " is-attend" : ""), text: (STAGE_LABEL[st] || "No stage") + (j.boardOrdering ? " (ordering)" : "") }));
      if (open) a.setAttribute("aria-current", "page");
      li.append(a);
      return li;
    }));
    countEl.textContent = `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;
    if (pendingScroll != null) {
      listEl.scrollTop = pendingScroll;
      pendingScroll = null;
    }
    if (pendingWin != null) {
      if (phone.matches && pendingWin) window.scrollTo(0, pendingWin);
      pendingWin = null;
    }
    const openRow = rowsEl.querySelector(".is-open");
    if (openRow && !phone.matches) {
      const r = openRow.getBoundingClientRect();
      const box = listEl.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) openRow.scrollIntoView({ block: "nearest" });
    }
  }
  rowsEl.addEventListener("click", saveList);

  let timer = null;
  qEl.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 200); });
  stageEl.addEventListener("change", load);
  archEl.addEventListener("change", load);

  // ---- breadcrumb: Jobs › My jobs › JQ321 Ashmore kitchen › Notes ----
  let job = null; // the open job's record, once loaded
  let tab = null; // the open tab's key
  function crumb(text, href, current) {
    const a = el("a", { href, text });
    if (current) a.setAttribute("aria-current", "page");
    return el("li", {}, a);
  }
  function trail() {
    if (!trailEl) return;
    const items = [crumb("Jobs", "/jobs.html", !jobId && !onJobPage)];
    if (filter) items.push(crumb(FILTER_LABEL[filter], "/jobs.html?filter=" + filter, false));
    if (onJobPage && !jobId) items.push(crumb("New job", "/job.html", true));
    if (jobId) {
      const name = job ? [job.jobNumber, job.name].filter(Boolean).join(" ") : "Job";
      const deep = tab && tab !== "overview";
      items.push(crumb(name, "/job.html?id=" + jobId, !deep));
      if (deep) {
        let label = TAB_LABEL[tab] || tab;
        if (tab === "quote" && job && job.quoteNumber) label = job.quoteNumber + " quote";
        items.push(crumb(label, "/job.html?id=" + jobId + "#tab-" + tab, true));
      }
    }
    trailEl.replaceChildren(...items);
  }
  if (trailEl) {
    trailEl.addEventListener("click", (ev) => {
      const a = ev.target.closest && ev.target.closest("a");
      if (!a || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      const href = a.getAttribute("href");
      const f = /filter=(\w+)/.exec(href);
      // On a wide screen the list is already beside the job: Jobs and the filter act on it in place.
      if (!phone.matches && /^\/jobs\.html/.test(href)) {
        ev.preventDefault();
        if (f && FILTERS.includes(f[1])) { setFilter(f[1], true); load(); }
        qEl.focus();
        return;
      }
      // The job's own crumb from a deeper tab goes back to its Overview.
      if (jobId && href === "/job.html?id=" + jobId && window.JobTabs) {
        ev.preventDefault();
        window.JobTabs.open("overview");
        if (location.hash) history.replaceState(null, "", location.pathname + location.search);
        window.scrollTo(0, 0);
        return;
      }
      const t = /#tab-(\w+)$/.exec(href);
      if (t && window.JobTabs) { ev.preventDefault(); window.JobTabs.open(t[1]); }
    });
  }

  // The open tab, from the strip jobtabs.js builds.
  const strip = $("joTabs");
  function readTab() {
    const on = strip && strip.querySelector('.jo-tab[aria-selected="true"]');
    const k = on ? on.id.replace(/^tab-/, "") : null;
    if (k !== tab) { tab = k; trail(); }
  }
  if (jobId && strip) {
    new MutationObserver(readTab).observe(strip, { subtree: true, attributes: true, attributeFilter: ["aria-selected"] });
    readTab();
  }
  async function loadJob() {
    try { job = await api("/api/job-records/" + jobId); } catch (e) { job = null; }
    trail();
  }
  if (jobId) {
    loadJob();
    const title = $("title"); // job.js rewrites the title after a save
    if (title) new MutationObserver(() => loadJob()).observe(title, { childList: true, characterData: true, subtree: true });
  }

  // ---- Jump to job: type-ahead by job number, name or client (the list API's q) ----
  const jumpEl = $("jdJump");
  const jumpList = $("jdJumpList");
  if (jumpEl && jumpList) {
    let jumpSeq = 0;
    let hits = [];
    let active = -1;
    let jumpTimer = null;
    function close() {
      jumpList.hidden = true;
      jumpEl.setAttribute("aria-expanded", "false");
      jumpEl.removeAttribute("aria-activedescendant");
      active = -1;
    }
    function mark() {
      [...jumpList.children].forEach((li, i) => li.setAttribute("aria-selected", i === active ? "true" : "false"));
      if (active >= 0) {
        jumpEl.setAttribute("aria-activedescendant", "jdJump-" + active);
        jumpList.children[active].scrollIntoView({ block: "nearest" });
      } else jumpEl.removeAttribute("aria-activedescendant");
    }
    function go(j) {
      if (!j) return;
      saveList();
      location.href = "/job.html?id=" + j.id;
    }
    async function search() {
      const q = jumpEl.value.trim();
      const mine = ++jumpSeq;
      if (!q) { close(); return; }
      let res;
      try { res = await api("/api/job-records?q=" + encodeURIComponent(q)); } catch (e) { res = []; }
      if (mine !== jumpSeq) return;
      hits = res.slice(0, 10);
      active = hits.length ? 0 : -1;
      jumpList.replaceChildren(...(hits.length ? hits.map((j, i) => {
        const li = el("li", { id: "jdJump-" + i, role: "option", "aria-selected": "false" },
          j.jobNumber ? el("span", { class: "jd-jno", text: j.jobNumber }) : null,
          el("span", { class: "jd-jname", text: j.name }),
          j.clientName ? el("span", { class: "jd-jclient", text: j.clientName }) : null);
        li.addEventListener("mousedown", (ev) => { ev.preventDefault(); go(j); });
        return li;
      }) : [el("li", { class: "jd-jnone", role: "option", "aria-disabled": "true", text: "No jobs match." })]));
      jumpList.hidden = false;
      jumpEl.setAttribute("aria-expanded", "true");
      mark();
    }
    jumpEl.addEventListener("input", () => { clearTimeout(jumpTimer); jumpTimer = setTimeout(search, 150); });
    jumpEl.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        if (jumpList.hidden) { if (jumpEl.value.trim()) search(); return; }
        if (!hits.length) return;
        ev.preventDefault();
        active = ev.key === "ArrowDown" ? (active + 1) % hits.length : (active - 1 + hits.length) % hits.length;
        mark();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (!jumpList.hidden && hits[active]) go(hits[active]);
        else if (jumpEl.value.trim()) search();
      } else if (ev.key === "Escape") {
        if (!jumpList.hidden) { ev.preventDefault(); close(); } else jumpEl.value = "";
      }
    });
    jumpEl.addEventListener("blur", () => setTimeout(close, 100));
  }

  // ---- start: the remembered filter, else My jobs for a project manager on a live job, else All ----
  async function start() {
    const asked = params.get("filter");
    if (FILTERS.includes(asked)) {
      setFilter(asked, true);
    } else if (savedFilter()) {
      setFilter(savedFilter());
    } else {
      let f = "all";
      try {
        const mineJobs = await api("/api/job-records?mine=1&archived=0");
        if (mineJobs.some((j) => !["complete", "invoiced", "lost", "archived"].includes(j.stage))) f = "mine";
      } catch (e) { /* All */ }
      setFilter(f);
    }
    const jobs = await load();
    // jobs.html on a wide screen opens your most recent job, else the first in the list. On a phone it is the list.
    if (!onJobPage && !phone.matches) {
      let target = Number(sget("localStorage", "cc.jobs.last"));
      if (!(Number.isInteger(target) && target > 0) || !(jobs || []).some((j) => j.id === target)) {
        // Not in the list as filtered: check it still exists before opening it.
        try { if (target > 0) await api("/api/job-records/" + target); else target = null; } catch (e) { target = null; }
      }
      if (!target && jobs && jobs[0]) target = jobs[0].id;
      if (target) location.replace("/job.html?id=" + target);
    }
  }
  trail();
  start();
})();
