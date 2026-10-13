// Board stocktake (/boards.html[?period=YYYY-MM][#count|#value|#list]): the monthly board count and
// its value (docs/plans/m11-contracts.md sections 8 and 11.4). The Workshop Manager types each
// board's quantity in whole or half sheets and finishes the count (stock.count), without prices.
// Ordering prices the boards, confirms the month's value and keeps the list (stock.order); an
// admin can reopen a confirmed month (users.admin). The server decides who may do what
// (lib/boards.js) and sends prices only to stock.order holders; cc.can() only hides controls.
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
    counted: ["Counted, value to confirm", "hs-badge-check"],
    valued: ["Value confirmed", "hs-badge-go"],
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
  const canAdmin = () => can("users.admin");

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

  function tabsAllowed() {
    const out = ["count"];
    if (canOrder() && view && view.status !== "open") out.push("value");
    if (canOrder()) out.push("list");
    return out;
  }

  function readUrl() {
    const q = new URLSearchParams(location.search);
    const p = q.get("period");
    period = P.validPeriod(p) && p <= currentPeriod() ? p : currentPeriod();
    const h = location.hash.replace(/^#/, "");
    tab = ["count", "value", "list"].includes(h) ? h : null;
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
      const word = st === "open" ? "counting" : st === "counted" ? "counted" : st === "valued" ? "valued" : "not started";
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
    for (const t of ["count", "value", "list"]) {
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
      text = `Counted by ${personName(view.counted.by)} on ${fmtStamp(view.counted.at)}.`;
      if (view.status === "valued") text += ` Value confirmed by ${personName(view.valued.by)} on ${fmtStamp(view.valued.at)}.`;
      else text += canOrder() ? " Ordering confirms the value." : " Ordering confirms the value next.";
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
      class: "hs-input bd-qty", type: "number", min: "0", max: String(QTY_MAX), step: "0.5", inputmode: "decimal",
      "data-board": String(l.boardId), "aria-label": `Sheets of ${boardName(l)}`,
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
    const note = $("bdCountNote");
    if (!isOpen()) {
      note.hidden = false;
      note.textContent = "The count is finished." + (view.status === "counted" && canOrder() ? " Reopen it on the Value tab to change a quantity." : view.status === "counted" ? " Ask Ordering to reopen it if a quantity needs to change." : "");
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

  // The adjustment typed on screen (cents), or NaN when it doesn't read as dollars.
  function typedAdjustment() {
    const v = P.parseDollars($("bdAdj").value);
    return v === null ? 0 : v;
  }

  function renderValue() {
    if (!canOrder() || isOpen()) return;
    const valued = view.status === "valued";
    $("bdReopenCount").hidden = view.status !== "counted";
    $("bdReopen").hidden = !(valued && canAdmin());
    $("bdValueNote").textContent = valued
      ? "The value is confirmed: these prices are frozen as they were then."
      : "Worked out from today's prices. Confirming freezes them and sends the value to Accounts.";
    const unpriced = view.lines.filter((l) => l.qty > 0 && l.priceCents == null);
    $("bdUnpriced").hidden = valued || !unpriced.length;
    $("bdUnpricedText").textContent = `${plural(unpriced.length, "counted board has", "counted boards have")} no price. Set each one below (per sheet, ex GST) before confirming the value.`;

    const rows = view.lines.map((l) => {
      const missing = l.priceCents == null;
      let price;
      if (!missing) price = el("span", { class: "bd-num", text: money(l.priceCents) });
      else if (valued) price = el("span", { class: "bd-none", text: "–" });
      else {
        const input = el("input", { class: "hs-input bd-money bd-price-in", type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "0.00", "aria-label": `Price per sheet of ${boardName(l)}` });
        price = el("div", { class: "bd-setprice" },
          l.qty > 0 ? el("span", { class: "bd-flag", text: "No price" }) : null,
          input,
          el("button", { type: "button", class: "hs-btn bd-mini", "data-act": "price", "data-board": String(l.boardId), text: "Set price", "aria-label": `Set the price of ${boardName(l)}` }));
      }
      return el("tr", { class: missing && l.qty > 0 && !valued ? "bd-row-flag" : null },
        el("td", { class: "bd-c-sup", text: l.supplier }),
        el("td", { class: "bd-c-thick", text: thick(l.thickness) }),
        nameCell(l),
        el("td", { class: "bd-c-finish", text: l.finish }),
        el("td", { class: "bd-c-qty" }, el("span", { class: "bd-num", text: qtyText(l.qty) })),
        el("td", { class: "bd-c-price" }, price),
        el("td", { class: "bd-c-amt" }, el("span", { class: "bd-num", text: l.lineCents == null ? "" : money(l.lineCents) })));
    });
    const adj = valued ? view.adjustmentCents : typedAdjustment();
    const total = Number.isNaN(adj) ? null : view.subtotalCents + adj;
    const foot = el("tfoot", null,
      el("tr", null, el("th", { scope: "row", colspan: "6", class: "bd-f-label", text: "Subtotal" }), el("td", { class: "bd-c-amt" }, el("span", { class: "bd-num", text: money(view.subtotalCents) }))),
      el("tr", null,
        el("th", { scope: "row", colspan: "6", class: "bd-f-label" }, "Adjustment",
          valued && view.adjustmentNote ? el("span", { class: "bd-f-note", text: view.adjustmentNote }) : null),
        el("td", { class: "bd-c-amt" }, el("span", { class: "bd-num", id: "bdAdjOut", text: Number.isNaN(adj) ? "?" : money(adj) }))),
      el("tr", { class: "bd-f-total" },
        el("th", { scope: "row", colspan: "6", class: "bd-f-label", text: valued ? "Board stock value (ex GST)" : "Value if confirmed now (ex GST)" }),
        el("td", { class: "bd-c-amt" }, el("span", { class: "bd-num", id: "bdTotalOut", text: total == null ? "?" : money(total) }))));
    $("bdValueBody").replaceChildren(el("div", { class: "bd-wrap" },
      el("table", { class: "bd-table bd-table-value" },
        head([["Supplier", "bd-c-sup"], ["Thickness", "bd-c-thick"], ["Board", "bd-c-name"], ["Finish", "bd-c-finish"], ["Sheets", "bd-c-qty"], ["Price per sheet", "bd-c-price"], ["Amount", "bd-c-amt"]]),
        el("tbody", null, ...rows),
        foot)));
    const form = $("bdConfirm");
    form.hidden = valued;
    if (!valued) {
      $("bdConfirmBtn").disabled = unpriced.length > 0;
      $("bdConfirmBtn").title = unpriced.length ? "Set the missing prices first" : "";
    }
  }

  function updateTotal() {
    const adj = typedAdjustment();
    const a = $("bdAdjOut");
    const t = $("bdTotalOut");
    if (a) a.textContent = Number.isNaN(adj) ? "?" : money(adj);
    if (t) t.textContent = Number.isNaN(adj) ? "?" : money(view.subtotalCents + adj);
  }

  function render() {
    if (!view) return;
    renderPicker();
    renderState();
    renderCount();
    renderValue();
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
    const fresh = !view || view.period !== v.period || view.status !== v.status;
    view = v;
    months = m.months || [];
    if (!quiet) setStatus("", "");
    if (fresh && view.status === "counted") {
      // A counted month's adjustment, ready to confirm (kept after an admin reopens it).
      $("bdAdj").value = view.adjustmentCents ? P.dollars(view.adjustmentCents).replace("$", "") : "";
      $("bdAdjNote").value = view.adjustmentNote || "";
      $("bdConfirmErr").textContent = "";
    }
    render();
    if (tab) setTab(tab); // the Value tab comes and goes with the count
    return true;
  }

  async function reload() {
    const a = document.activeElement;
    const key = a && a !== document.body ? { act: a.getAttribute("data-act"), board: a.getAttribute("data-board"), id: a.id } : null;
    const status = $("bdStatus").textContent;
    const kind = ($("bdStatus").className.match(/bd-status-(\w+)/) || [])[1] || "";
    await loadMonth();
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
    } else if (t.classList.contains("bd-price-in")) {
      e.preventDefault();
      const b = t.parentElement.querySelector("button[data-act='price']");
      if (b) b.click();
    }
  });

  // --------------------------------------------------------------- actions ---

  async function finishCount() {
    await queue;
    const missing = view.lines.filter((l) => l.qty == null).length;
    const ok = await dialog({
      title: `Finish the board count for ${P.longLabel(period)}?`,
      note: (missing ? `${plural(missing, "board has", "boards have")} no quantity yet and won't be on this month's count. ` : "") +
        "Ordering is told the count is done, to confirm the value. Quantities can't change afterwards unless Ordering reopens the count.",
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

  async function reopenValued() {
    const ok = await dialog({
      title: `Reopen the value for ${P.longLabel(period)}?`,
      note: "The frozen prices and value are cleared, and Accounts sees \"Waiting for the value\" until it's confirmed again. The count stays finished.",
      submit: "Reopen",
      submitClass: "hs-btn-stop",
      focus: "cancel",
      run: async () => { await send("POST", `/api/boards/counts/${period}/reopen`); },
    });
    if (!ok) return;
    setStatus(`The value for ${P.longLabel(period)} is open again.`, "ok");
    await reload();
    $("bdTitle").focus({ preventScroll: true });
  }

  async function confirmValue(e) {
    e.preventDefault();
    const err = $("bdConfirmErr");
    err.textContent = "";
    const adj = typedAdjustment();
    const note = $("bdAdjNote").value.trim();
    if (Number.isNaN(adj)) {
      err.textContent = "The adjustment must be dollars and cents, such as -125.50.";
      $("bdAdj").focus();
      return;
    }
    if (adj !== 0 && !note) {
      err.textContent = "Give a note for the adjustment.";
      $("bdAdjNote").focus();
      return;
    }
    const total = view.subtotalCents + adj;
    const ok = await dialog({
      title: `Confirm the board stock value for ${P.longLabel(period)}?`,
      note: `${money(total)} ex GST${adj ? ` (including an adjustment of ${money(adj)})` : ""}. Each board's price is frozen as it is now, and Accounts sees the value on Stock value.`,
      submit: "Confirm value",
      run: async () => { await send("POST", `/api/boards/counts/${period}/value`, { adjustmentCents: adj, adjustmentNote: note }); },
    });
    if (!ok) return;
    setStatus(`The board stock value for ${P.longLabel(period)} is confirmed: ${money(total)}.`, "ok");
    await reload();
    $("bdTitle").focus({ preventScroll: true });
  }

  async function setPrice(btn) {
    const boardId = Number(btn.getAttribute("data-board"));
    const line = view.lines.find((l) => l.boardId === boardId);
    const input = btn.parentElement.querySelector("input");
    const cents = P.parseDollars(input.value);
    if (cents === null || Number.isNaN(cents) || cents < 0) {
      input.setAttribute("aria-invalid", "true");
      setStatus(`The price of ${boardName(line)} must be dollars and cents per sheet, such as 84.50.`, "err");
      input.focus();
      return;
    }
    input.removeAttribute("aria-invalid");
    await send("PATCH", `/api/boards/${boardId}`, { priceCents: cents });
    if (boards) boards = null; // the List tab reloads its prices
    setStatus(`Price set: ${boardName(line)}, ${money(cents)} a sheet.`, "ok");
    await reload();
    // Focus: the next missing price, or the Confirm button.
    const next = document.querySelector("#bdValueBody .bd-price-in");
    if (next) next.focus();
    else if (!$("bdConfirmBtn").disabled) $("bdConfirmBtn").focus();
    else $("bdTitle").focus({ preventScroll: true });
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-act='price']");
    if (b) guardedRun(b, () => setPrice(b));
  });

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
    const rows = boards.map((b, i) => el("tr", { class: b.active ? null : "bd-row-off" },
      el("td", { class: "bd-c-sup", text: b.supplier }),
      el("td", { class: "bd-c-thick", text: thick(b.thickness) }),
      el("td", { class: "bd-c-name" },
        el("span", { class: "bd-name", text: b.name }),
        b.active ? null : el("span", { class: "hs-badge hs-badge-na bd-off", text: "Inactive" })),
      el("td", { class: "bd-c-finish", text: b.finish }),
      el("td", { class: "bd-c-price" }, b.priceCents == null ? el("span", { class: "bd-flag", text: "No price" }) : el("span", { class: "bd-num", text: money(b.priceCents) })),
      el("td", { class: "bd-c-acts" }, el("div", { class: "bd-acts" },
        listButton("edit", b.id, "Edit", `Edit ${boardName(b)}`),
        listButton("up", b.id, "Up", `Move ${boardName(b)} up`, i === 0),
        listButton("down", b.id, "Down", `Move ${boardName(b)} down`, i === boards.length - 1),
        listButton(b.active ? "off" : "on", b.id, b.active ? "Deactivate" : "Activate", `${b.active ? "Deactivate" : "Activate"} ${boardName(b)}`)))));
    host.replaceChildren(el("div", { class: "bd-wrap" },
      el("table", { class: "bd-table bd-table-list" },
        el("thead", null, el("tr", null,
          ...[["Supplier", "bd-c-sup"], ["Thickness", "bd-c-thick"], ["Board", "bd-c-name"], ["Finish", "bd-c-finish"], ["Price per sheet (ex GST)", "bd-c-price"]].map(([t, c]) => el("th", { scope: "col", class: c, text: t })),
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
    sup.value = b ? b.supplier : "";
    th.value = b && b.thickness != null ? String(b.thickness) : "";
    name.value = b ? b.name : "";
    fin.value = b ? b.finish : "";
    price.value = b && b.priceCents != null ? P.dollars(b.priceCents).replace("$", "") : "";
    active.checked = b ? b.active : true;
    const fields = [field("Supplier (optional)", sup), dl, field("Thickness in mm (optional)", th), field("Board", name), field("Finish (optional)", fin),
      field("Price per sheet, ex GST (optional)", price, "Ordering keeps the prices; the Workshop Manager doesn't see them.")];
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
        const body = { supplier: sup.value.trim(), thickness, name: name.value.trim(), finish: fin.value.trim(), priceCents };
        if (!body.name) throw new Error("Give the board's name.");
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
  $("bdReopen").addEventListener("click", once(reopenValued));
  $("bdPrintBlank").addEventListener("click", once(printBlank));
  $("bdConfirm").addEventListener("submit", once(confirmValue));
  $("bdAdj").addEventListener("input", updateTotal);
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
    // Ordering lands on Value once the count is finished, everyone else on Count.
    setTab(wanted || (canOrder() && view && view.status !== "open" ? "value" : "count"));
  })();
})();
