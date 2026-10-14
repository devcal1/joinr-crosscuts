// Deliveries (/deliveries.html, orders.receive): every ordered line waiting on delivery, grouped by
// the date it's expected, with Received and Delivery note on each line, the last 14 days received
// with Undo, and a printed checklist. docs/plans/m10-contracts.md sections 4.4 and 9.1. The dialogs
// are OrderUI's (orderui.js); the server decides who may do what (lib/orders.js).
//
// M11 (docs/plans/m11-contracts.md sections 9 and 11.7): a "Stock and paint" section after the five
// groups lists the monthly stock order's supplier groups, paint orders and drawer stock rows that
// are ordered (`stock.items`), each received through its own route; their recent receipts join
// Received recently with Undo, and those due within 7 days join the printed checklist. A drawer
// line stays in the job groups, labelled by its description.
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

  // YYYY-MM-DD plus n days.
  function addDays(s, n) {
    const p = parts(s);
    if (!p) return "";
    return new Date(Date.UTC(p.y, p.m - 1, p.d + n)).toISOString().slice(0, 10);
  }

  function lineName(l) {
    return `${l.jobName}: ${l.supplier}${l.description ? ", " + l.description : ""}`;
  }

  let data = null;
  let seq = 0;
  let loadedAt = 0;

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
    // "DRAWERS" / "PAINT ORDER <id>" under the description, as on the Orders page and the job page.
    const kind = window.OrderUI.kindLabel(l);
    const desc = td("Description", "dl-c-desc" + (l.description ? "" : " dl-blank"), el("span", { text: l.description || "" }));
    if (kind) desc.append(kind);
    return el("tr", { "data-id": String(l.id) },
      exp,
      td("Job", "dl-c-job", jobNode(l)),
      td("Supplier", "dl-c-sup", el("span", { text: l.supplier })),
      desc,
      td("Notes", "dl-c-notes" + (l.notes ? "" : " dl-blank"), el("span", { text: l.notes || "" })),
      td("Delivery note", "dl-c-note" + (note ? "" : " dl-blank"), note),
      cell);
  }

  // ------------------------------------------------- stock and paint (M11) ---

  function stockItems() {
    return (data && data.stock && Array.isArray(data.stock.items)) ? data.stock.items : [];
  }
  function stockRecent() {
    return (data && data.stock && Array.isArray(data.stock.recent)) ? data.stock.recent : [];
  }

  // A stock item's key on the page: its type and id ("stock:2026-10:Supplier", "paint:3").
  function sid(it) {
    return it.type + ":" + it.id;
  }

  // Whether the user may open the item's own page (lib/pages.js).
  function mayOpen(it) {
    if (it.type === "stock") return can("stock.count") || can("stock.order");
    if (it.type === "paint") return can("stock.order") || can("orders.receive");
    if (it.type === "drawer_stock") return can("stock.order");
    return false;
  }

  function safeLink(it) {
    return typeof it.link === "string" && /^\/(?!\/)/.test(it.link) ? it.link : null;
  }

  // The name in dialogs, aria labels and messages: "Stock order October 2026: Supplier".
  function itemName(it) {
    return it.label + (it.supplier ? ": " + it.supplier : "");
  }

  // Posts to the item's own receive route (section 9); the body is {receivedDate?, deliveryNote?}
  // or {undo: true}.
  function sendReceived(it, body) {
    if (it.type === "stock") {
      // "<period>:<supplier>": the supplier may itself hold a colon, so split at the first.
      const s = String(it.id);
      const at = s.indexOf(":");
      const period = s.slice(0, at);
      const supplier = s.slice(at + 1);
      return api("/api/stock/orders/" + encodeURIComponent(period) + "/groups/received", {
        method: "POST", body: JSON.stringify(Object.assign({ supplier }, body)),
      });
    }
    if (it.type === "paint") {
      return api("/api/paint/orders/" + encodeURIComponent(it.id) + "/received", { method: "POST", body: JSON.stringify(body) });
    }
    if (it.type === "drawer_stock") {
      return api("/api/drawers/placed/" + encodeURIComponent(it.id) + "/stock-received", { method: "POST", body: JSON.stringify(body) });
    }
    return Promise.reject(new Error("Reload the page and try again."));
  }

  function itemNode(it) {
    const href = safeLink(it);
    if (href && mayOpen(it)) return el("a", { class: "dl-job", href, text: it.label });
    return el("span", { class: "dl-job", text: it.label });
  }

  // The delivery-note block as an order line's (still waiting: the "attend to this" edge).
  function itemNote(it, waiting) {
    return window.OrderUI.noteBlock({ deliveryNote: it.deliveryNote || "", status: waiting ? "ordered" : "received" });
  }

  const STOCK_COLS = [
    ["Expected", "dl-c-date"], ["Order", "dl-c-what"], ["Supplier", "dl-c-sup"], ["Ordered", "dl-c-date"],
    ["Delivery note", "dl-c-note"], ["", "dl-c-acts"],
  ];

  function stockRow(it) {
    // One child, so the narrow card layout keeps the tag beside its label.
    const exp = td("Expected", "dl-c-date" + (it.overdue ? " dl-overdue" : ""),
      el("span", { text: it.expectedDate ? fmtDate(it.expectedDate) : "No date yet" },
        it.overdue ? el("span", { class: "dl-overdue-tag", text: "Overdue" }) : null));
    const box = el("div", { class: "dl-acts" });
    const key = sid(it);
    if (can("orders.receive")) {
      box.append(el("button", { type: "button", class: "hs-btn hs-btn-primary", "data-act": "sReceive", "data-id": key, text: "Received",
        "aria-label": "Received: " + itemName(it) }));
    }
    const href = safeLink(it);
    if (href && mayOpen(it)) {
      box.append(el("a", { class: "hs-btn", href, text: "Open", "aria-label": "Open " + it.label }));
    }
    const note = itemNote(it, true);
    return el("tr", { "data-sid": key },
      exp,
      td("Order", "dl-c-what", itemNode(it)),
      td("Supplier", "dl-c-sup", el("span", { text: it.supplier || "" })),
      td("Ordered", "dl-c-date" + (it.orderedDate ? "" : " dl-blank"), el("span", { text: fmtDate(it.orderedDate) })),
      td("Delivery note", "dl-c-note" + (note ? "" : " dl-blank"), note),
      td("", "dl-c-acts", box));
  }

  function stockSection() {
    const items = stockItems();
    if (!items.length) return null;
    const overdue = items.some((it) => it.overdue);
    return el("section", { class: "dl-group dl-stock", id: "dl-g-stock", "aria-labelledby": "dl-h-stock" },
      el("div", { class: "hs-sectionbar dl-bar" + (overdue ? " hs-sectionbar-orange" : "") },
        el("h2", { id: "dl-h-stock", tabindex: "-1" }, "Stock and paint ",
          el("span", { class: "dl-count" + (overdue ? " dl-count-overdue" : ""), text: String(items.length) })),
        el("span", { class: "dl-bar-note", text: "Workshop stock, paint orders and drawer stock" })),
      el("div", { class: "dl-wrap" }, el("table", { class: "dl-table dl-table-stock" }, headRow(STOCK_COLS),
        el("tbody", null, ...items.map(stockRow)))));
  }

  function renderGroups() {
    const host = $("dlGroups");
    const shown = data.groups.filter((g) => g.lines.length);
    const stock = stockSection();
    if (!shown.length) {
      host.replaceChildren(stock ? el("p", { class: "dl-empty dl-nothing", text: "No job lines on order." })
        : el("p", { class: "dl-empty dl-nothing", text: "Nothing on order." }));
      if (stock) host.append(stock);
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
    if (stock) host.append(stock);
  }

  // A stock, paint or drawer-stock receipt in Received recently: its label in the Job column.
  function stockRecentRow(it) {
    const key = sid(it);
    const cell = td("", "dl-c-acts");
    if (can("orders.receive")) {
      cell.append(el("div", { class: "dl-acts" }, el("button", { type: "button", class: "hs-btn", "data-act": "sUndo", "data-id": key,
        text: "Undo", "aria-label": "Undo received: " + itemName(it) })));
    }
    const note = itemNote(it, false);
    return el("tr", { "data-sid": key },
      td("Received", "dl-c-date", el("span", { text: fmtDate(it.receivedDate) })),
      td("By", "dl-c-by" + (it.receivedBy ? "" : " dl-blank"), el("span", { text: it.receivedBy ? it.receivedBy.name || "" : "" })),
      td("Order", "dl-c-job", itemNode(it)),
      td("Supplier", "dl-c-sup", el("span", { text: it.supplier || "" })),
      td("Description", "dl-c-desc dl-blank", el("span", { text: "" })),
      td("Delivery note", "dl-c-note" + (note ? "" : " dl-blank"), note),
      cell);
  }

  // Job lines and stock receipts together, newest first (each list already is).
  function recentAll() {
    const out = (data.recent || []).map((l) => ({ kind: "line", date: l.receivedDate || "", v: l }))
      .concat(stockRecent().map((it) => ({ kind: "stock", date: it.receivedDate || "", v: it })));
    return out.map((r, i) => Object.assign(r, { i })).sort((a, b) => b.date.localeCompare(a.date) || a.i - b.i);
  }

  function renderRecent() {
    const rows = $("dlRecentRows");
    const all = recentAll();
    $("dlRecent").hidden = false;
    $("dlRecentCount").textContent = String(all.length);
    $("dlRecentEmpty").hidden = all.length > 0;
    $("dlRecentWrap").hidden = all.length === 0;
    rows.replaceChildren(...all.map((r) => {
      if (r.kind === "stock") return stockRecentRow(r.v);
      const l = r.v;
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

  // `quiet`: a failure keeps what is on screen without a sentence (the idle reload retries).
  async function load(quiet) {
    const mine = ++seq;
    let d;
    try {
      d = await api("/api/orders/deliveries");
    } catch (e) {
      if (mine === seq && !quiet) setStatus(e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message, "err");
      return false;
    }
    if (mine !== seq) return false;
    data = d;
    loadedAt = Date.now();
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

  // A button by its action and id (a stock item's id is text that may hold any character, so the
  // ids are compared, not put in a selector).
  function button(id, act) {
    const want = String(id);
    for (const b of document.querySelectorAll(".dl-page button[data-act]")) {
      if (b.getAttribute("data-act") === act && b.getAttribute("data-id") === want) return b;
    }
    return null;
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
      if (res.refused) {
        // Refused (its sentence was in the dialog): the line may have changed elsewhere, so show
        // the list as it is now, with focus back on the same button if the line still has it.
        await load();
        if (!focusNode(button(id, act))) {
          if (act === "undoReceived") focusAfterUndo(id, before);
          else focusAfterReceive(id, before);
        }
        return;
      }
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

  // --- stock, paint and drawer-stock items (M11) ---

  function findItem(key) {
    for (const it of stockItems()) if (sid(it) === key) return it;
    for (const it of stockRecent()) if (sid(it) === key) return it;
    return null;
  }

  // After receiving an item: the next item's Received button, else the section's heading (or the
  // job groups'), else Received recently.
  function focusAfterItemReceive(key, before) {
    const at = before.items.indexOf(key);
    for (const next of before.items.slice(at + 1).concat(before.items.slice(0, Math.max(at, 0)).reverse())) {
      if (focusNode(button(next, "sReceive"))) return;
    }
    if (focusNode(heading("dl-h-stock"))) return;
    if (focusNode(heading("dlRecentTitle"))) return;
    focusNode($("dlTitle"));
  }

  // After Undo on an item: the next Undo in Received recently, or the item's Received button.
  function focusAfterItemUndo(key, before) {
    const ids = before.recentKeys;
    const at = ids.indexOf(key);
    for (const next of ids.slice(at + 1).concat(ids.slice(0, Math.max(at, 0)).reverse())) {
      if (focusNode(button(next.id, next.act))) return;
    }
    if (focusNode(button(key, "sReceive"))) return;
    if (focusNode(heading("dlRecentTitle"))) return;
    focusNode($("dlTitle"));
  }

  async function runItem(act, key) {
    if (busy || !data) return;
    const it = findItem(key);
    if (!it) return;
    busy = true;
    try {
      const before = {
        items: stockItems().map(sid),
        recentKeys: recentAll().map((r) => (r.kind === "stock" ? { id: sid(r.v), act: "sUndo" } : { id: String(r.v.id), act: "undoReceived" })),
      };
      const item = { name: itemName(it), orderedDate: it.orderedDate, receivedDate: it.receivedDate, deliveryNote: it.deliveryNote };
      const send = (body) => sendReceived(it, body);
      const res = act === "sReceive" ? await window.OrderUI.receiveItem(item, send) : await window.OrderUI.undoReceivedItem(item, send);
      if (!res) return; // cancelled: OrderUI puts focus back on the button
      if (res.refused) {
        await load();
        if (!focusNode(button(key, act))) {
          if (act === "sUndo") focusAfterItemUndo(key, before);
          else focusAfterItemReceive(key, before);
        }
        return;
      }
      setStatus((act === "sReceive" ? "Received: " : "Back to ordered: ") + itemName(it) + ".", "ok");
      await load();
      if (act === "sReceive") focusAfterItemReceive(key, before);
      else focusAfterItemUndo(key, before);
    } finally {
      busy = false;
    }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-act]");
    if (!b || !b.closest(".dl-page")) return;
    const act = b.getAttribute("data-act");
    if (act === "sReceive" || act === "sUndo") {
      runItem(act, b.getAttribute("data-id"));
      return;
    }
    run(act, Number(b.getAttribute("data-id")));
  });

  // ---------------------------------------------------------------- idle reload ---
  // As the board does: every 5 minutes the list reloads, so lines received or changed elsewhere
  // show as they are now; only when no dialog is open, nothing is being sent and the tab is
  // visible (a tab that comes back after 5 minutes or more reloads then). Focus stays on the
  // same control (by its line and action, or its id) and the scroll position is kept. A failed
  // reload keeps what is on screen; the next one retries.
  const IDLE_RELOAD_MS = 5 * 60 * 1000;

  function idle() {
    return !!data && !busy && document.visibilityState === "visible" && !document.querySelector("dialog[open]");
  }

  async function idleReload() {
    if (!idle()) return false;
    const a = document.activeElement;
    const key = a && a !== document.body
      ? { act: a.getAttribute("data-act"), id: a.getAttribute("data-id"), elId: a.id || null }
      : null;
    const x = window.scrollX;
    const y = window.scrollY;
    if (!(await load(true))) return false;
    if (key) {
      const back = key.act && key.id ? button(key.id, key.act) : key.elId ? $(key.elId) : null;
      if (back && back !== document.activeElement) back.focus({ preventScroll: true });
    }
    window.scrollTo(x, y);
    return true;
  }

  setInterval(idleReload, IDLE_RELOAD_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && loadedAt && Date.now() - loadedAt >= IDLE_RELOAD_MS) idleReload();
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
    // Stock and paint items due within the same 7 days (overdue ones included); the rest are
    // counted in the foot.
    const weekEnd = addDays(data.date, 7);
    const items = stockItems();
    const dueItems = items.filter((it) => it.expectedDate && it.expectedDate <= weekEnd);
    if (!groups.length && !dueItems.length) out.push(el("p", { class: "dl-p-empty", text: "Nothing is due in the next 7 days." }));
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
    if (dueItems.length) {
      const cols = el("colgroup", null, ...["dl-pc-tick", "dl-pc-date", "dl-pc-what", "dl-pc-sup", "dl-pc-date", "dl-pc-note"].map((c) => el("col", { class: c })));
      const hr = el("tr", null, ...["", "Expected", "Order", "Supplier", "Ordered", "Delivery note"].map((t) => el("th", { scope: "col", text: t })));
      const tb = el("tbody", null, ...dueItems.map((it) => el("tr", null,
        el("td", { class: "dl-p-tick" }, el("span", { class: "dl-p-box" })),
        el("td", null, el("span", { class: "dl-p-nowrap", text: fmtDate(it.expectedDate) }),
          it.overdue ? el("span", { class: "dl-p-over", text: "Overdue" }) : null),
        el("td", { class: "dl-p-strong", text: it.label }),
        el("td", { text: it.supplier || "" }),
        el("td", { class: "dl-p-nowrap", text: fmtDate(it.orderedDate) }),
        el("td", { class: "dl-p-note", text: (it.deliveryNote || "").trim() }))));
      out.push(el("section", { class: "dl-p-group" },
        el("h2", { class: "dl-p-h2", text: `Stock and paint (${dueItems.length})` }),
        el("table", { class: "dl-p-table" }, cols, el("thead", null, hr), tb)));
    }
    const later = data.groups.filter((g) => !PRINT_GROUPS.includes(g.id)).reduce((n, g) => n + g.lines.length, 0);
    const laterItems = items.length - dueItems.length;
    const notOn = [];
    if (later) notOn.push(plural(later, "line", "lines"));
    if (laterItems) notOn.push(plural(laterItems, "stock or paint order", "stock or paint orders"));
    if (notOn.length) out.push(el("p", { class: "dl-p-foot", text: `Not on this list: ${notOn.join(" and ")} expected later or with no date yet.` }));
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
