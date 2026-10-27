// Board stocktake (/boards.html[?period=YYYY-MM][#count|#list]): the monthly board count
// (docs/plans/m11-contracts.md sections 8 and 11.4). The Workshop Manager types each board's
// quantity in whole or half sheets and finishes the count (stock.count); a finished count is done
// (the value step was removed 2026-10-17). Ordering keeps the board list and its prices and can
// reopen a finished count (stock.order). The server decides who may do what (lib/boards.js) and
// sends prices only to stock.order holders; cc.can() only hides controls.
// Money is integer cents on the wire, shown and typed through Periods (public/periods.js).
(function () {
  "use strict";

  const P = window.Periods;
  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const QTY_MAX = 9999;
  const ROWS_PER_COLUMN = 48; // the blank sheet: two columns of this many boards per A4 page
  const STATE = {
    open: ["Counting", "hs-badge-na"],
    counted: ["Counted", "hs-badge-go"],
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
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }
  const fmtStamp = (iso) => fmtDate(sydneyDate(iso));

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }
  const personName = (p) => (p && p.name ? p.name : "someone");
  const money = (c) => (c == null ? "" : P.dollars(c));
  const qtyText = (q) => (q == null ? "" : String(q));
  const thick = (t) => (t == null ? "" : `${t} mm`);
  const boardName = (b) => [b.thickness != null ? `${b.thickness} mm` : "", b.name, b.finish].filter(Boolean).join(" ");

  function setStatus(text, kind) {
    const s = $("bdStatus");
    s.textContent = text || "";
    s.className = "bd-status" + (kind ? " bd-status-" + kind : "");
  }

  function errText(e) {
    return e instanceof TypeError ? "Couldn't reach the server. Try again." : (e && e.message) || String(e);
  }

  async function send(method, path, body) {
    return api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  }

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
          else $("bdTitle").focus({ preventScroll: true });
        }
      }
    };
  }

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

  // ------------------------------------------------------------------ dialogs ---
  // As stock.js: a modal on the shell's cc-dialog frame; run() resolves to close it, a thrown
  // sentence shows inside it. Resolves true when run() went through.
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
        el("h2", { class: "cc-dialog-title", id: "bd-dt-" + uid, text: spec.title }),
        spec.note ? el("p", { class: "cc-dialog-note bd-dlg-note", id: "bd-dn-" + uid, text: spec.note }) : null,
        spec.fields && spec.fields.length ? el("div", { class: "bd-dlg-fields" }, ...spec.fields) : null,
        err,
        el("div", { class: "cc-dialog-actions" }, cancel, go));
      const dlg = el("dialog", { class: "cc-dialog bd-dialog", "aria-labelledby": "bd-dt-" + uid, "aria-describedby": spec.note ? "bd-dn-" + uid : null }, form);
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
        else $("bdTitle").focus({ preventScroll: true });
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
      const start = spec.focus === "cancel" ? cancel : spec.fields && spec.fields.length ? form.querySelector("input, select, textarea") : go;
      (start || go).focus();
    });
  }

  function field(label, input, hint) {
    input.id = input.id || "bd-f-" + Math.random().toString(36).slice(2, 8);
    return el("div", { class: "cc-field" },
      el("label", { class: "cc-field-label", for: input.id, text: label }),
      input,
      hint ? el("span", { class: "bd-dlg-hint", text: hint }) : null);
  }

  function checkField(label, input) {
    input.id = "bd-f-" + Math.random().toString(36).slice(2, 8);
    return el("div", { class: "bd-check" }, input, el("label", { for: input.id, text: label }));
  }

  // ------------------------------------------------------------------- state ---

  let period = null;
  let view = null; // GET /api/boards/counts/:period
  let months = []; // GET /api/boards/counts
  let boards = null; // GET /api/boards?all=1 (the List tab)
  let tab = null;
  let seq = 0;

  const currentPeriod = () => P.currentPeriod(todayISO());

  // 0.2.6 (docs/plans/m27-contracts.md section 5): the workshop manager keeps the list too.
  function tabsAllowed() {
    return ["count", "list"];
  }

  const isEdge = (b) => b && b.kind === "edge";
  const unitOf = (b) => (isEdge(b) ? "rolls" : "sheets");

  function readUrl() {
    const q = new URLSearchParams(location.search);
    const p = q.get("period");
    period = P.validPeriod(p) && p <= currentPeriod() ? p : currentPeriod();
    const h = location.hash.replace(/^#/, "");
    tab = ["count", "list"].includes(h) ? h : null;
  }

  function writeUrl() {
    const next = `${location.pathname}?period=${period}${tab ? "#" + tab : ""}`;
    if (next !== location.pathname + location.search + location.hash) history.replaceState(null, "", next);
  }

  // ---------------------------------------------------------------- picker ---

  function renderPicker() {
    const cur = currentPeriod();
    const set = new Set([cur, P.addMonths(cur, -1), period, ...months.map((m) => m.period)]);
    const stateOf = new Map(months.map((m) => [m.period, m.status]));
    const sel = $("bdMonth");
    sel.replaceChildren(...[...set].sort().reverse().map((p) => {
      const st = stateOf.get(p);
      const word = st === "open" ? "counting" : st === "counted" ? "counted" : "not started";
      return el("option", { value: p, text: `${P.longLabel(p)} (${word})` });
    }));
    sel.value = period;
    $("bdNext").disabled = period >= cur;
    $("bdPrev").setAttribute("aria-label", `Previous month, ${P.longLabel(P.addMonths(period, -1))}`);
    $("bdNext").setAttribute("aria-label", period >= cur ? "Next month" : `Next month, ${P.longLabel(P.addMonths(period, 1))}`);
  }

  async function goPeriod(p) {
    if (!P.validPeriod(p) || p > currentPeriod() || p === period) return;
    period = p;
    writeUrl();
    await loadMonth();
  }

  // ------------------------------------------------------------------ tabs ---

  const panelId = (t) => "bdPanel" + t[0].toUpperCase() + t.slice(1);
  const tabId = (t) => "bdTab" + t[0].toUpperCase() + t.slice(1);

  function setTab(which, focus) {
    const allowed = tabsAllowed();
    tab = allowed.includes(which) ? which : allowed[0];
    const multi = allowed.length > 1;
    const tabs = $("bdTabs");
    tabs.hidden = !multi;
    if (multi) tabs.setAttribute("role", "tablist");
    for (const b of tabs.querySelectorAll(".bd-tab")) {
      const t = b.getAttribute("data-tab");
      const on = t === tab;
      b.hidden = !allowed.includes(t);
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(on));
      b.setAttribute("aria-controls", panelId(t));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const t of ["count", "list"]) {
      const panel = $(panelId(t));
      panel.hidden = t !== tab;
      if (multi) {
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", tabId(t));
        panel.removeAttribute("aria-label");
      }
    }
    writeUrl();
    if (tab === "list" && !boards) loadList();
  }

  // ------------------------------------------------------------- the month ---

  const isOpen = () => !view || view.status === "open";

  function renderState() {
    const [word, cls] = STATE[view.status] || [view.status, "hs-badge-na"];
    $("bdState").hidden = false;
    $("bdBadge").className = "hs-badge " + cls;
    $("bdBadge").textContent = word;
    const n = view.lines.filter((l) => l.qty != null).length;
    let text;
    if (view.status === "open") {
      text = view.lines.length ? `${n} of ${plural(view.lines.length, "board", "boards")} counted so far.` : "Nothing to count yet.";
    } else {
      text = view.counted ? `Counted by ${personName(view.counted.by)} on ${fmtStamp(view.counted.at)}.` : "The count is finished.";
    }
    $("bdStateText").textContent = text;
    $("bdMonthLabel").textContent = P.longLabel(period);
    document.title = `Board stocktake ${P.longLabel(period)} - Crosscuts`;
  }

  function nameCell(l) {
    const meta = [l.supplier, thick(l.thickness), l.finish].filter(Boolean).join(" · ");
    return el("td", { class: "bd-c-name" },
      el("span", { class: "bd-name", text: l.name }),
      meta ? el("span", { class: "bd-meta", text: meta }) : null);
  }

  function qtyInput(l) {
    const input = el("input", {
      class: "hs-input bd-qty", type: "number", min: "0", max: String(QTY_MAX), step: isEdge(l) ? "1" : "0.5", inputmode: isEdge(l) ? "numeric" : "decimal",
      "data-board": String(l.boardId), "aria-label": isEdge(l) ? `Rolls of ${boardName(l)}` : `Sheets of ${boardName(l)}`,
    });
    input.value = qtyText(l.qty);
    input.dataset.saved = input.value;
    return input;
  }

  function head(cols) {
    return el("thead", null, el("tr", null, ...cols.map(([t, c]) => el("th", { scope: "col", class: c, text: t }))));
  }

  function renderCount() {
    const edit = canCount() && isOpen();
    $("bdProgress").textContent = isOpen() ? "" : `${plural(view.lines.filter((l) => l.qty > 0).length, "board", "boards")} with sheets counted`;
    $("bdFinish").hidden = !edit || !view.lines.length;
    $("bdReopenCount").hidden = isOpen() || !canOrder();
    const note = $("bdCountNote");
    if (!isOpen()) {
      note.hidden = false;
      note.textContent = "The count is finished." + (canOrder() ? " Reopen it to change a quantity." : " Ask Ordering to reopen it if a quantity needs to change.");
    } else if (!canCount()) {
      note.hidden = false;
      note.textContent = "The Workshop Manager types the quantities here.";
    } else {
      note.hidden = true;
    }
    const host = $("bdCountBody");
    if (!view.lines.length) {
      host.replaceChildren(el("p", { class: "bd-empty", text: canOrder() ? "No boards yet. Add them on the List tab." : "No boards yet. Ordering adds them to the list." }));
      return;
    }
    const rows = view.lines.map((l) => el("tr", { class: l.qty == null ? null : "bd-row-done" },
      el("td", { class: "bd-c-sup", text: l.supplier }),
      el("td", { class: "bd-c-thick", text: thick(l.thickness) }),
      nameCell(l),
      el("td", { class: "bd-c-finish", text: l.finish }),
      el("td", { class: "bd-c-qty" }, edit ? qtyInput(l) : el("span", { class: "bd-num", text: qtyText(l.qty) || "–" }))));
    host.replaceChildren(el("div", { class: "bd-wrap" },
      el("table", { class: "bd-table bd-table-count" },
        head([["Supplier", "bd-c-sup"], ["Thickness", "bd-c-thick"], ["Board", "bd-c-name"], ["Finish", "bd-c-finish"], ["Sheets", "bd-c-qty"]]),
        el("tbody", null, ...rows))));
  }

  function render() {
    if (!view) return;
    renderPicker();
    renderState();
    renderCount();
  }

  // quiet: keep the status line (a list change reloads the month behind its own sentence).
  async function loadMonth(quiet) {
    const mine = ++seq;
    if (!quiet) setStatus("Loading...", "");
    let v, m;
    try {
      [v, m] = await Promise.all([api(`/api/boards/counts/${period}`), api("/api/boards/counts")]);
    } catch (e) {
      if (mine === seq) setStatus(errText(e), "err");
      return false;
    }
    if (mine !== seq) return false;
    view = v;
    months = m.months || [];
    if (!quiet) setStatus("", "");
    render();
    if (tab) setTab(tab);
    return true;
  }

  // A reload redraws every box. What was typed in them and isn't saved (counts waiting in the save
  // queue or refused on another row) is put back afterwards.
  function snapshotTyping() {
    const counts = [...document.querySelectorAll("input.bd-qty")]
      .filter((i) => i.value.trim() !== (i.dataset.saved || ""))
      .map((i) => ({ board: i.getAttribute("data-board"), value: i.value, focus: i === document.activeElement }));
    return { counts };
  }

  function restoreTyping(t) {
    for (const c of t.counts) {
      const i = document.querySelector(`input.bd-qty[data-board="${c.board}"]`);
      if (!i || i.disabled || i.value === c.value) continue;
      i.value = c.value;
      if (c.focus) i.focus({ preventScroll: true });
    }
  }

  async function reload() {
    const a = document.activeElement;
    const key = a && a !== document.body ? { act: a.getAttribute("data-act"), board: a.getAttribute("data-board"), id: a.id } : null;
    const status = $("bdStatus").textContent;
    const kind = ($("bdStatus").className.match(/bd-status-(\w+)/) || [])[1] || "";
    const typed = snapshotTyping();
    await loadMonth();
    restoreTyping(typed);
    setStatus(status, kind);
    if (key) {
      const back = key.act ? document.querySelector(`[data-act="${key.act}"][data-board="${key.board}"]`) : key.id ? $(key.id) : null;
      if (back && back.offsetParent) back.focus({ preventScroll: true });
    }
  }

  // ---------------------------------------------------------- saving the count ---

  let queue = Promise.resolve();

  function parseQty(input) {
    const t = input.value.trim();
    if (t === "") return input.validity && input.validity.badInput ? NaN : null;
    if (!/^\d*(\.\d*)?$/.test(t) || t === ".") return NaN;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 && n <= QTY_MAX && Number.isInteger(n * 2) ? n : NaN;
  }

  function saveQty(input) {
    const boardId = Number(input.getAttribute("data-board"));
    const line = view && view.lines.find((l) => l.boardId === boardId);
    if (!line) return;
    const v = parseQty(input);
    if (Number.isNaN(v)) {
      input.setAttribute("aria-invalid", "true");
      setStatus(`Sheets of ${boardName(line)}: a number from 0 to ${QTY_MAX} in whole or half sheets (2.5, say), or empty.`, "err");
      return;
    }
    if (input.getAttribute("aria-invalid")) setStatus("", ""); // the sentence about it no longer applies
    input.removeAttribute("aria-invalid");
    if (qtyText(v) === input.dataset.saved) return;
    const forPeriod = period;
    queue = queue.then(async () => {
      if (forPeriod !== period) return;
      input.classList.add("bd-saving");
      try {
        await send("PUT", `/api/boards/counts/${period}/lines`, { lines: [{ boardId, qty: v }] });
        if (forPeriod !== period) return;
        input.dataset.saved = qtyText(v);
        const live = document.querySelector(`input.bd-qty[data-board="${boardId}"]`);
        if (live && live !== input) live.dataset.saved = input.dataset.saved; // the box was redrawn meanwhile
        line.qty = v;
        input.value = qtyText(v);
        input.closest("tr").classList.toggle("bd-row-done", v != null);
        setStatus(`Saved: ${boardName(line)}, ${v == null ? "cleared" : plural(v, "sheet", "sheets")}.`, "ok");
        renderState();
      } catch (e) {
        input.value = input.dataset.saved;
        setStatus(errText(e), "err");
        if (!(e instanceof TypeError)) await reload();
      } finally {
        input.classList.remove("bd-saving");
      }
    });
  }

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains("bd-qty")) saveQty(t);
  });

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.key !== "Enter" || !t || !t.classList) return;
    if (t.classList.contains("bd-qty")) {
      e.preventDefault();
      const all = [...document.querySelectorAll("#bdPanelCount input.bd-qty")];
      const i = all.indexOf(t);
      const next = all[e.shiftKey ? i - 1 : i + 1];
      if (next) { next.focus(); next.select(); } else t.blur();
    }
  });

  // --------------------------------------------------------------- actions ---

  async function finishCount() {
    await queue;
    const missing = view.lines.filter((l) => l.qty == null).length;
    const ok = await dialog({
      title: `Finish the board count for ${P.longLabel(period)}?`,
      note: (missing ? `${plural(missing, "board has", "boards have")} no quantity yet and won't be on this month's count. ` : "") +
        "Quantities can't change afterwards unless Ordering reopens the count.",
      submit: "Finish count",
      focus: missing ? "cancel" : null,
      run: async () => { await send("POST", `/api/boards/counts/${period}/counted`); },
    });
    if (!ok) return;
    setStatus(`The board count for ${P.longLabel(period)} is finished.`, "ok");
    await reload();
    $("bdTitle").focus({ preventScroll: true });
  }

  async function reopenCount() {
    const ok = await dialog({
      title: `Reopen the board count for ${P.longLabel(period)}?`,
      note: "The Workshop Manager can change the quantities again and finish the count again.",
      submit: "Reopen count",
      focus: "cancel",
      run: async () => { await send("POST", `/api/boards/counts/${period}/reopen-count`); },
    });
    if (!ok) return;
    setStatus(`The board count for ${P.longLabel(period)} is open again.`, "ok");
    tab = "count";
    await reload();
    $("bdTitle").focus({ preventScroll: true });
  }

  // --------------------------------------------------------------- the list ---

  async function loadList() {
    try {
      boards = (await api("/api/boards?all=1")).boards || [];
    } catch (e) {
      setStatus(errText(e), "err");
      return;
    }
    renderList();
  }

  function listButton(act, id, text, label, disabled) {
    return el("button", { type: "button", class: "hs-btn bd-mini", "data-list": act, "data-id": String(id), text, "aria-label": label, disabled: !!disabled });
  }

  function renderList() {
    const host = $("bdListBody");
    if (!boards.length) {
      host.replaceChildren(el("p", { class: "bd-empty", text: "No boards yet. Add the first one." }));
      return;
    }
    const num = (v) => el("span", { class: "bd-num", text: v == null ? "–" : qtyText(v) });
    const rows = boards.map((b, i) => el("tr", { class: b.active ? null : "bd-row-off" },
      el("td", { class: "bd-c-sup", text: b.supplier }),
      el("td", { class: "bd-c-thick", text: thick(b.thickness) }),
      el("td", { class: "bd-c-name" },
        el("span", { class: "bd-name", text: b.name }),
        isEdge(b) ? el("span", { class: "bd-meta", text: ["Edge tape", b.width != null ? b.width + " mm wide" : "", b.colour].filter(Boolean).join(" · ") }) : null,
        b.active ? null : el("span", { class: "hs-badge hs-badge-na bd-off", text: "Inactive" })),
      el("td", { class: "bd-c-finish", text: b.finish }),
      el("td", { class: "bd-c-thick" }, num(b.onHand)),
      el("td", { class: "bd-c-thick" }, num(b.reserved)),
      el("td", { class: "bd-c-thick" }, num(b.free)),
      canOrder() ? el("td", { class: "bd-c-price" }, b.priceCents == null ? el("span", { class: "bd-flag", text: "No price" }) : el("span", { class: "bd-num", text: money(b.priceCents) })) : null,
      el("td", { class: "bd-c-acts" }, el("div", { class: "bd-acts" },
        listButton("edit", b.id, "Edit", `Edit ${boardName(b)}`),
        listButton("up", b.id, "Up", `Move ${boardName(b)} up`, i === 0),
        listButton("down", b.id, "Down", `Move ${boardName(b)} down`, i === boards.length - 1),
        listButton(b.active ? "off" : "on", b.id, b.active ? "Deactivate" : "Activate", `${b.active ? "Deactivate" : "Activate"} ${boardName(b)}`)))));
    host.replaceChildren(el("div", { class: "bd-wrap" },
      el("table", { class: "bd-table bd-table-list" },
        el("thead", null, el("tr", null,
          ...[["Supplier", "bd-c-sup"], ["Thickness", "bd-c-thick"], ["Board or edge tape", "bd-c-name"], ["Finish", "bd-c-finish"], ["On hand", "bd-c-thick"], ["Reserved", "bd-c-thick"], ["Free", "bd-c-thick"]]
            .concat(canOrder() ? [["Price per sheet (ex GST)", "bd-c-price"]] : [])
            .map(([t, c]) => el("th", { scope: "col", class: c, text: t })),
          el("th", { scope: "col", class: "bd-c-acts" }, el("span", { class: "bd-sr", text: "Actions" })))),
        el("tbody", null, ...rows))));
  }

  function boardDialog(b) {
    const sup = el("input", { class: "hs-input", type: "text", maxlength: "100", autocomplete: "off", list: "bd-suppliers" });
    const dl = el("datalist", { id: "bd-suppliers" }, ...[...new Set((boards || []).map((x) => x.supplier).filter(Boolean))].map((s) => el("option", { value: s })));
    const th = el("input", { class: "hs-input bd-short", type: "number", min: "1", max: "1000", step: "1", inputmode: "numeric" });
    const name = el("input", { class: "hs-input", type: "text", maxlength: "200", autocomplete: "off" });
    const fin = el("input", { class: "hs-input", type: "text", maxlength: "100", autocomplete: "off" });
    const price = el("input", { class: "hs-input bd-short", type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "0.00" });
    const active = el("input", { type: "checkbox" });
    const kind = el("select", { class: "hs-input bd-short" }, el("option", { value: "board", text: "Board" }), el("option", { value: "edge", text: "Edge tape (rolls)" }));
    const width = el("input", { class: "hs-input bd-short", type: "number", min: "1", max: "1000", step: "1", inputmode: "numeric" });
    const colour = el("input", { class: "hs-input", type: "text", maxlength: "100", autocomplete: "off" });
    const onHand = el("input", { class: "hs-input bd-short", type: "number", min: "0", max: String(QTY_MAX), step: "0.5", inputmode: "decimal" });
    kind.value = b && b.kind ? b.kind : "board";
    width.value = b && b.width != null ? String(b.width) : "";
    colour.value = b ? b.colour || "" : "";
    onHand.value = b && b.onHand != null ? qtyText(b.onHand) : "";
    sup.value = b ? b.supplier : "";
    th.value = b && b.thickness != null ? String(b.thickness) : "";
    name.value = b ? b.name : "";
    fin.value = b ? b.finish : "";
    price.value = b && b.priceCents != null ? P.dollars(b.priceCents).replace("$", "") : "";
    active.checked = b ? b.active : true;
    const fields = [field("Kind", kind), field("Supplier (optional)", sup), dl, field("Thickness in mm (optional)", th), field("Name", name), field("Finish (optional)", fin),
      field("Width in mm (edge tape, optional)", width), field("Colour (optional)", colour),
      field("On hand (optional)", onHand, "Sheets (halves allowed) or whole rolls. The monthly count resets it to what was counted.")];
    if (canOrder()) fields.push(field("Price per sheet, ex GST (optional)", price, "Ordering keeps the prices; the Workshop Manager doesn't see them."));
    if (b) fields.push(checkField("Active (on the monthly count)", active));
    return dialog({
      title: b ? "Edit board" : "Add board",
      fields,
      submit: b ? "Save" : "Add board",
      run: async () => {
        if (th.validity && th.validity.badInput) throw new Error("The thickness must be whole millimetres from 1 to 1000, or empty.");
        const t = th.value.trim();
        const thickness = t === "" ? null : /^\d+$/.test(t) && +t >= 1 && +t <= 1000 ? +t : NaN;
        if (Number.isNaN(thickness)) throw new Error("The thickness must be whole millimetres from 1 to 1000, or empty.");
        const priceCents = P.parseDollars(price.value);
        if (Number.isNaN(priceCents) || (priceCents != null && priceCents < 0)) throw new Error("The price must be dollars and cents, such as 84.50, or empty.");
        const body = { kind: kind.value, supplier: sup.value.trim(), thickness, name: name.value.trim(), finish: fin.value.trim(), colour: colour.value.trim() };
        if (canOrder()) body.priceCents = priceCents;
        const w = width.value.trim();
        body.width = w === "" ? null : /^\d+$/.test(w) && +w >= 1 && +w <= 1000 ? +w : NaN;
        if (Number.isNaN(body.width)) throw new Error("The width must be whole millimetres from 1 to 1000, or empty.");
        const oh = onHand.value.trim();
        const ohN = oh === "" ? null : Number(oh);
        if (ohN != null && (!Number.isFinite(ohN) || ohN < 0 || ohN > QTY_MAX || !Number.isInteger(ohN * (kind.value === "edge" ? 1 : 2)))) {
          throw new Error(kind.value === "edge" ? "On hand for edge tape is whole rolls." : "On hand is whole or half sheets.");
        }
        if (!b || ohN !== (b.onHand == null ? null : b.onHand)) body.onHand = ohN;
        if (!body.name) throw new Error("Give the name.");
        if (b) {
          body.active = active.checked;
          await send("PATCH", `/api/boards/${b.id}`, body);
        } else {
          await send("POST", "/api/boards", body);
        }
      },
    });
  }

  async function afterListChange(focusSel) {
    await loadList();
    await loadMonth(true);
    if (focusSel) {
      const b = document.querySelector(focusSel);
      if (b && !b.disabled) b.focus();
      else $("bdAdd").focus();
    }
  }

  async function listAction(act, id) {
    const i = boards.findIndex((x) => x.id === id);
    const b = boards[i];
    if (!b) return;
    if (act === "edit") {
      if (await boardDialog(b)) {
        setStatus(`Saved: ${boardName(b)}.`, "ok");
        await afterListChange(`[data-list="edit"][data-id="${id}"]`);
      }
    } else if (act === "up" || act === "down") {
      const other = boards[act === "up" ? i - 1 : i + 1];
      if (!other) return;
      boards = (await send("POST", "/api/boards/reorder", { ids: act === "up" ? [b.id, other.id] : [other.id, b.id] })).boards;
      setStatus(`Moved ${boardName(b)} ${act}.`, "ok");
      renderList();
      await loadMonth(true);
      const btn = document.querySelector(`[data-list="${act}"][data-id="${id}"]`);
      if (btn && !btn.disabled) btn.focus();
      else { const e2 = document.querySelector(`[data-list="edit"][data-id="${id}"]`); if (e2) e2.focus(); }
    } else if (act === "off" || act === "on") {
      await send("PATCH", `/api/boards/${id}`, { active: act === "on" });
      setStatus(act === "on" ? `${boardName(b)} is back on the list.` : `${boardName(b)} is off the list; it no longer appears on new counts.`, "ok");
      await afterListChange(`[data-list="${act === "on" ? "off" : "on"}"][data-id="${id}"]`);
    }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-list]");
    if (!b) return;
    guardedRun(b, () => listAction(b.getAttribute("data-list"), Number(b.getAttribute("data-id"))));
  });

  // --------------------------------------------------------------- printing ---
  // The blank count sheet: every active board in list order, two columns per A4 page, the header
  // on every page, as the workbook's sheet.

  function printColumn(chunk) {
    return el("table", { class: "bd-p-table" },
      el("colgroup", null, ...["bd-pc-qty", "bd-pc-sup", "bd-pc-thick", "bd-pc-name", "bd-pc-finish"].map((c) => el("col", { class: c }))),
      el("thead", null, el("tr", null, ...["Qty", "Sup", "Thk", "Board", "Finish"].map((t) => el("th", { scope: "col", text: t })))),
      el("tbody", null, ...chunk.map((b) => el("tr", null,
        el("td", { class: "bd-p-box" }),
        el("td", { text: b.supplier }),
        el("td", { text: b.thickness == null ? "" : String(b.thickness) }),
        el("td", { class: "bd-p-strong", text: b.name }),
        el("td", { text: b.finish })))));
  }

  function blankSheet(list) {
    const active = list.filter((b) => b.active);
    const perPage = ROWS_PER_COLUMN * 2;
    const pages = Math.max(1, Math.ceil(active.length / perPage));
    const out = [];
    for (let p = 0; p < pages; p++) {
      const slice = active.slice(p * perPage, (p + 1) * perPage);
      const left = slice.slice(0, ROWS_PER_COLUMN);
      const right = slice.slice(ROWS_PER_COLUMN);
      out.push(el("section", { class: "bd-p-page" },
        el("div", { class: "bd-p-head" },
          el("div", null,
            el("h1", { class: "bd-p-h1", text: "Board stocktake" }),
            el("p", { class: "bd-p-sub", text: `${P.longLabel(period)}${pages > 1 ? ` · page ${p + 1} of ${pages}` : ""}` })),
          el("div", { class: "bd-p-signs" }, ...["Counted by", "Date"].map((t) =>
            el("div", { class: "bd-p-sign" }, el("span", { class: "bd-p-label", text: t }), el("span", { class: "bd-p-rule" }))))),
        active.length
          ? el("div", { class: "bd-p-cols" }, printColumn(left), right.length ? printColumn(right) : el("div"))
          : el("p", { class: "bd-p-empty", text: "No boards on the list." })));
    }
    return out;
  }

  let printed = false;
  let titleBefore = null;
  async function printBlank() {
    await queue;
    const list = (await api("/api/boards")).boards || [];
    $("bdPrint").replaceChildren(...blankSheet(list));
    if (titleBefore == null) titleBefore = document.title;
    document.title = `Board stocktake sheet ${P.longLabel(period)}`;
    printed = true;
    window.print();
  }
  window.addEventListener("beforeprint", () => {
    if (printed || !view) return;
    if (titleBefore == null) titleBefore = document.title;
    // Ctrl+P: the blank sheet from the month's boards (the open month lists every active board).
    $("bdPrint").replaceChildren(...blankSheet(boards || view.lines.map((l) => ({ ...l, active: true }))));
    document.title = `Board stocktake sheet ${P.longLabel(period)}`;
  });
  window.addEventListener("afterprint", () => {
    if (titleBefore != null) document.title = titleBefore;
    titleBefore = null;
    printed = false;
  });

  // ------------------------------------------------------------------ start ---

  $("bdPrev").addEventListener("click", () => goPeriod(P.addMonths(period, -1)));
  $("bdNext").addEventListener("click", () => goPeriod(P.addMonths(period, 1)));
  $("bdMonth").addEventListener("change", (e) => goPeriod(e.target.value));
  $("bdFinish").addEventListener("click", once(finishCount));
  $("bdReopenCount").addEventListener("click", once(reopenCount));
  $("bdPrintBlank").addEventListener("click", once(printBlank));
  $("bdAdd").addEventListener("click", once(async () => {
    if (!boards) await loadList();
    if (await boardDialog(null)) {
      setStatus("Board added.", "ok");
      await afterListChange();
    }
  }));
  for (const b of document.querySelectorAll(".bd-tab")) b.addEventListener("click", () => setTab(b.getAttribute("data-tab")));
  $("bdTabs").addEventListener("keydown", (e) => {
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
    const wanted = tab;
    tab = null;
    await loadMonth();
    setTab(wanted || "count");
  })();
})();
