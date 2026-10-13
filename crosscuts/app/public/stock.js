// Stock order (/stock.html[?period=YYYY-MM][#count|#order|#list]): the monthly stock order
// (docs/plans/m11-contracts.md sections 7 and 11.3). The Workshop Manager types Have and finishes
// the count (stock.count); Ordering types Order, marks each supplier group ordered, prints the
// orders and keeps the list (stock.order). Received is on Deliveries; its dates show here
// read-only. The server decides who may do what (lib/stock.js); cc.can() only hides controls.
(function () {
  "use strict";

  const P = window.Periods;
  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const QTY_MAX = 99999;
  const STATE = {
    counting: ["Counting", "hs-badge-na"],
    counted: ["Counted, to order", "hs-badge-check"],
    ordering: ["Ordering", "hs-badge-check"],
    ordered: ["Ordered", "hs-badge-teal"],
    received: ["Received", "hs-badge-go"],
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

  function tabsAllowed() {
    const out = ["count"];
    if (canOrder()) out.push("order", "list");
    return out;
  }

  function currentPeriod() {
    return P.currentPeriod(todayISO());
  }

  function readUrl() {
    const q = new URLSearchParams(location.search);
    const p = q.get("period");
    period = P.validPeriod(p) && p <= currentPeriod() ? p : currentPeriod();
    const h = location.hash.replace(/^#/, "");
    tab = ["count", "order", "list"].includes(h) ? h : null;
  }

  function writeUrl() {
    const next = `${location.pathname}?period=${period}#${tab}`;
    if (next !== location.pathname + location.search + location.hash) history.replaceState(null, "", next);
  }

  // ---------------------------------------------------------------- picker ---

  function renderPicker() {
    const cur = currentPeriod();
    const set = new Set([cur, P.addMonths(cur, -1), period, ...months.map((m) => m.period)]);
    const stateOf = new Map(months.map((m) => [m.period, m.state]));
    const sel = $("stMonth");
    sel.replaceChildren(...[...set].sort().reverse().map((p) => {
      const st = stateOf.get(p);
      const word = st ? STATE[st][0].toLowerCase() : "not started";
      return el("option", { value: p, text: `${P.longLabel(p)} (${word})` });
    }));
    sel.value = period;
    $("stNext").disabled = period >= cur;
    $("stPrev").setAttribute("aria-label", `Previous month, ${P.longLabel(P.addMonths(period, -1))}`);
    $("stNext").setAttribute("aria-label", period >= cur ? "Next month" : `Next month, ${P.longLabel(P.addMonths(period, 1))}`);
  }

  async function goPeriod(p) {
    if (!P.validPeriod(p) || p > currentPeriod() || p === period) return;
    period = p;
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
    for (const t of ["count", "order", "list"]) {
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
      if (view.state === "counted") text += " Nothing ordered yet.";
      else if (view.state === "ordering") text += ` ${ordered.length} of ${plural(toOrder.length, "supplier", "suppliers")} ordered.`;
      else if (view.state === "ordered") text += " Every supplier is ordered; waiting on delivery.";
      else if (view.state === "received") text += " Everything ordered has been received.";
    }
    $("stStateText").textContent = text;
    $("stMonthLabel").textContent = P.longLabel(period);
    document.title = `Stock order ${P.longLabel(period)} - Crosscuts`;
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

  function qtyInput(kind, l, label) {
    const value = kind === "have" ? l.have : l.order;
    const input = el("input", {
      class: "hs-input st-qty", type: "number", min: "0", max: String(QTY_MAX), step: "1", inputmode: "numeric",
      "data-kind": kind, "data-item": String(l.itemId), "aria-label": `${label}: ${l.item}`,
    });
    input.value = value == null ? "" : String(value);
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
      note.textContent = `The count is finished. ${canOrder() ? "Reopen it on the Order tab to change Have." : "Ask Ordering to reopen it if Have needs to change."}`;
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
        el("td", { class: "st-c-qty" }, edit ? qtyInput("have", l, "Have") : qtyText(l.have))));
      return el("section", { class: "st-group", "aria-labelledby": "st-ch-" + gi },
        groupHead(g, el("span", { class: "st-count", text: `${done}/${g.lines.length}` }), "st-ch-" + gi),
        el("div", { class: "st-wrap" },
          el("table", { class: "st-table st-table-count" },
            el("thead", null, el("tr", null,
              el("th", { scope: "col", class: "st-c-code", text: "Code" }),
              el("th", { scope: "col", class: "st-c-item", text: "Item" }),
              el("th", { scope: "col", class: "st-c-link", text: "Link" }),
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
    const n = g.lines.filter((l) => l.order > 0).length;
    if (n) return el("span", { class: "hs-badge hs-badge-check", text: `${n} to order` });
    return el("span", { class: "hs-badge hs-badge-na", text: "Nothing to order" });
  }

  function renderOrder() {
    const edit = canOrder();
    const toOrder = view.groups.filter((g) => g.lines.some((l) => l.order > 0));
    $("stOrderSummary").textContent = toOrder.length
      ? `${plural(toOrder.length, "supplier", "suppliers")} with something to order`
      : "Nothing to order yet";
    $("stReopen").hidden = !(edit && view.state === "counted");
    $("stPrintAll").disabled = !toOrder.length;
    const note = $("stOrderNote");
    if (view.state === "counting") {
      note.hidden = false;
      note.textContent = "The count isn't finished yet. Order can be typed now; a supplier can be marked ordered once the count is finished.";
    } else if (view.state !== "counted" && edit) {
      note.hidden = false;
      note.textContent = "The count can be reopened once no supplier is marked ordered (Undo each one first).";
    } else {
      note.hidden = true;
    }
    const host = $("stOrderGroups");
    if (!view.groups.length) {
      host.replaceChildren(el("p", { class: "st-empty", text: "No stock items yet. Add them on the List tab." }));
      return;
    }
    host.replaceChildren(...view.groups.map((g, gi) => {
      const locked = !!g.ordered;
      const has = g.lines.some((l) => l.order > 0);
      const acts = el("div", { class: "st-bar-acts" });
      if (edit && !g.ordered && has && view.state !== "counting") {
        acts.append(el("button", { type: "button", class: "hs-btn hs-btn-primary", "data-act": "mark", "data-group": String(gi), text: "Mark ordered", "aria-label": `Mark ${g.supplier} ordered` }));
      }
      if (edit && g.ordered && !g.received) {
        acts.append(el("button", { type: "button", class: "hs-btn", "data-act": "undo", "data-group": String(gi), text: "Undo", "aria-label": `Undo the order for ${g.supplier}` }));
      }
      if (has) {
        acts.append(el("button", { type: "button", class: "hs-btn", "data-act": "print", "data-group": String(gi), text: "Print order", "aria-label": `Print the order for ${g.supplier}` }));
      }
      const rows = g.lines.map((l) => el("tr", { class: l.order > 0 ? "st-row-on" : null },
        el("td", { class: "st-c-code", text: l.code || "" }),
        itemCell(l),
        el("td", { class: "st-c-link" }, linkNode(l)),
        el("td", { class: "st-c-qty st-c-have" }, qtyText(l.have)),
        el("td", { class: "st-c-qty" }, edit && !locked ? qtyInput("order", l, "Order") : qtyText(l.order))));
      const bar = el("div", { class: "hs-sectionbar st-bar" + (has && !g.ordered ? " hs-sectionbar-orange" : "") },
        el("h2", { id: "st-oh-" + gi, tabindex: "-1" }, g.supplier + " ", groupBadge(g)),
        acts);
      return el("section", { class: "st-group", "aria-labelledby": "st-oh-" + gi },
        bar,
        ...groupDates(g),
        el("div", { class: "st-wrap" },
          el("table", { class: "st-table st-table-order" },
            el("thead", null, el("tr", null,
              el("th", { scope: "col", class: "st-c-code", text: "Code" }),
              el("th", { scope: "col", class: "st-c-item", text: "Item" }),
              el("th", { scope: "col", class: "st-c-link", text: "Link" }),
              el("th", { scope: "col", class: "st-c-qty st-c-have", text: "Have" }),
              el("th", { scope: "col", class: "st-c-qty", text: "Order" }))),
            el("tbody", null, ...rows))));
    }));
  }

  function render() {
    if (!view) return;
    renderPicker();
    renderState();
    renderCount();
    if (canOrder()) renderOrder();
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

  // --------------------------------------------------------- saving Have/Order ---

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
    const kind = input.getAttribute("data-kind");
    const itemId = Number(input.getAttribute("data-item"));
    const line = lineOf(itemId);
    if (!line) return;
    const v = parseQty(input);
    if (Number.isNaN(v)) {
      input.setAttribute("aria-invalid", "true");
      setStatus(`${kind === "have" ? "Have" : "Order"} for ${line.item} must be a whole number from 0 to ${QTY_MAX}, or empty.`, "err");
      return;
    }
    if (input.getAttribute("aria-invalid")) setStatus("", ""); // the sentence about it no longer applies
    input.removeAttribute("aria-invalid");
    if (String(v == null ? "" : v) === input.dataset.saved) return;
    const path = `/api/stock/orders/${period}/${kind === "have" ? "have" : "order"}`;
    const body = { lines: [kind === "have" ? { itemId, have: v } : { itemId, order: v }] };
    const forPeriod = period;
    queue = queue.then(async () => {
      if (forPeriod !== period) return;
      input.classList.add("st-saving");
      try {
        const res = await send("PUT", path, body);
        if (forPeriod !== period) return;
        input.dataset.saved = v == null ? "" : String(v);
        // Keep the inputs on screen; refresh the figures from the answer.
        view = res;
        const label = kind === "have" ? "Have" : "Order";
        setStatus(`Saved: ${line.item}, ${label.toLowerCase()} ${v == null ? "cleared" : v}.`, "ok");
        renderState();
        refreshFigures();
      } catch (e) {
        input.value = input.dataset.saved;
        setStatus(errText(e), "err");
        if (!(e instanceof TypeError)) await reload(); // refused: the month may have changed elsewhere
      } finally {
        input.classList.remove("st-saving");
      }
    });
  }

  // After a save: the counts and badges change, the inputs stay as they are.
  function refreshFigures() {
    const lines = allLines();
    const n = lines.filter((l) => l.have != null).length;
    $("stProgress").textContent = view.state === "counting" ? "" : `${n} of ${plural(lines.length, "item", "items")} counted`;
    view.groups.forEach((g, gi) => {
      const h = $("st-ch-" + gi);
      const c = h && h.querySelector(".st-count");
      if (c) c.textContent = `${g.lines.filter((l) => l.have != null).length}/${g.lines.length}`;
    });
    if (canOrder() && tab === "order") {
      // Mark ordered and Print order depend on Order > 0: rebuild the bars only.
      const host = $("stOrderGroups");
      view.groups.forEach((g, gi) => {
        const h = $("st-oh-" + gi);
        if (!h) return;
        const badge = h.querySelector(".hs-badge");
        if (badge) badge.replaceWith(groupBadge(g));
        const bar = h.parentElement;
        const has = g.lines.some((l) => l.order > 0);
        bar.classList.toggle("hs-sectionbar-orange", has && !g.ordered);
        const acts = bar.querySelector(".st-bar-acts");
        const want = [];
        if (!g.ordered && has && view.state !== "counting") want.push("mark");
        if (g.ordered && !g.received) want.push("undo");
        if (has) want.push("print");
        const haveActs = [...acts.querySelectorAll("button")].map((b) => b.getAttribute("data-act"));
        if (want.join() !== haveActs.join()) {
          const focused = acts.contains(document.activeElement) ? document.activeElement.getAttribute("data-act") : null;
          acts.replaceChildren(...want.map((a) => el("button", {
            type: "button", class: "hs-btn" + (a === "mark" ? " hs-btn-primary" : ""), "data-act": a, "data-group": String(gi),
            text: a === "mark" ? "Mark ordered" : a === "undo" ? "Undo" : "Print order",
            "aria-label": a === "mark" ? `Mark ${g.supplier} ordered` : a === "undo" ? `Undo the order for ${g.supplier}` : `Print the order for ${g.supplier}`,
          })));
          if (focused) { const b = acts.querySelector(`[data-act="${focused}"]`); if (b) b.focus(); }
        }
      });
      for (const input of host.querySelectorAll(`input[data-kind="order"]`)) {
        const l = lineOf(Number(input.getAttribute("data-item")));
        if (l) input.closest("tr").classList.toggle("st-row-on", l.order > 0);
      }
      const toOrder = view.groups.filter((g) => g.lines.some((l) => l.order > 0));
      $("stOrderSummary").textContent = toOrder.length ? `${plural(toOrder.length, "supplier", "suppliers")} with something to order` : "Nothing to order yet";
      $("stPrintAll").disabled = !toOrder.length;
    }
  }

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains("st-qty")) saveQty(t);
  });

  // Enter moves to the next box in the same column (the change event saves this one).
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.key !== "Enter" || !t || !t.classList || !t.classList.contains("st-qty")) return;
    e.preventDefault();
    const all = [...document.querySelectorAll(`.st-panel:not([hidden]) input.st-qty[data-kind="${t.getAttribute("data-kind")}"]`)];
    const i = all.indexOf(t);
    const next = all[e.shiftKey ? i - 1 : i + 1];
    if (next) { next.focus(); next.select(); } else t.blur();
  });

  // --------------------------------------------------------------- actions ---

  async function finishCount() {
    await queue;
    const missing = allLines().filter((l) => l.have == null).length;
    const ok = await dialog({
      title: `Finish the count for ${P.longLabel(period)}?`,
      note: (missing ? `${plural(missing, "item has", "items have")} no Have yet. ` : "") +
        "Ordering is told the count is done. Have can't change afterwards unless Ordering reopens the count.",
      submit: "Finish count",
      focus: missing ? "cancel" : null,
      run: async () => { view = await send("POST", `/api/stock/orders/${period}/counted`); },
    });
    if (!ok) return;
    setStatus(`The count for ${P.longLabel(period)} is finished.`, "ok");
    await reload();
    $("stTitle").focus({ preventScroll: true });
  }

  async function reopenCount() {
    const ok = await dialog({
      title: `Reopen the count for ${P.longLabel(period)}?`,
      note: "The Workshop Manager can change Have again and finish the count again. Lines with no Have and no Order are dropped.",
      submit: "Reopen count",
      focus: "cancel",
      run: async () => { view = await send("POST", `/api/stock/orders/${period}/reopen`); },
    });
    if (!ok) return;
    setStatus(`The count for ${P.longLabel(period)} is open again.`, "ok");
    await reload();
    $("stTitle").focus({ preventScroll: true });
  }

  async function markOrdered(g) {
    await queue;
    const today = todayISO();
    const od = el("input", { class: "hs-input st-date", type: "date", max: today, required: true });
    od.value = today;
    const ed = el("input", { class: "hs-input st-date", type: "date" });
    const n = g.lines.filter((l) => l.order > 0).length;
    const ok = await dialog({
      title: `Mark ${g.supplier} ordered`,
      note: `${plural(n, "item", "items")} on the ${P.longLabel(period)} order. It then shows on Deliveries to be marked received.`,
      fields: [field("Ordered date", od), field("Expected date (optional)", ed)],
      submit: "Mark ordered",
      run: async () => {
        if (!validDate(od.value)) throw new Error("Choose the date it was ordered.");
        if (od.value > today) throw new Error("The ordered date can't be in the future.");
        if (ed.value && !validDate(ed.value)) throw new Error("The expected date isn't a date.");
        view = await send("POST", `/api/stock/orders/${period}/groups`, { supplier: g.supplier, orderedDate: od.value, expectedDate: ed.value || null });
      },
    });
    if (!ok) return;
    setStatus(`${g.supplier} is marked ordered.`, "ok");
    await reload();
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
    if (!b || !b.closest("#stPanelOrder")) return;
    const g = view && view.groups[Number(b.getAttribute("data-group"))];
    if (!g) return;
    const act = b.getAttribute("data-act");
    const run = act === "mark" ? () => markOrdered(g) : act === "undo" ? () => undoOrdered(g) : () => printSheet("order", g);
    guardedRun(b, run);
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
    sup.value = it ? it.supplier : "";
    code.value = it ? it.code : "";
    name.value = it ? it.item : "";
    link.value = it ? it.link : "";
    active.checked = it ? it.active : true;
    const fields = [field("Supplier", sup, "Items with the same supplier are ordered together."), dl, field("Code (optional)", code), field("Item", name), field("Link (optional)", link)];
    if (it) fields.push(checkField("Active (on the monthly count)", active));
    return dialog({
      title: it ? "Edit stock item" : "Add stock item",
      fields,
      submit: it ? "Save" : "Add item",
      run: async () => {
        const body = { supplier: sup.value.trim(), code: code.value.trim(), item: name.value.trim(), link: link.value.trim() };
        if (!body.supplier) throw new Error("Give the supplier.");
        if (!body.item) throw new Error("Give the item.");
        if (body.link && !/^https?:\/\/\S+$/i.test(body.link)) throw new Error("The link must start with http:// or https://");
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
  // One container, filled just before printing: the blank count sheet, one supplier's order, or
  // every supplier's order (one page each). Ctrl+P prints the sheet of the tab on screen.

  let printed = null; // the sheet the last button built, so beforeprint doesn't rebuild it

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
    const out = [pHead("Stock count", P.longLabel(period), signLines(["Counted by", "Date"]))];
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

  function orderPage(g) {
    const lines = g.lines.filter((l) => l.order > 0);
    const right = el("div", { class: "st-p-meta" },
      el("p", { text: g.ordered ? `Ordered ${fmtDate(g.ordered.date)}` : `Printed ${fmtDate(todayISO())}` }),
      g.expectedDate ? el("p", { text: `Expected ${fmtDate(g.expectedDate)}` }) : null);
    return el("section", { class: "st-p-page" },
      pHead("Stock order", `${g.supplier} · ${P.longLabel(period)}`, right),
      el("table", { class: "st-p-table st-p-order" },
        el("colgroup", null, el("col", { class: "st-pc-code" }), el("col", { class: "st-pc-item" }), el("col", { class: "st-pc-qty" })),
        el("thead", null, el("tr", null, el("th", { scope: "col", text: "Code" }), el("th", { scope: "col", text: "Item" }), el("th", { scope: "col", class: "st-p-num", text: "Quantity" }))),
        el("tbody", null, ...lines.map((l) => el("tr", null,
          el("td", { class: "st-p-nowrap", text: l.code || "" }),
          el("td", { text: l.item }),
          el("td", { class: "st-p-num st-p-strong", text: String(l.order) }))))),
      el("p", { class: "st-p-foot", text: plural(lines.length, "item", "items") }));
  }

  async function buildSheet(kind, g) {
    const sheet = $("stPrint");
    let nodes;
    let title;
    if (kind === "blank") {
      const list = (await api("/api/stock/items")).items || [];
      nodes = blankSheet(list);
      title = `Stock count sheet ${P.longLabel(period)}`;
    } else if (kind === "order") {
      nodes = [orderPage(g)];
      title = `Stock order ${g.supplier} ${P.longLabel(period)}`;
    } else {
      const groups = view.groups.filter((x) => x.lines.some((l) => l.order > 0));
      nodes = groups.length ? groups.map(orderPage) : [pHead("Stock order", P.longLabel(period)), el("p", { class: "st-p-empty", text: "Nothing to order." })];
      title = `Stock orders ${P.longLabel(period)}`;
    }
    sheet.replaceChildren(...nodes);
    return title;
  }

  let titleBefore = null;
  async function printSheet(kind, g) {
    await queue;
    const title = await buildSheet(kind, g);
    if (titleBefore == null) titleBefore = document.title;
    document.title = title;
    printed = kind;
    window.print();
  }

  window.addEventListener("beforeprint", () => {
    if (printed) return; // a button built it
    if (titleBefore == null) titleBefore = document.title;
    // Ctrl+P: the sheet of the tab on screen (the blank sheet needs the list, already loaded or the
    // month's own lines will do).
    const sheet = $("stPrint");
    if (tab === "order" && view) {
      const groups = view.groups.filter((x) => x.lines.some((l) => l.order > 0));
      sheet.replaceChildren(...(groups.length ? groups.map(orderPage) : [pHead("Stock order", P.longLabel(period)), el("p", { class: "st-p-empty", text: "Nothing to order." })]));
      document.title = `Stock orders ${P.longLabel(period)}`;
    } else {
      const list = items ? items : allLines().map((l, i) => ({ id: l.itemId, supplier: (view.groups.find((g) => g.lines.includes(l)) || {}).supplier, code: l.code, item: l.item, active: true, sort: i }));
      sheet.replaceChildren(...blankSheet(list));
      document.title = `Stock count sheet ${P.longLabel(period)}`;
    }
  });
  window.addEventListener("afterprint", () => {
    if (titleBefore != null) document.title = titleBefore;
    titleBefore = null;
    printed = null;
  });

  // ------------------------------------------------------------------ start ---

  $("stPrev").addEventListener("click", () => goPeriod(P.addMonths(period, -1)));
  $("stNext").addEventListener("click", () => goPeriod(P.addMonths(period, 1)));
  $("stMonth").addEventListener("change", (e) => goPeriod(e.target.value));
  $("stFinish").addEventListener("click", once(finishCount));
  $("stReopen").addEventListener("click", once(reopenCount));
  $("stPrintBlank").addEventListener("click", once(() => printSheet("blank")));
  $("stPrintAll").addEventListener("click", once(() => printSheet("all")));
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

  readUrl();
  (async () => {
    const ready = window.cc && window.cc.ready ? window.cc.ready : Promise.resolve();
    await ready;
    const ok = await loadMonth();
    // Ordering lands on Order once the count is finished, everyone else on Count.
    if (!tab) tab = canOrder() && view && view.state !== "counting" ? "order" : "count";
    setTab(tab);
    if (ok) render();
  })();
})();
