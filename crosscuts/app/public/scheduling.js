// Scheduling page: the Upcoming, next 14 days lists, from GET /api/scheduling/upcoming
// (docs/plans/m3-contracts.md section 4). Read-only; each row links to the job.
(function () {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // "Tue 14 Nov" from a Sydney YYYY-MM-DD (calendar arithmetic only, so the browser's zone doesn't matter).
  function fmtDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return s || "";
    const dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
    return `${DAYS[dow]} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
  }
  function fmtFull(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : s || "";
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

  function table(heads, rows) {
    const t = el("table", { class: "hs-table sc-table" });
    t.append(el("thead", {}, el("tr", {}, ...heads.map((h) => el("th", { text: h })))));
    t.append(el("tbody", {}, ...rows));
    return el("div", { class: "sc-wrap" }, t);
  }
  const jobCell = (id, name, anchor) => el("td", { class: "sc-job" }, el("a", { href: "/job.html?id=" + id + "#" + anchor, text: name }));

  function fill(id, list, emptyText, build) {
    const box = document.getElementById(id);
    box.replaceChildren(list.length ? build(list) : el("p", { class: "sc-empty", text: emptyText }));
  }

  async function init() {
    let data;
    try {
      data = await api("/api/scheduling/upcoming");
    } catch (e) {
      document.getElementById("scMessage").textContent = e.message;
      for (const id of ["scInspections", "scMaterials", "scMaterialsIn"]) document.getElementById(id).replaceChildren();
      return;
    }
    const range = document.getElementById("range");
    range.textContent = fmtFull(data.from) + " to " + fmtFull(data.to);
    range.hidden = false;

    fill("scInspections", data.inspections, "No inspections booked in the next 14 days.", (list) =>
      table(
        ["Date", "Time", "Job", "Host"],
        list.map((i) =>
          el(
            "tr",
            {},
            el("td", { class: "sc-when", text: fmtDay(i.date) }),
            el("td", { text: i.time || "" }),
            jobCell(i.jobId, i.jobName, "inspection"),
            el("td", { text: i.host })
          )
        )
      )
    );

    fill("scMaterials", data.materials, "No materials expected in the next 14 days.", (list) =>
      table(
        ["Expected", "Job", "Supplier", "Description"],
        list.map((m) => {
          const when = el("td", { class: "sc-when" + (m.overdue ? " sc-late" : ""), text: fmtDay(m.expectedDate) });
          if (m.overdue) when.append(el("span", { class: "sc-late-tag", text: "Overdue" }));
          return el("tr", {}, when, jobCell(m.jobId, m.jobName, "orders"), el("td", { text: m.supplier }), el("td", { class: "sc-text", text: m.description }));
        })
      )
    );

    fill("scMaterialsIn", data.materialsIn, "No jobs have had all their materials arrive in the last 14 days.", (list) =>
      table(
        ["Job", "Materials in"],
        list.map((m) => el("tr", {}, jobCell(m.jobId, m.jobName, "orders"), el("td", { class: "sc-when", text: fmtDay(m.materialsInDate) })))
      )
    );
  }

  init();
})();
