// Jobs list page. Talks to /api/job-records (see routes/jobs.js).
(function () {
  const STAGES = [
    ["lead", "Lead"],
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
  const STAGE_LABEL = Object.fromEntries(STAGES);

  // Stage badge classes. Teal for work in hand, orange for "attend to this" (ready to cut),
  // green for finished, neutral for the rest (dimmed once lost or archived).
  const STAGE_BADGE = {
    lead: "hs-badge-na",
    quoted: "hs-badge-na",
    won: "hs-badge-teal",
    design_ordering: "hs-badge-teal",
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

  const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  const qEl = document.getElementById("q");
  const stageEl = document.getElementById("stage");
  const archEl = document.getElementById("showArchived");
  const headEl = document.getElementById("head");
  const rowsEl = document.getElementById("rows");
  const countEl = document.getElementById("count");
  const newBtn = document.getElementById("newJob");

  for (const [v, label] of STAGES) stageEl.append(el("option", { value: v, text: label }));

  function refreshNewButton() {
    newBtn.hidden = !can("jobs.edit");
  }
  refreshNewButton();
  window.addEventListener("load", refreshNewButton);
  document.addEventListener("cc:ready", refreshNewButton);

  let seq = 0;
  async function load() {
    const mine = ++seq;
    const params = new URLSearchParams();
    if (stageEl.value) params.set("stage", stageEl.value);
    if (qEl.value.trim()) params.set("q", qEl.value.trim());
    if (!archEl.checked) params.set("archived", "0");
    let jobs;
    try {
      jobs = await api("/api/job-records?" + params);
    } catch (e) {
      if (mine !== seq) return;
      rowsEl.replaceChildren(el("tr", {}, el("td", { colspan: 6, class: "jobs-empty muted", text: "Could not load jobs: " + e.message })));
      return;
    }
    if (mine !== seq) return; // a newer request superseded this one
    render(jobs);
  }

  function render(jobs) {
    const showValue = jobs.some((j) => "valueCents" in j);
    const cols = ["Name", "Client", "Stage", "Promised install", "Sheets"];
    if (showValue) cols.push("Value");
    headEl.replaceChildren(
      el("tr", {}, ...cols.map((c, i) => el("th", { class: i >= 4 ? "num" : "", text: c })))
    );

    if (jobs.length === 0) {
      rowsEl.replaceChildren(
        el("tr", {}, el("td", { colspan: cols.length, class: "jobs-empty muted", text: "No jobs match." }))
      );
      countEl.textContent = "";
      return;
    }

    rowsEl.replaceChildren(
      ...jobs.map((j) => {
        const tr = el("tr", { class: j.archived ? "is-archived" : "" });
        const nameCell = el("td", { class: "name" }, el("a", { href: "/job.html?id=" + j.id, text: j.name }));
        tr.append(
          nameCell,
          el("td", { text: j.clientName || "" }),
          el("td", {}, el("span", { class: stageClass(j.stage), text: STAGE_LABEL[j.stage] || "No stage" })),
          el("td", { text: fmtDate(j.promisedInstallDate) }),
          el("td", { class: "num", text: j.sheetCount == null ? "" : String(j.sheetCount) })
        );
        if (showValue) {
          tr.append(el("td", { class: "num", text: j.valueCents == null ? "" : money.format(j.valueCents / 100) }));
        }
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

  load();
})();
