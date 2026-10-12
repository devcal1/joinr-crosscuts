// BAS sales (bas.html[?fy=2027][#2026-09]): the financial year's sales by month on a cash basis,
// with quarter and year totals; a month's detail (figures, lodging, the hand amount, its invoice
// list and CSV); and the same month compared across financial years. Talks to /api/bas
// (routes/bas.js, docs/plans/m9-contracts.md sections 6 and 9.1). Money is integer cents on the
// wire; it is shown and typed only through Periods (public/periods.js).
(function () {
  "use strict";

  const P = window.Periods;
  const API = "/api/bas";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DASH = "–";

  // Permissions come from the shell. Without it, act as view-only: the server enforces
  // everything regardless.
  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }
  const canEdit = () => can("invoices.edit");
  const canReopen = () => can("users.admin");

  // --- helpers ---------------------------------------------------------------------
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
  const $ = (id) => document.getElementById(id);
  const svgNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs) {
    const node = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
  }

  // '5 Oct 2026' from 'YYYY-MM-DD'
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }
  // The Sydney calendar date (YYYY-MM-DD) of a UTC ISO timestamp, or of now.
  function sydneyDate(iso) {
    const d = iso ? new Date(iso) : new Date();
    if (isNaN(d)) return "";
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  }
  // '5 Oct' (the lodged badge)
  function shortDay(iso) {
    const d = sydneyDate(iso);
    return d ? fmtDate(d).replace(/ \d{4}$/, "") : "";
  }

  const money = (c) => (c === null || c === undefined ? DASH : P.dollars(c));
  const num = (c) => (c === null || c === undefined ? "" : String(c));

  function showError(e) {
    toast(`Error: ${e && e.message ? e.message : e}`);
  }

  // A button that can't be pressed twice while its request runs.
  function once(ctrl, fn) {
    return async (...args) => {
      if (ctrl.disabled) return;
      ctrl.disabled = true;
      try {
        await fn(...args);
      } catch (e) {
        showError(e);
      } finally {
        ctrl.disabled = false;
      }
    };
  }

  // --- state -----------------------------------------------------------------------------
  let year = null; // GET /api/bas?fy=
  let detail = null; // GET /api/bas/months/:period
  let openPeriod = null; // the month whose detail is open
  let showLive = false; // a lodged month: show the current list instead of the frozen one
  let compareData = null;
  let yearSeq = 0;
  let detailSeq = 0;

  // --- URL: ?fy= and #YYYY-MM ---------------------------------------------------------------
  function hashPeriod() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ""));
    return P.validPeriod(h) ? h : null;
  }
  function writeUrl() {
    const u = new URL(location.href);
    if (year) u.searchParams.set("fy", String(year.fy));
    const next = u.pathname + u.search + (openPeriod ? "#" + openPeriod : "");
    if (next !== location.pathname + location.search + location.hash) history.replaceState(null, "", next);
  }

  // --- the year table ------------------------------------------------------------------------
  // The current month of the year on screen: the last month that isn't in the future, when this
  // is the current financial year (the server knows today; the page doesn't guess).
  function currentPeriodOf(y) {
    if (!y || y.fy !== y.currentFy) return null;
    const past = y.months.filter((m) => !m.future);
    return past.length ? past[past.length - 1].period : null;
  }
  const beforeHistory = (period) => P.compare(period, P.HISTORY_START) < 0;
  const hasDetail = (m) => !m.future && !beforeHistory(m.period);

  function statusCell(m, current) {
    const td = el("td", { class: "ba-st" });
    if (m.future || beforeHistory(m.period)) return td;
    const f = m.figures || {};
    if (m.lodged) {
      td.append(el("span", { class: "hs-badge hs-badge-na ba-badge", text: `Lodged ${shortDay(m.lodged.at)}` }));
      if (m.changed) td.append(el("span", { class: "hs-badge hs-badge-check ba-badge", text: "Changed since lodged" }));
    }
    let word = "";
    if (m.period === current) word = "Not ended";
    else if (f.kind === "imported") word = "Imported";
    else if (f.kind === "mixed") word = "Includes a hand amount";
    if (word) td.append(el("span", { class: "ba-st-word", text: word }));
    return td;
  }

  function figureCells(f, blank) {
    if (blank) return ["", "", "", "", ""].map(() => el("td", { class: "num" }));
    const mic = f.notInMyobCount || 0;
    return [
      el("td", { class: "num ba-sales", text: money(f.salesCents) }),
      el("td", { class: "num", text: money(f.gstCents) }),
      el("td", { class: "num", text: money(f.exGstCents) }),
      el("td", { class: "num", text: num(f.invoiceCount) }),
      el("td", { class: "num" + (mic > 0 ? " ba-attend" : ""), text: num(f.notInMyobCount) }),
    ];
  }

  function renderYear() {
    const y = year;
    const current = currentPeriodOf(y);
    document.title = `BAS sales ${y.label || P.fyLabel(y.fy)}`;
    $("fyLabel").textContent = y.label || P.fyLabel(y.fy);
    $("fyRange").textContent = y.rangeLabel || P.fyRangeLabel(y.fy);
    $("printTitle").textContent = `BAS sales ${y.label || P.fyLabel(y.fy)}`;
    $("printRange").textContent = y.rangeLabel || P.fyRangeLabel(y.fy);
    $("printDate").textContent = `Printed ${fmtDate(sydneyDate())}`;
    const prev = $("prevFy"), next = $("nextFy");
    prev.disabled = !(y.fy > y.firstFy);
    next.disabled = !(y.fy < y.currentFy);
    prev.setAttribute("aria-label", prev.disabled ? "Previous year" : `Previous year, ${P.fyLabel(y.fy - 1)}`);
    next.setAttribute("aria-label", next.disabled ? "Next year" : `Next year, ${P.fyLabel(y.fy + 1)}`);

    let dash = false;
    const body = $("yearRows");
    body.replaceChildren();
    const quarters = y.quarters || [];
    y.months.forEach((m, i) => {
      const blank = m.future || beforeHistory(m.period);
      const f = m.figures || {};
      if (!blank && f.salesCents && (f.gstCents === null || f.exGstCents === null)) dash = true;
      const tr = el("tr", { class: "ba-mrow" + (m.future ? " ba-future" : "") + (m.period === openPeriod ? " ba-open" : "") });
      tr.dataset.period = m.period;
      const th = el("th", { scope: "row", class: "ba-mcell" });
      const label = m.label || P.label(m.period);
      if (hasDetail(m)) {
        const btn = el("button", {
          type: "button",
          class: "ba-monthbtn",
          "aria-expanded": m.period === openPeriod ? "true" : "false",
          "aria-controls": "detail",
          text: label,
        });
        btn.addEventListener("click", () => toggleMonth(m.period));
        th.append(btn);
      } else {
        th.append(el("span", { class: "ba-mlabel", text: label }));
      }
      tr.append(th, ...figureCells(f, blank), statusCell(m, current));
      body.append(tr);
      // A quarter subtotal after every third month.
      if (i % 3 === 2) {
        const q = quarters[(i - 2) / 3];
        const qMonths = y.months.slice(i - 2, i + 1);
        if (q) body.append(sumRow("ba-qrow", q.label || P.quarterLabel(y.fy, q.q), q, qMonths, 3));
      }
    });
    const foot = $("yearFoot");
    foot.replaceChildren();
    if (y.total) foot.append(sumRow("ba-yrow", "Year total", y.total, y.months, 12));
    if ((y.total && y.total.salesCents && y.total.gstCents === null) || quarters.some((q) => q.salesCents && q.gstCents === null)) dash = true;
    $("dashKey").hidden = !dash;
    $("yearSection").hidden = false;
  }

  // A quarter or the year: the sums, the Not in MYOB count added from its months, and
  // "2 of 3 lodged".
  function sumRow(cls, label, s, months, of) {
    const tr = el("tr", { class: cls });
    const allBlank = months.every((m) => m.future || beforeHistory(m.period));
    tr.append(el("th", { scope: "row", class: "ba-mcell", text: label }));
    if (allBlank) {
      tr.append(...figureCells({}, true), el("td"));
      return tr;
    }
    const mic = months.reduce((n, m) => n + (m.future ? 0 : (m.figures && m.figures.notInMyobCount) || 0), 0);
    tr.append(
      el("td", { class: "num ba-sales", text: money(s.salesCents) }),
      el("td", { class: "num", text: money(s.gstCents) }),
      el("td", { class: "num", text: money(s.exGstCents) }),
      el("td", { class: "num", text: num(s.invoiceCount) }),
      el("td", { class: "num" + (mic > 0 ? " ba-attend" : ""), text: String(mic) }),
      el("td", { class: "ba-st", text: s.lodgedCount ? `${s.lodgedCount} of ${of} lodged` : "" })
    );
    return tr;
  }

  async function loadYear(fy) {
    const seq = ++yearSeq;
    const q = fy ? `?fy=${encodeURIComponent(fy)}` : "";
    try {
      const y = await api(`${API}${q}`);
      if (seq !== yearSeq) return false;
      year = y;
      $("pageStatus").textContent = "";
      renderYear();
      writeUrl();
      return true;
    } catch (e) {
      if (seq !== yearSeq) return false;
      $("pageStatus").textContent = e.message;
      return false;
    }
  }

  async function changeFy(step) {
    if (!year) return;
    const fy = year.fy + step;
    if (fy < year.firstFy || fy > year.currentFy) return;
    closeDetail(false);
    await loadYear(fy);
  }

  // --- a month's detail -------------------------------------------------------------------
  function toggleMonth(period) {
    if (period === openPeriod) closeDetail(true);
    else openMonth(period, true);
  }

  function markOpenRow() {
    for (const tr of document.querySelectorAll("#yearRows tr.ba-mrow")) {
      const on = tr.dataset.period === openPeriod;
      tr.classList.toggle("ba-open", on);
      const b = tr.querySelector(".ba-monthbtn");
      if (b) b.setAttribute("aria-expanded", on ? "true" : "false");
    }
  }

  function closeDetail(focusRow) {
    const was = openPeriod;
    openPeriod = null;
    detail = null;
    $("detail").hidden = true;
    markOpenRow();
    writeUrl();
    if (focusRow && was) {
      const b = document.querySelector(`#yearRows tr[data-period="${was}"] .ba-monthbtn`);
      if (b) b.focus();
    }
  }

  async function openMonth(period, focus) {
    // A month in another financial year brings that year's table with it.
    if (year && P.fyOf(period) !== year.fy) {
      const ok = await loadYear(P.fyOf(period));
      if (!ok) return;
    }
    const seq = ++detailSeq;
    if (openPeriod !== period) showLive = false;
    openPeriod = period;
    markOpenRow();
    writeUrl();
    const box = $("detail");
    box.hidden = false;
    $("detail-h").textContent = P.longLabel(period);
    $("detailStatus").textContent = "Loading...";
    $("detailBody").hidden = true;
    for (const id of ["prevMonth", "nextMonth"]) $(id).disabled = true;
    try {
      const d = await api(`${API}/months/${encodeURIComponent(period)}`);
      if (seq !== detailSeq) return;
      detail = d;
      $("detailStatus").textContent = "";
      renderDetail();
    } catch (e) {
      if (seq !== detailSeq) return;
      $("detailStatus").textContent = e.message;
    }
    if (focus) {
      $("detail-h").focus({ preventScroll: true });
      box.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }

  // Rows of the figures table: [label, value of figures].
  const FIG_ROWS = [
    ["Sales inc GST (G1)", (f) => money(f.salesCents), "salesCents"],
    ["GST (1A)", (f) => money(f.gstCents), "gstCents"],
    ["Ex GST", (f) => money(f.exGstCents), "exGstCents"],
    ["Invoices", (f) => `${f.invoiceCount || 0} (${P.dollars(f.invoiceCents || 0)})`, "invoiceCents"],
    ["Hand amount", (f) => (f.handCents === null || f.handCents === undefined ? "None" : P.dollars(f.handCents) + (f.handGstCents === null || f.handGstCents === undefined ? ", GST not known" : `, GST ${P.dollars(f.handGstCents)}`)), "handCents"],
    ["Not in MYOB", (f) => String(f.notInMyobCount || 0), "notInMyobCount"],
  ];

  function renderDetail() {
    const d = detail;
    const m = d.month;
    const f = m.figures || {};
    const live = m.live || f;
    const lodged = !!m.lodged;
    const both = lodged && m.changed;
    const isCurrent = !d.next; // the server's next is null at the current month
    const edit = canEdit();

    $("detail-h").textContent = P.longLabel(m.period);
    const prev = $("prevMonth"), next = $("nextMonth");
    prev.disabled = !d.prev;
    next.disabled = !d.next;
    prev.setAttribute("aria-label", d.prev ? `Previous month, ${P.longLabel(d.prev)}` : "Previous month");
    next.setAttribute("aria-label", d.next ? `Next month, ${P.longLabel(d.next)}` : "Next month");

    // where the month stands
    let st = "";
    if (lodged) {
      const by = m.lodged.by && m.lodged.by.name ? ` by ${m.lodged.by.name}` : "";
      st = `Lodged ${fmtDate(sydneyDate(m.lodged.at))}${by}.`;
      if (both) st += " Its figures have changed since; the lodged figures stand.";
    } else if (isCurrent) {
      st = "This month hasn't ended yet, so it can't be lodged.";
    } else if (f.kind === "imported") {
      st = "Imported: a hand amount, no invoices.";
    }
    $("detailStatus").textContent = st;

    // figures
    const head = $("figsHead");
    head.replaceChildren(
      el("tr", {},
        el("th", { scope: "col" }, el("span", { class: "ba-visually-hidden", text: "Figure" })),
        el("th", { scope: "col", class: "num", text: lodged ? "Lodged" : "This month" }),
        both ? el("th", { scope: "col", class: "num", text: "Now" }) : null)
    );
    const rows = $("figsRows");
    rows.replaceChildren();
    for (const [label, show, key] of FIG_ROWS) {
      const tr = el("tr", {}, el("th", { scope: "row", class: "ba-fig-k", text: label }), el("td", { class: "num", text: show(f) }));
      if (both) {
        const differs = f[key] !== live[key] || (key === "handCents" && f.handGstCents !== live.handGstCents) || (key === "invoiceCents" && f.invoiceCount !== live.invoiceCount);
        tr.append(el("td", { class: "num" + (differs ? " ba-attend" : ""), text: show(live) }));
      }
      if (key === "salesCents") tr.classList.add("ba-fig-main");
      rows.append(tr);
    }
    const note = (f.handNote || "").trim();
    $("handNoteLine").hidden = !note;
    $("handNoteLine").textContent = note ? `Hand amount note: ${note}` : "";

    // changes
    const changes = (lodged && d.changes) || [];
    $("changes").hidden = !changes.length;
    $("changeList").replaceChildren(...changes.map((s) => el("li", { text: s })));

    // lodge / reopen
    const lodgeOk = edit && !lodged && !isCurrent;
    const reopenOk = canReopen() && lodged;
    $("lodgeBtn").hidden = !lodgeOk;
    $("reopenBtn").hidden = !reopenOk;
    $("monthActs").hidden = !(lodgeOk || reopenOk);
    $("lockedNote").hidden = !(edit && lodged);

    // the hand amount form
    const form = $("handForm");
    form.hidden = !(edit && !lodged);
    if (!form.hidden) {
      $("handAmount").value = f.handCents === null || f.handCents === undefined ? "" : P.dollars(f.handCents);
      $("handGst").value = f.handGstCents === null || f.handGstCents === undefined ? "" : P.dollars(f.handGstCents);
      $("handNote").value = f.handNote || "";
      $("handErr").textContent = "";
      $("handClear").hidden = f.handCents === null || f.handCents === undefined;
    }

    renderInvoices();
  }

  function renderInvoices() {
    const d = detail;
    const m = d.month;
    const lodged = !!m.lodged;
    const frozen = lodged && !showLive && Array.isArray(d.lodgedInvoices);
    const list = frozen ? d.lodgedInvoices : d.invoices || [];
    const f = lodged && !showLive ? m.figures : m.live || m.figures;

    const toggle = $("listToggle");
    toggle.hidden = !lodged;
    toggle.textContent = "Show current list";
    toggle.setAttribute("aria-pressed", showLive ? "true" : "false");
    $("invTitle").textContent = lodged
      ? showLive ? "Invoices paid in this month now" : "Invoices paid in this month, as lodged"
      : "Invoices paid in this month";
    $("csvLink").href = `${API}/months/${encodeURIComponent(m.period)}/invoices.csv`;
    $("csvNote").hidden = !(lodged && !showLive);

    const body = $("invRows");
    body.replaceChildren();
    for (const inv of list) {
      const job = inv.job && inv.job.name ? inv.job.name : "";
      const myob = inv.myobEnteredDate
        ? el("td", { class: "ba-when", text: fmtDate(inv.myobEnteredDate) })
        : el("td", { class: "ba-when ba-attend", text: "Not yet" });
      body.append(
        el("tr", {},
          el("td", { class: "ba-invno" }, el("a", { href: `/invoice.html?id=${encodeURIComponent(inv.id)}`, text: inv.number || `#${inv.id}` })),
          el("td", { class: "ba-client", text: inv.client || "" }),
          el("td", { class: "ba-job", text: job }),
          el("td", { class: "ba-when", text: fmtDate(inv.issueDate) }),
          el("td", { class: "ba-when", text: fmtDate(inv.paidDate) }),
          el("td", { class: "num", text: money(inv.totalCents) }),
          el("td", { class: "num", text: money(inv.gstCents) }),
          el("td", { class: "num", text: money(inv.exGstCents) }),
          myob)
      );
    }
    const foot = $("invFoot");
    foot.replaceChildren();
    if (f && f.handCents !== null && f.handCents !== undefined) {
      const ex = f.handGstCents === null || f.handGstCents === undefined ? null : f.handCents - f.handGstCents;
      foot.append(
        el("tr", { class: "ba-hand-row" },
          el("th", { scope: "row", text: "Hand amount" }),
          el("td", { class: "ba-client", colspan: "4", text: (f.handNote || "").trim() }),
          el("td", { class: "num", text: money(f.handCents) }),
          el("td", { class: "num", text: money(f.handGstCents) }),
          el("td", { class: "num", text: money(ex) }),
          el("td"))
      );
    }
    if (f && (list.length || f.handCents !== null && f.handCents !== undefined)) {
      foot.append(
        el("tr", { class: "ba-total-row" },
          el("th", { scope: "row", text: "Month total" }),
          el("td", { colspan: "4" }),
          el("td", { class: "num", text: money(f.salesCents) }),
          el("td", { class: "num", text: money(f.gstCents) }),
          el("td", { class: "num", text: money(f.exGstCents) }),
          el("td"))
      );
    }
    $("invEmpty").hidden = list.length > 0 || foot.children.length > 0;
    $("invEmpty").textContent = lodged && !showLive ? "No invoices were paid in this month when it was lodged." : "No invoices were paid in this month.";
    $("detailBody").hidden = false;
  }

  // After a write: the detail the server returned, then the year and the comparison again.
  async function afterChange(d) {
    if (d && d.month && d.month.period === openPeriod) {
      detail = d;
      renderDetail();
    }
    await Promise.all([loadYear(year ? year.fy : null), loadCompare()]);
  }

  async function lodge() {
    const m = detail.month;
    const f = m.figures || {};
    const q = `Lodge ${P.longLabel(m.period)}? Sales inc GST ${P.dollars(f.salesCents || 0)}.\n\nIts figures and invoice list are frozen as they are now. Only an admin can reopen it.`;
    if (!confirm(q)) return;
    const d = await api(`${API}/months/${encodeURIComponent(m.period)}/lodge`, { method: "POST", body: "{}" });
    toast(`${P.longLabel(m.period)} lodged`);
    await afterChange(d);
  }

  async function reopen() {
    const m = detail.month;
    if (!confirm(`Reopen ${P.longLabel(m.period)}? Its lodged figures are dropped, and it shows the figures as they are now.`)) return;
    const d = await api(`${API}/months/${encodeURIComponent(m.period)}/reopen`, { method: "POST", body: "{}" });
    toast(`${P.longLabel(m.period)} reopened`);
    await afterChange(d);
  }

  async function putHand(body) {
    const period = detail.month.period;
    try {
      const d = await api(`${API}/months/${encodeURIComponent(period)}/hand`, { method: "PUT", body: JSON.stringify(body) });
      return d;
    } catch (e) {
      $("handErr").textContent = e.message;
      return null;
    }
  }

  async function saveHand(ev) {
    ev.preventDefault();
    const err = $("handErr");
    err.textContent = "";
    const amount = P.parseDollars($("handAmount").value);
    const gst = P.parseDollars($("handGst").value);
    const note = $("handNote").value.trim();
    if (Number.isNaN(amount)) return fail("handAmount", "Type the amount in dollars, like 1,234.56");
    if (Number.isNaN(gst)) return fail("handGst", "Type the GST in dollars, like 112.23, or leave it blank");
    if (amount === null && gst !== null) return fail("handAmount", "Enter the amount the GST belongs to, or clear the GST");
    if (amount === null && note) return fail("handAmount", "Enter an amount for the note, or clear it");
    const d = await putHand({ handCents: amount, handGstCents: gst, handNote: note });
    if (!d) return;
    toast(amount === null ? "Hand amount cleared" : "Hand amount saved");
    await afterChange(d);
    function fail(id, msg) {
      err.textContent = msg;
      $(id).focus();
    }
  }

  async function clearHand() {
    const m = detail.month;
    const f = m.figures || {};
    if (!confirm(`Clear the hand amount of ${P.dollars(f.handCents)} from ${P.longLabel(m.period)}?`)) return;
    $("handErr").textContent = "";
    const d = await putHand({ handCents: null, handGstCents: null, handNote: "" });
    if (!d) return;
    toast("Hand amount cleared");
    await afterChange(d);
  }

  // --- the comparison ----------------------------------------------------------------------
  async function loadCompare() {
    try {
      compareData = await api(`${API}/compare`);
      renderCompare();
    } catch (e) {
      $("compareSection").hidden = true;
      showError(e);
    }
  }

  // The FY's line colour: the current one teal, the one before it the label grey, older ones
  // the muted grey. No other colours (contracts section 9.1).
  function lineClass(fy, current) {
    if (fy === current) return "ba-l-now";
    if (fy === current - 1) return "ba-l-last";
    return "ba-l-old";
  }

  function compactDollars(cents) {
    const d = cents / 100;
    const a = Math.abs(d);
    if (a >= 1e6) return `${d < 0 ? "-" : ""}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "")}m`;
    if (a >= 1e3) return `${d < 0 ? "-" : ""}$${Math.round(a / 1e3)}k`;
    return `${d < 0 ? "-" : ""}$${Math.round(a)}`;
  }

  // A tidy step for about four gridlines.
  function niceStep(span) {
    const raw = span / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const k of [1, 2, 2.5, 5, 10]) if (raw <= k * mag) return k * mag;
    return 10 * mag;
  }

  function renderCompare() {
    const c = compareData;
    if (!c || !Array.isArray(c.fys) || !c.fys.length) {
      $("compareSection").hidden = true;
      return;
    }
    const fys = c.fys.slice().sort((a, b) => a - b);
    const current = year ? year.currentFy : fys[fys.length - 1];
    const rows = c.rows || [];

    // the table: rows Jul-Jun, a column per FY (oldest on the left)
    $("cmpHead").replaceChildren(
      el("tr", {},
        el("th", { scope: "col", text: "Month" }),
        ...fys.map((fy) => el("th", { scope: "col", class: "num" + (fy === current ? " ba-cmp-now" : ""), text: P.fyLabel(fy) })))
    );
    $("cmpRows").replaceChildren(
      ...rows.map((r) =>
        el("tr", {},
          el("th", { scope: "row", text: r.label }),
          ...fys.map((fy) => {
            const v = r.values ? r.values[fy] : null;
            return el("td", { class: "num" + (fy === current ? " ba-cmp-now" : ""), text: v === null || v === undefined ? "" : P.dollars(v) });
          })))
    );

    // the chart, drawn at the box's own width so its type stays 11px on a phone and on a wide screen
    $("compareSection").hidden = false;
    const box = $("chartBox");
    const inner = box.clientWidth - 24; // the box's padding
    const W = Math.max(300, Math.round(inner || 760));
    chartWidth = W;
    const H = W < 560 ? 220 : 260, L = 52, R = 62, T = 14, B = 28;
    const pw = W - L - R, ph = H - T - B;
    let lo = 0, hi = 0;
    for (const r of rows) for (const fy of fys) {
      const v = r.values ? r.values[fy] : null;
      if (typeof v === "number") { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    if (hi === lo) hi = lo + 100000;
    const step = niceStep(hi - lo);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const x = (i) => L + (pw * i) / 11;
    const y = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;

    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "ba-svg", role: "img", "aria-labelledby": "chartTitle" });
    const title = svg("title", { id: "chartTitle" });
    title.textContent = "Line chart of sales inc GST by month, one line per financial year. The table below has the figures.";
    root.append(title);

    for (let v = lo; v <= hi + 1; v += step) {
      root.append(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? "ba-axis" : "ba-grid" }));
      const t = svg("text", { x: L - 8, y: y(v) + 4, class: "ba-tick", "text-anchor": "end" });
      t.textContent = compactDollars(v);
      root.append(t);
    }
    const every = pw / 11 < 30 ? 2 : 1; // a narrow chart labels every other month
    rows.forEach((r, i) => {
      if (i % every) return;
      const t = svg("text", { x: x(i), y: H - 8, class: "ba-tick", "text-anchor": "middle" });
      t.textContent = r.label;
      root.append(t);
    });

    // older lines first, so the current year is drawn on top
    const ends = [];
    for (const fy of fys) {
      const cls = lineClass(fy, current);
      const g = svg("g", { class: cls });
      let d = "";
      let pen = false;
      let last = null;
      rows.forEach((r, i) => {
        const v = r.values ? r.values[fy] : null;
        if (typeof v !== "number") { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
        last = { i, v };
        const dot = svg("circle", { cx: x(i), cy: y(v), r: fy === current ? 3.5 : 2.5, class: "ba-dot" });
        const tip = svg("title");
        tip.textContent = `${r.label}, ${P.fyLabel(fy)}: ${P.dollars(v)}`;
        dot.append(tip);
        g.append(dot);
      });
      if (d) g.prepend(svg("path", { d, class: "ba-line" }));
      root.append(g);
      if (last) ends.push({ fy, cls, x: x(last.i), y: y(last.v) });
    }
    // labels at the line ends, nudged apart so they don't overlap
    const GAP = 13;
    const byX = new Map();
    for (const e of ends) {
      const k = Math.round(e.x);
      if (!byX.has(k)) byX.set(k, []);
      byX.get(k).push(e);
    }
    for (const group of byX.values()) {
      group.sort((a, b) => a.y - b.y);
      for (let i = 1; i < group.length; i++) if (group[i].y - group[i - 1].y < GAP) group[i].y = group[i - 1].y + GAP;
      const over = group.length ? group[group.length - 1].y - (H - B) : 0;
      if (over > 0) for (const e of group) e.y -= over;
      for (const e of group) {
        const t = svg("text", { x: e.x + 8, y: e.y + 4, class: `ba-endlabel ${e.cls}` });
        t.textContent = P.fyLabel(e.fy);
        root.append(t);
      }
    }
    box.replaceChildren(root);
  }

  // Redraw the chart when its box changes width (a turned phone, a resized window).
  let chartWidth = 0;
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!compareData || $("compareSection").hidden) return;
      const w = Math.max(300, Math.round($("chartBox").clientWidth - 24));
      if (w !== chartWidth) renderCompare();
    }, 150);
  });

  // --- print -------------------------------------------------------------------------------
  function print() {
    if (year) document.title = `BAS sales ${year.label || P.fyLabel(year.fy)}`;
    $("printDate").textContent = `Printed ${fmtDate(sydneyDate())}`;
    window.print();
  }

  // --- start-up ------------------------------------------------------------------------------
  function applyAccess() {
    $("viewOnly").hidden = canEdit();
  }

  async function boot() {
    if (window.cc && window.cc.ready) await window.cc.ready;
    applyAccess();
    $("prevFy").addEventListener("click", () => changeFy(-1));
    $("nextFy").addEventListener("click", () => changeFy(1));
    $("printBtn").addEventListener("click", print);
    $("closeDetail").addEventListener("click", () => closeDetail(true));
    $("prevMonth").addEventListener("click", () => detail && detail.prev && openMonth(detail.prev, true));
    $("nextMonth").addEventListener("click", () => detail && detail.next && openMonth(detail.next, true));
    $("lodgeBtn").addEventListener("click", once($("lodgeBtn"), lodge));
    $("reopenBtn").addEventListener("click", once($("reopenBtn"), reopen));
    $("handForm").addEventListener("submit", once($("handSave"), saveHand));
    $("handClear").addEventListener("click", once($("handClear"), clearHand));
    $("listToggle").addEventListener("click", () => {
      showLive = !showLive;
      if (detail) renderInvoices();
    });
    window.addEventListener("hashchange", () => {
      const p = hashPeriod();
      if (p && p !== openPeriod) openMonth(p, true);
      else if (!p && openPeriod) closeDetail(false);
    });

    // A month in the hash brings its own financial year; otherwise ?fy=, else the current one.
    const h0 = hashPeriod();
    const hp = h0 && P.compare(h0, P.HISTORY_START) >= 0 ? h0 : null;
    const qfy = new URL(location.href).searchParams.get("fy");
    const fy = hp ? P.fyOf(hp) : qfy && /^\d{4}$/.test(qfy) ? Number(qfy) : null;
    const [ok] = await Promise.all([loadYear(fy), loadCompare()]);
    if (!ok) return;
    if (hp) {
      const row = year.months.find((m) => m.period === hp);
      if (row && hasDetail(row)) await openMonth(hp, false);
      else writeUrl();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
