// The job page as a container (docs/plans/jobs-tradify-contracts.md section 5.1): a fixed header, then tabs.
// At load this moves the existing section elements into tab panels. The section scripts are unchanged:
// they still find their elements by id. A tab whose sections are all hidden for the caller is not shown.
// The last tab is remembered per browser (localStorage cc.job.tab); a hash naming a section opens its tab.
(function () {
  const jobId = Number(new URLSearchParams(location.search).get("id"));
  if (!Number.isInteger(jobId) || jobId < 1) return; // a new job: the form only, no tabs

  // [key, label, top-level section ids in order]
  const TABS = [
    ["overview", "Overview", ["meta", "form", "people"]],
    ["quote", "Quote", ["joinr", "fullquote"]],
    ["notes", "Notes", ["jobNotes"]],
    ["photos", "Photos", ["photos", "jnPhotos"]],
    ["invoices", "Invoices", ["invoices"]],
    ["orders", "Orders & materials", ["materials", "orders"]],
    ["planner", "Planner & tasks", ["planner", "tasks", "comments"]],
    ["workshop", "Workshop", ["benchtops", "reservations", "issues", "inspection"]],
  ];
  const KEY = "cc.job.tab";
  const ALWAYS = new Set(["overview"]);

  const STAGE_LABEL = {
    lead: "Quoted", quoted: "Quoted", won: "Won", projects: "Projects", ordering: "Ordering",
    ready_to_cut: "Ready to cut", on_board: "On board", complete: "Complete", invoiced: "Invoiced",
    lost: "Lost", archived: "Archived",
  };
  const STAGE_BADGE = {
    won: "hs-badge-teal", projects: "hs-badge-teal", ordering: "hs-badge-teal", on_board: "hs-badge-teal",
    ready_to_cut: "hs-badge-check", complete: "hs-badge-go", invoiced: "hs-badge-go",
  };

  const $ = (id) => document.getElementById(id);
  const main = document.querySelector("main");
  const strip = $("joTabs");
  const head = $("joHead");
  if (!main || !strip || !head) return;

  function store(get, v) {
    try {
      if (get) return localStorage.getItem(KEY);
      localStorage.setItem(KEY, v);
    } catch (e) { /* storage blocked: the page works without it */ }
    return null;
  }

  // ---- build the strip and panels; move the sections in ----
  const tabs = new Map(); // key -> {btn, panel, sections}
  for (const [key, label, ids] of TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "jo-tab";
    btn.id = "tab-" + key;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", "panel-" + key);
    btn.setAttribute("aria-selected", "false");
    btn.tabIndex = -1;
    btn.textContent = label;
    strip.append(btn);
    const panel = document.createElement("div");
    panel.className = "jo-panel";
    panel.id = "panel-" + key;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", btn.id);
    panel.hidden = true;
    const sections = [];
    for (const id of ids) {
      const s = $(id);
      if (!s) continue;
      panel.append(s);
      sections.push(s);
    }
    main.append(panel);
    tabs.set(key, { btn, panel, sections });
  }
  strip.hidden = false;
  document.body.classList.add("jo-tabbed");

  function visible(key) {
    if (ALWAYS.has(key)) return true;
    return tabs.get(key).sections.some((s) => !s.hidden);
  }

  let active = null;
  function select(key, opts) {
    if (!tabs.has(key)) return;
    active = key;
    for (const [k, t] of tabs) {
      const on = k === key;
      t.panel.hidden = !on;
      t.btn.setAttribute("aria-selected", on ? "true" : "false");
      t.btn.tabIndex = on ? 0 : -1;
      t.btn.classList.toggle("is-on", on);
    }
    if (opts && opts.remember) store(false, key);
    const b = tabs.get(key).btn;
    if (b.scrollIntoView && strip.scrollWidth > strip.clientWidth) {
      strip.scrollLeft = Math.max(0, b.offsetLeft - (strip.clientWidth - b.offsetWidth) / 2);
    }
  }

  // Tab buttons follow their sections' hidden flags, which the section scripts set as data arrives.
  let settled = false;
  function refresh() {
    for (const [k, t] of tabs) t.btn.hidden = !visible(k);
    if (settled && active && !visible(active)) select("overview");
  }
  const mo = new MutationObserver(refresh);
  for (const t of tabs.values()) for (const s of t.sections) mo.observe(s, { attributes: true, attributeFilter: ["hidden"] });
  refresh();

  // The tab holding an element id (a section or anything inside one), or null.
  function tabOf(id) {
    if (!id) return null;
    const m = /^tab-(.+)$/.exec(id);
    if (m && tabs.has(m[1])) return m[1];
    const target = $(id);
    if (!target) return null;
    for (const [k, t] of tabs) if (t.panel.contains(target)) return k;
    return null;
  }
  function hashId() {
    if (location.hash.length < 2) return null;
    try { return decodeURIComponent(location.hash.slice(1)); } catch (e) { return location.hash.slice(1); }
  }

  const fromHash = tabOf(hashId());
  const saved = store(true);
  select(fromHash || (saved && tabs.has(saved) ? saved : "overview"));

  window.addEventListener("hashchange", () => {
    const id = hashId();
    const k = tabOf(id);
    if (!k) return;
    select(k);
    const t = $(id);
    if (t && !/^tab-/.test(id) && !t.hidden) t.scrollIntoView();
  });

  strip.addEventListener("click", (ev) => {
    const b = ev.target.closest && ev.target.closest(".jo-tab");
    if (!b) return;
    select(b.id.slice(4), { remember: true });
  });
  strip.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft" && ev.key !== "Home" && ev.key !== "End") return;
    const shown = [...tabs.keys()].filter((k) => !tabs.get(k).btn.hidden);
    let i = shown.indexOf(active);
    if (ev.key === "ArrowRight") i = (i + 1) % shown.length;
    else if (ev.key === "ArrowLeft") i = (i - 1 + shown.length) % shown.length;
    else if (ev.key === "Home") i = 0;
    else i = shown.length - 1;
    ev.preventDefault();
    select(shown[i], { remember: true });
    tabs.get(shown[i]).btn.focus();
  });

  // Once permissions and the first loads have had time, a remembered tab with nothing in it falls back.
  async function settle() {
    if (document.readyState !== "complete") await new Promise((r) => window.addEventListener("load", r, { once: true }));
    if (window.cc && window.cc.ready) { try { await window.cc.ready; } catch (e) { /* shell failed */ } }
    setTimeout(() => { settled = true; refresh(); }, 2500);
  }
  settle();

  // ---- the sticky header sits under the menu bar ----
  function shellHeight() {
    const sh = $("cc-shell");
    const h = sh ? Math.round(sh.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty("--shell-h", `${h}px`);
    // Jumps to a section (deep links) land below the sticky header.
    document.documentElement.style.setProperty("--jo-head-h", `${Math.round(head.getBoundingClientRect().height)}px`);
  }
  shellHeight();
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(shellHeight);
    if ($("cc-shell")) ro.observe($("cc-shell"));
    ro.observe(head);
  }
  window.addEventListener("resize", shellHeight);

  // ---- phone: the header folds; More shows client, site and project manager ----
  const moreBtn = $("joMoreBtn");
  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      const open = !head.classList.contains("is-open");
      head.classList.toggle("is-open", open);
      moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
      moreBtn.textContent = open ? "Less" : "More";
    });
  }

  // ---- header facts: job number, stage, client, site ----
  async function facts() {
    let j;
    try { j = await api("/api/job-records/" + jobId); } catch (e) { return; }
    $("joNumber").textContent = j.jobNumber || "";
    const st = j.pipelineStage || j.stage;
    const badge = $("joStage");
    badge.className = "hs-badge " + (STAGE_BADGE[st] || "hs-badge-na") + " jo-stage";
    badge.textContent = (STAGE_LABEL[st] || "No stage") + (j.boardOrdering ? " (ordering)" : "");
    const f = $("joFacts");
    f.replaceChildren();
    const add = (label, value) => {
      const span = document.createElement("span");
      span.className = "jo-fact";
      const l = document.createElement("span");
      l.className = "hs-label";
      l.textContent = label;
      const v = document.createElement("span");
      v.textContent = value;
      span.append(l, " ", v);
      f.append(span);
    };
    add("Client", j.clientName || "None");
    add("Site", j.siteAddress || "None");
  }
  facts();
  // job.js rewrites the title after a save: refresh the facts then.
  const title = $("title");
  if (title) new MutationObserver(() => facts()).observe(title, { childList: true, characterData: true, subtree: true });

  window.JobTabs = { open: (key) => select(key, { remember: true }), refreshFacts: facts };
})();
