// Jobs list page. Talks to /api/job-records (see routes/jobs.js).
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

  // Stage badge classes. Teal for work in hand, orange for "attend to this" (ready to cut),
  // green for finished, neutral for the rest (dimmed once lost or archived).
  const STAGE_BADGE = {
    lead: "hs-badge-na", // retired stage; old rows read as Quoted
    quoted: "hs-badge-na",
    won: "hs-badge-teal",
    projects: "hs-badge-teal",
    ordering: "hs-badge-teal",
    ready_to_cut: "hs-badge-check",
    on_board: "hs-badge-teal",
    complete: "hs-badge-go",
    invoiced: "hs-badge-go",
    lost: "hs-badge-na stage-dim",
    archived: "hs-badge-na stage-dim",
  };
  const stageClass = (s) => "hs-badge " + (STAGE_BADGE[s] || "hs-badge-na");

  // The shell (public/shell/shell.js) may expose window.cc.can(key). Without
  // it, assume allowed: the server is what actually enforces permissions.
  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : true;
  }

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

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const qEl = document.getElementById("q");
  const stageEl = document.getElementById("stage");
  const archEl = document.getElementById("showArchived");
  const headEl = document.getElementById("head");
  const rowsEl = document.getElementById("rows");
  const countEl = document.getElementById("count");
  const newBtn = document.getElementById("newJob");
  const filtersEl = document.getElementById("joFilters");

  for (const [v, label] of STAGES) stageEl.append(el("option", { value: v, text: label }));

  function refreshNewButton() {
    newBtn.hidden = !can("jobs.edit");
  }
  refreshNewButton();
  window.addEventListener("load", refreshNewButton);
  document.addEventListener("cc:ready", refreshNewButton);

  // ---- filter: My jobs | Unassigned | All, remembered per browser (cc.jobs.filter) ----
  const FKEY = "cc.jobs.filter";
  const FILTERS = ["mine", "unassigned", "all"];
  let filter = null;
  function savedFilter() {
    try { const v = localStorage.getItem(FKEY); return FILTERS.includes(v) ? v : null; } catch (e) { return null; }
  }
  function setFilter(f, remember) {
    filter = f;
    for (const b of filtersEl.querySelectorAll("[data-filter]")) {
      b.setAttribute("aria-pressed", b.getAttribute("data-filter") === f ? "true" : "false");
    }
    if (remember) { try { localStorage.setItem(FKEY, f); } catch (e) { /* storage blocked */ } }
  }
  filtersEl.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest("[data-filter]");
    if (!b) return;
    setFilter(b.getAttribute("data-filter"), true);
    load();
  });

  // ---- sort (client side) ----
  const COLS = [
    { key: "jobNumber", label: "Job no.", cls: "jo-jobno" },
    { key: "name", label: "Name", cls: "name" },
    { key: "clientName", label: "Client" },
    { key: "stage", label: "Stage" },
    { key: "pm", label: "Project manager" },
    { key: "lastActivityAt", label: "Last activity", cls: "jo-when" },
  ];
  let sortKey = "lastActivityAt";
  let sortDir = -1;
  const STAGE_ORDER = Object.fromEntries(STAGES.map(([v], i) => [v, i]));
  function sortVal(j, k) {
    if (k === "stage") return STAGE_ORDER[j.pipelineStage || j.stage] == null ? 99 : STAGE_ORDER[j.pipelineStage || j.stage];
    if (k === "pm") return j.projectManager ? j.projectManager.name.toLowerCase() : "￿";
    if (k === "lastActivityAt") return j.lastActivityAt || "";
    return String(j[k] || "").toLowerCase();
  }
  function sorted(jobs) {
    return jobs.slice().sort((a, b) => {
      const x = sortVal(a, sortKey);
      const y = sortVal(b, sortKey);
      if (x < y) return -sortDir;
      if (x > y) return sortDir;
      return a.id - b.id;
    });
  }

  function relTime(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    const d = Math.floor(s / 86400);
    if (d < 31) return d === 1 ? "yesterday" : d + " days ago";
    const dt = new Date(t);
    return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
  }
  function fullTime(iso) {
    const dt = new Date(iso || "");
    return isNaN(dt) ? "" : dt.toLocaleString("en-AU");
  }

  let seq = 0;
  let lastJobs = [];
  async function load() {
    const mine = ++seq;
    const params = new URLSearchParams();
    if (stageEl.value) params.set("stage", stageEl.value);
    if (qEl.value.trim()) params.set("q", qEl.value.trim());
    if (!archEl.checked) params.set("archived", "0");
    if (filter === "mine") params.set("mine", "1");
    else if (filter === "unassigned") params.set("unassigned", "1");
    let jobs;
    try {
      jobs = await api("/api/job-records?" + params);
    } catch (e) {
      if (mine !== seq) return;
      rowsEl.replaceChildren(el("tr", {}, el("td", { colspan: COLS.length, class: "jobs-empty muted", text: "Could not load jobs: " + e.message })));
      return;
    }
    if (mine !== seq) return; // a newer request superseded this one
    lastJobs = jobs;
    render(jobs);
  }

  function renderHead() {
    headEl.replaceChildren(
      el("tr", {}, ...COLS.map((c) => {
        const on = c.key === sortKey;
        const th = el("th", { class: "jo-sortable", scope: "col", "aria-sort": on ? (sortDir > 0 ? "ascending" : "descending") : "none" });
        const b = el("button", { class: "jo-sortbtn", type: "button", text: c.label + (on ? (sortDir > 0 ? " (A-Z)" : " (Z-A)") : "") });
        if (c.key === "lastActivityAt" && on) b.textContent = c.label + (sortDir > 0 ? " (oldest)" : " (newest)");
        b.addEventListener("click", () => {
          if (sortKey === c.key) sortDir = -sortDir;
          else { sortKey = c.key; sortDir = c.key === "lastActivityAt" ? -1 : 1; }
          render(lastJobs);
        });
        th.append(b);
        return th;
      }))
    );
  }

  function render(jobs) {
    renderHead();
    if (jobs.length === 0) {
      const msg = filter === "mine" ? "You are not project manager on any job that matches." : filter === "unassigned" ? "Every live job has a project manager." : "No jobs match.";
      rowsEl.replaceChildren(el("tr", {}, el("td", { colspan: COLS.length, class: "jobs-empty muted", text: msg })));
      countEl.textContent = "";
      return;
    }
    rowsEl.replaceChildren(
      ...sorted(jobs).map((j) => {
        const tr = el("tr", { class: j.archived ? "is-archived" : "" });
        const href = "/job.html?id=" + j.id;
        const st = j.pipelineStage || j.stage;
        const pm = j.projectManager;
        tr.append(
          el("td", { class: "jo-jobno", "data-label": "Job no." }, el("a", { href, text: j.jobNumber || "" })),
          el("td", { class: "name" }, el("a", { href, text: j.name })),
          el("td", { "data-label": "Client", text: j.clientName || "" }),
          el("td", { "data-label": "Stage" }, el("span", { class: stageClass(st), text: (STAGE_LABEL[st] || "No stage") + (j.boardOrdering ? " (ordering)" : "") })),
          el("td", { "data-label": "Project manager" }, pm ? el("span", { text: pm.name }) : el("span", { class: "jo-unassigned", text: "Unassigned" })),
          el("td", { class: "jo-when", "data-label": "Last activity", title: fullTime(j.lastActivityAt), text: relTime(j.lastActivityAt) })
        );
        return tr;
      })
    );
    countEl.textContent = `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;
  }

  let timer = null;
  qEl.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(load, 200);
  });
  stageEl.addEventListener("change", load);
  archEl.addEventListener("change", load);

  // The default: the remembered filter, else My jobs for a project manager on at least one live job, else All.
  async function start() {
    const saved = savedFilter();
    if (saved) {
      setFilter(saved);
    } else {
      let f = "all";
      try {
        const mineJobs = await api("/api/job-records?mine=1&archived=0");
        if (mineJobs.some((j) => !["complete", "invoiced", "lost", "archived"].includes(j.stage))) f = "mine";
      } catch (e) { /* All */ }
      setFilter(f);
    }
    load();
  }
  start();
})();
