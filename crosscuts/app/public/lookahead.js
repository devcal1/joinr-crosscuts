// Lookahead page: GET /api/scheduling/lookahead (docs/plans/m5-contracts.md sections 3 and 4).
// Read-only. Every user-supplied string goes in through textContent (el's "text" prop).
(function () {
  const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"];
  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // Kept in step with LABELS in lib/production.js.
  const STAGE_LABELS = {
    cut_edge: "Cut & edge",
    kit: "Kit",
    assemble: "Assemble",
    inspect: "Inspect",
    paint: "Paint",
    install: "Install",
    return_visit: "Return visit",
  };
  const AWAY_TEXT = { leave: "leave", sick: "sick", other: "away", off: "day off" };

  // "5 Nov 2035" from a Sydney YYYY-MM-DD (calendar text only, so the browser's zone doesn't matter).
  function fmtFull(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : s || "";
  }
  // The day number for a column heading, from the week's Monday and the day index.
  function dayNum(weekStart, i) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStart || "");
    if (!m) return "";
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + i));
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  }

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }

  let canJobs = false;

  function jobCell(jobId, name) {
    const td = el("td", { class: "la-job" });
    if (canJobs && jobId != null) td.append(el("a", { href: "/job.html?id=" + encodeURIComponent(jobId), text: name }));
    else td.textContent = name;
    return td;
  }

  function materialsCell(materials) {
    const td = el("td", { class: "la-mark" });
    if (materials === "in") td.append(el("span", { class: "la-mat-in", text: "In" }));
    else if (materials === "ordered") td.append(el("span", { class: "la-mat-ordered", text: "Ordered" }));
    return td;
  }

  function stageCell(stage) {
    return el("td", { class: "la-stage", text: stage ? STAGE_LABELS[stage] || stage : "" });
  }

  function wrap(table) {
    return el("div", { class: "la-wrap" }, table);
  }

  function dayCell(chips) {
    const td = el("td");
    for (const c of chips || []) {
      const away = c.away ? AWAY_TEXT[c.away] || "away" : "";
      td.append(el("span", { class: "la-name" + (away ? " la-away" : ""), text: away ? `${c.name} (${away})` : c.name }));
    }
    return td;
  }

  function panelTable(week, rows) {
    const head = el(
      "tr",
      {},
      el("th", { text: "Job" }),
      ...DAY_NAMES.map((d, i) => el("th", { class: "la-daycol", text: `${d} ${dayNum(week.start, i)}` })),
      el("th", { text: "Materials" }),
      el("th", { text: "Stage" })
    );
    const body = rows.map((row) =>
      el(
        "tr",
        {},
        jobCell(row.jobId, row.jobName),
        ...DAY_KEYS.map((k) => dayCell(row.cells && row.cells[k])),
        materialsCell(row.materials),
        stageCell(row.productionStage)
      )
    );
    return wrap(el("table", { class: "hs-table la-table la-grid" }, el("thead", {}, head), el("tbody", {}, ...body)));
  }

  function panelBlock(week, title, rows) {
    const block = el("div", {}, el("h4", { class: "la-h3", text: title }));
    block.append(rows.length ? panelTable(week, rows) : el("p", { class: "la-empty", text: "Nothing scheduled." }));
    return block;
  }

  function weekBlock(week, index) {
    const empty = !week.manufacturing.length && !week.installing.length;
    const section = el("section", { class: "la-week" });
    const head = el("div", { class: "la-week-head" }, el("h3", { class: "la-week-title", text: "Week of " + week.label }));
    if (index === 0) head.append(el("span", { class: "la-week-tag", text: "This week" }));
    section.append(head);
    if (empty) {
      section.append(el("p", { class: "la-empty", text: "Nothing scheduled this week." }));
      return section;
    }
    section.append(panelBlock(week, "Manufacturing", week.manufacturing), panelBlock(week, "Installing", week.installing));
    return section;
  }

  function toStartTable(list) {
    const head = el(
      "tr",
      {},
      el("th", { text: "Job" }),
      el("th", { text: "Promised install" }),
      el("th", { text: "Materials" }),
      el("th", { text: "Stage" })
    );
    const body = list.map((j) => {
      const when = j.promisedInstallDate
        ? el("td", { class: "la-when", text: fmtFull(j.promisedInstallDate) })
        : el("td", { class: "la-nodate", text: "No date" });
      return el("tr", {}, jobCell(j.jobId, j.name), when, materialsCell(j.materials), stageCell(j.productionStage));
    });
    return wrap(el("table", { class: "hs-table la-table" }, el("thead", {}, head), el("tbody", {}, ...body)));
  }

  async function init() {
    const message = document.getElementById("laMessage");
    const weeksBox = document.getElementById("laWeeks");
    const startBox = document.getElementById("laToStart");
    try {
      if (window.cc && window.cc.ready && typeof window.cc.ready.then === "function") await window.cc.ready;
    } catch (e) {
      /* the page still works without the shell; links just stay off */
    }
    canJobs = !!(window.cc && typeof window.cc.can === "function" && window.cc.can("jobs.view"));
    let data;
    try {
      data = await api("/api/scheduling/lookahead");
    } catch (e) {
      message.textContent = e.message;
      weeksBox.replaceChildren();
      startBox.replaceChildren();
      return;
    }
    weeksBox.replaceChildren(...data.weeks.map(weekBlock));
    startBox.replaceChildren(
      data.toStart.length ? toStartTable(data.toStart) : el("p", { class: "la-empty", text: "Nothing is waiting to start." })
    );
  }

  // shell/shell.js loads after this script and defines window.cc, so start once the page has parsed.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
