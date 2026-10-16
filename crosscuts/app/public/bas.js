// BAS sales (bas.html[?fy=2027][#2026-09]): the financial year's sales by month, each typed in by
// hand, with quarter and year totals; a month's detail (figures, lodging, the form where its sales
// are typed); and the same month compared across financial years. Talks to /api/bas
// (routes/bas.js, docs/plans/m9-contracts.md sections 6 and 9.1 and its 2026-10-16 note). Money is
// integer cents on the wire; it is shown and typed only through Periods (public/periods.js).
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

  function showError(e) {
    toast(`Error: ${e && e.message ? e.message : e}`);
  }

  // A button that can't be pressed twice while its request runs. Disabling it drops the focus, so
  // afterwards the focus goes back to it, or to the month's heading when it has gone (never body).
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
        const a = document.activeElement;
        if (!a || a === document.body) {
          if (ctrl.offsetParent) ctrl.focus();
          else focusDetail();
        }
      }
    };
  }

  // The month's heading (it names the month; the status line under it says where it stands).
  function focusDetail() {
    if (!$("detail").hidden) $("detail-h").focus({ preventScroll: true });
  }

  // --- state -----------------------------------------------------------------------------
  let year = null; // GET /api/bas?fy=
  let detail = null; // GET /api/bas/months/:period
  let openPeriod = null; // the month whose detail is open
  let compareData = null;
  let yearSeq = 0;
  let detailSeq = 0;
  let navPrev = null; // where the detail's Previous / Next month buttons go
  let navNext = null;

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
    }
    let word = "";
    if (!f.entered) word = m.period === current ? "Not entered yet" : "Not entered";
    else if (m.period === current) word = "Not ended";
    if (word) td.append(el("span", { class: "ba-st-word", text: word }));
    return td;
  }

  // The three figure cells of a month: blank when it isn't entered (or is outside the table's
  // range), a dash for a GST that wasn't typed.
  function figureCells(f, blank) {
    if (blank || !f.entered) return ["", "", ""].map(() => el("td", { class: "num" }));
    return [
      el("td", { class: "num ba-sales", text: money(f.salesCents) }),
      el("td", { class: "num", text: money(f.gstCents) }),
      el("td", { class: "num", text: money(f.exGstCents) }),
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
      // an entered month whose GST wasn't typed
      if (!blank && f.entered && (f.gstCents === null || f.exGstCents === null)) dash = true;
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
        if (q) body.append(sumRow("ba-qrow", q.label || P.quarterLabel(y.fy, q.q), q, 3));
      }
    });
    const foot = $("yearFoot");
    foot.replaceChildren();
    if (y.total) foot.append(sumRow("ba-yrow", "Year total", y.total, 12));
    if ((y.total && y.total.enteredCount && y.total.gstCents === null) || quarters.some((q) => q.enteredCount && q.gstCents === null)) dash = true;
    $("dashKey").hidden = !dash;
    $("csvLink").href = `${API}/sales.csv?fy=${encodeURIComponent(y.fy)}`;
    $("yearSection").hidden = false;
  }

  // A quarter or the year: the sums of the months entered, and "2 of 3 lodged". Blank when no
  // month in it is entered.
  function sumRow(cls, label, s, of) {
    const tr = el("tr", { class: cls });
    tr.append(el("th", { scope: "row", class: "ba-mcell", text: label }));
    tr.append(...figureCells({ entered: !!s.enteredCount, ...s }, false));
    tr.append(el("td", { class: "ba-st", text: s.lodgedCount ? `${s.lodgedCount} of ${of} lodged` : "" }));
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
    if (!okToLeave()) return;
    closeDetail(false);
    await loadYear(fy);
  }

  // --- the sales typed but not saved ------------------------------------------------------
  function typedValues() {
    return [$("salesAmount").value, $("salesGst").value, $("salesNote").value];
  }
  // True when the sales form on screen differs from the month's saved figures.
  function typedDirty() {
    if (!detail || $("detail").hidden || $("detailBody").hidden || $("salesForm").hidden) return false;
    const f = detail.month.figures || {};
    const [a, g, n] = typedValues();
    return !(
      P.parseDollars(a) === (f.salesCents ?? null) &&
      P.parseDollars(g) === (f.gstCents ?? null) &&
      n.trim() === (f.note || "").trim()
    );
  }
  // Before the month on screen goes (another month, Close, another year, the hash): ask first
  // when the sales form has typing that isn't saved.
  function okToLeave() {
    if (!typedDirty()) return true;
    return confirm(`The sales you typed for ${P.longLabel(detail.month.period)} aren't saved. Leave them unsaved?`);
  }

  // --- a month's detail -------------------------------------------------------------------
  function toggleMonth(period) {
    if (!okToLeave()) return;
    if (period === openPeriod) closeDetail(true);
    else openMonth(period, true);
  }

  // The detail's Previous / Next month buttons.
  function setMonthNav(prev, next) {
    navPrev = prev || null;
    navNext = next || null;
    const pb = $("prevMonth"), nb = $("nextMonth");
    pb.disabled = !navPrev;
    nb.disabled = !navNext;
    pb.setAttribute("aria-label", navPrev ? `Previous month, ${P.longLabel(navPrev)}` : "Previous month");
    nb.setAttribute("aria-label", navNext ? `Next month, ${P.longLabel(navNext)}` : "Next month");
  }
  // Without the server's answer (a failed load): the months either side, within the history and
  // up to the current month as the year table knows it.
  function fallbackNav(period) {
    const prev = P.compare(period, P.HISTORY_START) > 0 ? P.addMonths(period, -1) : null;
    const cur = currentPeriodOf(year);
    const later = cur ? P.compare(period, cur) < 0 : !!year && P.fyOf(period) < year.currentFy;
    return [prev, later ? P.addMonths(period, 1) : null];
  }
  function goMonth(to) {
    if (!to || !okToLeave()) return;
    openMonth(to, true);
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

  // Opens a month's detail. A month before the history, or after the current month, has none: it
  // opens nothing, closes any open detail and puts the URL right (the year table's guard).
  async function openMonth(period, focus) {
    if (!year || !P.validPeriod(period) || beforeHistory(period) || P.fyOf(period) > year.currentFy) {
      closeDetail(false);
      return;
    }
    // A month in another financial year brings that year's table with it.
    if (P.fyOf(period) !== year.fy) {
      const ok = await loadYear(P.fyOf(period));
      if (!ok) return;
    }
    const row = year.months.find((m) => m.period === period);
    if (!row || !hasDetail(row)) {
      closeDetail(false);
      return;
    }
    const seq = ++detailSeq;
    openPeriod = period;
    markOpenRow();
    writeUrl();
    const box = $("detail");
    box.hidden = false;
    $("detail-h").textContent = P.longLabel(period);
    $("detailStatus").textContent = "Loading...";
    $("detailBody").hidden = true;
    setMonthNav(null, null);
    try {
      const d = await api(`${API}/months/${encodeURIComponent(period)}`);
      if (seq !== detailSeq) return;
      detail = d;
      $("detailStatus").textContent = "";
      renderDetail();
    } catch (e) {
      if (seq !== detailSeq) return;
      detail = null;
      $("detailStatus").textContent = e.message;
      setMonthNav(...fallbackNav(period));
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
  ];

  function renderDetail() {
    const d = detail;
    const m = d.month;
    const f = m.figures || {};
    const lodged = !!m.lodged;
    const isCurrent = !d.next; // the server's next is null at the current month
    const edit = canEdit();

    $("detail-h").textContent = P.longLabel(m.period);
    setMonthNav(d.prev, d.next);

    // where the month stands
    let st = "";
    if (lodged) {
      const by = m.lodged.by && m.lodged.by.name ? ` by ${m.lodged.by.name}` : "";
      st = `Lodged ${fmtDate(sydneyDate(m.lodged.at))}${by}.`;
    } else if (!f.entered) {
      st = isCurrent ? "Not entered yet. This month hasn't ended, so it can't be lodged." : "Not entered yet.";
    } else if (isCurrent) {
      st = "This month hasn't ended yet, so it can't be lodged.";
    }
    $("detailStatus").textContent = st;

    // figures
    const rows = $("figsRows");
    rows.replaceChildren();
    for (const [label, show, key] of FIG_ROWS) {
      const tr = el("tr", {}, el("th", { scope: "row", class: "ba-fig-k", text: label }));
      // blank, not a dash, while nothing is entered
      tr.append(el("td", { class: "num", text: f.entered ? show(f) : "" }));
      if (key === "salesCents") tr.classList.add("ba-fig-main");
      rows.append(tr);
    }
    const note = (f.note || "").trim();
    $("noteLine").hidden = !note;
    $("noteLine").textContent = note ? `Note: ${note}` : "";

    // lodge / reopen
    const lodgeOk = edit && !lodged && !isCurrent && f.entered;
    const reopenOk = canReopen() && lodged;
    $("lodgeBtn").hidden = !lodgeOk;
    $("reopenBtn").hidden = !reopenOk;
    $("monthActs").hidden = !(lodgeOk || reopenOk);
    $("lockedNote").hidden = !(edit && lodged);

    // the sales form
    const form = $("salesForm");
    form.hidden = !(edit && !lodged);
    if (!form.hidden) {
      $("salesAmount").value = f.entered ? P.dollars(f.salesCents) : "";
      $("salesGst").value = f.entered && f.gstCents !== null ? P.dollars(f.gstCents) : "";
      $("salesNote").value = f.note || "";
      $("salesErr").textContent = "";
      $("salesClear").hidden = !f.entered;
    }
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

  // A lodge or reopen the server refused because the month changed elsewhere (lodged or reopened
  // in another tab): say why, then show the month as it is now so the page stops offering it.
  async function refusedRefresh(e, period) {
    showError(e);
    try {
      const d = await api(`${API}/months/${encodeURIComponent(period)}`);
      if (period === openPeriod) {
        detail = d;
        renderDetail();
      }
    } catch (_) {
      // the toast above already said what went wrong
    }
    await loadYear(year ? year.fy : null);
  }

  // What a lodge freezes: whether the month is lodged and its figures.
  function lodgeKey(d) {
    const m = d.month;
    const f = m.figures || {};
    return JSON.stringify([!!m.lodged, f.entered, f.salesCents ?? null, f.gstCents ?? null, f.note || ""]);
  }

  // Shows a fresh detail; typing in the sales form that isn't saved stays in it.
  function showDetailKeepingTyping(d) {
    const typed = typedDirty() ? typedValues() : null;
    detail = d;
    renderDetail();
    if (typed && !$("salesForm").hidden) {
      $("salesAmount").value = typed[0];
      $("salesGst").value = typed[1];
      $("salesNote").value = typed[2];
    }
  }

  // The confirm names the figure that will be frozen: the month is fetched again first, and if it
  // has changed since it was shown, the page shows it as it is now and doesn't lodge.
  async function lodge() {
    const period = detail.month.period;
    const shown = lodgeKey(detail);
    let fresh;
    try {
      fresh = await api(`${API}/months/${encodeURIComponent(period)}`);
    } catch (e) {
      showError(e);
      return;
    }
    if (period !== openPeriod) return;
    if (lodgeKey(fresh) !== shown) {
      showDetailKeepingTyping(fresh);
      toast(`${P.longLabel(period)} changed since you opened it; check the figures`);
      focusDetail();
      await loadYear(year ? year.fy : null);
      return;
    }
    const f = fresh.month.figures || {};
    const unsaved = typedDirty() ? "\n\nThe sales you typed aren't saved; they are left out." : "";
    const q = `Lodge ${P.longLabel(period)}? Sales inc GST ${P.dollars(f.salesCents || 0)}.\n\nIts figures are frozen as they are now. Only an admin can reopen it.${unsaved}`;
    if (!confirm(q)) return;
    let d;
    try {
      d = await api(`${API}/months/${encodeURIComponent(period)}/lodge`, { method: "POST", body: "{}" });
    } catch (e) {
      await refusedRefresh(e, period);
      focusDetail();
      return;
    }
    toast(`${P.longLabel(period)} lodged`);
    await afterChange(d);
    focusDetail();
  }

  async function reopen() {
    const m = detail.month;
    if (!confirm(`Reopen ${P.longLabel(m.period)}? It can then be changed and lodged again.`)) return;
    let d;
    try {
      d = await api(`${API}/months/${encodeURIComponent(m.period)}/reopen`, { method: "POST", body: "{}" });
    } catch (e) {
      await refusedRefresh(e, m.period);
      focusDetail();
      return;
    }
    toast(`${P.longLabel(m.period)} reopened`);
    await afterChange(d);
    focusDetail();
  }

  async function putSales(body) {
    const period = detail.month.period;
    try {
      const d = await api(`${API}/months/${encodeURIComponent(period)}/sales`, { method: "PUT", body: JSON.stringify(body) });
      return d;
    } catch (e) {
      $("salesErr").textContent = e.message;
      // Lodged meanwhile (another tab): the form can't be used any more, so show the month as it
      // is now. A refused value leaves the typing and the sentence where they are.
      try {
        const now = await api(`${API}/months/${encodeURIComponent(period)}`);
        if (now.month.lodged && period === openPeriod) {
          toast(`Error: ${e.message}`);
          await afterChange(now);
        }
      } catch (_) {
        // keep the sentence already shown
      }
      return null;
    }
  }

  async function saveSales(ev) {
    ev.preventDefault();
    const err = $("salesErr");
    err.textContent = "";
    const amount = P.parseDollars($("salesAmount").value);
    const gst = P.parseDollars($("salesGst").value);
    const note = $("salesNote").value.trim();
    if (Number.isNaN(amount)) return fail("salesAmount", "Type the sales in dollars, like 1,234.56");
    if (Number.isNaN(gst)) return fail("salesGst", "Type the GST in dollars, like 112.23, or leave it blank");
    if (amount === null && gst !== null) return fail("salesAmount", "Enter the sales for the GST to go with");
    if (amount === null && note) return fail("salesAmount", "Enter the sales for the note, or clear the note");
    const d = await putSales({ salesCents: amount, gstCents: gst, note });
    if (!d) {
      // refused: back to the amount, with the sentence under the form (lodged meanwhile: the form
      // has gone, so the month's heading)
      if (!$("salesForm").hidden) $("salesAmount").focus();
      else focusDetail();
      return;
    }
    toast(amount === null ? "Sales cleared" : "Sales saved");
    await afterChange(d);
    focusDetail();
    function fail(id, msg) {
      err.textContent = msg;
      $(id).focus();
    }
  }

  async function clearSales() {
    const m = detail.month;
    const f = m.figures || {};
    if (!confirm(`Clear the sales of ${P.dollars(f.salesCents || 0)} from ${P.longLabel(m.period)}?`)) return;
    $("salesErr").textContent = "";
    const d = await putSales({ salesCents: null, gstCents: null, note: "" });
    if (!d) return; // once() puts the focus back on Clear, or on the heading if the form has gone
    toast("Sales cleared");
    await afterChange(d);
    focusDetail();
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
    $("closeDetail").addEventListener("click", () => okToLeave() && closeDetail(true));
    $("prevMonth").addEventListener("click", () => goMonth(navPrev));
    $("nextMonth").addEventListener("click", () => goMonth(navNext));
    $("lodgeBtn").addEventListener("click", once($("lodgeBtn"), lodge));
    $("reopenBtn").addEventListener("click", once($("reopenBtn"), reopen));
    $("salesForm").addEventListener("submit", once($("salesSave"), saveSales));
    $("salesClear").addEventListener("click", once($("salesClear"), clearSales));
    // A hand-edited hash: a month with a detail opens it; anything else (not a month, before Jun
    // 2023, after this month) opens nothing, closes the detail and puts the URL right. Unsaved
    // typing in the sales form is asked about first (Cancel puts the hash back).
    window.addEventListener("hashchange", () => {
      const p = hashPeriod();
      if (p && p === openPeriod) return;
      if (!openPeriod && !p) {
        writeUrl();
        return;
      }
      if (!okToLeave()) {
        writeUrl();
        return;
      }
      if (p) openMonth(p, true);
      else closeDetail(false);
    });
    window.addEventListener("beforeunload", (e) => {
      if (typedDirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    // A month in the hash brings its own financial year; otherwise ?fy=, else the current one.
    const h0 = hashPeriod();
    const hp = h0 && !beforeHistory(h0) ? h0 : null;
    const qfy = new URL(location.href).searchParams.get("fy");
    const qfyNum = qfy && /^\d{4}$/.test(qfy) ? Number(qfy) : null;
    let [ok] = await Promise.all([loadYear(hp ? P.fyOf(hp) : qfyNum), loadCompare()]);
    // a month in a year that hasn't started: the year the page would show without it
    if (!ok && hp) ok = await loadYear(qfyNum);
    if (!ok) return;
    if (h0) await openMonth(h0, false);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
