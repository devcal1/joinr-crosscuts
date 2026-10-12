// One pay run (payrun.html?id=N[&sheet=M][#summary]): the timesheet entry screen that mirrors the
// paper form row for row, and the pay-run summary for keying into MYOB.
// docs/plans/m8-contracts.md sections 6 (the API) and 8.2 (this page). All hour maths (the daily
// split, totals, display and parsing) comes from public/paymaths.js (window.PayMaths); nothing here
// splits hours itself. Hours are integer minutes on the wire. User text goes in via textContent.
(function () {
  "use strict";

  const PM = window.PayMaths;
  const $ = (id) => document.getElementById(id);

  // The typed columns, in the paper's order (Tab moves across them).
  const FIELDS = ["start", "finish", "lunch", "phol", "sick", "arl", "onsite", "job"];
  const HOUR_FIELDS = ["start", "finish", "lunch", "phol", "sick", "arl", "onsite"];
  const MIN_KEY = {
    start: "startMin", finish: "finishMin", lunch: "lunchMin", phol: "pholMin",
    sick: "sickMin", arl: "arlMin", onsite: "onsiteMin",
  };
  const LABEL = {
    start: "Start", finish: "Finish", lunch: "Lunch", phol: "P HOL",
    sick: "SICK", arl: "ARL", onsite: "ON SITE", job: "JOB",
  };
  const PARSE = {
    start: PM.parseClock, finish: PM.parseClock, lunch: PM.parseLunch,
    phol: PM.parseHours, sick: PM.parseHours, arl: PM.parseHours, onsite: PM.parseHours,
  };
  // Tidy form of a parsed value: times as 07:30, lunch as minutes, hours to two places.
  function tidy(field, min) {
    if (min == null) return "";
    if (field === "start" || field === "finish") return PM.clock(min);
    if (field === "lunch") return String(min);
    return PM.hours(min);
  }
  const UNREADABLE = {
    start: "Can't read Start: type a time like 7:30",
    finish: "Can't read Finish: type a time like 16:30",
    lunch: "Can't read Lunch: type minutes (30) or h:mm (0:45)",
    phol: "Can't read P HOL: type hours like 7.5 or 7:30",
    sick: "Can't read SICK: type hours like 7.5 or 7:30",
    arl: "Can't read ARL: type hours like 7.5 or 7:30",
    onsite: "Can't read ON SITE: type hours like 7.5 or 7:30",
  };
  // Which cells a dayProblem sentence outlines.
  const PROBLEM_CELLS = {
    "Give both a start and a finish": ["start", "finish"],
    "Finish must be after start": ["start", "finish"],
    "Lunch needs a start and a finish": ["start", "finish", "lunch"],
    "Lunch is longer than the day": ["lunch"],
    "More than 24 hours in one day": ["start", "finish", "phol", "sick", "arl"],
    "On-site hours are more than the hours worked": ["onsite"],
  };

  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }

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

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function longDate(date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }
  function dayDate(date) {
    const key = PM.dayKeyOf(date);
    return (key ? PM.DAY_LABELS[key] + " " : "") + PM.shortDate(date);
  }
  // A UTC ISO timestamp as a Sydney date, '12 Oct 2026'.
  function sydneyDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return longDate(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d));
  }

  // ------------------------------------------------------------------ state ---

  const params = new URLSearchParams(location.search);
  const runId = /^[1-9]\d*$/.test(params.get("id") || "") ? Number(params.get("id")) : null;
  let wantSheet = /^[1-9]\d*$/.test(params.get("sheet") || "") ? Number(params.get("sheet")) : null;

  let canEdit = false;
  let isAdmin = false;
  let run = null; // run object (section 6.2)
  let rules = null; // the section 3 rules object the split uses
  let summary = null; // section 6.4
  let summaryStale = true;
  let tab = "sheets";

  let sheet = null; // the timesheet as last loaded or saved (section 6.2)
  let rows = []; // per day: {date, key, cells: {field: {text, sug, input}}, tr, hint, problem}
  let baseline = ""; // snapshot() at load, for the unsaved-changes guard
  let saving = false;
  let loadSeq = 0;

  const editable = () => canEdit && run && run.status === "open";

  // ------------------------------------------------------------ the header ---

  function renderHeader() {
    $("runLabel").textContent = run.label || PM.fortnightLabel(run.startDate);
    document.title = `Pay run ${run.label || ""} - Crosscuts`;

    const badge = $("runBadge");
    badge.hidden = false;
    if (run.status === "open") {
      badge.className = "hs-badge hs-badge-check";
      badge.textContent = "Open";
    } else if (run.myobEnteredDate) {
      badge.className = "hs-badge hs-badge-teal";
      badge.textContent = "Entered in MYOB";
    } else {
      badge.className = "hs-badge hs-badge-na";
      badge.textContent = "Finalised";
    }

    const open = run.status === "open";
    const sheets = run.timesheets || [];
    $("finaliseBtn").hidden = !(canEdit && open);
    $("myobWrap").hidden = !(canEdit && !open);
    $("myobTick").checked = !!run.myobEnteredDate;
    $("reopenBtn").hidden = !(isAdmin && !open);
    $("deleteBtn").hidden = !(canEdit && open && sheets.every((t) => !t.saved));

    const sum = $("printSummary");
    sum.href = `/payprint.html?id=${run.id}&what=summary`;
    sum.hidden = false;
    const ps = $("printSheets");
    ps.href = `/payprint.html?start=${encodeURIComponent(run.startDate)}&what=sheets`;
    ps.hidden = false;

    const typed = sheets.filter((t) => t.entered).length;
    const bits = [`${longDate(run.startDate)} to ${longDate(run.endDate)}`, `${typed} of ${sheets.length} typed in`];
    if (!open && run.finalisedAt) {
      bits.push(`Finalised ${sydneyDate(run.finalisedAt)}` + (run.finalisedBy ? ` by ${run.finalisedBy.name}` : ""));
    }
    if (run.myobEnteredDate) bits.push(`Entered in MYOB ${longDate(run.myobEnteredDate)}`);
    if (!canEdit) bits.push("View only");
    $("runMeta").textContent = bits.join(" · ");
  }

  // --------------------------------------------------------------- the tabs ---

  function setTab(which, focus) {
    tab = which === "summary" ? "summary" : "sheets";
    const sheetsOn = tab === "sheets";
    $("tabSheets").setAttribute("aria-selected", String(sheetsOn));
    $("tabSummary").setAttribute("aria-selected", String(!sheetsOn));
    $("tabSheets").tabIndex = sheetsOn ? 0 : -1;
    $("tabSummary").tabIndex = sheetsOn ? -1 : 0;
    $("panelSheets").hidden = !sheetsOn;
    $("panelSummary").hidden = sheetsOn;
    if (focus) (sheetsOn ? $("tabSheets") : $("tabSummary")).focus();
    syncUrl();
    if (!sheetsOn) loadSummary();
  }

  function syncUrl() {
    const q = new URLSearchParams();
    q.set("id", String(runId));
    if (sheet) q.set("sheet", String(sheet.id));
    const url = `${location.pathname}?${q.toString()}${tab === "summary" ? "#summary" : ""}`;
    history.replaceState(null, "", url);
  }

  // ---------------------------------------------------------- the sheet list ---

  function renderList() {
    const list = $("sheetList");
    list.replaceChildren();
    const sheets = run.timesheets || [];
    $("sheetCount").textContent = sheets.length ? `${sheets.filter((t) => t.entered).length} of ${sheets.length} typed in` : "";
    $("noSheets").hidden = sheets.length > 0;
    const dirtyNow = isDirty();
    for (const t of sheets) {
      const on = sheet && sheet.id === t.id;
      const b = el("button", { type: "button", class: "pr-item" + (on ? " pr-item-on" : ""), "data-id": t.id });
      if (on) b.setAttribute("aria-current", "true");
      b.append(el("span", { class: "pr-item-name", text: t.name }));
      let state;
      if (on && dirtyNow) state = el("span", { class: "pr-item-state pr-st-unsaved", text: "Unsaved" });
      else if (t.entered) state = el("span", { class: "pr-item-state pr-st-typed", text: "Typed in" });
      else if (t.saved) state = el("span", { class: "pr-item-state pr-st-saved", text: "Saved" });
      else state = el("span", { class: "pr-item-state pr-st-new", text: "Not started" });
      const hrs = el("span", { class: "pr-item-hrs", text: PM.hours((t.totals && t.totals.workedMin) || 0) + " h" });
      b.append(el("span", { class: "pr-item-sub" }, state, hrs));
      b.addEventListener("click", () => selectSheet(t.id));
      list.append(el("li", null, b));
    }
    $("sideTools").hidden = !editable();
    syncRemove();
  }

  // A sheet can be removed while it has nothing stored (no typed day and no notes).
  function storedEmpty(ts) {
    if (!ts) return false;
    if ((ts.notes || "") !== "") return false;
    return (ts.days || []).every((d) => d.job === "" && HOUR_FIELDS.every((f) => d[MIN_KEY[f]] == null));
  }
  function syncRemove() {
    $("removeSheetBtn").hidden = !(editable() && sheet && storedEmpty(sheet));
  }

  function nextSheetId() {
    const sheets = run.timesheets || [];
    const i = sheets.findIndex((t) => sheet && t.id === sheet.id);
    return i >= 0 && i + 1 < sheets.length ? sheets[i + 1].id : null;
  }

  function confirmDiscard() {
    if (!isDirty()) return true;
    return confirm(`You have unsaved changes on ${sheet.name}'s sheet. Leave them unsaved?`);
  }

  async function selectSheet(id, opts) {
    if (!(opts && opts.skipGuard) && sheet && sheet.id === id) return;
    if (!(opts && opts.skipGuard) && !confirmDiscard()) return;
    const seq = ++loadSeq;
    $("saveStatus").textContent = "";
    try {
      const ts = await api(`/api/payruns/${runId}/timesheets/${id}`);
      if (seq !== loadSeq) return;
      showSheet(ts);
    } catch (e) {
      if (seq !== loadSeq) return;
      $("saveStatus").textContent = `Couldn't open that sheet: ${e.message}`;
    }
  }

  // ----------------------------------------------------------- the entry grid ---

  function showSheet(ts) {
    sheet = ts;
    lastDirty = false;
    hideStale();
    $("entry").hidden = false;
    $("empName").textContent = ts.name;
    $("fromDate").textContent = longDate(run.startDate);
    $("toDate").textContent = longDate(run.endDate);
    $("sheetState").textContent = ts.saved ? (ts.updatedAt ? `Last saved ${sydneyDate(ts.updatedAt)}` : "Saved") : "Not saved yet";

    buildGrid();
    const ed = editable();
    $("notes").hidden = !ed;
    $("notesRo").hidden = ed;
    $("notes").value = ts.notes || "";
    $("notesRo").textContent = ts.notes || "No notes.";
    $("notesRo").classList.toggle("pr-none", !ts.notes);
    for (const [id, v] of [["signedTick", ts.signed], ["enteredTick", ts.entered]]) {
      $(id).checked = !!v;
      $(id).disabled = !ed;
    }
    $("saveBar").hidden = !ed;
    // A sheet never saved opens with the suggestions filled in; a saved one offers the button.
    if (ed && !ts.saved) fillSuggestions(true);
    $("fillBtn").hidden = !(ed && ts.saved && hasSuggestions());
    baseline = snapshot();
    recomputeAll();
    syncUrl();
    renderList();
  }

  function suggestionFor(date) {
    return (sheet && sheet.suggestions && sheet.suggestions[date]) || null;
  }
  function hasSuggestions() {
    return Object.values((sheet && sheet.suggestions) || {}).some(
      (s) => s && ((s.job || "") !== "" || s.pholMin != null || s.sickMin != null || s.arlMin != null)
    );
  }
  function hintFor(date) {
    const s = suggestionFor(date);
    if (!s) return "";
    if (s.reason === "holiday") return s.holidayName || "Public holiday";
    if (s.reason === "leave") return "Leave on the board";
    if (s.reason === "sick") return "Sick on the board";
    if (s.reason === "other") return "Away";
    return "";
  }

  function buildGrid() {
    const body = $("gridBody");
    body.replaceChildren();
    rows = [];
    const ed = editable();
    (sheet.days || []).forEach((d, i) => {
      const tr = el("tr", { class: i === 5 ? "pr-week2" : null });
      tr.append(el("td", { class: "pr-date", text: PM.shortDate(d.date) }));
      tr.append(el("td", { class: "pr-day", text: PM.DAY_LABELS[d.day] || d.day || "" }));
      const row = { date: d.date, key: d.day || PM.dayKeyOf(d.date), cells: {}, tr };
      for (const f of FIELDS) {
        const td = el("td", { class: f === "job" ? "pr-col-job" : "pr-c" });
        const text = f === "job" ? d.job || "" : tidy(f, d[MIN_KEY[f]]);
        const cell = { text, sug: false, input: null, td };
        if (ed) {
          const label = `${LABEL[f]}, ${dayDate(d.date)}`;
          const input = el("input", {
            class: "pr-in" + (f === "job" ? " pr-in-job" : ""),
            type: "text",
            autocomplete: "off",
            spellcheck: "false",
            inputmode: f === "job" ? null : "decimal",
            maxlength: f === "job" ? "200" : "8",
            "aria-label": label,
            "data-row": String(i),
            "data-field": f,
          });
          input.value = text;
          input.addEventListener("input", () => onInput(i, f));
          input.addEventListener("blur", () => onBlur(i, f));
          input.addEventListener("keydown", (e) => onKey(e, i, f));
          cell.input = input;
          td.append(input);
        } else {
          td.textContent = text;
          td.classList.add("pr-ro");
        }
        row.cells[f] = cell;
        tr.append(td);
      }
      row.totalTd = el("td", { class: "num pr-calc" });
      row.otTd = el("td", { class: "num pr-calc" });
      row.dtTd = el("td", { class: "num pr-calc" });
      row.hintTd = el("td", { class: "pr-col-hint" });
      tr.append(row.totalTd, row.otTd, row.dtTd, row.hintTd);
      body.append(tr);
      rows.push(row);
    });
  }

  function setCellText(i, f, text, sug) {
    const cell = rows[i].cells[f];
    cell.text = text;
    cell.sug = !!sug;
    if (cell.input) {
      cell.input.value = text;
      cell.input.classList.toggle("pr-sug", cell.sug);
    } else {
      cell.td.textContent = text;
    }
  }

  // Fills the blank cells from the suggestions (job, P HOL, SICK, ARL), marked as suggestions.
  // Returns how many cells were filled.
  function fillSuggestions(quiet) {
    let n = 0;
    rows.forEach((row, i) => {
      const s = suggestionFor(row.date);
      if (!s) return;
      if ((s.job || "") !== "" && row.cells.job.text.trim() === "") {
        setCellText(i, "job", s.job, true);
        n++;
      }
      for (const [f, k] of [["phol", "pholMin"], ["sick", "sickMin"], ["arl", "arlMin"]]) {
        if (s[k] != null && row.cells[f].text.trim() === "") {
          setCellText(i, f, tidy(f, s[k]), true);
          n++;
        }
      }
    });
    if (!quiet) {
      recomputeAll();
      $("saveStatus").textContent = n
        ? `Filled ${n} blank ${n === 1 ? "cell" : "cells"} from the suggestions.`
        : "Nothing to fill: the suggested cells already have values.";
    }
    return n;
  }

  // The parsed day, or what is wrong with it.
  function rowState(row) {
    const day = { date: row.date };
    const bad = [];
    for (const f of HOUR_FIELDS) {
      const v = PARSE[f](row.cells[f].text);
      if (Number.isNaN(v)) bad.push(f);
      day[MIN_KEY[f]] = Number.isNaN(v) ? null : v;
    }
    day.job = row.cells.job.text.trim();
    if (bad.length) return { day, bad, sentence: UNREADABLE[bad[0]] };
    const problem = PM.dayProblem(day);
    if (problem) return { day, bad: PROBLEM_CELLS[problem] || HOUR_FIELDS, sentence: problem };
    return { day, bad: [], sentence: null, split: PM.split(day, row.key, rules) };
  }

  function recomputeRow(row) {
    if (!editable()) return null;
    const st = rowState(row);
    for (const f of FIELDS) {
      const c = row.cells[f];
      const bad = st.bad.includes(f);
      c.input.classList.toggle("pr-bad", bad);
      if (bad) c.input.setAttribute("aria-invalid", "true");
      else c.input.removeAttribute("aria-invalid");
    }
    row.tr.classList.toggle("pr-row-bad", !!st.sentence);
    const sp = st.split;
    const hasTimes = st.day.startMin != null && st.day.finishMin != null;
    row.totalTd.textContent = sp && hasTimes ? PM.hours(sp.workedMin) : "";
    row.otTd.textContent = sp && sp.otMin ? PM.hours(sp.otMin) : "";
    row.dtTd.textContent = sp && sp.dtMin ? PM.hours(sp.dtMin) : "";
    renderHint(row, st.sentence);
    return st;
  }

  function renderHint(row, sentence) {
    row.hintTd.replaceChildren();
    if (sentence) row.hintTd.append(el("span", { class: "pr-problem", text: sentence }));
    const hint = hintFor(row.date);
    if (hint) row.hintTd.append(el("span", { class: "pr-hint", text: hint }));
  }

  // Live totals while editing; the stored figures when read-only.
  function recomputeAll() {
    let tot;
    if (editable()) {
      const days = [];
      for (const row of rows) {
        const st = recomputeRow(row);
        // A day with a problem still counts its readable leave and on-site hours, but no work.
        if (st) days.push(Object.assign({}, st.day, st.split || {}));
      }
      tot = PM.totals(days);
    } else {
      rows.forEach((row, i) => {
        const d = sheet.days[i];
        const hasTimes = d.startMin != null && d.finishMin != null;
        row.totalTd.textContent = hasTimes ? PM.hours(d.workedMin) : "";
        row.otTd.textContent = d.otMin ? PM.hours(d.otMin) : "";
        row.dtTd.textContent = d.dtMin ? PM.hours(d.dtMin) : "";
        renderHint(row, null);
      });
      tot = sheet.totals || PM.totals(sheet.days);
    }
    renderTotals(tot);
    $("keyLine").hidden = !rows.some((r) => FIELDS.some((f) => r.cells[f].sug));
  }

  function renderTotals(t) {
    const tr = $("totalsRow");
    tr.replaceChildren();
    tr.append(el("th", { scope: "row", class: "pr-tot-label", text: "TOTALS" }));
    tr.append(el("td"), el("td"), el("td"), el("td"));
    for (const k of ["pholMin", "sickMin", "arlMin", "onsiteMin"]) tr.append(el("td", { class: "num", text: PM.hours(t[k]) }));
    tr.append(el("td"));
    for (const k of ["workedMin", "otMin", "dtMin"]) tr.append(el("td", { class: "num pr-tot-strong", text: PM.hours(t[k]) }));
    tr.append(el("td"));
    $("sNormal").textContent = PM.hours(t.normalMin);
    $("sOt").textContent = PM.hours(t.otMin);
    $("sDt").textContent = PM.hours(t.dtMin);
    $("sPhol").textContent = PM.hours(t.pholMin);
    $("sArl").textContent = PM.hours(t.arlMin);
    $("sSick").textContent = PM.hours(t.sickMin);
    $("sOnsite").textContent = PM.hours(t.onsiteMin);
  }

  function onInput(i, f) {
    const cell = rows[i].cells[f];
    cell.text = cell.input.value;
    if (cell.sug) {
      cell.sug = false;
      cell.input.classList.remove("pr-sug");
    }
    recomputeAll();
    markDirty();
    if ($("saveStatus").textContent.startsWith("Not saved")) $("saveStatus").textContent = "";
  }

  function onBlur(i, f) {
    const cell = rows[i].cells[f];
    if (f === "job") {
      const t = cell.input.value.trim();
      if (t !== cell.input.value) cell.input.value = cell.text = t;
      return;
    }
    const v = PARSE[f](cell.input.value);
    if (v === null) {
      if (cell.input.value !== "") cell.input.value = cell.text = "";
    } else if (!Number.isNaN(v)) {
      const t = tidy(f, v);
      if (t !== cell.input.value) cell.input.value = cell.text = t;
    }
  }

  function focusCell(i, f) {
    const row = rows[i];
    if (!row || !row.cells[f].input) return false;
    row.cells[f].input.focus();
    row.cells[f].input.select();
    return true;
  }

  // Tab moves across (the browser's order); Enter moves down the same column, Shift+Enter up.
  function onKey(e, i, f) {
    if (e.key !== "Enter" || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    e.preventDefault();
    if (e.shiftKey) {
      focusCell(i - 1, f);
    } else if (!focusCell(i + 1, f)) {
      $("notes").focus();
    }
  }

  // ------------------------------------------------------ dirty and the guard ---

  function snapshot() {
    if (!sheet || !editable()) return "";
    return JSON.stringify({
      days: rows.map((row) => FIELDS.map((f) => {
        if (f === "job") return row.cells.job.text.trim();
        const v = PARSE[f](row.cells[f].text);
        return Number.isNaN(v) ? "?" + row.cells[f].text : v;
      })),
      notes: $("notes").value,
      signed: $("signedTick").checked,
      entered: $("enteredTick").checked,
    });
  }
  function isDirty() {
    return !!sheet && editable() && snapshot() !== baseline;
  }
  let lastDirty = false;
  function markDirty() {
    const d = isDirty();
    if (d !== lastDirty) {
      lastDirty = d;
      renderList();
    }
  }

  // ------------------------------------------------------------------ saving ---

  async function save() {
    if (!editable() || !sheet || saving) return false;
    for (let i = 0; i < rows.length; i++) {
      const st = rowState(rows[i]);
      if (st.sentence) {
        $("saveStatus").textContent = `Not saved. Fix the orange cells first: ${dayDate(rows[i].date)}: ${st.sentence}.`;
        focusCell(i, st.bad[0] || "start");
        return false;
      }
    }
    const body = {
      days: rows.map((row) => {
        const st = rowState(row);
        const d = { date: row.date };
        for (const f of HOUR_FIELDS) d[MIN_KEY[f]] = st.day[MIN_KEY[f]];
        d.job = st.day.job;
        return d;
      }),
      notes: $("notes").value,
      signed: $("signedTick").checked,
      entered: $("enteredTick").checked,
      updatedAt: sheet.updatedAt,
    };
    saving = true;
    setSaveBusy(true);
    $("saveStatus").textContent = "Saving...";
    try {
      const res = await fetch(`/api/payruns/${runId}/timesheets/${sheet.id}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
        return false;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const at = document.activeElement;
        const back = at && at.dataset && at.dataset.field ? [Number(at.dataset.row), at.dataset.field] : null;
        updateListRow(data);
        summaryStale = true;
        showSheet(data);
        if (back) focusCell(back[0], back[1]);
        $("saveStatus").textContent = `Saved ${data.name}'s sheet.`;
        return true;
      }
      if (res.status === 409 && data && data.timesheet) {
        $("saveStatus").textContent = "";
        showStale(data.error || "Someone else saved this sheet; reload it", data.timesheet);
        return false;
      }
      $("saveStatus").textContent = `Not saved. ${data.error || `Request failed (${res.status})`}`;
      if (res.status === 409) await reloadRun(); // finalised meanwhile: show it as it now is
      return false;
    } catch (e) {
      $("saveStatus").textContent = "Not saved. Couldn't reach the server; try again.";
      return false;
    } finally {
      saving = false;
      setSaveBusy(false);
    }
  }

  function setSaveBusy(on) {
    $("saveBtn").disabled = on;
    $("saveNextBtn").disabled = on;
  }

  function updateListRow(ts) {
    const row = (run.timesheets || []).find((t) => t.id === ts.id);
    if (!row) return;
    row.entered = ts.entered;
    row.signed = ts.signed;
    row.saved = ts.saved;
    row.totals = ts.totals;
    row.name = ts.name;
    renderHeader();
  }

  let staleSheet = null;
  function showStale(sentence, ts) {
    staleSheet = ts;
    $("staleText").textContent = sentence;
    $("stale").hidden = false;
    $("reloadSheetBtn").focus();
  }
  function hideStale() {
    staleSheet = null;
    $("stale").hidden = true;
  }
  async function reloadSheet() {
    const id = sheet.id;
    let ts = staleSheet;
    try {
      ts = await api(`/api/payruns/${runId}/timesheets/${id}`);
    } catch (e) {
      if (!ts) return toast(`Error: ${e.message}`);
    }
    lastDirty = false;
    updateListRow(ts);
    showSheet(ts);
    $("saveStatus").textContent = "Reloaded the saved sheet.";
  }

  async function saveAndNext() {
    const next = nextSheetId();
    const ok = await save();
    if (!ok) return;
    if (next == null) {
      $("saveStatus").textContent = `Saved ${sheet.name}'s sheet. That was the last sheet.`;
      return;
    }
    await selectSheet(next, { skipGuard: true });
    focusCell(0, "start");
  }

  // ------------------------------------------------------- run-level actions ---

  async function reloadRun() {
    run = await api(`/api/payruns/${runId}`);
    summaryStale = true;
    renderHeader();
    renderList();
    if (sheet) {
      const still = (run.timesheets || []).some((t) => t.id === sheet.id);
      if (still) await selectSheet(sheet.id, { skipGuard: true });
    }
    if (tab === "summary") loadSummary();
  }

  async function finalise() {
    if (isDirty()) {
      if (!confirm(`Save the changes to ${sheet.name}'s sheet before finalising?`)) return;
      if (!(await save())) return;
    }
    const unticked = (run.timesheets || []).filter((t) => !t.entered).map((t) => t.name);
    let q = `Finalise the pay run for ${run.label}? This freezes every sheet and the summary.`;
    if (unticked.length) {
      q += `\n\nThese sheets aren't ticked as typed in:\n${unticked.join("\n")}\n\nFinalise anyway?`;
    }
    if (!confirm(q)) return;
    run = await api(`/api/payruns/${runId}/finalise`, { method: "POST", body: "{}" });
    summaryStale = true;
    await afterRunChange();
    toast("Pay run finalised.");
  }

  async function reopen() {
    if (!confirm(`Reopen the pay run for ${run.label}? Its sheets can be changed again and the summary is no longer frozen.`)) return;
    run = await api(`/api/payruns/${runId}/reopen`, { method: "POST", body: "{}" });
    summaryStale = true;
    await afterRunChange();
    toast("Pay run reopened.");
  }

  async function setMyob() {
    const tick = $("myobTick");
    const want = tick.checked;
    tick.disabled = true;
    try {
      run = await api(`/api/payruns/${runId}/myob`, { method: "POST", body: JSON.stringify({ entered: want }) });
      renderHeader();
      toast(want ? "Ticked as entered in MYOB." : "Unticked: not entered in MYOB.");
    } catch (e) {
      tick.checked = !want;
      toast(`Error: ${e.message}`);
    } finally {
      tick.disabled = false;
    }
  }

  async function deleteRun() {
    if (!confirm(`Delete the pay run for ${run.label}? Its blank sheets go with it.`)) return;
    await api(`/api/payruns/${runId}`, { method: "DELETE" });
    baseline = snapshot();
    location.href = "/payruns.html";
  }

  async function afterRunChange() {
    renderHeader();
    renderList();
    if (sheet) await selectSheet(sheet.id, { skipGuard: true });
    if (tab === "summary") loadSummary();
  }

  // ---------------------------------------------------------- add and remove ---

  let addPeople = [];
  async function openAdd() {
    const dlg = $("addDlg");
    const sel = $("addPerson");
    $("addError").textContent = "";
    sel.replaceChildren(el("option", { value: "", text: "Loading..." }));
    $("addOk").disabled = true;
    dlg.showModal();
    sel.focus();
    try {
      const data = await api("/api/payruns/people");
      const inRun = new Set();
      for (const t of run.timesheets || []) {
        if (t.person && t.person.id != null) inRun.add("p" + t.person.id);
        if (t.person && t.person.workerId != null) inRun.add("w" + t.person.workerId);
      }
      addPeople = (data.people || []).filter((p) => !p.archived &&
        !(p.id != null && inRun.has("p" + p.id)) && !(p.workerId != null && inRun.has("w" + p.workerId)));
      sel.replaceChildren();
      if (!addPeople.length) {
        sel.append(el("option", { value: "", text: "Everyone is already in this pay run" }));
        return;
      }
      addPeople.forEach((p, i) => {
        let text = p.name;
        if (p.kind === "pay_only") text += " (pay only)";
        if (!p.onPayRun) text += " (off the pay run)";
        sel.append(el("option", { value: String(i), text }));
      });
      $("addOk").disabled = false;
    } catch (e) {
      sel.replaceChildren(el("option", { value: "", text: "Couldn't load people" }));
      $("addError").textContent = e.message;
    }
  }

  async function submitAdd(e) {
    e.preventDefault();
    const p = addPeople[Number($("addPerson").value)];
    if (!p) return;
    $("addOk").disabled = true;
    $("addError").textContent = "";
    try {
      const body = p.id != null ? { personId: p.id } : { workerId: p.workerId };
      const ts = await api(`/api/payruns/${runId}/timesheets`, { method: "POST", body: JSON.stringify(body) });
      $("addDlg").close();
      run = await api(`/api/payruns/${runId}`);
      renderHeader();
      renderList();
      toast(`Added ${ts.name}'s sheet.`);
      await selectSheet(ts.id);
    } catch (err) {
      $("addError").textContent = err.message;
      $("addOk").disabled = false;
    }
  }

  async function removeSheet() {
    if (!sheet) return;
    if (!confirm(`Remove ${sheet.name}'s sheet from this pay run?`)) return;
    const sheets = run.timesheets || [];
    const i = sheets.findIndex((t) => t.id === sheet.id);
    await api(`/api/payruns/${runId}/timesheets/${sheet.id}`, { method: "DELETE" });
    const name = sheet.name;
    sheet = null;
    lastDirty = false;
    run = await api(`/api/payruns/${runId}`);
    summaryStale = true;
    renderHeader();
    renderList();
    const left = run.timesheets || [];
    if (left.length) await selectSheet(left[Math.min(Math.max(i, 0), left.length - 1)].id, { skipGuard: true });
    else {
      $("entry").hidden = true;
      syncUrl();
    }
    toast(`Removed ${name}'s sheet.`);
  }

  // -------------------------------------------------------------- the summary ---

  let sumSeq = 0;
  async function loadSummary() {
    if (!summaryStale && summary) return renderSummary();
    const seq = ++sumSeq;
    $("sumStatus").textContent = "Loading...";
    try {
      const s = await api(`/api/payruns/${runId}/summary`);
      if (seq !== sumSeq) return;
      summary = s;
      summaryStale = false;
      if (s.rules) rules = run.status === "open" ? s.rules : rules || s.rules;
      renderSummary();
    } catch (e) {
      if (seq !== sumSeq) return;
      $("sumStatus").textContent = `Couldn't load the summary: ${e.message}`;
    }
  }

  function rulesLine(r) {
    if (!r) return "";
    return `Ordinary ${PM.hours(r.ordinaryMonThuMin)} h Mon–Thu, ${PM.hours(r.ordinaryFriMin)} h Fri; ` +
      `first ${PM.hours(r.otBandMin)} h overtime, then double time`;
  }

  const SUM_COLS = ["normalMin", "otMin", "dtMin", "pholMin", "arlMin", "sickMin", "onsiteMin"];
  function numCell(min) {
    return el("td", { class: "num" + (min ? "" : " pr-zero"), text: PM.hours(min || 0) });
  }

  function renderSummary() {
    const s = summary;
    $("sumDraft").hidden = !!s.frozen;
    $("sumRules").textContent = rulesLine(s.rules);
    const status = [];
    if (isDirty()) status.push(`Unsaved changes on ${sheet.name}'s sheet aren't in these numbers yet.`);
    if (!(s.rows || []).length) status.push("No sheets in this pay run.");
    $("sumStatus").textContent = status.join(" ");
    const body = $("sumRows");
    body.replaceChildren();
    for (const r of s.rows || []) {
      const tr = el("tr");
      tr.append(el("th", { scope: "row", class: "pr-sum-name", text: r.name }));
      for (const k of SUM_COLS) tr.append(numCell(r[k]));
      tr.append(el("td", { class: "pr-sum-notes" + (r.notes ? "" : " pr-zero"), text: r.notes || "" }));
      body.append(tr);
    }
    const foot = $("sumFoot");
    foot.replaceChildren();
    const t = s.totals || {};
    const tr = el("tr");
    tr.append(el("th", { scope: "row", text: "Totals" }));
    for (const k of SUM_COLS) tr.append(el("td", { class: "num", text: PM.hours(t[k] || 0) }));
    tr.append(el("td"));
    foot.append(tr);
  }

  // ------------------------------------------------------------------- boot ---

  function wire() {
    $("tabSheets").addEventListener("click", () => setTab("sheets"));
    $("tabSummary").addEventListener("click", () => setTab("summary"));
    $("tabs").addEventListener("keydown", (e) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const to = e.key === "Home" ? "sheets" : e.key === "End" ? "summary" : tab === "sheets" ? "summary" : "sheets";
        setTab(to, true);
      }
    });
    window.addEventListener("hashchange", () => setTab(location.hash === "#summary" ? "summary" : "sheets"));

    $("finaliseBtn").addEventListener("click", guarded(finalise));
    $("reopenBtn").addEventListener("click", guarded(reopen));
    $("deleteBtn").addEventListener("click", guarded(deleteRun));
    $("myobTick").addEventListener("change", setMyob);

    $("addSheetBtn").addEventListener("click", guarded(openAdd));
    $("removeSheetBtn").addEventListener("click", guarded(removeSheet));
    $("addForm").addEventListener("submit", submitAdd);
    $("addCancel").addEventListener("click", () => $("addDlg").close());
    $("addDlg").addEventListener("mousedown", (e) => {
      if (e.target === $("addDlg")) $("addDlg").close();
    });

    $("saveBtn").addEventListener("click", () => save());
    $("saveNextBtn").addEventListener("click", () => saveAndNext());
    $("fillBtn").addEventListener("click", () => {
      fillSuggestions(false);
      markDirty();
    });
    $("reloadSheetBtn").addEventListener("click", reloadSheet);
    $("notes").addEventListener("input", markDirty);
    $("signedTick").addEventListener("change", markDirty);
    $("enteredTick").addEventListener("change", markDirty);

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (tab === "sheets" && editable() && !$("addDlg").open) save();
      }
    });
    window.addEventListener("beforeunload", (e) => {
      if (isDirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  async function boot() {
    if (window.cc && window.cc.ready) await window.cc.ready;
    canEdit = can("invoices.edit");
    isAdmin = can("users.admin");
    wire();
    if (!runId) {
      $("pageStatus").textContent = "No pay run chosen. Go back to Pay runs and open one.";
      return;
    }
    try {
      const [r, s] = await Promise.all([
        api(`/api/payruns/${runId}`),
        api(`/api/payruns/${runId}/summary`).catch(() => null),
      ]);
      run = r;
      if (s) {
        summary = s;
        summaryStale = false;
        rules = s.rules || null;
      }
      if (!rules) rules = (await api("/api/payruns")).rules;
    } catch (e) {
      $("pageStatus").textContent = `Couldn't open this pay run: ${e.message}`;
      return;
    }
    $("pageStatus").textContent = "";
    $("pageStatus").hidden = true;
    renderHeader();
    $("tabs").hidden = false;
    renderList();
    setTab(location.hash === "#summary" ? "summary" : "sheets");
    const sheets = run.timesheets || [];
    const pick = sheets.find((t) => t.id === wantSheet) || sheets[0];
    wantSheet = null;
    if (pick) await selectSheet(pick.id, { skipGuard: true });
    else syncUrl();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
