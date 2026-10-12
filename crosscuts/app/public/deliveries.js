// Deliveries (/deliveries.html, orders.receive): every ordered line waiting on delivery, grouped by
// the date it's expected, with Received and Delivery note on each line, the last 14 days received
// with Undo, and a printed checklist. docs/plans/m10-contracts.md sections 4.4 and 9.1. The dialogs
// are OrderUI's (orderui.js); the server decides who may do what (lib/orders.js).
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const PRINT_GROUPS = ["overdue", "today", "week"];

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

  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }

  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  }

  function parts(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }

  // "13 Oct 2026"
  function fmtDate(s) {
    const p = parts(s);
    return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : "";
  }

  // "Tuesday 13 October" (with the year for the printed sheet)
  function dayName(s, withYear) {
    const p = parts(s);
    if (!p) return "";
    const wd = DAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
    return `${wd} ${p.d} ${LONG_MONTHS[p.m - 1]}${withYear ? " " + p.y : ""}`;
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  function lineName(l) {
    return `${l.jobName}: ${l.supplier}${l.description ? ", " + l.description : ""}`;
  }

  let data = null;
  let seq = 0;

  function setStatus(text, kind) {
    const s = $("dlStatus");
    s.textContent = text || "";
    s.className = "dl-status" + (kind ? " dl-status-" + kind : "");
  }

  // ------------------------------------------------------------------ rendering ---

  // A cell with its column name, which the narrow layout shows beside the value.
  function td(label, cls, ...kids) {
    return el("td", { class: cls || null, "data-label": label || null }, ...kids);
  }

  function jobNode(l) {
    if (!can("jobs.view")) return el("span", { class: "dl-job", text: l.jobName });
    return el("a", { class: "dl-job", href: "/job.html?id=" + encodeURIComponent(l.jobId) + "#orders", text: l.jobName });
  }

  function headRow(cols) {
    return el("thead", null, el("tr", null, ...cols.map(([label, cls]) =>
      el("th", { scope: "col", class: cls }, label ? label : el("span", { class: "dl-sr", text: "Actions" })))));
  }

  const LINE_COLS = [
    ["Expected", "dl-c-date"], ["Job", "dl-c-job"], ["Supplier", "dl-c-sup"], ["Description", "dl-c-desc"],
    ["Notes", "dl-c-notes"], ["Delivery note", "dl-c-note"], ["", "dl-c-acts"],
  ];

  function lineRow(l, group) {
    const acts = window.OrderUI.actions(l);
    const exp = td("Expected", "dl-c-date" + (group.id === "overdue" ? " dl-overdue" : ""),
      el("span", { text: l.expectedDate ? fmtDate(l.expectedDate) : "No date yet" }));
    const cell = td("", "dl-c-acts");
    const box = el("div", { class: "dl-acts" });
    if (acts.receive) {
      box.append(el("button", { type: "button", class: "hs-btn hs-btn-primary", "data-act": "receive", "data-id": String(l.id), text: "Received",
        "aria-label": "Received: " + lineName(l) }));
    }
    if (acts.note) {
      box.append(el("button", { type: "button", class: "hs-btn", "data-act": "note", "data-id": String(l.id), text: "Delivery note",
        "aria-label": "Delivery note: " + lineName(l) }));
    }
    cell.append(box);
    const note = window.OrderUI.noteBlock(l);
    return el("tr", { "data-id": String(l.id) },
      exp,
      td("Job", "dl-c-job", jobNode(l)),
      td("Supplier", "dl-c-sup", el("span", { text: l.supplier })),
      td("Description", "dl-c-desc" + (l.description ? "" : " dl-blank"), el("span", { text: l.description || "" })),
      td("Notes", "dl-c-notes" + (l.notes ? "" : " dl-blank"), el("span", { text: l.notes || "" })),
      td("Delivery note", "dl-c-note" + (note ? "" : " dl-blank"), note),
      cell);
  }

  function renderGroups() {
    const host = $("dlGroups");
    const shown = data.groups.filter((g) => g.lines.length);
    if (!shown.length) {
      host.replaceChildren(el("p", { class: "dl-empty dl-nothing", text: "Nothing on order." }));
      return;
    }
    host.replaceChildren(...shown.map((g) => {
      const overdue = g.id === "overdue";
      const hid = "dl-h-" + g.id;
      const tbody = el("tbody", null, ...g.lines.map((l) => lineRow(l, g)));
      return el("section", { class: "dl-group", id: "dl-g-" + g.id, "aria-labelledby": hid },
        el("div", { class: "hs-sectionbar dl-bar" + (overdue ? " hs-sectionbar-orange" : "") },
          el("h2", { id: hid, tabindex: "-1" }, g.label + " ",
            el("span", { class: "dl-count" + (overdue ? " dl-count-overdue" : ""), text: String(g.lines.length) }))),
        el("div", { class: "dl-wrap" }, el("table", { class: "dl-table" }, headRow(LINE_COLS), tbody)));
    }));
  }

  function renderRecent() {
    const rows = $("dlRecentRows");
    const recent = data.recent || [];
    $("dlRecent").hidden = false;
    $("dlRecentCount").textContent = String(recent.length);
    $("dlRecentEmpty").hidden = recent.length > 0;
    $("dlRecentWrap").hidden = recent.length === 0;
    rows.replaceChildren(...recent.map((l) => {
      const acts = window.OrderUI.actions(l);
      const cell = td("", "dl-c-acts");
      if (acts.undoReceived) {
        cell.append(el("div", { class: "dl-acts" }, el("button", { type: "button", class: "hs-btn", "data-act": "undoReceived", "data-id": String(l.id),
          text: "Undo", "aria-label": "Undo received: " + lineName(l) })));
      }
      const note = window.OrderUI.noteBlock(l);
      return el("tr", { "data-id": String(l.id) },
        td("Received", "dl-c-date", el("span", { text: fmtDate(l.receivedDate) })),
        td("By", "dl-c-by" + (l.receivedBy ? "" : " dl-blank"), el("span", { text: l.receivedBy ? l.receivedBy.name : "" })),
        td("Job", "dl-c-job", jobNode(l)),
        td("Supplier", "dl-c-sup", el("span", { text: l.supplier })),
        td("Description", "dl-c-desc" + (l.description ? "" : " dl-blank"), el("span", { text: l.description || "" })),
        td("Delivery note", "dl-c-note" + (note ? "" : " dl-blank"), note),
        cell);
    }));
  }

  function render() {
    $("dlDate").textContent = dayName(data.date);
    renderGroups();
    renderRecent();
  }

  // ------------------------------------------------------------------- loading ---

  async function load() {
    const mine = ++seq;
    let d;
    try {
      d = await api("/api/orders/deliveries");
    } catch (e) {
      if (mine === seq) setStatus(e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message, "err");
      return false;
    }
    if (mine !== seq) return false;
    data = d;
    if (!window.cc || window.cc.loaded) render(); // otherwise the start waits for the shell
    return true;
  }

  function findLine(id) {
    for (const g of data.groups) for (const l of g.lines) if (l.id === id) return { line: l, group: g };
    for (const l of data.recent) if (l.id === id) return { line: l, group: null };
    return null;
  }

  // ------------------------------------------------------------------- actions ---

  function focusNode(n) {
    if (!n) return false;
    n.focus();
    return document.activeElement === n;
  }

  function button(id, act) {
    return document.querySelector(`button[data-act="${act}"][data-id="${id}"]`);
  }

  function heading(id) {
    return $(id);
  }

  // After a reload: the next line's Received button (in the order the page showed), or the
  // group's heading, or the next group's, or Received recently, or the page heading.
  function focusAfterReceive(id, before) {
    const ids = before.lines;
    const at = ids.indexOf(id);
    for (const next of ids.slice(at + 1)) {
      if (focusNode(button(next, "receive")) || focusNode(button(next, "note"))) return;
    }
    const groups = before.groups;
    const gi = groups.indexOf(before.groupOf[id]);
    for (const g of groups.slice(gi).concat(groups.slice(0, gi).reverse())) {
      if (focusNode(heading("dl-h-" + g))) return;
    }
    if (focusNode(heading("dlRecentTitle"))) return;
    focusNode($("dlTitle"));
  }

  // After Undo: the next Undo button in Received recently, or the line's Received button (it is
  // back on the list), or the section heading.
  function focusAfterUndo(id, before) {
    const ids = before.recent;
    const at = ids.indexOf(id);
    for (const next of ids.slice(at + 1).concat(ids.slice(0, at).reverse())) {
      if (focusNode(button(next, "undoReceived"))) return;
    }
    if (focusNode(button(id, "receive"))) return;
    if (focusNode(heading("dlRecentTitle"))) return;
    focusNode($("dlTitle"));
  }

  function snapshot() {
    const groupOf = {};
    const lines = [];
    for (const g of data.groups) for (const l of g.lines) {
      lines.push(l.id);
      groupOf[l.id] = g.id;
    }
    return { lines, groupOf, groups: data.groups.filter((g) => g.lines.length).map((g) => g.id), recent: data.recent.map((l) => l.id) };
  }

  let busy = false;
  async function run(act, id) {
    if (busy || !data) return;
    const found = findLine(id);
    if (!found) return;
    const line = found.line;
    busy = true;
    try {
      const before = snapshot();
      const res = await window.OrderUI[act](line);
      if (!res) return; // cancelled: OrderUI puts focus back on the button
      const after = res.order || {};
      let said;
      if (act === "receive") said = "Received: " + lineName(line) + ".";
      else if (act === "undoReceived") said = "Back to ordered: " + lineName(line) + ".";
      else said = (after.deliveryNote ? "Delivery note saved: " : "Delivery note cleared: ") + lineName(line) + ".";
      setStatus(said, "ok");
      await load();
      if (act === "receive") focusAfterReceive(id, before);
      else if (act === "undoReceived") focusAfterUndo(id, before);
      else if (!focusNode(button(id, "note"))) focusAfterReceive(id, before); // the note stays on its line
    } finally {
      busy = false;
    }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-act]");
    if (!b || !b.closest(".dl-page")) return;
    run(b.getAttribute("data-act"), Number(b.getAttribute("data-id")));
  });

  // -------------------------------------------------------------------- print ---

  function buildPrint() {
    const sheet = $("dlPrintSheet");
    if (!data) {
      sheet.replaceChildren();
      return;
    }
    const groups = data.groups.filter((g) => PRINT_GROUPS.includes(g.id) && g.lines.length);
    const head = el("div", { class: "dl-p-head" },
      el("div", null,
        el("h1", { class: "dl-p-h1", text: "Deliveries" }),
        el("p", { class: "dl-p-date", text: dayName(data.date, true) })),
      el("div", { class: "dl-p-sign" }, el("span", { class: "dl-p-label", text: "Checked by" }), el("span", { class: "dl-p-rule" })));
    const out = [head];
    if (!groups.length) out.push(el("p", { class: "dl-p-empty", text: "Nothing is due in the next 7 days." }));
    for (const g of groups) {
      const cols = el("colgroup", null, ...["dl-pc-tick", "dl-pc-date", "dl-pc-job", "dl-pc-sup", "dl-pc-desc", "dl-pc-note"].map((c) => el("col", { class: c })));
      const hr = el("tr", null, ...["", "Expected", "Job", "Supplier", "Description", "Delivery note"].map((t) => el("th", { scope: "col", text: t })));
      const tb = el("tbody", null, ...g.lines.map((l) => el("tr", null,
        el("td", { class: "dl-p-tick" }, el("span", { class: "dl-p-box" })),
        el("td", { class: "dl-p-nowrap", text: l.expectedDate ? fmtDate(l.expectedDate) : "" }),
        el("td", { class: "dl-p-strong", text: l.jobName }),
        el("td", { text: l.supplier }),
        el("td", { text: l.description || "" }),
        el("td", { class: "dl-p-note", text: (l.deliveryNote || "").trim() }))));
      out.push(el("section", { class: "dl-p-group" },
        el("h2", { class: "dl-p-h2", text: `${g.label} (${g.lines.length})` }),
        el("table", { class: "dl-p-table" }, cols, el("thead", null, hr), tb)));
    }
    const later = data.groups.filter((g) => !PRINT_GROUPS.includes(g.id)).reduce((n, g) => n + g.lines.length, 0);
    if (later) out.push(el("p", { class: "dl-p-foot", text: `Not on this list: ${plural(later, "line", "lines")} expected later or with no date yet.` }));
    sheet.replaceChildren(...out);
  }

  let titleBefore = null;
  function beforePrint() {
    buildPrint();
    if (titleBefore == null) titleBefore = document.title;
    document.title = "Deliveries " + fmtDate((data && data.date) || todayISO());
  }
  function afterPrint() {
    if (titleBefore != null) document.title = titleBefore;
    titleBefore = null;
  }
  window.addEventListener("beforeprint", beforePrint);
  window.addEventListener("afterprint", afterPrint);
  $("dlPrint").addEventListener("click", () => {
    beforePrint();
    window.print();
  });

  // --------------------------------------------------------------------- start ---

  $("dlDate").textContent = dayName(todayISO());
  (async () => {
    // Buttons and job links depend on the user's keys, so wait for the shell too.
    const ready = window.cc && window.cc.ready ? window.cc.ready : Promise.resolve();
    const [, ok] = await Promise.all([ready, load()]);
    if (ok) {
      setStatus("", "");
      render();
    }
  })();
})();
