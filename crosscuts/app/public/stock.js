// Stock order (/stock.html[?period=YYYY-MM|YYYY-MM-DD][#count|#ordered|#list]): the fortnightly stock
// count (docs/plans/m27-contracts.md sections 2 and 3). The Workshop Manager types Have and
// finishes the count (stock.count); finishing puts what is below target on the monthly stock order
// on the Orders page (0.2.27, docs/plans/stock-orders-contracts.md), where ordering happens. This
// page keeps Count and List, "Send to monthly order" for a fortnight counted before 0.2.27, and a
// read-only Ordered view for past fortnights ordered on the old Order tab. The server decides who
// may do what (lib/stock.js); cc.can() only hides controls.
(function () {
  "use strict";

  const P = window.Periods;
  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const QTY_MAX = 99999;
  const STATE = {
    counting: ["Counting", "hs-badge-na"],
    counted: ["Counted", "hs-badge-teal"],
    ordering: ["Ordering", "hs-badge-check"],
    ordered: ["Ordered", "hs-badge-teal"],
    received: ["Received", "hs-badge-go"],
    nothing: ["Nothing to order", "hs-badge-na"],
  };

  // ------------------------------------------------------------------ helpers ---

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
  const canCount = () => can("stock.count");
  const canOrder = () => can("stock.order");

  function sydneyDate(iso) {
    const d = iso ? new Date(iso) : new Date();
    if (isNaN(d)) return "";
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
  const todayISO = () => sydneyDate();

  // "14 Oct 2026" from "2026-10-14"
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }
  const fmtStamp = (iso) => fmtDate(sydneyDate(iso));

  function validDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  function personName(p) {
    return p && p.name ? p.name : "someone";
  }

  function setStatus(text, kind) {
    const s = $("stStatus");
    s.textContent = text || "";
    s.className = "st-status" + (kind ? " st-status-" + kind : "");
  }

  function errText(e) {
    return e instanceof TypeError ? "Couldn't reach the server. Try again." : (e && e.message) || String(e);
  }

  async function send(method, path, body) {
    return api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  // A button that can't be pressed twice while its request runs; focus comes back to it (or the
  // page heading when it has gone).
  function once(fn) {
    let running = false;
    return async function (e) {
      if (running) return;
      running = true;
      const btn = e && e.currentTarget;
      try {
        await fn(e);
      } catch (err) {
        setStatus(errText(err), "err");
      } finally {
        running = false;
        const a = document.activeElement;
        if (!a || a === document.body) {
          if (btn && btn.isConnected && btn.offsetParent) btn.focus();
          else $("stTitle").focus({ preventScroll: true });
        }
      }
    };
  }

  // ------------------------------------------------------------------ dialogs ---
  // A modal on the shell's cc-dialog frame. spec: {title, note, fields: [nodes], submit,
  // submitClass, focus ("cancel" or a node), run}. run() resolves to close the dialog; a thrown
  // sentence shows inside it and it stays open. Resolves true when run() went through, else false.
  let openDlg = null;
  function dialog(spec) {
    if (openDlg) openDlg.close();
    const opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    return new Promise((resolve) => {
      let done = false;
      let busy = false;
      const uid = Math.random().toString(36).slice(2, 8);
      const err = el("p", { class: "cc-dialog-error", role: "alert" });
      const cancel = el("button", { type: "button", class: "hs-btn", text: "Cancel" });
      const go = el("button", { type: "submit", class: "hs-btn " + (spec.submitClass || "hs-btn-primary"), text: spec.submit });
      const form = el("form", { class: "cc-dialog-form", novalidate: true },
        el("h2", { class: "cc-dialog-title", id: "st-dt-" + uid, text: spec.title }),
        spec.note ? el("p", { class: "cc-dialog-note st-dlg-note", id: "st-dn-" + uid, text: spec.note }) : null,
        spec.fields && spec.fields.length ? el("div", { class: "st-dlg-fields" }, ...spec.fields) : null,
        err,
        el("div", { class: "cc-dialog-actions" }, cancel, go));
      const dlg = el("dialog", { class: "cc-dialog st-dialog", "aria-labelledby": "st-dt-" + uid, "aria-describedby": spec.note ? "st-dn-" + uid : null }, form);
      document.body.append(dlg);
      openDlg = dlg;
      const setBusy = (on) => {
        busy = on;
        for (const n of form.querySelectorAll("button, input, select, textarea")) n.disabled = on;
      };
      cancel.addEventListener("click", () => dlg.close());
      dlg.addEventListener("mousedown", (e) => { if (e.target === dlg && !busy) dlg.close(); });
      dlg.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
      dlg.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const stops = [...dlg.querySelectorAll("button, input, select, textarea, a[href]")].filter((n) => !n.disabled && n.offsetParent !== null);
        if (!stops.length) return;
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
      dlg.addEventListener("close", () => {
        if (openDlg === dlg) openDlg = null;
        dlg.remove();
        if (opener && opener.isConnected && opener.offsetParent) opener.focus();
        else $("stTitle").focus({ preventScroll: true });
        resolve(done);
      });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (busy) return;
        err.textContent = "";
        setBusy(true);
        try {
          await spec.run();
          done = true;
          setBusy(false);
          dlg.close();
        } catch (ex) {
          setBusy(false);
          err.textContent = errText(ex);
        }
      });
      dlg.showModal();
      const start = spec.focus === "cancel" ? cancel : spec.focus || (spec.fields && spec.fields.length ? form.querySelector("input, select, textarea") : go);
      (start || go).focus();
    });
  }

  function field(label, input, hint) {
    const id = input.id || "st-f-" + Math.random().toString(36).slice(2, 8);
    input.id = id;
    return el("div", { class: "cc-field" },
      el("label", { class: "cc-field-label", for: id, text: label }),
      input,
      hint ? el("span", { class: "st-dlg-hint", text: hint }) : null);
  }

  function checkField(label, input) {
    const id = "st-f-" + Math.random().toString(36).slice(2, 8);
    input.id = id;
    return el("div", { class: "st-check" }, input, el("label", { for: id, text: label }));
  }

  // ------------------------------------------------------------------- state ---

  let period = null;
  let view = null; // GET /api/stock/orders/:period
  let months = []; // GET /api/stock/orders
  let items = null; // GET /api/stock/items[?all=1]
  let tab = "count";
  let seq = 0;
  let sentResult = null; // what Finish count or Send just did, shown until the period changes
  let cycle = { cycle: "fortnightly", cycleStart: "2026-10-26" }; // GET /api/stock/settings

  // Count and List. The read-only Ordered view shows only for a period that has supplier
  // groups ordered on the old Order tab (0.2.27: ordering is on the Orders page now).
  function hasOrdered() {
    return !!(view && view.groups.some((g) => g.ordered));
  }
  function tabsAllowed() {
    const out = ["count"];
    if (hasOrdered()) out.push("ordered");
    out.push("list");
    return out;
  }

  function currentPeriod() {
    return P.currentStockPeriod(todayISO(), cycle.cycle, cycle.cycleStart);
  }

  function started(p) {
    return P.validStockPeriod(p) && P.stockPeriodStarted(p, todayISO());
  }

  function readUrl() {
    const q = new URLSearchParams(location.search);
    const p = q.get("period");
    period = started(p) ? p : currentPeriod();
    const h = location.hash.replace(/^#/, "");
    tab = h === "order" ? "ordered" : ["count", "ordered", "list"].includes(h) ? h : null;
  }

  function writeUrl() {
    const next = `${location.pathname}?period=${period}#${tab}`;
    if (next !== location.pathname + location.search + location.hash) history.replaceState(null, "", next);
  }

  // ---------------------------------------------------------------- picker ---

  function renderPicker() {
    const cur = currentPeriod();
    const set = new Set([cur, P.addStockPeriods(cur, -1), period, ...months.map((m) => m.period)]);
    const stateOf = new Map(months.map((m) => [m.period, m.state]));
    const sel = $("stMonth");
    sel.replaceChildren(...[...set].sort().reverse().map((p) => {
      const st = stateOf.get(p);
      const word = st ? STATE[st][0].toLowerCase() : "not started";
      return el("option", { value: p, text: `${P.stockLabel(p)} (${word})` });
    }));
    sel.value = period;
    const next = P.addStockPeriods(period, 1);
    $("stNext").disabled = !started(next);
    $("stPrev").setAttribute("aria-label", `Previous, ${P.stockLabel(P.addStockPeriods(period, -1))}`);
    $("stNext").setAttribute("aria-label", !started(next) ? "Next" : `Next, ${P.stockLabel(next)}`);
  }

  async function goPeriod(p) {
    if (!started(p) || p === period) return;
    period = p;
    sentResult = null;
    writeUrl();
    await loadMonth();
  }

  // ------------------------------------------------------------------ tabs ---

  function setTab(which, focus) {
    const allowed = tabsAllowed();
    tab = allowed.includes(which) ? which : allowed[0];
    const multi = allowed.length > 1;
    const tabs = $("stTabs");
    tabs.hidden = !multi;
    if (multi) tabs.setAttribute("role", "tablist");
    for (const b of tabs.querySelectorAll(".st-tab")) {
      const t = b.getAttribute("data-tab");
      const on = t === tab;
      b.hidden = !allowed.includes(t);
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(on));
      b.setAttribute("aria-controls", "stPanel" + t[0].toUpperCase() + t.slice(1));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const t of ["count", "ordered", "list"]) {
      const panel = $("stPanel" + t[0].toUpperCase() + t.slice(1));
      panel.hidden = t !== tab;
      if (multi) {
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", "stTab" + t[0].toUpperCase() + t.slice(1));
        panel.removeAttribute("aria-label");
      }
    }
    writeUrl();
    if (tab === "list" && !items) loadList();
  }

  // ------------------------------------------------------------- the month ---

  function allLines() {
    return view ? view.groups.flatMap((g) => g.lines) : [];
  }

  const counted = () => !!(view && view.state !== "counting");

  function renderState() {
    const [word, cls] = STATE[view.state] || [view.state, "hs-badge-na"];
    $("stState").hidden = false;
    $("stBadge").className = "hs-badge " + cls;
    $("stBadge").textContent = word;
    const lines = allLines();
    let text;
    if (view.state === "counting") {
      const n = lines.filter((l) => l.have != null).length;
      text = lines.length ? `${n} of ${plural(lines.length, "item", "items")} counted so far.` : "Nothing to count yet.";
    } else {
      text = `Counted by ${personName(view.counted.by)} on ${fmtStamp(view.counted.at)}.`;
      const toOrder = view.groups.filter((g) => g.lines.some((l) => l.order > 0));
      const ordered = view.groups.filter((g) => g.ordered);
      if (view.state === "ordering") text += ` ${ordered.length} of ${plural(toOrder.length, "supplier", "suppliers")} ordered.`;
      else if (view.state === "ordered") text += " Every supplier is ordered; waiting on delivery.";
      else if (view.state === "received") text += " Everything ordered has been received.";
      else if (view.state === "nothing") text += " Nothing to order this month.";
    }
    $("stStateText").textContent = text;
    renderSent();
    $("stMonthLabel").textContent = P.stockLabel(period);
    document.title = `Stock order ${P.stockLabel(period)} - Crosscuts`;
  }

  // After Finish count or Send: how many items went to which month, with a link to that order. A
  // count already sent says so; an older fortnight never sent offers "Send to monthly order".
  function renderSent() {
    const note = $("stSent");
    const nodes = [];
    const r = sentResult && sentResult.month ? sentResult : null;
    const s = view.sent && view.sent.period ? view.sent : null;
    if (r && r.skipped) {
      nodes.push(document.createTextNode("Not sent to the stock order: a newer count has already been sent."));
    } else if (r) {
      const n = (r.added || 0) + (r.updated || 0);
      nodes.push(document.createTextNode(`${plural(n, "item is", "items are")} on the ${P.stockLabel(r.month)} stock order (${r.added || 0} added, ${r.updated || 0} changed, ${r.removed || 0} removed). `));
      nodes.push(el("a", { href: `/orders.html?stock=${encodeURIComponent(r.month)}`, text: "Open the stock order", "aria-label": `Open the ${P.stockLabel(r.month)} stock order` }));
    } else if (s) {
      nodes.push(document.createTextNode(`Sent to the ${P.stockLabel(s.period)} stock order on ${fmtStamp(s.at)}. `));
      nodes.push(el("a", { href: `/orders.html?stock=${encodeURIComponent(s.period)}`, text: "Open the stock order", "aria-label": `Open the ${P.stockLabel(s.period)} stock order` }));
    }
    note.hidden = !nodes.length;
    note.replaceChildren(...nodes);
    const pending = view.state !== "counting" && !view.sent && view.groups.some((g) => !g.ordered && g.lines.some((l) => l.order > 0));
    $("stSendRow").hidden = !(pending && canOrder());
    $("stReopen").hidden = !(canOrder() && view.state === "counted" && !view.groups.some((g) => g.ordered));
  }

  function linkNode(l) {
    if (!l.link) return el("span", { class: "st-none", text: "" });
    return el("a", { href: l.link, target: "_blank", rel: "noopener noreferrer", text: "Open", "aria-label": `Open ${l.item} (new tab)` });
  }

  function itemCell(l) {
    return el("td", { class: "st-c-item" },
      el("span", { class: "st-item", text: l.item }),
      l.code ? el("span", { class: "st-code-sub", text: l.code }) : null);
  }

  function qtyInput(l) {
    const input = el("input", {
      class: "hs-input st-qty", type: "number", min: "0", max: String(QTY_MAX), step: "1", inputmode: "numeric",
      "data-kind": "have", "data-item": String(l.itemId), "aria-label": `Have: ${l.item}`,
    });
    input.value = l.have == null ? "" : String(l.have);
    input.dataset.saved = input.value;
    return input;
  }


  function qtyText(v) {
    return el("span", { class: "st-num" + (v == null ? " st-none" : ""), text: v == null ? "–" : String(v) });
  }

  function groupHead(g, extra, id) {
    return el("div", { class: "hs-sectionbar st-bar" },
      el("h2", { id, tabindex: "-1" }, g.supplier + " ", extra || null));
  }

  function renderCount() {
    const lines = allLines();
    const edit = canCount() && view.state === "counting";
    const n = lines.filter((l) => l.have != null).length;
    $("stProgress").textContent = view.state === "counting" ? "" : `${n} of ${plural(lines.length, "item", "items")} counted`;
    $("stFinish").hidden = !edit || !lines.length;
    const note = $("stCountNote");
    if (view.state !== "counting") {
      note.hidden = false;
      note.textContent = `The count is finished. ${canOrder() ? "Reopen it to change Have." : "Ask Ordering to reopen it if Have needs to change."}`;
    } else if (!canCount()) {
      note.hidden = false;
      note.textContent = "The Workshop Manager types Have here.";
    } else {
      note.hidden = true;
    }
    const host = $("stCountGroups");
    if (!view.groups.length) {
      host.replaceChildren(el("p", { class: "st-empty", text: canOrder() ? "No stock items yet. Add them on the List tab." : "No stock items yet. Ordering adds them to the list." }));
      return;
    }
    host.replaceChildren(...view.groups.map((g, gi) => {
      const done = g.lines.filter((l) => l.have != null).length;
      const rows = g.lines.map((l) => el("tr", null,
        el("td", { class: "st-c-code", text: l.code || "" }),
        itemCell(l),
        el("td", { class: "st-c-link" }, linkNode(l)),
        el("td", { class: "st-c-qty st-c-have" }, qtyText(l.target)),
        el("td", { class: "st-c-qty" }, edit ? qtyInput("have", l, "Have") : qtyText(l.have))));
      return el("section", { class: "st-group", "aria-labelledby": "st-ch-" + gi },
        groupHead(g, el("span", { class: "st-count", text: `${done}/${g.lines.length}` }), "st-ch-" + gi),
        el("div", { class: "st-wrap" },
          el("table", { class: "st-table st-table-count" },
            el("thead", null, el("tr", null,
              el("th", { scope: "col", class: "st-c-code", text: "Code" }),
              el("th", { scope: "col", class: "st-c-item", text: "Item" }),
              el("th", { scope: "col", class: "st-c-link", text: "Link" }),
              el("th", { scope: "col", class: "st-c-qty st-c-have", text: "Target" }),
              el("th", { scope: "col", class: "st-c-qty", text: "Have" }))),
            el("tbody", null, ...rows))));
    }));
  }

  function groupDates(g) {
    const bits = [];
    if (g.ordered) bits.push(`Ordered ${fmtDate(g.ordered.date)} by ${personName(g.ordered.by)}`);
    if (g.expectedDate) bits.push(`Expected ${fmtDate(g.expectedDate)}`);
    if (g.received) bits.push(`Received ${fmtDate(g.received.date)} by ${personName(g.received.by)}`);
    const out = [];
    if (bits.length) out.push(el("p", { class: "st-dates", text: bits.join(" · ") }));
    if (g.deliveryNote) {
      out.push(el("div", { class: "st-dnote" + (g.received ? "" : " st-dnote-open") },
        el("span", { class: "st-dnote-label", text: "Delivery note" }),
        el("span", { class: "st-dnote-text", text: g.deliveryNote })));
    }
    return out;
  }

  function groupBadge(g) {
    if (g.received) return el("span", { class: "hs-badge hs-badge-go", text: "Received" });
    if (g.ordered) return el("span", { class: "hs-badge hs-badge-teal", text: "Ordered" });
    return el("span", { class: "hs-badge hs-badge-na", text: "Not ordered" });
  }

  // The Ordered tab: a past fortnight's supplier groups that were ordered on the old Order tab,
  // read-only. Undo stays for a group not yet received (the server decides if it may).
  function renderOrdered() {
    const host = $("stOrderedGroups");
    if (!hasOrdered()) {
      host.replaceChildren();
      return;
    }
    const edit = canOrder();
    const groups = view.groups.map((g, gi) => ({ g, gi })).filter((x) => x.g.ordered);
    host.replaceChildren(...groups.map(({ g, gi }) => {
      const acts = el("div", { class: "st-bar-acts" });
      if (edit && !g.received) {
        acts.append(el("button", { type: "button", class: "hs-btn", "data-act": "undo", "data-group": String(gi), text: "Undo", "aria-label": `Undo the order for ${g.supplier}` }));
      }
      const lines = g.lines.filter((l) => l.order > 0);
      const rows = lines.map((l) => el("tr", null,
        el("td", { class: "st-c-code", text: l.code || "" }),
        itemCell(l),
        el("td", { class: "st-c-qty" }, qtyText(l.order))));
      return el("section", { class: "st-group", "aria-labelledby": "st-oh-" + gi },
        el("div", { class: "hs-sectionbar st-bar" },
          el("h2", { id: "st-oh-" + gi, tabindex: "-1" }, g.supplier + " ", groupBadge(g)),
          acts),
        ...groupDates(g),
        el("div", { class: "st-wrap" },
          el("table", { class: "st-table st-table-ordered" },
            el("thead", null, el("tr", null,
              el("th", { scope: "col", class: "st-c-code", text: "Code" }),
              el("th", { scope: "col", class: "st-c-item", text: "Item" }),
              el("th", { scope: "col", class: "st-c-qty", text: "Ordered" }))),
            el("tbody", null, ...rows))));
    }));
  }


  function render() {
    if (!view) return;
    renderPicker();
    renderState();
    renderCount();
    renderOrdered();
    if (tab) setTab(tab);
  }

  // quiet: keep the status line (a list change reloads the month behind its own sentence).
  async function loadMonth(quiet) {
    const mine = ++seq;
    if (!quiet) setStatus("Loading...", "");
    let v, m;
    try {
      [v, m] = await Promise.all([api(`/api/stock/orders/${period}`), api("/api/stock/orders")]);
    } catch (e) {
      if (mine === seq) setStatus(errText(e), "err");
      return false;
    }
    if (mine !== seq) return false;
    view = v;
    months = m.months || [];
    if (!quiet) setStatus("", "");
    render();
    return true;
  }

  // Reload after a change, keeping focus on the same control when it is still there.
  async function reload() {
    const a = document.activeElement;
    const key = a && a !== document.body ? { act: a.getAttribute("data-act"), group: a.getAttribute("data-group"), id: a.id } : null;
    const status = $("stStatus").textContent;
    const kind = ($("stStatus").className.match(/st-status-(\w+)/) || [])[1] || "";
    await loadMonth();
    setStatus(status, kind);
    if (key) {
      const back = key.act ? document.querySelector(`button[data-act="${key.act}"][data-group="${key.group}"]`) : key.id ? $(key.id) : null;
      if (back && back.offsetParent) back.focus({ preventScroll: true });
    }
  }

  // --------------------------------------------------------- saving Have ---

  let queue = Promise.resolve();

  function lineOf(itemId) {
    return allLines().find((l) => l.itemId === itemId) || null;
  }

  function parseQty(input) {
    const t = input.value.trim();
    if (t === "") return input.validity && input.validity.badInput ? NaN : null;
    if (!/^\d+$/.test(t)) return NaN;
    const n = Number(t);
    return n <= QTY_MAX ? n : NaN;
  }

  function saveQty(input) {
    const itemId = Number(input.getAttribute("data-item"));
    const line = lineOf(itemId);
    if (!line) return;
    const v = parseQty(input);
    if (Number.isNaN(v)) {
      input.setAttribute("aria-invalid", "true");
      setStatus(`Have for ${line.item} must be a whole number from 0 to ${QTY_MAX}, or empty.`, "err");
      return;
    }
    if (input.getAttribute("aria-invalid")) setStatus("", ""); // the sentence about it no longer applies
    input.removeAttribute("aria-invalid");
    if (String(v == null ? "" : v) === input.dataset.saved) return;
    const path = `/api/stock/orders/${period}/have`;
    const body = { lines: [{ itemId, have: v }] };
    const forPeriod = period;
    queue = queue.then(async () => {
      if (forPeriod !== period) return;
      input.classList.add("st-saving");
      try {
        const res = await send("PUT", path, body);
        if (forPeriod !== period) return;
        input.dataset.saved = v == null ? "" : String(v);
        const live = document.querySelector(`input.st-qty[data-item="${itemId}"]`);
        if (live && live !== input) live.dataset.saved = input.dataset.saved; // the box was redrawn meanwhile
        // Keep the inputs on screen; refresh the figures from the answer.
        view = res;
        setStatus(`Saved: ${line.item}, have ${v == null ? "cleared" : v}.`, "ok");
        renderState();
        refreshFigures();
      } catch (e) {
        input.value = input.dataset.saved;
        setStatus(errText(e), "err");
        if (!(e instanceof TypeError)) { // refused: the month may have changed elsewhere
          const typed = snapshotTyping(input);
          await reload();
          restoreTyping(typed);
        }
      } finally {
        input.classList.remove("st-saving");
      }
    });
  }

  // Boxes with something typed that isn't saved yet (or is waiting in the save queue). A refused
  // save reloads the month, which redraws every box; these are put back afterwards.
  function snapshotTyping(except) {
    const out = [];
    for (const i of document.querySelectorAll("input.st-qty")) {
      if (i === except || i.value.trim() === (i.dataset.saved || "")) continue;
      out.push({ item: i.getAttribute("data-item"), value: i.value, focus: i === document.activeElement });
    }
    return out;
  }

  function restoreTyping(list) {
    for (const t of list) {
      const i = document.querySelector(`input.st-qty[data-item="${t.item}"]`);
      if (!i || i.disabled || i.value === t.value) continue;
      i.value = t.value;
      if (t.focus) i.focus({ preventScroll: true });
    }
  }

  // After a save: the counts change, the inputs stay as they are.
  function refreshFigures() {
    const lines = allLines();
    const n = lines.filter((l) => l.have != null).length;
    $("stProgress").textContent = view.state === "counting" ? "" : `${n} of ${plural(lines.length, "item", "items")} counted`;
    view.groups.forEach((g, gi) => {
      const h = $("st-ch-" + gi);
      const c = h && h.querySelector(".st-count");
      if (c) c.textContent = `${g.lines.filter((l) => l.have != null).length}/${g.lines.length}`;
    });
  }

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains("st-qty") && t.getAttribute("data-kind") === "have") saveQty(t);
  });

  // Enter moves to the next Have box (the change event saves this one).
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.key !== "Enter" || !t || !t.classList || !t.classList.contains("st-qty") || t.getAttribute("data-kind") !== "have") return;
    e.preventDefault();
    const all = [...document.querySelectorAll('.st-panel:not([hidden]) input.st-qty[data-kind="have"]')];
    const i = all.indexOf(t);
    const next = all[e.shiftKey ? i - 1 : i + 1];
    if (next) { next.focus(); next.select(); } else t.blur();
  });


  // --------------------------------------------------------------- actions ---

  // Finishing the count puts its quantities on the monthly order (the server does it in the same
  // step); the answer says how many went where.
  async function finishCount() {
    await queue;
    const missing = allLines().filter((l) => l.have == null).length;
    let result = null;
    const ok = await dialog({
      title: `Finish the count for ${P.stockLabel(period)}?`,
      note: (missing ? `${plural(missing, "item has", "items have")} no Have yet. ` : "") +
        "What is below target goes on the stock order for this month on the Orders page. Have can't change afterwards unless the count is reopened.",
      submit: "Finish count",
      focus: missing ? "cancel" : null,
      run: async () => { view = await send("POST", `/api/stock/orders/${period}/counted`); result = view.sentResult || null; },
    });
    if (!ok) return;
    setStatus(`The count for ${P.stockLabel(period)} is finished.`, "ok");
    sentResult = result;
    await reload();
    $("stTitle").focus({ preventScroll: true });
  }

  // Rule G: an older fortnight, counted but never sent to a monthly order.
  async function sendToMonthly() {
    await queue;
    let result = null;
    const ok = await dialog({
      title: `Send the ${P.stockLabel(period)} count to the monthly order?`,
      note: "Its quantities go on the stock order for this month, less anything already ordered and not yet received. It can't be sent once a newer count has been.",
      submit: "Send to monthly order",
      run: async () => { view = await send("POST", `/api/stock/orders/${period}/send`); result = view.sentResult || null; },
    });
    if (!ok) return;
    setStatus(`The ${P.stockLabel(period)} count is sent to the monthly order.`, "ok");
    sentResult = result;
    await reload();
    $("stTitle").focus({ preventScroll: true });
  }


  async function reopenCount() {
    const ok = await dialog({
      title: `Reopen the count for ${P.stockLabel(period)}?`,
      note: "The Workshop Manager can change Have again and finish the count again. Lines with no Have and no Order are dropped.",
      submit: "Reopen count",
      focus: "cancel",
      run: async () => { view = await send("POST", `/api/stock/orders/${period}/reopen`); },
    });
    if (!ok) return;
    setStatus(`The count for ${P.stockLabel(period)} is open again.`, "ok");
    await reload();
    $("stTitle").focus({ preventScroll: true });
  }


  async function undoOrdered(g) {
    const ok = await dialog({
      title: `Undo the order for ${g.supplier}?`,
      note: "The supplier goes back to not ordered: its Order quantities can change again and it leaves Deliveries. The dates are cleared.",
      submit: "Undo",
      focus: "cancel",
      run: async () => { view = await send("POST", `/api/stock/orders/${period}/groups`, { supplier: g.supplier, undo: true }); },
    });
    if (!ok) return;
    setStatus(`${g.supplier} is no longer marked ordered.`, "ok");
    await reload();
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-act]");
    if (!b || !b.closest("#stPanelOrdered")) return;
    const g = view && view.groups[Number(b.getAttribute("data-group"))];
    if (!g || b.getAttribute("data-act") !== "undo") return;
    guardedRun(b, () => undoOrdered(g));
  });


  const running = new WeakSet();
  async function guardedRun(btn, fn) {
    if (running.has(btn)) return;
    running.add(btn);
    try {
      await fn();
    } catch (e) {
      setStatus(errText(e), "err");
    } finally {
      running.delete(btn);
    }
  }

  // --------------------------------------------------------------- the list ---

  async function loadList() {
    try {
      const r = await api("/api/stock/items?all=1");
      items = r.items || [];
    } catch (e) {
      setStatus(errText(e), "err");
      return;
    }
    renderList();
  }

  // The list in groups: a group is the exact supplier text, in the order of its first item.
  function listGroups(list) {
    const out = [];
    const at = new Map();
    for (const it of list) {
      if (!at.has(it.supplier)) {
        at.set(it.supplier, out.length);
        out.push({ supplier: it.supplier, items: [] });
      }
      out[at.get(it.supplier)].items.push(it);
    }
    return out;
  }

  function listButton(act, id, text, label, disabled) {
    return el("button", { type: "button", class: "hs-btn st-mini", "data-list": act, "data-id": String(id), text, "aria-label": label, disabled: !!disabled });
  }

  function renderList() {
    const host = $("stListGroups");
    if (!items.length) {
      host.replaceChildren(el("p", { class: "st-empty", text: "No stock items yet. Add the first one." }));
      return;
    }
    const groups = listGroups(items);
    host.replaceChildren(...groups.map((g, gi) => {
      const rows = g.items.map((it, i) => el("tr", { class: it.active ? null : "st-row-off" },
        el("td", { class: "st-c-code", text: it.code || "" }),
        el("td", { class: "st-c-item" },
          el("span", { class: "st-item", text: it.item }),
          it.active ? null : el("span", { class: "hs-badge hs-badge-na st-off", text: "Inactive" })),
        el("td", { class: "st-c-qty" }, qtyText(it.target)),
        el("td", { class: "st-c-linkfull" }, it.link ? el("a", { href: it.link, target: "_blank", rel: "noopener noreferrer", text: it.link, "aria-label": `${it.link} (new tab)` }) : null),
        el("td", { class: "st-c-acts" }, el("div", { class: "st-acts" },
          listButton("edit", it.id, "Edit", `Edit ${it.item}`),
          listButton("up", it.id, "Up", `Move ${it.item} up`, i === 0),
          listButton("down", it.id, "Down", `Move ${it.item} down`, i === g.items.length - 1),
          listButton(it.active ? "off" : "on", it.id, it.active ? "Deactivate" : "Activate", `${it.active ? "Deactivate" : "Activate"} ${it.item}`)))));
      const acts = el("div", { class: "st-bar-acts" },
        el("button", { type: "button", class: "hs-btn st-mini", "data-list": "gup", "data-id": String(gi), text: "Group up", "aria-label": `Move the ${g.supplier} group up`, disabled: gi === 0 }),
        el("button", { type: "button", class: "hs-btn st-mini", "data-list": "gdown", "data-id": String(gi), text: "Group down", "aria-label": `Move the ${g.supplier} group down`, disabled: gi === groups.length - 1 }));
      return el("section", { class: "st-group", "aria-labelledby": "st-lh-" + gi },
        el("div", { class: "hs-sectionbar st-bar" }, el("h2", { id: "st-lh-" + gi, tabindex: "-1" }, g.supplier + " ", el("span", { class: "st-count", text: String(g.items.length) })), acts),
        el("div", { class: "st-wrap" },
          el("table", { class: "st-table st-table-list" },
            el("thead", null, el("tr", null,
              el("th", { scope: "col", class: "st-c-code", text: "Code" }),
              el("th", { scope: "col", class: "st-c-item", text: "Item" }),
              el("th", { scope: "col", class: "st-c-qty", text: "Target" }),
              el("th", { scope: "col", class: "st-c-linkfull", text: "Link" }),
              el("th", { scope: "col", class: "st-c-acts" }, el("span", { class: "st-sr", text: "Actions" })))),
            el("tbody", null, ...rows))));
    }));
  }

  function itemDialog(it) {
    const sup = el("input", { class: "hs-input", type: "text", maxlength: "200", autocomplete: "off", list: "st-suppliers" });
    const dl = el("datalist", { id: "st-suppliers" }, ...[...new Set((items || []).map((i) => i.supplier))].map((s) => el("option", { value: s })));
    const code = el("input", { class: "hs-input", type: "text", maxlength: "100", autocomplete: "off" });
    const name = el("input", { class: "hs-input", type: "text", maxlength: "200", autocomplete: "off" });
    const link = el("input", { class: "hs-input", type: "url", maxlength: "500", autocomplete: "off", placeholder: "https://" });
    const active = el("input", { type: "checkbox" });
    const target = el("input", { class: "hs-input st-qty", type: "number", min: "0", max: String(QTY_MAX), step: "1", inputmode: "numeric" });
    target.value = it && it.target != null ? String(it.target) : "";
    sup.value = it ? it.supplier : "";
    code.value = it ? it.code : "";
    name.value = it ? it.item : "";
    link.value = it ? it.link : "";
    active.checked = it ? it.active : true;
    const fields = [field("Supplier", sup, "Items with the same supplier are ordered together."), dl, field("Code (optional)", code), field("Item", name), field("Target (optional)", target, "The total wanted on the shelf. Order fills in as target minus have."), field("Link (optional)", link)];
    if (it) fields.push(checkField("Active (on the count)", active));
    return dialog({
      title: it ? "Edit stock item" : "Add stock item",
      fields,
      submit: it ? "Save" : "Add item",
      run: async () => {
        const body = { supplier: sup.value.trim(), code: code.value.trim(), item: name.value.trim(), link: link.value.trim() };
        if (!body.supplier) throw new Error("Give the supplier.");
        if (!body.item) throw new Error("Give the item.");
        if (body.link && !/^https?:\/\/\S+$/i.test(body.link)) throw new Error("The link must start with http:// or https://");
        const t = target.value.trim();
        if (t !== "" && (!/^\d+$/.test(t) || Number(t) > QTY_MAX)) throw new Error(`The target must be a whole number from 0 to ${QTY_MAX}, or empty.`);
        body.target = t === "" ? null : Number(t);
        if (it) {
          body.active = active.checked;
          await send("PATCH", `/api/stock/items/${it.id}`, body);
        } else {
          await send("POST", "/api/stock/items", body);
        }
      },
    });
  }

  async function reloadList(focusSel) {
    await loadList();
    await loadMonth(true); // the open month shows list changes
    if (focusSel) {
      const b = document.querySelector(focusSel);
      if (b && !b.disabled) b.focus();
      else $("stAdd").focus();
    }
  }

  async function reorder(ids, focusSel, said) {
    items = (await send("POST", "/api/stock/items/reorder", { ids })).items;
    setStatus(said, "ok");
    renderList();
    await loadMonth(true);
    const b = document.querySelector(focusSel);
    if (b && !b.disabled) b.focus();
    else { const h = document.querySelector("#stListGroups h2"); if (h) h.focus(); }
  }

  async function listAction(act, id) {
    if (act === "gup" || act === "gdown") {
      const groups = listGroups(items);
      const gi = id;
      const to = act === "gup" ? gi - 1 : gi + 1;
      if (to < 0 || to >= groups.length) return;
      [groups[gi], groups[to]] = [groups[to], groups[gi]];
      await reorder(groups.flatMap((g) => g.items.map((i) => i.id)), `[data-list="${act}"][data-id="${to}"]`, `Moved the ${groups[to].supplier} group ${act === "gup" ? "up" : "down"}.`);
      return;
    }
    const it = items.find((i) => i.id === id);
    if (!it) return;
    if (act === "edit") {
      if (await itemDialog(it)) {
        setStatus(`Saved: ${it.item}.`, "ok");
        await reloadList(`[data-list="edit"][data-id="${id}"]`);
      }
    } else if (act === "up" || act === "down") {
      const g = listGroups(items).find((x) => x.supplier === it.supplier);
      const i = g.items.indexOf(it);
      const other = g.items[act === "up" ? i - 1 : i + 1];
      if (!other) return;
      // The pair, in its new order: they swap the two places they held.
      await reorder(act === "up" ? [it.id, other.id] : [other.id, it.id], `[data-list="${act}"][data-id="${id}"]`, `Moved ${it.item} ${act}.`);
    } else if (act === "off" || act === "on") {
      await send("PATCH", `/api/stock/items/${id}`, { active: act === "on" });
      setStatus(act === "on" ? `${it.item} is back on the list.` : `${it.item} is off the list; it no longer appears on new counts.`, "ok");
      await reloadList(`[data-list="${act === "on" ? "off" : "on"}"][data-id="${id}"]`);
    }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-list]");
    if (!b) return;
    guardedRun(b, () => listAction(b.getAttribute("data-list"), Number(b.getAttribute("data-id"))));
  });

  // --------------------------------------------------------------- printing ---
  // One container, filled just before printing: the blank count sheet (Ctrl+P prints it too).

  let printed = false; // the button built the sheet, so beforeprint doesn't rebuild it


  function pHead(title, sub, right) {
    return el("div", { class: "st-p-head" },
      el("div", null, el("h1", { class: "st-p-h1", text: title }), sub ? el("p", { class: "st-p-sub", text: sub }) : null),
      right || null);
  }

  function signLines(labels) {
    return el("div", { class: "st-p-signs" }, ...labels.map((t) =>
      el("div", { class: "st-p-sign" }, el("span", { class: "st-p-label", text: t }), el("span", { class: "st-p-rule" }))));
  }

  function blankSheet(list) {
    const groups = listGroups(list.filter((i) => i.active));
    const out = [pHead("Stock count", P.stockLabel(period), signLines(["Counted by", "Date"]))];
    if (!groups.length) out.push(el("p", { class: "st-p-empty", text: "No stock items on the list." }));
    for (const g of groups) {
      out.push(el("section", { class: "st-p-group" },
        el("h2", { class: "st-p-h2", text: g.supplier }),
        el("table", { class: "st-p-table st-p-count" },
          el("colgroup", null, el("col", { class: "st-pc-code" }), el("col", { class: "st-pc-item" }), el("col", { class: "st-pc-box" })),
          el("thead", null, el("tr", null, el("th", { scope: "col", text: "Code" }), el("th", { scope: "col", text: "Item" }), el("th", { scope: "col", class: "st-p-num", text: "Have" }))),
          el("tbody", null, ...g.items.map((i) => el("tr", null,
            el("td", { class: "st-p-nowrap", text: i.code || "" }),
            el("td", { text: i.item }),
            el("td", { class: "st-p-box" })))))));
    }
    return out;
  }

  async function printSheet() {
    await queue;
    const list = (await api("/api/stock/items")).items || [];
    $("stPrint").replaceChildren(...blankSheet(list));
    if (titleBefore == null) titleBefore = document.title;
    document.title = `Stock count sheet ${P.stockLabel(period)}`;
    printed = true;
    window.print();
  }

  let titleBefore = null;

  window.addEventListener("beforeprint", () => {
    if (printed) return; // the button built it
    if (titleBefore == null) titleBefore = document.title;
    // Ctrl+P: the blank count sheet (the list if loaded, else the month's own lines).
    const list = items ? items : allLines().map((l, i) => ({ id: l.itemId, supplier: (view.groups.find((g) => g.lines.includes(l)) || {}).supplier, code: l.code, item: l.item, active: true, sort: i }));
    $("stPrint").replaceChildren(...blankSheet(list));
    document.title = `Stock count sheet ${P.stockLabel(period)}`;
  });
  window.addEventListener("afterprint", () => {
    if (titleBefore != null) document.title = titleBefore;
    titleBefore = null;
    printed = false;
  });


  // ------------------------------------------------------------------ start ---

  $("stPrev").addEventListener("click", () => goPeriod(P.addStockPeriods(period, -1)));
  $("stNext").addEventListener("click", () => goPeriod(P.addStockPeriods(period, 1)));
  $("stMonth").addEventListener("change", (e) => goPeriod(e.target.value));
  $("stFinish").addEventListener("click", once(finishCount));
  $("stReopen").addEventListener("click", once(reopenCount));
  $("stSend").addEventListener("click", once(sendToMonthly));
  $("stPrintBlank").addEventListener("click", once(() => printSheet()));
  $("stAdd").addEventListener("click", once(async () => {
    if (!items) await loadList();
    if (await itemDialog(null)) {
      setStatus("Item added.", "ok");
      await reloadList();
    }
  }));
  for (const b of document.querySelectorAll(".st-tab")) b.addEventListener("click", () => setTab(b.getAttribute("data-tab")));
  $("stTabs").addEventListener("keydown", (e) => {
    const allowed = tabsAllowed();
    const i = allowed.indexOf(tab);
    let to = null;
    if (e.key === "ArrowRight") to = allowed[(i + 1) % allowed.length];
    else if (e.key === "ArrowLeft") to = allowed[(i - 1 + allowed.length) % allowed.length];
    else if (e.key === "Home") to = allowed[0];
    else if (e.key === "End") to = allowed[allowed.length - 1];
    if (!to) return;
    e.preventDefault();
    setTab(to, true);
  });

  (async () => {
    const ready = window.cc && window.cc.ready ? window.cc.ready : Promise.resolve();
    await ready;
    try {
      cycle = await api("/api/stock/settings");
    } catch (_) {
      // keep the defaults; loadMonth reports any real trouble
    }
    readUrl();
    const ok = await loadMonth();
    if (!tab) tab = "count";
    setTab(tab);
    if (ok) render();
  })();
})();

