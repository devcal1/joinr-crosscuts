// Pay runs (payruns.html): this fortnight and next, the list of pay runs, who is on the pay run,
// the public holidays and the pay rules. Talks to /api/payruns (routes/payruns.js,
// docs/plans/m8-contracts.md sections 6 and 8.1). Hours are integer minutes on the wire; they are
// shown and parsed only through PayMaths (public/paymaths.js).
(function () {
  "use strict";

  const PM = window.PayMaths;
  const API = "/api/payruns";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Permissions come from the shell. Without it, act as view-only: the server enforces
  // everything regardless.
  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }
  const canEdit = () => can("invoices.edit");

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

  function parseISO(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  }
  // '3 Nov 2026'
  function fmtDate(s) {
    const d = parseISO(s);
    return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : "";
  }
  function weekdayOf(s) {
    const d = parseISO(s);
    return d ? WEEKDAYS[d.getUTCDay()] : "";
  }
  // Today's date in Sydney, YYYY-MM-DD (en-CA formats as ISO).
  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  function showError(e) {
    toast(`Error: ${e && e.message ? e.message : e}`);
  }

  // --- state -----------------------------------------------------------------------------
  let overview = null; // GET /api/payruns
  let people = [];
  let holidays = [];
  let settings = null;
  let peopleSeq = 0;
  let holSeq = 0;
  const dlg = $("dlg");

  // --- this fortnight and next -------------------------------------------------------------
  function runFor(f, runs) {
    if (!f) return null;
    if (f.payRunId != null) return runs.find((r) => r.id === f.payRunId) || { id: f.payRunId };
    return runs.find((r) => r.startDate === f.startDate) || null;
  }

  // The fortnight objects from GET /. If the server leaves them out, they are worked out here from
  // the anchor and today's Sydney date (the same rule as lib/payroll.js currentStart).
  function fortnights(data) {
    if (data.current && data.next) return [data.current, data.next];
    const anchor = data.rules && data.rules.anchor;
    if (!anchor) return [];
    const start = PM.fortnightStartFor(todayISO(), anchor);
    return [start, PM.addDays(start, 14)].map((s) => ({
      startDate: s,
      endDate: PM.endOf(s),
      label: PM.fortnightLabel(s),
      payRunId: null,
    }));
  }

  // [state, sentence]: state drives the card's edge colour.
  function runStatus(run) {
    if (!run) return ["none", "Not started"];
    if (run.status === "finalised") {
      return run.myobEnteredDate ? ["myob", "Entered in MYOB"] : ["final", "Finalised"];
    }
    if (run.timesheetCount == null) return ["open", "Open"];
    return ["open", `Open: ${run.enteredCount || 0} of ${run.timesheetCount} typed in`];
  }

  function printHref(start, what) {
    return `/payprint.html?start=${encodeURIComponent(start)}&what=${what}`;
  }

  function renderFortnights() {
    const box = $("fortnights");
    box.replaceChildren();
    const runs = overview.payRuns || [];
    const titles = ["This fortnight", "Next fortnight"];
    fortnights(overview).forEach((f, i) => {
      const run = runFor(f, runs);
      const [state, sentence] = runStatus(run);
      const headId = `fn-${i}`;
      const card = el("article", { class: `py-card st-${state}`, "aria-labelledby": headId });
      card.append(
        el("span", { class: "hs-label", text: titles[i] }),
        el("h3", { class: "py-card-title", id: headId, text: f.label || PM.fortnightLabel(f.startDate) }),
        el("p", { class: "py-card-status", text: sentence })
      );
      const acts = el("div", { class: "py-card-acts" });
      if (run && run.id != null) {
        acts.append(el("a", { class: "hs-btn hs-btn-primary", href: `/payrun.html?id=${run.id}`, text: "Open" }));
      } else if (canEdit()) {
        const start = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Start pay run" });
        start.addEventListener("click", () => startRun(f, start));
        acts.append(start);
      }
      acts.append(
        el("a", { class: "hs-btn", href: printHref(f.startDate, "sheets"), text: "Print timesheets" }),
        el("a", { class: "hs-btn", href: printHref(f.startDate, "overtime"), text: "Print overtime log" })
      );
      card.append(acts);
      box.append(card);
    });
    if (!box.children.length) box.append(el("p", { class: "py-loading", text: "The fortnight start isn't set." }));
  }

  async function startRun(f, btn) {
    btn.disabled = true;
    try {
      const run = await api(API, { method: "POST", body: JSON.stringify({ startDate: f.startDate }) });
      toast("Pay run started");
      location.href = `/payrun.html?id=${run.id}`;
    } catch (e) {
      btn.disabled = false;
      showError(e);
      loadOverview();
    }
  }

  // --- the pay runs table ------------------------------------------------------------------
  const BADGE = {
    open: ["hs-badge-check", "Open"],
    final: ["hs-badge-na", "Finalised"],
    myob: ["hs-badge-teal", "Entered in MYOB"],
  };

  function renderRuns() {
    const runs = overview.payRuns || [];
    const tbody = $("runs");
    tbody.replaceChildren();
    for (const r of runs) {
      const state = r.status === "finalised" ? (r.myobEnteredDate ? "myob" : "final") : "open";
      const [cls, text] = BADGE[state];
      const badge = el("span", { class: `hs-badge ${cls}`, text });
      if (state === "myob") badge.title = `Entered in MYOB ${fmtDate(r.myobEnteredDate)}`;
      tbody.append(
        el(
          "tr",
          {},
          el("td", { class: "py-fn", "data-label": "Fortnight" },
            el("a", { href: `/payrun.html?id=${r.id}`, text: r.label || PM.fortnightLabel(r.startDate) })),
          el("td", { "data-label": "Status" }, badge),
          el("td", { class: "num", "data-label": "Typed in", text: `${r.enteredCount || 0} of ${r.timesheetCount || 0}` })
        )
      );
    }
    $("runsCount").textContent = runs.length ? `${runs.length} ${runs.length === 1 ? "pay run" : "pay runs"}` : "";
    const empty = $("runsEmpty");
    empty.hidden = runs.length > 0;
    empty.textContent = canEdit()
      ? "No pay runs yet. Start this fortnight's above."
      : "No pay runs yet.";
    tbody.closest("table").hidden = runs.length === 0;
  }

  async function loadOverview() {
    try {
      overview = await api(API);
      renderFortnights();
      renderRuns();
    } catch (e) {
      $("fortnights").replaceChildren(el("p", { class: "py-loading", text: `Couldn't load the pay runs: ${e.message}` }));
      showError(e);
    }
  }

  // --- who's on the pay run ------------------------------------------------------------------
  function renderPeople() {
    const edit = canEdit();
    const tbody = $("people");
    tbody.replaceChildren();
    for (const p of people) {
      const worker = p.kind === "worker";
      const name = el("td", { class: "py-name", "data-label": "Name" }, el("span", { text: p.name }));
      if (p.archived) name.append(el("span", { class: "hs-badge hs-badge-na py-tag", text: "Removed" }));

      const on = el("td", { class: "py-on", "data-label": "On the pay run" });
      if (edit && !p.archived) {
        const box = el("input", { type: "checkbox", "aria-label": `${p.name} is on the pay run` });
        box.checked = !!p.onPayRun;
        const word = el("span", { text: p.onPayRun ? "Yes" : "No" });
        box.addEventListener("change", () => {
          word.textContent = box.checked ? "Yes" : "No";
          setOnPayRun(p, box);
        });
        on.append(el("label", { class: "py-check" }, box, word));
      } else {
        on.append(el("span", { class: p.onPayRun && !p.archived ? "" : "py-muted", text: p.onPayRun && !p.archived ? "Yes" : "No" }));
      }

      const kind = el("td", { class: "py-kind", "data-label": "Kind" });
      if (worker) kind.append(el("span", { class: "py-muted", text: "Board worker" }));
      else kind.append(el("span", { class: "hs-badge hs-badge-na", text: "Pay only" }));

      const acts = el("td", { class: "py-acts" });
      if (edit && !worker) {
        if (p.archived) {
          const back = el("button", { type: "button", class: "hs-btn", text: "Restore" });
          back.setAttribute("aria-label", `Restore ${p.name}`);
          back.addEventListener("click", () => restorePerson(p, back));
          acts.append(back);
        } else {
          const ren = el("button", { type: "button", class: "hs-btn", text: "Rename" });
          ren.setAttribute("aria-label", `Rename ${p.name}`);
          ren.addEventListener("click", () => openRename(p));
          const rm = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Remove" });
          rm.setAttribute("aria-label", `Remove ${p.name}`);
          rm.addEventListener("click", () => openRemovePerson(p));
          acts.append(ren, rm);
        }
      }
      tbody.append(el("tr", { class: p.archived ? "py-removed" : "" }, name, on, kind, acts));
    }
    const active = people.filter((p) => !p.archived);
    const onRun = active.filter((p) => p.onPayRun).length;
    $("peopleCount").textContent = people.length ? `${onRun} of ${active.length} on the pay run` : "";
    const empty = $("peopleEmpty");
    empty.hidden = people.length > 0;
    empty.textContent = edit
      ? "Nobody yet. Board workers appear here once they are on the Workers page; add office staff with Add person."
      : "Nobody yet.";
    tbody.closest("table").hidden = people.length === 0;
  }

  async function loadPeople() {
    const seq = ++peopleSeq;
    try {
      const all = $("showRemoved").checked ? "?all=1" : "";
      const d = await api(`${API}/people${all}`);
      if (seq !== peopleSeq) return;
      people = d.people || [];
      renderPeople();
    } catch (e) {
      if (seq !== peopleSeq) return;
      const empty = $("peopleEmpty");
      empty.hidden = false;
      empty.textContent = `Couldn't load the people: ${e.message}`;
      $("people").closest("table").hidden = true;
      showError(e);
    }
  }

  function personUrl(p) {
    return p.kind === "worker" ? `${API}/people/worker/${p.workerId}` : `${API}/people/${p.id}`;
  }

  async function setOnPayRun(p, box) {
    const want = box.checked;
    box.disabled = true;
    try {
      const method = p.kind === "worker" ? "PUT" : "PATCH";
      await api(personUrl(p), { method, body: JSON.stringify({ onPayRun: want }) });
      toast(want ? `${p.name} is on the pay run` : `${p.name} is off the pay run`);
    } catch (e) {
      showError(e);
    }
    loadPeople();
  }

  async function restorePerson(p, btn) {
    btn.disabled = true;
    try {
      await api(personUrl(p), { method: "PATCH", body: JSON.stringify({ archived: false }) });
      toast(`${p.name} restored`);
    } catch (e) {
      showError(e);
    }
    loadPeople();
  }

  // --- public holidays ---------------------------------------------------------------------
  function holRange() {
    const today = todayISO();
    return { from: $("showPast").checked ? PM.addDays(today, -365) : today, to: PM.addDays(today, 365) };
  }

  function renderHolidays() {
    const edit = canEdit();
    const today = todayISO();
    const tbody = $("hols");
    tbody.replaceChildren();
    for (const h of holidays) {
      const past = h.date < today;
      const acts = el("td", { class: "py-acts" });
      if (edit) {
        const rm = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Remove" });
        rm.setAttribute("aria-label", `Remove ${h.name}, ${fmtDate(h.date)}`);
        rm.addEventListener("click", () => openRemoveHoliday(h));
        acts.append(rm);
      }
      tbody.append(
        el(
          "tr",
          { class: past ? "py-past" : "" },
          el("td", { class: "py-when", "data-label": "Date", text: fmtDate(h.date) }),
          el("td", { class: "py-day", "data-label": "Day", text: h.weekday || weekdayOf(h.date) }),
          el("td", { class: "py-holname", "data-label": "Name", text: h.name }),
          acts
        )
      );
    }
    $("holCount").textContent = holidays.length ? `${holidays.length} ${holidays.length === 1 ? "day" : "days"}` : "";
    const empty = $("holsEmpty");
    empty.hidden = holidays.length > 0;
    empty.textContent = $("showPast").checked
      ? "No public holidays in the last year or the next 12 months."
      : "No public holidays in the next 12 months.";
    tbody.closest("table").hidden = holidays.length === 0;
  }

  async function loadHolidays() {
    const seq = ++holSeq;
    try {
      const { from, to } = holRange();
      const d = await api(`${API}/holidays?from=${from}&to=${to}`);
      if (seq !== holSeq) return;
      holidays = d.holidays || [];
      renderHolidays();
    } catch (e) {
      if (seq !== holSeq) return;
      const empty = $("holsEmpty");
      empty.hidden = false;
      empty.textContent = `Couldn't load the public holidays: ${e.message}`;
      $("hols").closest("table").hidden = true;
      showError(e);
    }
  }

  // --- pay rules ---------------------------------------------------------------------------
  const RULE_FIELDS = [
    ["rMonThu", "ordinaryMonThuMin", "Ordinary hours Mon–Thu"],
    ["rFri", "ordinaryFriMin", "Ordinary hours Fri"],
    ["rOt", "otBandMin", "Overtime hours before double time"],
  ];

  function renderSettings() {
    const edit = canEdit();
    for (const [id, key] of RULE_FIELDS) {
      const inp = $(id);
      inp.value = PM.hours(settings[key]);
      inp.readOnly = !edit;
    }
    const anchor = $("rAnchor");
    anchor.value = settings.anchor || "";
    const why = $("anchorWhy");
    if (settings.anchorLocked) {
      anchor.disabled = true;
      why.hidden = false;
      why.textContent = "Locked: a pay run exists, so the fortnight start can't change.";
    } else {
      anchor.disabled = false;
      anchor.readOnly = !edit;
      why.hidden = true;
      why.textContent = "";
    }
    $("rulesSave").hidden = !edit;
    $("rulesErr").textContent = "";
  }

  async function loadSettings() {
    try {
      settings = await api(`${API}/settings`);
      renderSettings();
    } catch (e) {
      $("rulesErr").textContent = `Couldn't load the pay rules: ${e.message}`;
      showError(e);
    }
  }

  // The changed fields, as minutes and a date. Throws a sentence when something won't do.
  function rulesBody() {
    const body = {};
    for (const [id, key, label] of RULE_FIELDS) {
      const inp = $(id);
      const min = PM.parseHours(inp.value);
      if (min == null || Number.isNaN(min)) {
        inp.focus();
        throw new Error(`${label}: type hours, like 8 or 7.5`);
      }
      if (min > 720) {
        inp.focus();
        throw new Error(`${label}: at most 12 hours`);
      }
      if (min !== settings[key]) body[key] = min;
    }
    const anchor = $("rAnchor");
    if (!settings.anchorLocked && anchor.value !== settings.anchor) {
      if (!anchor.value || !parseISO(anchor.value)) {
        anchor.focus();
        throw new Error("Pick the fortnight start date");
      }
      if (PM.dayKeyOf(anchor.value) !== "mon") {
        anchor.focus();
        throw new Error("The fortnight must start on a Monday");
      }
      body.anchor = anchor.value;
    }
    return body;
  }

  async function saveRules(ev) {
    ev.preventDefault();
    if (!canEdit() || !settings) return;
    const err = $("rulesErr");
    const btn = $("rulesSave");
    err.textContent = "";
    let body;
    try {
      body = rulesBody();
    } catch (e) {
      err.textContent = e.message;
      return;
    }
    if (!Object.keys(body).length) {
      renderSettings();
      toast("Nothing to save");
      return;
    }
    btn.disabled = true;
    try {
      settings = await api(`${API}/settings`, { method: "PUT", body: JSON.stringify(body) });
      renderSettings();
      toast("Pay rules saved");
      if (body.anchor) loadOverview();
    } catch (e) {
      err.textContent = e.message;
      showError(e);
    } finally {
      btn.disabled = false;
    }
  }

  // --- dialogs -------------------------------------------------------------------------------
  function errorLine() {
    return el("p", { class: "cc-dialog-error", role: "alert" });
  }
  function closeBtn(text) {
    const b = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: text || "Cancel" });
    b.addEventListener("click", () => dlg.close());
    return b;
  }
  function field(label, node) {
    return el("div", { class: "cc-field" }, el("label", { class: "cc-field-label", for: node.id, text: label }), node);
  }
  function textInput(id, value, max) {
    const n = el("input", { id, class: "hs-input", type: "text", autocomplete: "off", maxlength: String(max) });
    n.value = value || "";
    return n;
  }

  // Runs `fn` with the dialog's buttons disabled; a failure shows in the dialog's error line (a
  // toast would sit behind the modal's backdrop).
  async function busy(root, errEl, fn) {
    const btns = [...root.querySelectorAll("button, input")];
    const was = btns.map((b) => b.disabled);
    btns.forEach((b) => (b.disabled = true));
    errEl.textContent = "";
    try {
      await fn();
    } catch (e) {
      errEl.textContent = e.message;
      btns.forEach((b, i) => (b.disabled = was[i]));
      const first = root.querySelector("input:not([disabled])");
      if (first) first.focus();
      return;
    }
    btns.forEach((b, i) => (b.disabled = was[i]));
  }

  // A small form dialog: title, optional note, fields, an action button. `run` gets nothing and
  // throws a sentence on failure; on success the dialog closes.
  function formDialog({ title, note, fields, action, actionClass, run, focus }) {
    const root = el("form", { class: "cc-dialog-form", method: "dialog", novalidate: true });
    root.append(el("h2", { class: "cc-dialog-title", id: "dlgTitle", text: title }));
    if (note) root.append(el("p", { class: "cc-dialog-note", text: note }));
    for (const f of fields || []) root.append(f);
    const err = errorLine();
    const go = el("button", { type: "submit", class: `hs-btn ${actionClass || "hs-btn-primary"}`, text: action });
    root.append(err, el("div", { class: "cc-dialog-actions" }, closeBtn(), go));
    root.addEventListener("submit", (ev) => {
      ev.preventDefault();
      busy(root, err, async () => {
        await run();
        dlg.close();
      });
    });
    dlg.replaceChildren(root);
    if (!dlg.open) dlg.showModal();
    (focus || go).focus();
  }

  function cleanName(text, max, what) {
    const s = String(text || "").trim();
    if (!s) throw new Error(`Type ${what}`);
    if (s.length > max) throw new Error(`Keep ${what} to ${max} characters`);
    return s;
  }

  function openAddPerson() {
    const name = textInput("dpName", "", 100);
    formDialog({
      title: "Add person",
      note: "For someone paid who isn't on the board, such as office staff. They go on the pay run straight away.",
      fields: [field("Name", name)],
      action: "Add person",
      focus: name,
      run: async () => {
        const n = cleanName(name.value, 100, "a name");
        await api(`${API}/people`, { method: "POST", body: JSON.stringify({ name: n }) });
        toast(`${n} added`);
        loadPeople();
      },
    });
  }

  function openRename(p) {
    const name = textInput("dpRename", p.name, 100);
    formDialog({
      title: "Rename",
      note: "Sheets already in a pay run keep the name they were started with until it is finalised.",
      fields: [field("Name", name)],
      action: "Save name",
      focus: name,
      run: async () => {
        const n = cleanName(name.value, 100, "a name");
        if (n === p.name) return;
        await api(personUrl(p), { method: "PATCH", body: JSON.stringify({ name: n }) });
        toast("Renamed");
        loadPeople();
      },
    });
    name.select();
  }

  function openRemovePerson(p) {
    formDialog({
      title: `Remove ${p.name}?`,
      note: "They come off the list and off pay runs started from now on. Their sheets in past pay runs stay. Show removed people brings them back.",
      action: "Remove",
      actionClass: "hs-btn-stop",
      run: async () => {
        await api(personUrl(p), { method: "PATCH", body: JSON.stringify({ archived: true }) });
        toast(`${p.name} removed`);
        loadPeople();
      },
    });
  }

  function openAddHoliday() {
    const date = el("input", { id: "dhDate", class: "hs-input", type: "date" });
    const name = textInput("dhName", "", 80);
    formDialog({
      title: "Add holiday",
      note: "A public holiday on a weekday is suggested as P HOL hours on every timesheet that day.",
      fields: [el("div", { class: "py-two" }, field("Date", date), field("Name", name))],
      action: "Add holiday",
      focus: date,
      run: async () => {
        if (!date.value || !parseISO(date.value)) throw new Error("Pick a date");
        const n = cleanName(name.value, 80, "the holiday's name");
        await api(`${API}/holidays`, { method: "POST", body: JSON.stringify({ date: date.value, name: n }) });
        toast("Holiday added");
        loadHolidays();
      },
    });
  }

  function openRemoveHoliday(h) {
    formDialog({
      title: "Remove this public holiday?",
      note: `${h.name}, ${h.weekday || weekdayOf(h.date)} ${fmtDate(h.date)}. Sheets already saved keep what was typed.`,
      action: "Remove holiday",
      actionClass: "hs-btn-stop",
      run: async () => {
        await api(`${API}/holidays/${encodeURIComponent(h.date)}`, { method: "DELETE" });
        toast("Holiday removed");
        loadHolidays();
      },
    });
  }

  // --- start-up ------------------------------------------------------------------------------
  function applyAccess() {
    const edit = canEdit();
    $("addPerson").hidden = !edit;
    $("addHoliday").hidden = !edit;
    $("rulesSave").hidden = !edit;
    $("viewOnly").hidden = edit;
  }

  async function boot() {
    if (window.cc && window.cc.ready) await window.cc.ready;
    applyAccess();
    $("addPerson").addEventListener("click", openAddPerson);
    $("addHoliday").addEventListener("click", openAddHoliday);
    $("showRemoved").addEventListener("change", loadPeople);
    $("showPast").addEventListener("change", loadHolidays);
    $("rulesForm").addEventListener("submit", saveRules);
    await Promise.all([loadOverview(), loadPeople(), loadHolidays(), loadSettings()]);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
