// Drawer order (/drawers.html, stock.order): docs/plans/m11-contracts.md sections 4.3, 6.1, 6.2 and
// 11.2. Five tabs, kept in the hash: EDGE and DTC (each brand's checked drawer lines still to order,
// added up as the workbook's sheet, with the stock row typed in, Print and Mark ordered, and the
// lines waiting for the Design/PM check), Placed (each placed order's frozen sheet, Print again,
// Undo and Stock received), Names (the drawer name list, and the names from Joinr not on it) and
// Settings (the two supplier names).
//
// The sizes come from drawers.js (window.Drawers). The server decides who may do what
// (lib/drawers.js); cc.can() only hides what a user can't use. Every value goes in as text.
// Page classes are prefixed dw- (drawerspage.css).
(function () {
  "use strict";

  const D = window.Drawers;
  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const TABS = ["edge", "dtc", "placed", "names", "settings"];
  const SECTION_LABEL = { drawers: "Drawers", innerDrawers: "Inner drawers" };
  const NAME_MAX = 200;
  const SUPPLIER_MAX = 200;
  const NOTE_MAX = 500;

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

  function validDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }

  // "14 Oct 2026"
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  // A UTC timestamp as its Sydney date, "14 Oct 2026".
  function fmtStamp(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    return fmtDate(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(t)));
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  function brandLabel(id) {
    const b = D.brand(id);
    return b ? b.label : String(id || "").toUpperCase();
  }

  function heightLabel(brandId, mm) {
    const b = D.brand(brandId);
    const h = b && b.heights.find((x) => x.mm === mm);
    return h ? h.label : String(mm);
  }

  // "6 × Mid 126/500, 4 × High 174/500" (describe() without its "Drawers (EDGE): " head).
  function countsText(brandId, counts) {
    if (!counts || !counts.length) return "";
    const s = D.describe(brandId, counts);
    const at = s.indexOf(": ");
    return at === -1 ? s : s.slice(at + 2);
  }

  function sizeText(brandId, height, length) {
    return `${brandLabel(brandId)} ${heightLabel(brandId, height)} / ${length}`;
  }

  function jobNode(jobId, jobName, cls) {
    if (!can("jobs.view") || jobId == null) return el("span", { class: cls || "dw-job", text: jobName || "" });
    return el("a", { class: cls || "dw-job", href: "/job.html?id=" + encodeURIComponent(jobId) + "#orders", text: jobName || "" });
  }

  function setStatus(text, kind) {
    const s = $("dwStatus");
    s.textContent = text || "";
    s.className = "dw-status" + (kind ? " dw-status-" + kind : "");
  }

  function errText(e) {
    return e instanceof TypeError ? "Couldn't reach the server. Try again." : (e && e.message) || "That didn't work. Try again.";
  }

  // api() with a server's refusal marked, so a dialog can tell it from its own sentences.
  async function send(path, method, body) {
    try {
      return await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      if (e instanceof TypeError) throw new Error("Couldn't reach the server. Try again.");
      if (e && typeof e === "object") e.refused = true;
      throw e;
    }
  }

  function focusNode(n) {
    if (!n || !n.isConnected) return false;
    n.focus();
    return document.activeElement === n;
  }

  // ------------------------------------------------------------------ dialogs ---
  // A modal on the shell's cc-dialog frame, as OrderUI's: spec {title, note, fields, hint, submit,
  // submitClass, cancel, focus ("cancel" or a node), wide, run}. run() returns the response to
  // resolve with, undefined to close with null, or throws a sentence (marked `refused` when the
  // server said no). Resolves the response, {refused: true} when closed after a refusal, or null.
  let openDlg = null;

  function dialog(spec) {
    if (openDlg) openDlg.dismiss();
    const opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    return new Promise((resolve) => {
      let result = null;
      let refused = false;
      let busy = false;
      const uid = Math.random().toString(36).slice(2, 8);
      const titleId = "dw-dt-" + uid;
      const noteId = "dw-dn-" + uid;
      const err = el("p", { class: "cc-dialog-error dw-dlg-error", role: "alert" });
      const cancel = el("button", { type: "button", class: "hs-btn", text: spec.cancel || "Cancel" });
      const go = el("button", { type: "submit", class: "hs-btn " + (spec.submitClass || "hs-btn-primary"), text: spec.submit });
      const form = el("form", { class: "cc-dialog-form dw-dlg-form", method: "dialog", novalidate: true },
        el("h2", { class: "cc-dialog-title", id: titleId, text: spec.title }),
        spec.note ? el("p", { class: "cc-dialog-note dw-dlg-note", id: noteId, text: spec.note }) : null,
        ...(spec.fields || []),
        spec.hint ? el("p", { class: "cc-dialog-note", text: spec.hint }) : null,
        err,
        el("div", { class: "cc-dialog-actions" }, cancel, go));
      const dlg = el("dialog", { class: "cc-dialog dw-dlg" + (spec.wide ? " dw-dlg-wide" : ""), "aria-labelledby": titleId,
        "aria-describedby": spec.note ? noteId : null }, form);
      document.body.append(dlg);
      const start = spec.focus === "cancel" ? cancel : spec.focus || go;
      const me = { dismiss: () => dlg.open && dlg.close() };
      openDlg = me;

      function setBusy(on) {
        busy = on;
        for (const n of form.querySelectorAll("button, input, textarea, select")) {
          if (on) {
            n.dataset.dwWas = n.disabled ? "1" : "";
            n.disabled = true;
          } else {
            n.disabled = n.dataset.dwWas === "1";
          }
        }
      }

      cancel.addEventListener("click", () => dlg.close());
      dlg.addEventListener("mousedown", (e) => {
        if (e.target === dlg && !busy) dlg.close();
      });
      dlg.addEventListener("cancel", (e) => {
        if (busy) e.preventDefault();
      });
      dlg.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const stops = [...dlg.querySelectorAll("button, input, textarea, select, a[href], [tabindex]:not([tabindex='-1'])")]
          .filter((n) => !n.disabled && n.offsetParent !== null);
        if (!stops.length) return;
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (e.shiftKey && (document.activeElement === first || !dlg.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !dlg.contains(document.activeElement))) {
          e.preventDefault();
          first.focus();
        }
      });
      dlg.addEventListener("close", () => {
        if (openDlg === me) openDlg = null;
        dlg.remove();
        if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
        resolve(result !== null ? result : refused ? { refused: true } : null);
      });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (busy) return;
        err.textContent = "";
        setBusy(true);
        try {
          const r = await spec.run();
          result = r === undefined ? null : r;
          setBusy(false);
          dlg.close();
        } catch (ex) {
          setBusy(false);
          if (ex && ex.refused) refused = true;
          err.textContent = (ex && ex.message) || "That didn't save. Try again.";
          if (ex && ex.reload) {
            // The sheet changed under the dialog: the only way on is to look at it again.
            cancel.textContent = "Reload the order";
            go.disabled = true;
            cancel.focus();
            return;
          }
          const back = ex && ex.focus ? ex.focus : start;
          if (back && typeof back.focus === "function") back.focus();
        }
      });
      dlg.showModal();
      start.focus();
    });
  }

  function fieldBox(label, input, hint) {
    const id = "dw-f-" + Math.random().toString(36).slice(2, 8);
    input.id = id;
    const box = el("div", { class: "cc-field dw-dlg-field" }, el("label", { class: "cc-field-label", for: id, text: label }), input);
    if (hint) {
      const hid = id + "-h";
      box.append(el("span", { class: "dw-dlg-hint", id: hid, text: hint }));
      input.setAttribute("aria-describedby", hid);
    }
    return box;
  }

  function dateInput(value, min, max) {
    const n = el("input", { class: "hs-input dw-date", type: "date", min: min || null, max: max || null });
    n.value = value || "";
    return n;
  }

  function sentence(msg, focus) {
    const e = new Error(msg);
    if (focus) e.focus = focus;
    return e;
  }

  // ------------------------------------------------------------- the sheet ---
  // The workbook's sheet (section 4.3): one block per height with the seven lengths across, a row
  // per job, then Stock, then the block's totals; the grand total under it. `sheet` is
  // {brand, rows: [{orderId, jobId, jobName, notes?, counts}], stock, totals, total}. With
  // `stockInputs`, the Stock row is number inputs (the brand tab); otherwise plain numbers.

  function cellMap(counts) {
    const m = {};
    for (const c of counts || []) m[c.height + "x" + c.length] = c.qty;
    return m;
  }

  function sumHeight(counts, height) {
    let n = 0;
    for (const c of counts || []) if (c.height === height) n += c.qty;
    return n;
  }

  function numCell(v, cls) {
    return el("td", { class: "dw-n" + (cls ? " " + cls : "") }, v ? document.createTextNode(String(v)) : null);
  }

  function sheetTable(sheet, opts) {
    const o = opts || {};
    const b = D.brand(sheet.brand);
    const lengths = D.LENGTHS;
    const table = el("table", { class: "dw-sheet" });
    table.append(el("colgroup", null, el("col", { class: "dw-col-job" }), ...lengths.map(() => el("col", { class: "dw-col-n" })),
      el("col", { class: "dw-col-tot" })));
    table.append(el("thead", null, el("tr", null,
      el("th", { scope: "col", class: "dw-th-job", text: "Job" }),
      ...lengths.map((l) => el("th", { scope: "col", class: "dw-n", text: String(l) })),
      el("th", { scope: "col", class: "dw-n dw-tot", text: "Total" }))));
    const stock = cellMap(sheet.stock);
    const totals = cellMap(sheet.totals);
    for (const h of b.heights) {
      const tb = el("tbody", { class: "dw-block" });
      const hid = "dw-h-" + sheet.brand + "-" + h.mm + (o.idSuffix || "");
      tb.append(el("tr", { class: "dw-blockhead" }, el("th", { scope: "rowgroup", colspan: String(lengths.length + 2), id: hid, text: h.label })));
      for (const r of sheet.rows || []) {
        const m = cellMap(r.counts);
        const rowTotal = sumHeight(r.counts, h.mm);
        if (!rowTotal) continue;
        tb.append(el("tr", { class: "dw-jobrow" },
          el("th", { scope: "row", class: "dw-th-job" }, jobNode(r.jobId, r.jobName),
            r.notes && o.notes ? el("span", { class: "dw-rownote", text: r.notes }) : null),
          ...lengths.map((l) => numCell(m[h.mm + "x" + l])),
          numCell(rowTotal, "dw-tot")));
      }
      const stockRow = el("tr", { class: "dw-stockrow" }, el("th", { scope: "row", class: "dw-th-job", text: "Stock" }));
      for (const l of lengths) {
        const key = h.mm + "x" + l;
        if (o.stockInputs) {
          const inp = el("input", {
            class: "hs-input dw-qty", type: "number", min: "0", max: String(D.QTY_MAX), step: "1", inputmode: "numeric",
            "data-key": key, "data-h": String(h.mm), "data-l": String(l),
            "aria-label": `Stock, ${h.label}, ${l} mm`,
          });
          inp.value = stock[key] ? String(stock[key]) : "";
          stockRow.append(el("td", { class: "dw-n dw-in" }, inp));
        } else {
          stockRow.append(numCell(stock[key]));
        }
      }
      stockRow.append(el("td", { class: "dw-n dw-tot", "data-stocktot": String(h.mm) },
        sumHeight(sheet.stock, h.mm) ? document.createTextNode(String(sumHeight(sheet.stock, h.mm))) : null));
      tb.append(stockRow);
      const totRow = el("tr", { class: "dw-totrow" }, el("th", { scope: "row", class: "dw-th-job", text: "Total " + h.label }));
      for (const l of lengths) totRow.append(el("td", { class: "dw-n", "data-tot": h.mm + "x" + l },
        totals[h.mm + "x" + l] ? document.createTextNode(String(totals[h.mm + "x" + l])) : null));
      const ht = sumHeight(sheet.totals, h.mm);
      totRow.append(el("td", { class: "dw-n dw-tot", "data-htot": String(h.mm) }, ht ? document.createTextNode(String(ht)) : null));
      tb.append(totRow);
      table.append(tb);
    }
    return table;
  }

  // ------------------------------------------------------------- brand tabs ---
  const boards = {}; // brand -> GET /api/drawers?brand= response
  const loadSeq = {};

  async function loadBrand(brand) {
    const mine = (loadSeq[brand] = (loadSeq[brand] || 0) + 1);
    let d;
    try {
      d = await api("/api/drawers?brand=" + encodeURIComponent(brand));
    } catch (e) {
      if (mine === loadSeq[brand]) setStatus(e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message, "err");
      return false;
    }
    if (mine !== loadSeq[brand]) return false;
    boards[brand] = d;
    if (tab === brand) renderBrand(brand);
    return true;
  }

  function renderBrand(brand) {
    const panel = $("dwPanel-" + brand);
    const d = boards[brand];
    if (!d) {
      panel.replaceChildren(el("p", { class: "dw-empty", text: "Loading..." }));
      return;
    }
    const label = brandLabel(brand);
    const jobs = d.rows.length;
    const stockTotal = D.total(d.stock);
    const summary = el("p", { class: "dw-summary" },
      el("span", { class: "dw-sumitem" }, el("span", { class: "dw-label", text: "Supplier" }), el("b", { text: d.supplier })),
      el("span", { class: "dw-sumitem" }, el("span", { class: "dw-label", text: "Jobs" }), el("b", { text: String(jobs) })),
      el("span", { class: "dw-sumitem" }, el("span", { class: "dw-label", text: "Drawers" }), el("b", { id: "dwGrand-" + brand, text: String(d.total) })));
    const tools = el("div", { class: "dw-tools" });
    const print = el("button", { type: "button", class: "hs-btn", "data-act": "print", "data-brand": brand, text: "Print",
      "aria-label": `Print the ${label} sheet` });
    tools.append(print);
    if (can("orders.mark_ordered")) {
      const mark = el("button", { type: "button", class: "hs-btn hs-btn-primary", "data-act": "place", "data-brand": brand,
        text: "Mark ordered", "aria-label": `Mark the ${label} drawer order ordered` });
      if (!jobs && !stockTotal) mark.disabled = true;
      tools.append(mark);
    }
    const top = el("div", { class: "dw-bar" }, summary, tools);

    const sheetSec = el("section", { class: "dw-group", "aria-labelledby": "dwSheetH-" + brand },
      el("div", { class: "hs-sectionbar dw-sbar" },
        el("h2", { id: "dwSheetH-" + brand, tabindex: "-1" }, `${label} sheet `, el("span", { class: "dw-count", text: String(jobs) })),
        el("span", { class: "dw-sbar-note", text: "Checked lines and the stock row" })),
      jobs ? null : el("p", { class: "dw-note", text: "No checked drawer lines to order. Type a stock row to order drawers for the shelf." }),
      el("div", { class: "dw-wrap" }, sheetTable({ brand, rows: d.rows, stock: d.stock, totals: d.totals, total: d.total },
        { stockInputs: true, notes: true })),
      el("p", { class: "dw-foot" }, "Total drawers ", el("b", { id: "dwFoot-" + brand, text: String(d.total) }),
        el("span", { class: "dw-foot-note", text: " · Type stock counts in the Stock rows; each is saved as you leave the box." })));

    const waitSec = el("section", { class: "dw-group", "aria-labelledby": "dwWaitH-" + brand },
      el("div", { class: "hs-sectionbar dw-sbar" + (d.waiting.length ? " hs-sectionbar-orange" : "") },
        el("h2", { id: "dwWaitH-" + brand, tabindex: "-1" }, "Waiting for Design/PM check ",
          el("span", { class: "dw-count" + (d.waiting.length ? " dw-count-check" : ""), text: String(d.waiting.length) })),
        el("span", { class: "dw-sbar-note", text: "Not in the totals until checked" })));
    if (!d.waiting.length) {
      waitSec.append(el("p", { class: "dw-empty", text: "Nothing waiting." }));
    } else {
      const tb = el("tbody", null, ...d.waiting.map((w) => el("tr", null,
        el("td", { class: "dw-c-job", "data-label": "Job" }, el("div", null, jobNode(w.jobId, w.jobName),
          w.notes ? el("span", { class: "dw-rownote", text: w.notes }) : null)),
        el("td", { class: "dw-c-desc", "data-label": "Drawers", text: countsText(brand, w.counts) }),
        el("td", { class: "dw-c-num", "data-label": "Total", text: String(w.total) }),
        el("td", { class: "dw-c-src", "data-label": "From", text: w.source === "joinr" ? "Joinr" : "Typed in" }))));
      waitSec.append(el("div", { class: "dw-wrap" }, el("table", { class: "dw-table dw-table-wait" },
        el("thead", null, el("tr", null, ...[["Job", "dw-c-job"], ["Drawers", "dw-c-desc"], ["Total", "dw-c-num"], ["From", "dw-c-src"]]
          .map(([t, c]) => el("th", { scope: "col", class: c, text: t })))), tb)));
    }
    const keep = document.activeElement && panel.contains(document.activeElement) ? document.activeElement : null;
    const keepKey = keep ? { key: keep.getAttribute("data-key"), act: keep.getAttribute("data-act") } : null;
    panel.replaceChildren(top, sheetSec, waitSec);
    if (keepKey) {
      const back = keepKey.key ? panel.querySelector(`input[data-key="${keepKey.key}"]`)
        : keepKey.act ? panel.querySelector(`button[data-act="${keepKey.act}"]`) : null;
      if (back) back.focus({ preventScroll: true });
    }
  }

  // The stock row: each change is checked here, then the whole row is saved (one save at a time;
  // a change made while one is out is sent after it). The totals are updated in place, so what
  // the user is typing in another box stays.
  const stockSaving = {};
  const stockAgain = {};

  function stockInputs(brand) {
    return [...$("dwPanel-" + brand).querySelectorAll("input.dw-qty")];
  }

  function readStock(brand) {
    const out = [];
    for (const inp of stockInputs(brand)) {
      const raw = inp.value.trim();
      if (raw === "") {
        inp.removeAttribute("aria-invalid");
        continue;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > D.QTY_MAX) {
        inp.setAttribute("aria-invalid", "true");
        return { bad: inp };
      }
      inp.removeAttribute("aria-invalid");
      if (n > 0) out.push({ height: Number(inp.getAttribute("data-h")), length: Number(inp.getAttribute("data-l")), qty: n });
    }
    return { counts: out };
  }

  function applyTotals(brand, d) {
    const panel = $("dwPanel-" + brand);
    const tot = cellMap(d.totals);
    for (const td of panel.querySelectorAll("td[data-tot]")) {
      const v = tot[td.getAttribute("data-tot")];
      td.textContent = v ? String(v) : "";
    }
    for (const td of panel.querySelectorAll("td[data-htot]")) {
      const v = sumHeight(d.totals, Number(td.getAttribute("data-htot")));
      td.textContent = v ? String(v) : "";
    }
    for (const td of panel.querySelectorAll("td[data-stocktot]")) {
      const v = sumHeight(d.stock, Number(td.getAttribute("data-stocktot")));
      td.textContent = v ? String(v) : "";
    }
    for (const id of ["dwGrand-" + brand, "dwFoot-" + brand]) if ($(id)) $(id).textContent = String(d.total);
    const mark = panel.querySelector('button[data-act="place"]');
    if (mark) mark.disabled = !d.rows.length && !D.total(d.stock);
  }

  async function saveStock(brand) {
    if (stockSaving[brand]) {
      stockAgain[brand] = true;
      return stockSaving[brand];
    }
    const read = readStock(brand);
    if (read.bad) {
      setStatus(`Each stock count is a whole number from 0 to ${D.QTY_MAX}.`, "err");
      return false;
    }
    const before = JSON.stringify((boards[brand] && boards[brand].stock) || []);
    if (JSON.stringify(D.sorted(brand, read.counts)) === before) return true;
    setStatus("Saving the stock row...", "");
    stockSaving[brand] = (async () => {
      try {
        const d = await send("/api/drawers/stock", "PUT", { brand, counts: read.counts });
        boards[brand] = d;
        if (tab === brand) applyTotals(brand, d);
        setStatus(`${brandLabel(brand)} stock row saved.`, "ok");
        return true;
      } catch (e) {
        setStatus("The stock row didn't save: " + errText(e), "err");
        return false;
      } finally {
        stockSaving[brand] = null;
        if (stockAgain[brand]) {
          stockAgain[brand] = false;
          saveStock(brand);
        }
      }
    })();
    return stockSaving[brand];
  }

  async function flushStock(brand) {
    while (stockSaving[brand]) await stockSaving[brand];
    return saveStock(brand);
  }

  async function place(brand, opener) {
    if (!(await flushStock(brand))) return;
    if (!(await loadBrand(brand))) return;
    const d = boards[brand];
    const label = brandLabel(brand);
    const stockTotal = D.total(d.stock);
    if (!d.rows.length && !stockTotal) {
      setStatus("Nothing to order on the " + label + " sheet.", "err");
      return;
    }
    const today = todayISO();
    const od = dateInput(today, null, today);
    const ex = dateInput("", today, null);
    od.addEventListener("input", () => { ex.min = validDate(od.value) ? od.value : today; });
    const list = el("ul", { class: "dw-dlg-list" },
      ...d.rows.map((r) => el("li", null, el("b", { text: r.jobName }), document.createTextNode(` (${plural(D.total(r.counts), "drawer", "drawers")})`))));
    if (stockTotal) list.append(el("li", null, el("b", { text: "Stock row" }), document.createTextNode(` (${plural(stockTotal, "drawer", "drawers")})`)));
    const fields = [
      el("div", { class: "dw-dlg-row" }, fieldBox("Ordered", od), fieldBox("Expected", ex, "Optional. Goes on each job's line, so it shows on Deliveries.")),
      el("div", { class: "dw-dlg-sub" }, el("span", { class: "cc-field-label", text: d.rows.length ? "These jobs' drawer lines are marked ordered" : "Only the stock row is ordered" }), list),
    ];
    const r = await dialog({
      title: `Mark the ${label} order ordered`,
      note: `${plural(d.total, "drawer", "drawers")} from ${d.supplier}.`,
      fields,
      hint: d.rows.length ? "When this is a job's last line to order, its progress invoice falls due." : null,
      submit: "Mark ordered",
      wide: true,
      focus: od,
      run: () => {
        if (!validDate(od.value)) throw sentence("Choose the date it was ordered", od);
        if (od.value > today) throw sentence("The ordered date can't be in the future", od);
        if (ex.value && !validDate(ex.value)) throw sentence("That expected date isn't a whole date", ex);
        return send("/api/drawers/place", "POST", {
          brand, orderedDate: od.value, expectedDate: ex.value || null, orderIds: d.rows.map((x) => x.orderId),
          sheetKey: d.sheetKey, // what was on screen: the server refuses (409) when the sheet has changed since
        }).catch((ex) => {
          if (ex && /changed while you were looking/i.test(ex.message || "")) ex.reload = true;
          throw ex;
        });
      },
    });
    if (!r) return;
    if (r.refused) {
      await loadBrand(brand);
      focusNode(opener) || focusNode($("dwSheetH-" + brand));
      return;
    }
    const p = r.drawerOrder;
    setStatus(`${label} drawer order placed: ${p.jobs.length ? plural(p.jobs.length, "job", "jobs") : "stock only"}, ${plural(p.total, "drawer", "drawers")}. Print it from here to send.`, "ok");
    boards[brand] = null;
    loadBrand(brand);
    placedList = null;
    openPlaced(p.id, true);
  }

  // ------------------------------------------------------------------ placed ---
  let placedList = null;
  let placedOpen = null; // the open placed order (with grid), or null for the list
  let placedFilter = "";

  async function loadPlacedList() {
    try {
      const r = await api("/api/drawers/placed" + (placedFilter ? "?brand=" + encodeURIComponent(placedFilter) : ""));
      placedList = r.placed;
      return true;
    } catch (e) {
      setStatus(e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message, "err");
      return false;
    }
  }

  function stockState(p) {
    if (!p.stockTotal) return "None";
    if (p.stockReceived) return `${p.stockTotal}, received ${fmtDate(p.stockReceived.date)}`;
    return `${p.stockTotal}, not received`;
  }

  function linesState(p) {
    const n = p.jobs.length;
    if (!n) return "No job lines";
    if (p.linesReceived === n) return "All received";
    return `${p.linesReceived} of ${n} received`;
  }

  // "Job A, Job B" with each name a link to its job (with jobs.view), or "Stock only".
  function jobList(jobs) {
    const out = el("span", { class: "dw-jobs" });
    if (!jobs.length) out.textContent = "Stock only";
    jobs.forEach((j, k) => {
      if (k) out.append(document.createTextNode(", "));
      out.append(jobNode(j.jobId, j.jobName, "dw-joblink"));
    });
    return out;
  }

  function renderPlacedList() {
    const panel = $("dwPanel-placed");
    const filter = el("select", { class: "hs-input dw-filter", id: "dwPlacedBrand" },
      el("option", { value: "", text: "Both brands" }), ...D.BRANDS.map((b) => el("option", { value: b.id, text: b.label })));
    filter.value = placedFilter;
    filter.addEventListener("change", async () => {
      placedFilter = filter.value;
      if (await loadPlacedList()) renderPlacedList();
      focusNode($("dwPlacedBrand"));
    });
    const bar = el("div", { class: "hs-sectionbar dw-sbar" },
      el("h2", { id: "dwPlacedH", tabindex: "-1" }, "Placed orders ", el("span", { class: "dw-count", text: String((placedList || []).length) })),
      el("span", { class: "dw-sbar-note", text: "The newest 50" }));
    const tools = el("div", { class: "dw-filterbar" }, el("label", { class: "dw-label", for: "dwPlacedBrand", text: "Brand" }), filter);
    const list = placedList || [];
    let body;
    if (!list.length) {
      body = el("p", { class: "dw-empty", text: "No drawer orders placed yet." });
    } else {
      const tb = el("tbody", null, ...list.map((p) => el("tr", null,
        el("td", { class: "dw-c-date", "data-label": "Ordered", text: fmtDate(p.orderedDate) }),
        el("td", { class: "dw-c-brand", "data-label": "Brand", text: brandLabel(p.brand) }),
        el("td", { class: "dw-c-sup", "data-label": "Supplier", text: p.supplier }),
        el("td", { class: "dw-c-jobs", "data-label": "Jobs" }, jobList(p.jobs)),
        el("td", { class: "dw-c-num", "data-label": "Drawers", text: String(p.total) }),
        el("td", { class: "dw-c-stock", "data-label": "Stock row", text: stockState(p) }),
        el("td", { class: "dw-c-lines", "data-label": "Job lines", text: linesState(p) }),
        el("td", { class: "dw-c-acts" }, el("button", { type: "button", class: "hs-btn", "data-act": "openPlaced", "data-id": String(p.id),
          text: "Open", "aria-label": `Open the ${brandLabel(p.brand)} order of ${fmtDate(p.orderedDate)}` })))));
      const cols = [["Ordered", "dw-c-date"], ["Brand", "dw-c-brand"], ["Supplier", "dw-c-sup"], ["Jobs", "dw-c-jobs"], ["Drawers", "dw-c-num"],
        ["Stock row", "dw-c-stock"], ["Job lines", "dw-c-lines"], ["", "dw-c-acts"]];
      body = el("div", { class: "dw-wrap" }, el("table", { class: "dw-table dw-table-placed" },
        el("thead", null, el("tr", null, ...cols.map(([t, c]) => el("th", { scope: "col", class: c }, t || el("span", { class: "dw-sr", text: "Actions" }))))), tb));
    }
    panel.replaceChildren(el("section", { class: "dw-group", "aria-labelledby": "dwPlacedH" }, bar, tools, body));
  }

  async function openPlaced(id, focusHeading) {
    let p;
    try {
      p = await api("/api/drawers/placed/" + encodeURIComponent(id));
    } catch (e) {
      setStatus(e.message === "Not found" ? "That drawer order isn't there any more (it may have been undone)." : errText(e), "err");
      placedOpen = null;
      if (tab !== "placed") showTab("placed");
      else {
        if (!placedList) await loadPlacedList();
        renderPlacedList();
      }
      return;
    }
    placedOpen = p;
    if (tab !== "placed") showTab("placed", false, true);
    if (location.hash !== "#placed-" + p.id) history.replaceState(null, "", location.pathname + "#placed-" + p.id);
    renderPlaced();
    if (focusHeading) focusNode($("dwPlacedOneH"));
  }

  function renderPlaced() {
    const p = placedOpen;
    const panel = $("dwPanel-placed");
    const label = brandLabel(p.brand);
    const acts = el("div", { class: "dw-tools" },
      el("button", { type: "button", class: "hs-btn", "data-act": "printPlaced", text: "Print again" }));
    if (p.stockTotal && can("orders.receive")) {
      if (p.stockReceived) acts.append(el("button", { type: "button", class: "hs-btn", "data-act": "undoStock", text: "Undo stock received" }));
      else acts.append(el("button", { type: "button", class: "hs-btn hs-btn-primary", "data-act": "stockReceived", text: "Stock received" }));
    }
    if (p.undoable && can("orders.mark_ordered")) {
      acts.append(el("button", { type: "button", class: "hs-btn", "data-act": "undoPlaced", text: "Undo order" }));
    }
    const kv = el("div", { class: "hs-kvt dw-kvt" });
    const add = (k, ...v) => kv.append(el("div", { class: "k", text: k }), el("div", { class: "v" }, ...v));
    add("Supplier", el("span", { text: p.supplier }));
    add("Ordered", el("span", { text: fmtDate(p.orderedDate) + (p.createdBy && p.createdBy.name ? ", by " + p.createdBy.name : "") }));
    add("Expected", el("span", { text: p.expectedDate ? fmtDate(p.expectedDate) : "No date" }));
    add("Job lines", el("span", { text: p.jobs.length ? `${linesState(p)} (${plural(p.linesOrdered, "line", "lines")} still ordered)` : "None (stock only)" }));
    const stockV = [el("span", { text: stockState(p) + (p.stockReceived && p.stockReceived.by && p.stockReceived.by.name ? ", by " + p.stockReceived.by.name : "") })];
    if (p.stockDeliveryNote) stockV.push(el("span", { class: "dw-rownote", text: "Delivery note: " + p.stockDeliveryNote }));
    add("Stock row", ...stockV);
    const grid = p.grid || { rows: [], stock: [], totals: [], total: 0 };
    const back = el("button", { type: "button", class: "hs-btn hs-btn-quiet", "data-act": "placedList", text: "All placed orders" });
    panel.replaceChildren(
      el("div", { class: "dw-back" }, back),
      el("section", { class: "dw-group", "aria-labelledby": "dwPlacedOneH" },
        el("div", { class: "hs-sectionbar dw-sbar" },
          el("h2", { id: "dwPlacedOneH", tabindex: "-1", text: `${label} drawer order, ${fmtDate(p.orderedDate)}` }),
          el("span", { class: "dw-sbar-note", text: "As sent" })),
        el("div", { class: "dw-bar" }, kv, acts),
        el("div", { class: "dw-wrap" }, sheetTable({ brand: p.brand, rows: grid.rows, stock: grid.stock, totals: grid.totals, total: grid.total },
          { idSuffix: "-placed", notes: true })),
        el("p", { class: "dw-foot" }, "Total drawers ", el("b", { text: String(p.total) }))));
  }

  async function stockReceived(opener) {
    const p = placedOpen;
    const today = todayISO();
    const date = dateInput(today, p.orderedDate, today);
    const note = el("textarea", { class: "hs-input dw-text", maxlength: String(NOTE_MAX), rows: "3" });
    note.value = p.stockDeliveryNote || "";
    const r = await dialog({
      title: "Stock received",
      note: `${brandLabel(p.brand)} stock row: ${plural(p.stockTotal, "drawer", "drawers")} from ${p.supplier}, ordered ${fmtDate(p.orderedDate)}.`,
      fields: [fieldBox("Date received", date), fieldBox("Delivery note (optional)", note, "Up to 500 characters.")],
      submit: "Mark received",
      focus: date,
      run: () => {
        if (!validDate(date.value)) throw sentence("Choose the date it arrived", date);
        const body = { receivedDate: date.value };
        const n = note.value.trim();
        if (n !== (p.stockDeliveryNote || "").trim()) body.deliveryNote = n;
        return send("/api/drawers/placed/" + p.id + "/stock-received", "POST", body);
      },
    });
    await afterPlacedAction(r, opener, "Stock row received.");
  }

  async function undoStock(opener) {
    const p = placedOpen;
    const r = await dialog({
      title: "Undo stock received?",
      note: `${brandLabel(p.brand)} stock row, received ${fmtDate(p.stockReceived && p.stockReceived.date)}.`,
      hint: "It goes back to waiting for delivery. Its delivery note stays.",
      submit: "Undo received",
      cancel: "Keep received",
      focus: "cancel",
      run: () => send("/api/drawers/placed/" + p.id + "/stock-received", "POST", { undo: true }),
    });
    await afterPlacedAction(r, opener, "Stock row back to waiting for delivery.");
  }

  async function undoPlaced(opener) {
    const p = placedOpen;
    const label = brandLabel(p.brand);
    const r = await dialog({
      title: "Undo this drawer order?",
      note: `${label} drawer order of ${fmtDate(p.orderedDate)}: ${plural(p.total, "drawer", "drawers")}.`,
      hint: (p.jobs.length ? `The ${plural(p.jobs.length, "job's", "jobs'")} drawer lines go back to To order. ` : "") +
        (p.stockTotal ? "The stock row goes back onto the sheet. " : "") +
        "A progress invoice that already fell due stays due.",
      submit: "Undo order",
      submitClass: "hs-btn-stop",
      cancel: "Keep order",
      focus: "cancel",
      run: () => send("/api/drawers/placed/" + p.id + "/undo", "POST", {}),
    });
    if (!r) return;
    if (r.refused) {
      await openPlaced(p.id);
      focusNode(opener) || focusNode($("dwPlacedOneH"));
      return;
    }
    setStatus(`${label} drawer order of ${fmtDate(p.orderedDate)} undone. ${p.jobs.length ? "Its lines are" : "Its stock row is"} back on the ${label} sheet.`, "ok");
    boards[p.brand] = null;
    placedOpen = null;
    placedList = null;
    history.replaceState(null, "", location.pathname + "#placed");
    if (await loadPlacedList()) renderPlacedList();
    focusNode($("dwPlacedH"));
  }

  async function afterPlacedAction(r, opener, said) {
    if (!r) return;
    const id = placedOpen.id;
    if (!r.refused) setStatus(said, "ok");
    placedList = null;
    await openPlaced(id);
    const act = opener && opener.getAttribute("data-act");
    const next = { stockReceived: "undoStock", undoStock: "stockReceived" }[act];
    focusNode($("dwPanel-placed").querySelector(`button[data-act="${next}"]`)) ||
      focusNode($("dwPanel-placed").querySelector(`button[data-act="${act}"]`)) || focusNode($("dwPlacedOneH"));
  }

  // ------------------------------------------------------------------- names ---
  let names = null;
  let unmapped = null;

  async function loadNames() {
    try {
      const [n, u] = await Promise.all([api("/api/drawers/names"), api("/api/drawers/unmapped")]);
      names = n.names;
      unmapped = u.unmapped;
      return true;
    } catch (e) {
      setStatus(e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message, "err");
      return false;
    }
  }

  function mapText(n) {
    return n.ignored ? "Ignored" : sizeText(n.brand, n.height, n.length);
  }

  function renderNames() {
    const panel = $("dwPanel-names");
    const um = unmapped || [];
    const umSec = el("section", { class: "dw-group", "aria-labelledby": "dwUnmappedH" },
      el("div", { class: "hs-sectionbar dw-sbar" + (um.length ? " hs-sectionbar-orange" : "") },
        el("h2", { id: "dwUnmappedH", tabindex: "-1" }, "Names from Joinr not on the list ",
          el("span", { class: "dw-count" + (um.length ? " dw-count-check" : ""), text: String(um.length) })),
        el("span", { class: "dw-sbar-note", text: "From jobs whose drawers aren't ordered yet" })));
    if (!um.length) {
      umSec.append(el("p", { class: "dw-empty", text: "Every drawer name from Joinr is on the list." }));
    } else {
      const tb = el("tbody", null, ...um.map((u, i) => {
        const jobs = el("span", { class: "dw-jobs" });
        u.jobs.forEach((j, k) => {
          if (k) jobs.append(document.createTextNode(", "));
          jobs.append(jobNode(j.jobId, j.jobName), document.createTextNode(` (${j.qty})`));
        });
        return el("tr", null,
          el("td", { class: "dw-c-name", "data-label": "Name" }, el("b", { class: "dw-strong", text: u.name })),
          el("td", { class: "dw-c-sec", "data-label": "Section", text: SECTION_LABEL[u.section] || u.section }),
          el("td", { class: "dw-c-num", "data-label": "Qty", text: String(u.qty) }),
          el("td", { class: "dw-c-jobs", "data-label": "Jobs" }, jobs),
          el("td", { class: "dw-c-acts" }, el("button", { type: "button", class: "hs-btn hs-btn-primary", "data-act": "addUnmapped", "data-i": String(i),
            text: "Add", "aria-label": "Add to the list: " + u.name })));
      }));
      umSec.append(el("div", { class: "dw-wrap" }, el("table", { class: "dw-table dw-table-unmapped" },
        el("thead", null, el("tr", null, ...[["Name", "dw-c-name"], ["Section", "dw-c-sec"], ["Qty", "dw-c-num"], ["Jobs", "dw-c-jobs"], ["", "dw-c-acts"]]
          .map(([t, c]) => el("th", { scope: "col", class: c }, t || el("span", { class: "dw-sr", text: "Actions" }))))), tb)));
    }

    const list = names || [];
    const listSec = el("section", { class: "dw-group", "aria-labelledby": "dwNamesH" },
      el("div", { class: "hs-sectionbar dw-sbar" },
        el("h2", { id: "dwNamesH", tabindex: "-1" }, "Drawer name list ", el("span", { class: "dw-count", text: String(list.length) })),
        el("button", { type: "button", class: "hs-btn hs-btn-primary", "data-act": "addName", text: "Add name" })),
      el("p", { class: "dw-note", text: "Each Joinr catalogue name maps to one brand, height and length, or is ignored (runner sets, accessories and other lines that aren't drawers). A change here applies to the next grid filled or refilled from Joinr." }));
    if (!list.length) {
      listSec.append(el("p", { class: "dw-empty", text: "No names on the list yet." }));
    } else {
      const tb = el("tbody", null, ...list.map((n) => el("tr", null,
        el("td", { class: "dw-c-name", "data-label": "Name" }, el("b", { class: "dw-strong", text: n.name })),
        el("td", { class: "dw-c-map" + (n.ignored ? " dw-ignored" : ""), "data-label": "Maps to", text: mapText(n) }),
        el("td", { class: "dw-c-by", "data-label": "Changed", text: fmtStamp(n.updatedAt) + (n.updatedBy && n.updatedBy.name ? ", " + n.updatedBy.name : "") }),
        el("td", { class: "dw-c-acts" }, el("div", { class: "dw-acts" },
          el("button", { type: "button", class: "hs-btn", "data-act": "editName", "data-id": String(n.id), text: "Edit", "aria-label": "Edit " + n.name }),
          el("button", { type: "button", class: "hs-btn", "data-act": "removeName", "data-id": String(n.id), text: "Remove", "aria-label": "Remove " + n.name }))))));
      listSec.append(el("div", { class: "dw-wrap" }, el("table", { class: "dw-table dw-table-names" },
        el("thead", null, el("tr", null, ...[["Name", "dw-c-name"], ["Maps to", "dw-c-map"], ["Changed", "dw-c-by"], ["", "dw-c-acts"]]
          .map(([t, c]) => el("th", { scope: "col", class: c }, t || el("span", { class: "dw-sr", text: "Actions" }))))), tb)));
    }
    panel.replaceChildren(umSec, listSec);
  }

  // The add/edit dialog: the name, then Drawer (brand, height, length) or Ignore.
  function nameDialog(existing, prefill) {
    const n = existing || {};
    const name = el("input", { class: "hs-input", type: "text", maxlength: String(NAME_MAX), autocomplete: "off" });
    name.value = existing ? n.name : prefill ? prefill.name : "";
    const kindName = "dw-kind-" + Math.random().toString(36).slice(2, 8);
    const asDrawer = el("input", { type: "radio", name: kindName, value: "drawer" });
    const asIgnore = el("input", { type: "radio", name: kindName, value: "ignore" });
    asDrawer.checked = !n.ignored;
    asIgnore.checked = !!n.ignored;
    const brand = el("select", { class: "hs-input" }, ...D.BRANDS.map((b) => el("option", { value: b.id, text: b.label })));
    const height = el("select", { class: "hs-input" });
    const length = el("select", { class: "hs-input" }, ...D.LENGTHS.map((l) => el("option", { value: String(l), text: l + " mm" })));
    function fillHeights(keep) {
      const b = D.brand(brand.value);
      height.replaceChildren(...b.heights.map((h) => el("option", { value: String(h.mm), text: h.label })));
      if (keep && b.heights.some((h) => String(h.mm) === keep)) height.value = keep;
    }
    brand.value = n.brand && D.brand(n.brand) ? n.brand : D.BRANDS[0].id;
    fillHeights(n.height != null ? String(n.height) : null);
    length.value = n.length != null ? String(n.length) : "500";
    brand.addEventListener("change", () => fillHeights(height.value));
    const size = el("div", { class: "dw-dlg-row dw-dlg-row3" }, fieldBox("Brand", brand), fieldBox("Height", height), fieldBox("Length", length));
    function sync() {
      size.hidden = asIgnore.checked;
    }
    asDrawer.addEventListener("change", sync);
    asIgnore.addEventListener("change", sync);
    sync();
    const kind = el("fieldset", { class: "dw-kind" }, el("legend", { class: "cc-field-label", text: "This name is" }),
      el("label", { class: "dw-radio" }, asDrawer, el("span", { text: "A drawer size" })),
      el("label", { class: "dw-radio" }, asIgnore, el("span", { text: "Not a drawer (ignore it)" })));
    const fields = [fieldBox("Joinr catalogue name", name, "As Joinr sends it; capitals and spaces don't matter."), kind, size];
    if (prefill) {
      fields.unshift(el("p", { class: "cc-dialog-note", text: `Seen as ${SECTION_LABEL[prefill.section] || prefill.section}, ${prefill.qty} in all, on ${prefill.jobs.map((j) => j.jobName).join(", ")}.` }));
    }
    return dialog({
      title: existing ? "Edit name" : "Add a name",
      fields,
      hint: "Grids already filled keep their counts. Refill a job's grid from its page to use the change.",
      submit: existing ? "Save" : "Add name",
      wide: true,
      focus: prefill ? asDrawer : name,
      run: () => {
        const v = name.value.trim();
        if (!v) throw sentence("Type the name", name);
        const body = asIgnore.checked
          ? { name: v, ignored: true }
          : { name: v, brand: brand.value, height: Number(height.value), length: Number(length.value) };
        if (existing) {
          const same = v === n.name && (asIgnore.checked ? n.ignored
            : !n.ignored && body.brand === n.brand && body.height === n.height && body.length === n.length);
          if (same) return undefined;
          if (!asIgnore.checked) body.ignored = false;
          return send("/api/drawers/names/" + n.id, "PATCH", body);
        }
        return send("/api/drawers/names", "POST", body);
      },
    });
  }

  async function nameAction(act, opener) {
    let r;
    let said;
    if (act === "addName") {
      r = await nameDialog(null, null);
      said = r && !r.refused ? `Added: ${r.name} (${mapText(r)}).` : "";
    } else if (act === "addUnmapped") {
      const u = unmapped[Number(opener.getAttribute("data-i"))];
      if (!u) return;
      r = await nameDialog(null, u);
      said = r && !r.refused ? `Added: ${r.name} (${mapText(r)}). Refill the jobs' grids from their pages to use it.` : "";
    } else {
      const n = names.find((x) => x.id === Number(opener.getAttribute("data-id")));
      if (!n) return;
      if (act === "editName") {
        r = await nameDialog(n, null);
        said = r && !r.refused ? `Saved: ${r.name} (${mapText(r)}).` : "";
      } else {
        r = await dialog({
          title: "Remove this name?",
          note: `${n.name} (${mapText(n)}).`,
          hint: "Grids already filled keep their counts. The next time Joinr sends this name it shows as not on the list.",
          submit: "Remove",
          submitClass: "hs-btn-stop",
          cancel: "Keep",
          focus: "cancel",
          run: () => send("/api/drawers/names/" + n.id, "DELETE"),
        });
        said = r && !r.refused ? `Removed: ${n.name}.` : "";
      }
    }
    if (!r) return;
    if (said) setStatus(said, "ok");
    if (!(await loadNames())) return;
    renderNames();
    const id = opener.getAttribute("data-id");
    if (act === "editName" && focusNode($("dwPanel-names").querySelector(`button[data-act="editName"][data-id="${id}"]`))) return;
    if (act === "addUnmapped") {
      const left = $("dwPanel-names").querySelectorAll('button[data-act="addUnmapped"]');
      const at = Math.min(Number(opener.getAttribute("data-i")), left.length - 1);
      if (at >= 0 && focusNode(left[at])) return;
      focusNode($("dwUnmappedH"));
      return;
    }
    focusNode($("dwPanel-names").querySelector('button[data-act="addName"]')) || focusNode($("dwNamesH"));
  }

  // ---------------------------------------------------------------- settings ---
  async function loadSettings() {
    try {
      const s = await api("/api/drawers/settings");
      $("dwSupEdge").value = s.supplierEdge;
      $("dwSupDtc").value = s.supplierDtc;
      settingsLoaded = s;
      return true;
    } catch (e) {
      setStatus(e instanceof TypeError ? "Couldn't reach the server. Reload to try again." : e.message, "err");
      return false;
    }
  }
  let settingsLoaded = null;

  async function saveSettings(ev) {
    ev.preventDefault();
    const msg = $("dwSettingsMsg");
    msg.className = "dw-formmsg";
    const edge = $("dwSupEdge").value.trim();
    const dtc = $("dwSupDtc").value.trim();
    for (const [v, inp] of [[edge, $("dwSupEdge")], [dtc, $("dwSupDtc")]]) {
      if (!v || v.length > SUPPLIER_MAX) {
        msg.textContent = "Each supplier name is 1 to 200 characters.";
        msg.className = "dw-formmsg dw-status-err";
        inp.focus();
        return;
      }
    }
    const body = {};
    if (!settingsLoaded || edge !== settingsLoaded.supplierEdge) body.supplierEdge = edge;
    if (!settingsLoaded || dtc !== settingsLoaded.supplierDtc) body.supplierDtc = dtc;
    if (!Object.keys(body).length) {
      msg.textContent = "Nothing changed.";
      return;
    }
    const btn = $("dwSettingsSave");
    btn.disabled = true;
    msg.textContent = "Saving...";
    try {
      const s = await send("/api/drawers/settings", "PUT", body);
      settingsLoaded = s;
      $("dwSupEdge").value = s.supplierEdge;
      $("dwSupDtc").value = s.supplierDtc;
      msg.textContent = "Saved. New drawer lines use these suppliers.";
      msg.className = "dw-formmsg dw-status-ok";
      for (const b of D.BRANDS) boards[b.id] = null;
    } catch (e) {
      msg.textContent = errText(e);
      msg.className = "dw-formmsg dw-status-err";
    } finally {
      btn.disabled = false;
    }
  }

  // -------------------------------------------------------------------- tabs ---
  let tab = null;

  function tabFromHash() {
    const h = location.hash.replace(/^#/, "");
    if (/^placed-\d+$/.test(h)) return { tab: "placed", placed: Number(h.slice(7)) };
    return { tab: TABS.includes(h) ? h : "edge", placed: null };
  }

  // Shows a tab and loads what it needs. `focusTab`: keyboard selection (focus the tab).
  // `keepPlaced`: an open placed order stays open (openPlaced shows it itself).
  async function showTab(name, focusTab, keepPlaced) {
    tab = name;
    for (const t of TABS) {
      const btn = $("dwTab-" + t);
      const on = t === name;
      btn.setAttribute("aria-selected", on ? "true" : "false");
      btn.tabIndex = on ? 0 : -1;
      $("dwPanel-" + t).hidden = !on;
    }
    if (focusTab) $("dwTab-" + name).focus();
    const want = name === "placed" && placedOpen && keepPlaced ? "#placed-" + placedOpen.id : "#" + name;
    if (location.hash !== want) history.replaceState(null, "", location.pathname + want);
    if (name === "edge" || name === "dtc") {
      renderBrand(name);
      await loadBrand(name);
    } else if (name === "placed") {
      if (keepPlaced && placedOpen) return;
      placedOpen = null;
      if (!placedList) $("dwPanel-placed").replaceChildren(el("p", { class: "dw-empty", text: "Loading..." }));
      if (await loadPlacedList()) renderPlacedList();
    } else if (name === "names") {
      if (!names) $("dwPanel-names").replaceChildren(el("p", { class: "dw-empty", text: "Loading..." }));
      if (await loadNames()) renderNames();
    } else if (name === "settings") {
      $("dwSettingsMsg").textContent = "";
      await loadSettings();
    }
  }

  $("dwTabs").addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button[data-tab]");
    if (!b) return;
    setStatus("", "");
    showTab(b.getAttribute("data-tab"));
  });
  $("dwTabs").addEventListener("keydown", (e) => {
    const i = TABS.indexOf(tab);
    let to = null;
    if (e.key === "ArrowRight") to = TABS[(i + 1) % TABS.length];
    else if (e.key === "ArrowLeft") to = TABS[(i - 1 + TABS.length) % TABS.length];
    else if (e.key === "Home") to = TABS[0];
    else if (e.key === "End") to = TABS[TABS.length - 1];
    if (!to) return;
    e.preventDefault();
    setStatus("", "");
    showTab(to, true);
  });
  window.addEventListener("hashchange", () => {
    const h = tabFromHash();
    if (h.placed) openPlaced(h.placed);
    else if (h.tab !== tab) showTab(h.tab);
  });

  // ----------------------------------------------------------------- actions ---
  let busy = false;
  document.addEventListener("click", async (e) => {
    const b = e.target.closest && e.target.closest("button[data-act]");
    if (!b || !b.closest(".dw-panel") || b.disabled || busy) return;
    const act = b.getAttribute("data-act");
    busy = true;
    try {
      if (act === "print") await printBrand(b.getAttribute("data-brand"));
      else if (act === "place") await place(b.getAttribute("data-brand"), b);
      else if (act === "openPlaced") await openPlaced(Number(b.getAttribute("data-id")), true);
      else if (act === "placedList") {
        placedOpen = null;
        history.replaceState(null, "", location.pathname + "#placed");
        if (await loadPlacedList()) renderPlacedList();
        focusNode($("dwPlacedH"));
      } else if (act === "printPlaced") printPlaced();
      else if (act === "stockReceived") await stockReceived(b);
      else if (act === "undoStock") await undoStock(b);
      else if (act === "undoPlaced") await undoPlaced(b);
      else if (["addName", "addUnmapped", "editName", "removeName"].includes(act)) await nameAction(act, b);
    } finally {
      busy = false;
    }
  });

  document.addEventListener("change", (e) => {
    const inp = e.target;
    if (!inp.classList || !inp.classList.contains("dw-qty")) return;
    if (tab === "edge" || tab === "dtc") saveStock(tab);
  });

  $("dwSettingsForm").addEventListener("submit", saveSettings);

  // ------------------------------------------------------------------- print ---
  // Black on white A4 (drawerspage.css print block): the sheet of section 4.3 with the supplier
  // and the date, and the grand total at the foot.

  function buildPrint(sheet, meta) {
    const label = brandLabel(sheet.brand);
    const head = el("div", { class: "dw-p-head" },
      el("div", null,
        el("h1", { class: "dw-p-h1", text: `${label} drawer order` }),
        el("p", { class: "dw-p-sup", text: sheet.supplier })),
      el("div", { class: "dw-p-meta" },
        el("p", null, el("span", { class: "dw-p-label", text: meta.dateLabel }), el("b", { text: fmtDate(meta.date) })),
        meta.expected ? el("p", null, el("span", { class: "dw-p-label", text: "Expected" }), el("b", { text: fmtDate(meta.expected) })) : null));
    const b = D.brand(sheet.brand);
    const stock = cellMap(sheet.stock);
    const totals = cellMap(sheet.totals);
    const table = el("table", { class: "dw-p-table" });
    const noted = new Set(); // a job's note prints once, under its name in the first block it appears in
    table.append(el("colgroup", null, el("col", { class: "dw-pc-job" }), ...D.LENGTHS.map(() => el("col", { class: "dw-pc-n" })), el("col", { class: "dw-pc-n" })));
    for (const h of b.heights) {
      const tb = el("tbody", { class: "dw-p-block" });
      tb.append(el("tr", { class: "dw-p-bh" }, el("th", { scope: "col", class: "dw-p-hl", text: h.label }),
        ...D.LENGTHS.map((l) => el("th", { scope: "col", class: "dw-p-n", text: String(l) })), el("th", { scope: "col", class: "dw-p-n", text: "Total" })));
      for (const r of sheet.rows || []) {
        const t = sumHeight(r.counts, h.mm);
        if (!t) continue;
        const m = cellMap(r.counts);
        const showNote = r.notes && !noted.has(r.orderId);
        noted.add(r.orderId);
        tb.append(el("tr", null, el("td", { class: "dw-p-job" }, document.createTextNode(r.jobName || ""),
            showNote ? el("span", { class: "dw-p-note", text: r.notes }) : null),
          ...D.LENGTHS.map((l) => el("td", { class: "dw-p-n", text: m[h.mm + "x" + l] ? String(m[h.mm + "x" + l]) : "" })),
          el("td", { class: "dw-p-n dw-p-strong", text: String(t) })));
      }
      const st = sumHeight(sheet.stock, h.mm);
      tb.append(el("tr", null, el("td", { class: "dw-p-job", text: "Stock" }),
        ...D.LENGTHS.map((l) => el("td", { class: "dw-p-n", text: stock[h.mm + "x" + l] ? String(stock[h.mm + "x" + l]) : "" })),
        el("td", { class: "dw-p-n dw-p-strong", text: st ? String(st) : "" })));
      const ht = sumHeight(sheet.totals, h.mm);
      tb.append(el("tr", { class: "dw-p-tot" }, el("td", { class: "dw-p-job", text: "Total" }),
        ...D.LENGTHS.map((l) => el("td", { class: "dw-p-n", text: totals[h.mm + "x" + l] ? String(totals[h.mm + "x" + l]) : "" })),
        el("td", { class: "dw-p-n", text: ht ? String(ht) : "" })));
      table.append(tb);
    }
    const foot = el("div", { class: "dw-p-foot" },
      el("p", null, el("span", { class: "dw-p-label", text: "Grand total" }), el("b", { text: plural(sheet.total, "drawer", "drawers") })),
      el("p", null, el("span", { class: "dw-p-label", text: meta.dateLabel }), el("b", { text: fmtDate(meta.date) })));
    $("dwPrintSheet").replaceChildren(head, table, foot);
    return `${label} drawer order ${fmtDate(meta.date)}`;
  }

  let titleBefore = null;
  function printWith(title) {
    if (titleBefore == null) titleBefore = document.title;
    document.title = title;
    window.print();
  }
  window.addEventListener("afterprint", () => {
    if (titleBefore != null) document.title = titleBefore;
    titleBefore = null;
  });
  // Printing from the browser's own menu prints what the tab shows.
  window.addEventListener("beforeprint", () => {
    if (titleBefore != null) return; // the page's own Print already built it
    if ((tab === "edge" || tab === "dtc") && boards[tab]) {
      const d = boards[tab];
      titleBefore = document.title;
      document.title = buildPrint({ ...d, brand: tab }, { dateLabel: "Printed", date: todayISO() });
    } else if (tab === "placed" && placedOpen) {
      titleBefore = document.title;
      document.title = buildPlacedPrint();
    } else {
      $("dwPrintSheet").replaceChildren(el("p", { class: "dw-p-empty", text: "Open a brand or a placed order to print its sheet." }));
    }
  });

  async function printBrand(brand) {
    if (!(await flushStock(brand))) return;
    await loadBrand(brand);
    const d = boards[brand];
    if (!d) return;
    printWith(buildPrint({ ...d, brand }, { dateLabel: "Printed", date: todayISO() }));
  }

  function buildPlacedPrint() {
    const p = placedOpen;
    const g = p.grid || {};
    return buildPrint({ brand: p.brand, supplier: p.supplier, rows: g.rows || [], stock: g.stock || [], totals: g.totals || [], total: p.total },
      { dateLabel: "Ordered", date: p.orderedDate, expected: p.expectedDate });
  }

  function printPlaced() {
    if (placedOpen) printWith(buildPlacedPrint());
  }

  // ------------------------------------------------------------------- start ---
  (async () => {
    const ready = window.cc && window.cc.ready ? window.cc.ready : Promise.resolve();
    await ready;
    setStatus("", "");
    // Deliveries links a drawer stock row as /drawers.html?placed=<id>.
    const q = new URLSearchParams(location.search).get("placed");
    if (q && /^[1-9]\d*$/.test(q)) {
      history.replaceState(null, "", location.pathname + "#placed-" + q);
    }
    const h = tabFromHash();
    if (h.placed) await openPlaced(h.placed, true);
    else await showTab(h.tab);
  })();
})();
