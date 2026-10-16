// Leave and availability page. Talks to /api/availability (routes/availability.js,
// docs/plans/m5-contracts.md section 3). All text from the server is put in the page with
// textContent, never as HTML.
(function () {
  "use strict";

  const DAYS = [
    ["mon", "Mon"],
    ["tue", "Tue"],
    ["wed", "Wed"],
    ["thu", "Thu"],
    ["fri", "Fri"],
  ];
  const DAY_LABEL = Object.fromEntries(DAYS);
  const KINDS = [
    ["leave", "Leave"],
    ["sick", "Sick"],
    ["other", "Other"],
  ];
  const KIND_LABEL = Object.fromEntries(KINDS);
  const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Permissions come from the shell. The server enforces everything regardless.
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
  const $ = (id) => document.getElementById(id);

  // --- dates ---------------------------------------------------------------------------------
  function sydneyToday() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }
  function addDays(s, n) {
    const [y, m, d] = s.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + n));
    return date.toISOString().slice(0, 10);
  }
  // "Mon 3 Nov 2035"
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return String(s || "");
    const dow = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
    return `${WEEKDAY_SHORT[dow]} ${+m[3]} ${MONTH_SHORT[+m[2] - 1]} ${m[1]}`;
  }

  // --- state ---------------------------------------------------------------------------------
  let workers = [];
  let leave = [];
  let loaded = false;
  let seq = 0; // the newest load wins
  const dlg = $("dlg");

  function setMessage(msg, kind) {
    const m = $("message");
    m.textContent = msg || "";
    m.className = "av-message " + (kind || "");
  }

  // "Full time", "3 days a week", "Day off: Fri", or both together.
  function patternText(w) {
    const parts = [];
    if (w.daysPerWeek) parts.push(`${w.daysPerWeek} ${w.daysPerWeek === 1 ? "day" : "days"} a week`);
    const off = w.regularDaysOff || [];
    if (off.length) parts.push((off.length === 1 ? "Day off: " : "Days off: ") + off.map((d) => DAY_LABEL[d] || d).join(", "));
    if (parts.length === 2) parts[1] = parts[1].charAt(0).toLowerCase() + parts[1].slice(1);
    return parts.length ? parts.join(", ") : "Full time";
  }

  // --- load and render -----------------------------------------------------------------------
  async function load() {
    const mine = ++seq;
    const today = sydneyToday();
    const qs = new URLSearchParams({ from: addDays(today, -30), to: addDays(today, 366) });
    try {
      const data = await api("/api/availability?" + qs);
      if (mine !== seq) return;
      workers = data.workers || [];
      leave = data.leave || [];
      loaded = true;
      setMessage("");
      render();
    } catch (e) {
      if (mine !== seq) return;
      setMessage("Could not load availability: " + e.message, "err");
    }
  }

  function render() {
    renderWorkers();
    syncFilter();
    renderLeave();
    $("addLeave").hidden = !can("users.admin");
  }

  function renderWorkers() {
    const tbody = $("workers");
    tbody.replaceChildren();
    const edit = can("users.admin");
    for (const w of workers) {
      const name = el("td", { class: "av-name", text: w.name });
      if (w.archived) name.append(el("span", { class: "hs-badge hs-badge-na av-tag", text: "Archived" }));
      const pattern = el("td", { text: patternText(w) });
      if (!w.daysPerWeek && !(w.regularDaysOff || []).length) pattern.className = "av-pattern-none";
      const acts = el("td", { class: "av-acts" });
      if (edit) {
        const b = el("button", { type: "button", class: "hs-btn", text: "Edit pattern" });
        b.addEventListener("click", () => openPattern(w));
        acts.append(b);
      }
      tbody.append(el("tr", { class: w.archived ? "av-archived" : "" }, name, pattern, acts));
    }
    const active = workers.filter((w) => !w.archived).length;
    $("workersCount").textContent = active + (active === 1 ? " worker" : " workers");
    if (!workers.length) {
      tbody.append(el("tr", null, el("td", { colspan: "3", class: "av-pattern-none", text: "No workers yet. Add them on the Workers page." })));
    }
  }

  function syncFilter() {
    const sel = $("fWorker");
    const keep = sel.value;
    sel.replaceChildren(el("option", { value: "", text: "All workers" }));
    for (const w of workers) sel.append(el("option", { value: String(w.id), text: w.name + (w.archived ? " (archived)" : "") }));
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
  }

  function renderLeave() {
    const today = sydneyToday();
    const showPast = $("fPast").checked;
    const wid = $("fWorker").value;
    const rows = leave.filter((l) => (showPast || l.to >= today) && (!wid || String(l.worker.id) === wid));
    const tbody = $("leave");
    tbody.replaceChildren();
    const edit = can("users.admin");
    for (const l of rows) {
      const acts = el("td", { class: "av-acts" });
      if (edit) {
        const rm = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Remove" });
        rm.addEventListener("click", () => openRemove(l));
        acts.append(rm);
      }
      tbody.append(
        el(
          "tr",
          null,
          el("td", { class: "av-name", text: l.worker.name }),
          el("td", { class: "av-when", "data-label": "From", text: fmtDate(l.from) }),
          el("td", { class: "av-when", "data-label": "To", text: fmtDate(l.to) }),
          el("td", { class: "num", "data-label": "Weekdays", text: String(l.days) }),
          el("td", { "data-label": "Kind", text: KIND_LABEL[l.kind] || l.kind }),
          el("td", { class: "av-note", "data-label": "Note", text: l.note || "" }),
          acts
        )
      );
    }
    $("leaveCount").textContent = rows.length + (rows.length === 1 ? " entry" : " entries");
    const empty = $("leaveEmpty");
    empty.hidden = rows.length > 0;
    if (!rows.length) {
      empty.textContent = wid || showPast ? "No leave matches." : "No leave is booked.";
    }
    // The table is hidden when empty so the empty note stands alone.
    $("leave").closest(".av-wrap").hidden = rows.length === 0;
  }

  // --- dialogs -------------------------------------------------------------------------------
  dlg.addEventListener("mousedown", (e) => {
    if (e.target === dlg) dlg.close();
  });

  function errorLine() {
    return el("p", { class: "cc-dialog-error", role: "alert" });
  }
  function field(label, node, id) {
    return el("div", { class: "cc-field" }, el("label", { class: "cc-field-label", for: id, text: label }), node);
  }
  function closeBtn(label) {
    const b = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: label || "Cancel" });
    b.addEventListener("click", () => dlg.close());
    return b;
  }
  function show(root) {
    dlg.replaceChildren(root);
    if (!dlg.open) dlg.showModal();
  }
  // Runs fn with the dialog's buttons disabled; a failure goes in the error line.
  async function busy(root, errEl, fn) {
    const btns = [...root.querySelectorAll("button")];
    const was = btns.map((b) => b.disabled);
    btns.forEach((b) => (b.disabled = true));
    errEl.textContent = "";
    try {
      await fn();
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      btns.forEach((b, i) => (b.disabled = was[i]));
    }
  }

  function openAddLeave() {
    const err = errorLine();
    const who = el("select", { id: "alWorker", class: "hs-input" });
    const ordered = [...workers.filter((w) => !w.archived), ...workers.filter((w) => w.archived)];
    who.append(el("option", { value: "", text: "Choose a worker" }));
    for (const w of ordered) who.append(el("option", { value: String(w.id), text: w.name + (w.archived ? " (archived)" : "") }));
    const today = sydneyToday();
    const from = el("input", { id: "alFrom", class: "hs-input", type: "date", value: today, required: true });
    const to = el("input", { id: "alTo", class: "hs-input", type: "date", value: today, required: true });
    // The end date follows the start until the person sets their own.
    let toTouched = false;
    to.addEventListener("input", () => {
      toTouched = true;
    });
    from.addEventListener("input", () => {
      if (!toTouched || (to.value && from.value && to.value < from.value)) to.value = from.value;
    });
    const kind = el("select", { id: "alKind", class: "hs-input" });
    for (const [k, label] of KINDS) kind.append(el("option", { value: k, text: label }));
    const note = el("textarea", { id: "alNote", class: "hs-input", maxlength: "500", rows: "3" });
    const save = el("button", { type: "submit", class: "hs-btn hs-btn-primary", text: "Add leave" });
    const root = el(
      "form",
      { class: "cc-dialog-form", novalidate: true },
      el("h2", { class: "cc-dialog-title", id: "dlgTitle", text: "Add leave" }),
      field("Worker", who, "alWorker"),
      el("div", { class: "av-two" }, field("From", from, "alFrom"), field("To", to, "alTo")),
      field("Kind", kind, "alKind"),
      field("Note", note, "alNote"),
      el("p", { class: "av-hint-dlg", text: "Whole days. Saturday and Sunday in the range are ignored by the board." }),
      err,
      el("div", { class: "cc-dialog-actions" }, closeBtn(), save)
    );
    root.addEventListener("submit", (ev) => {
      ev.preventDefault();
      busy(root, err, async () => {
        if (!who.value) throw new Error("Choose a worker");
        if (!from.value) throw new Error("Choose a start date");
        if (!to.value) throw new Error("Choose an end date");
        if (from.value > to.value) throw new Error("The start date can't be after the end date");
        await api("/api/availability/leave", {
          method: "POST",
          body: JSON.stringify({ workerId: Number(who.value), from: from.value, to: to.value, kind: kind.value, note: note.value }),
        });
        dlg.close();
        await load();
        setMessage("Leave added", "ok");
      });
    });
    show(root);
    who.focus();
  }

  function openRemove(l) {
    const err = errorLine();
    const yes = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Remove leave" });
    const range = l.from === l.to ? fmtDate(l.from) : `${fmtDate(l.from)} to ${fmtDate(l.to)}`;
    const root = el(
      "div",
      { class: "cc-dialog-form" },
      el("h2", { class: "cc-dialog-title", id: "dlgTitle", text: "Remove this leave?" }),
      el("p", { class: "cc-dialog-note", text: `${l.worker.name}, ${range}. The board will stop showing them as away.` }),
      err,
      el("div", { class: "cc-dialog-actions" }, closeBtn("Keep it"), yes)
    );
    yes.addEventListener("click", () => {
      busy(root, err, async () => {
        await api("/api/availability/leave/" + l.id, { method: "DELETE" });
        dlg.close();
        await load();
        setMessage("Leave removed", "ok");
      });
    });
    show(root);
  }

  function openPattern(w) {
    const err = errorLine();
    const days = el("select", { id: "pdDays", class: "hs-input" });
    days.append(el("option", { value: "", text: "Full time" }));
    for (let n = 1; n <= 4; n++) days.append(el("option", { value: String(n), text: `${n} ${n === 1 ? "day" : "days"} a week` }));
    days.value = w.daysPerWeek ? String(w.daysPerWeek) : "";
    const boxes = DAYS.map(([key, label]) => {
      const cb = el("input", { type: "checkbox", value: key });
      cb.checked = (w.regularDaysOff || []).includes(key);
      return [cb, el("label", null, cb, document.createTextNode(label))];
    });
    const offWrap = el("div", { class: "av-days", role: "group", "aria-label": "Regular day off" });
    for (const [, lab] of boxes) offWrap.append(lab);
    const save = el("button", { type: "submit", class: "hs-btn hs-btn-primary", text: "Save" });
    const root = el(
      "form",
      { class: "cc-dialog-form", novalidate: true },
      el("h2", { class: "cc-dialog-title", id: "dlgTitle", text: "Edit pattern" }),
      el("p", { class: "cc-dialog-note", text: w.name }),
      field("Days a week", days, "pdDays"),
      el("div", { class: "cc-field" }, el("span", { class: "cc-field-label", text: "Regular day off" }), offWrap),
      el("p", { class: "av-hint-dlg", text: "The board warns when a worker is booked on more days than this in a week, and shows a regular day off as away." }),
      err,
      el("div", { class: "cc-dialog-actions" }, closeBtn(), save)
    );
    root.addEventListener("submit", (ev) => {
      ev.preventDefault();
      busy(root, err, async () => {
        const off = boxes.filter(([cb]) => cb.checked).map(([cb]) => cb.value);
        if (off.length > 4) throw new Error("Pick at most four regular days off");
        await api("/api/availability/workers/" + w.id, {
          method: "PATCH",
          body: JSON.stringify({ daysPerWeek: days.value ? Number(days.value) : null, regularDaysOff: off }),
        });
        dlg.close();
        await load();
        setMessage("Pattern saved", "ok");
      });
    });
    show(root);
    days.focus();
  }

  // --- start ---------------------------------------------------------------------------------
  $("fWorker").addEventListener("change", renderLeave);
  $("fPast").addEventListener("change", renderLeave);
  $("addLeave").addEventListener("click", openAddLeave);
  load();
  // The shell finishes loading permissions after first paint: redraw so the buttons follow
  // users.admin.
  function onReady() {
    if (loaded) render();
    else $("addLeave").hidden = !can("users.admin");
  }
  if (window.cc && window.cc.loaded) onReady();
  document.addEventListener("cc:ready", onReady);
})();
