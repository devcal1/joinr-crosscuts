(function () {
  const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"];
  const DAY_LABELS = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri" };
  const PANELS = [
    { key: "manufacturing", label: "Manufacturing" },
    { key: "installing", label: "Installing" },
  ];

  const weeksContainer = document.getElementById("weeksContainer");
  const legendEl = document.getElementById("legend");
  const weekPicker = document.getElementById("weekPicker");
  const popover = document.getElementById("popover");
  const finishDialog = document.getElementById("finishDialog");
  const backlogEl = document.getElementById("backlogPanel");

  const state = {
    workers: [],
    jobs: [],
    weeks: [],
    backlog: [],
    weekStart: mondayOf(localTodayStr()),
  };
  // The local date the board was last successfully rendered for — drives the
  // midnight rollover check so an always-on TV doesn't keep highlighting
  // yesterday's column.
  let renderedToday = localTodayStr();

  // --- date helpers (client-local, so "today" always matches the browser) ---
  function localTodayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function parseDate(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function formatDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function addDays(s, n) {
    const d = parseDate(s);
    d.setDate(d.getDate() + n);
    return formatDate(d);
  }
  function mondayOf(s) {
    const d = parseDate(s);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return formatDate(d);
  }
  // Australian date display, d/m and d/m/yy (e.g. 4/9/26), no zero padding.
  function fmtAUShort(s) {
    const d = parseDate(s);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  }
  function fmtAU(s) {
    const d = parseDate(s);
    return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(-2)}`;
  }
  // Built client-side (Mon–Fri range in AU format); the server's `label`
  // field is deliberately unused so date display stays a frontend concern.
  function weekRangeLabel(week) {
    return `${fmtAU(week.start)} – ${fmtAU(addDays(week.start, 4))}`;
  }

  // api(), toast(), guarded() now live in shared.js, loaded before this file.

  // --- data loading ---
  async function loadWorkers() {
    state.workers = await api("/api/workers");
  }
  async function loadJobs() {
    state.jobs = await api("/api/jobs");
  }
  async function loadSchedule() {
    const data = await api(`/api/schedule?week=${state.weekStart}`);
    // The board shows ONE week at a time. /api/schedule still returns the
    // fortnight (weeks[0] and weeks[0]+7) and is left alone on purpose — it's
    // on the ungated whitelist, other callers may rely on its shape, and
    // dropping the extra week here costs nothing. Everything downstream
    // (renderWeeks, alignPanels, exportJpg) already loops over state.weeks,
    // so a one-element array needs no special-casing.
    state.weeks = data.weeks.slice(0, 1);
    state.backlog = data.backlog || [];
  }

  // --- legend ---
  function renderLegend() {
    legendEl.innerHTML = "";
    for (const w of state.workers.filter((w) => !w.archived)) {
      const span = document.createElement("span");
      span.className = "chip-worker";
      span.style.background = w.bg;
      span.style.color = w.fg;
      span.textContent = w.name;
      legendEl.appendChild(span);
    }
  }

  // --- chip element ---
  function chipEl(chip) {
    const span = document.createElement("span");
    span.className = "chip-worker";
    span.style.background = chip.bg;
    span.style.color = chip.fg;
    // Chips share a cell's width once they wrap into columns, so the name
    // ellipsises rather than spilling into the next day — title keeps the
    // full name reachable on hover.
    span.title = chip.name;
    const nameSpan = document.createElement("span");
    nameSpan.className = "chip-name";
    nameSpan.textContent = chip.name;
    span.appendChild(nameSpan);
    const x = document.createElement("span");
    x.className = "chip-x";
    x.textContent = "×";
    x.title = "Remove";
    x.addEventListener("click", guarded(async (e) => {
      e.stopPropagation();
      await api(`/api/assignments/${chip.assignmentId}`, { method: "DELETE" });
      await refresh();
    }));
    span.appendChild(x);
    return span;
  }

  // --- worker picker popover ---
  function openPopover(anchorEl, rowId, day) {
    popover.innerHTML = "";
    const active = state.workers.filter((w) => !w.archived);
    if (active.length === 0) {
      const empty = document.createElement("div");
      empty.className = "popover-empty";
      empty.textContent = "No workers yet — add one on the Workers page.";
      popover.appendChild(empty);
    }
    for (const w of active) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "popover-item";
      const swatch = document.createElement("span");
      swatch.className = "popover-swatch";
      swatch.style.background = w.bg;
      btn.appendChild(swatch);
      const label = document.createElement("span");
      label.textContent = w.name;
      btn.appendChild(label);
      btn.addEventListener("click", guarded(async () => {
        closePopover();
        await api(`/api/rows/${rowId}/assignments`, {
          method: "POST",
          body: JSON.stringify({ day, workerId: w.id }),
        });
        await refresh();
      }));
      popover.appendChild(btn);
    }
    // Unhide before measuring (display:none reads 0x0), then clamp to the
    // viewport — flipping above the anchor when there's no room below.
    const rect = anchorEl.getBoundingClientRect();
    popover.hidden = false;
    const pw = popover.offsetWidth;
    const ph = popover.offsetHeight;
    popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8))}px`;
    const below = rect.bottom + 4;
    popover.style.top = `${below + ph > window.innerHeight ? Math.max(8, rect.top - ph - 4) : below}px`;
  }
  function closePopover() {
    popover.hidden = true;
  }
  document.addEventListener("click", (e) => {
    if (!popover.hidden && !popover.contains(e.target) && !e.target.closest(".cell-add")) {
      closePopover();
    }
  });

  // --- drag to reorder ---
  // Set by a grip's dragstart, cleared on dragend. Dragging is scoped to one
  // panel of one week: the drop targets are wired per-grid in panelEl and
  // refuse a drag whose panelKey doesn't match, so a job can't be dropped
  // across the Manufacturing/Installing divide (an installing row can carry
  // locked-in day flags that a manufacturing row is not allowed to have).
  let dragState = null;
  // Separate from dragState: a "To start" item dragged into a panel. Set by the
  // item grip's dragstart, cleared on dragend or drop. Any panel accepts it.
  let backlogDrag = null;

  function clearDropMarkers() {
    for (const el of weeksContainer.querySelectorAll(".drop-before, .drop-after, .drop-active")) {
      el.classList.remove("drop-before", "drop-after", "drop-active");
    }
    // The "To start" panel is a drop target for scheduled rows too (see below).
    backlogEl.classList.remove("drop-active");
  }

  // Real rows only — the head row and alignPanels' blank padding rows carry no
  // data-row-id, so this is the panel's true server order (alignPanels only
  // ever inserts nulls, it never reorders a panel).
  function realRows(grid) {
    return [...grid.querySelectorAll(".sched-row[data-row-id]")];
  }

  function rowUnderPointer(grid, e) {
    const row = e.target.closest(".sched-row[data-row-id]");
    return row && grid.contains(row) ? row : null;
  }

  // Where the dragged row lands once it has been lifted out of the list. The
  // server applies the same lift-then-insert, so this index transfers directly.
  function dropIndex(grid, targetRow, after) {
    const ids = realRows(grid).map((r) => Number(r.dataset.rowId));
    const from = ids.indexOf(dragState.rowId);
    if (from !== -1) ids.splice(from, 1);
    const at = ids.indexOf(Number(targetRow.dataset.rowId));
    return at === -1 ? ids.length : at + (after ? 1 : 0);
  }

  // Backlog drops only: the row under the pointer and which half of it, or null
  // when the pointer is over no real row (the drop then appends).
  function rowSlot(grid, e) {
    const target = rowUnderPointer(grid, e);
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { target, after: e.clientY > rect.top + rect.height / 2 };
  }

  function wireDropTarget(grid, panelKey, weekStart) {
    // Backlog items: nothing is lifted out of a backlog drag, so the index is
    // simply the row's position in the panel (+1 when dropped below it).
    grid.addEventListener("dragover", (e) => {
      if (!backlogDrag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDropMarkers();
      const slot = rowSlot(grid, e);
      if (slot) slot.target.classList.add(slot.after ? "drop-after" : "drop-before");
      else grid.classList.add("drop-active");
    });
    grid.addEventListener("drop", guarded(async (e) => {
      if (!backlogDrag) return;
      e.preventDefault();
      const slot = rowSlot(grid, e);
      const body = { weekStart, panel: panelKey };
      if (slot) body.toIndex = realRows(grid).indexOf(slot.target) + (slot.after ? 1 : 0);
      const id = backlogDrag.id;
      backlogDrag = null;
      clearDropMarkers();
      await api(`/api/jobs/backlog/${id}/place`, { method: "POST", body: JSON.stringify(body) });
      await refresh();
    }));

    grid.addEventListener("dragover", (e) => {
      if (!dragState || dragState.panelKey !== panelKey) return;
      const target = rowUnderPointer(grid, e);
      if (!target || Number(target.dataset.rowId) === dragState.rowId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = target.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      clearDropMarkers();
      target.classList.add(after ? "drop-after" : "drop-before");
    });
    grid.addEventListener("dragleave", (e) => {
      if (!grid.contains(e.relatedTarget)) clearDropMarkers();
    });
    grid.addEventListener("drop", guarded(async (e) => {
      if (!dragState || dragState.panelKey !== panelKey) return;
      const target = rowUnderPointer(grid, e);
      if (!target || Number(target.dataset.rowId) === dragState.rowId) return;
      e.preventDefault();
      const rect = target.getBoundingClientRect();
      const toIndex = dropIndex(grid, target, e.clientY > rect.top + rect.height / 2);
      const rowId = dragState.rowId;
      dragState = null;
      clearDropMarkers();
      await api(`/api/rows/${rowId}/move`, { method: "PATCH", body: JSON.stringify({ toIndex }) });
      await refresh();
    }));
  }

  // --- row rendering ---
  function rowEl(row, panelKey, todayIndex) {
    const wrap = document.createDocumentFragment();

    const rowDiv = document.createElement("div");
    rowDiv.className = "sched-row";
    rowDiv.dataset.rowId = row.rowId;

    const jobCell = document.createElement("div");
    jobCell.className = "job-cell";

    const nameInput = document.createElement("input");
    nameInput.className = "job-name";
    nameInput.value = row.jobName;
    nameInput.spellcheck = false;
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") nameInput.blur();
    });
    nameInput.addEventListener("blur", guarded(async () => {
      const value = nameInput.value.trim();
      if (!value || value === row.jobName) {
        nameInput.value = row.jobName;
        return;
      }
      await api(`/api/jobs/${row.jobId}`, { method: "PATCH", body: JSON.stringify({ name: value }) });
      await refresh();
    }));
    jobCell.appendChild(nameInput);

    const actions = document.createElement("div");
    actions.className = "job-actions";

    // Drag handle. The row itself is deliberately NOT draggable: it holds the
    // job-name text input, and a draggable ancestor breaks click-to-position
    // and text selection inside an input in Chrome. A dedicated grip keeps
    // renaming and dragging from fighting each other.
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "btn btn-ghost btn-icon drag-grip";
    grip.title = "Drag to reorder, or onto To start to unschedule";
    grip.draggable = true;
    grip.innerHTML = '<i class="ph ph-dots-six-vertical"></i>';
    grip.addEventListener("dragstart", (e) => {
      dragState = { rowId: row.rowId, panelKey };
      e.dataTransfer.effectAllowed = "move";
      // Firefox drops a drag that carries no data payload.
      e.dataTransfer.setData("text/plain", String(row.rowId));
      // Drag the whole row, not the little grip button.
      e.dataTransfer.setDragImage(rowDiv, 12, 12);
      rowDiv.classList.add("dragging");
    });
    grip.addEventListener("dragend", () => {
      dragState = null;
      rowDiv.classList.remove("dragging");
      clearDropMarkers();
    });
    actions.appendChild(grip);

    const notesBtn = iconBtn("ph-note-pencil", "Notes", () => toggleNotes(row.rowId));
    if (row.notes && row.notes.trim()) {
      notesBtn.classList.add("has-notes");
      rowDiv.classList.add("has-notes-row"); // drives the print-only marker
    }
    actions.appendChild(notesBtn);
    actions.appendChild(iconBtn("ph-copy", "Copy to next week", guarded(async () => {
      await api(`/api/rows/${row.rowId}/duplicate`, { method: "POST", body: JSON.stringify({}) });
      toast("Copied to next week");
      await refresh();
    })));
    // Move (not copy) to the adjacent week. Assignments and flags hang off
    // week_row_id, which the server leaves alone — the workers come along.
    actions.appendChild(iconBtn("ph-arrow-square-left", "Move to previous week", guarded(async () => {
      await api(`/api/rows/${row.rowId}/move`, { method: "PATCH", body: JSON.stringify({ week: "prev" }) });
      toast("Moved to previous week");
      await refresh();
    })));
    actions.appendChild(iconBtn("ph-arrow-square-right", "Move to next week", guarded(async () => {
      await api(`/api/rows/${row.rowId}/move`, { method: "PATCH", body: JSON.stringify({ week: "next" }) });
      toast("Moved to next week");
      await refresh();
    })));
    actions.appendChild(iconBtn("ph-trash", "Remove row", guarded(async () => {
      if (!confirm(`Remove "${row.jobName}" from this week's ${panelKey} schedule?`)) return;
      await api(`/api/rows/${row.rowId}`, { method: "DELETE" });
      await refresh();
    })));
    jobCell.appendChild(actions);
    rowDiv.appendChild(jobCell);

    DAY_KEYS.forEach((day, i) => {
      const flagged = !!(row.flags && row.flags[day]);
      const cell = document.createElement("div");
      cell.className = "sched-cell" + (i === todayIndex ? " today-col" : "") + (flagged ? " flagged" : "");
      const chips = document.createElement("div");
      chips.className = "sched-chips";
      // Two rows max, filled column-major (see .sched-chips): worker 2 sits
      // under worker 1, worker 3 starts a second column beside worker 1, 4
      // under 3. Keeps a busy day two chips tall instead of four, which is
      // what decides how much of the week fits on the TV.
      // One worker gets a single track — a second empty track would still
      // contribute its row gap and pad every quiet row by 5px.
      // MIRRORED in exportJpg(); the JPG must lay chips out the same way.
      chips.style.gridTemplateRows = row.cells[day].length > 1 ? "auto auto" : "auto";
      // 3+ workers means two columns of ~63px, where a chip's padding and its
      // × leave under half the width for the name ("Shooter" truncates to one
      // letter). .crowded compresses those cells only — the common 1-2 worker
      // cell keeps the roomier chip it has today.
      if (row.cells[day].length > 2) chips.classList.add("crowded");
      for (const chip of row.cells[day]) chips.appendChild(chipEl(chip));
      cell.appendChild(chips);

      const controls = document.createElement("div");
      controls.className = "cell-controls";
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "cell-add";
      addBtn.textContent = "+";
      addBtn.title = "Add worker";
      addBtn.addEventListener("click", () => openPopover(addBtn, row.rowId, day));
      controls.appendChild(addBtn);

      if (panelKey === "installing") {
        const flagBtn = document.createElement("button");
        flagBtn.type = "button";
        flagBtn.className = "cell-flag" + (flagged ? " active" : "");
        flagBtn.title = flagged
          ? "Locked in with client — click to unflag"
          : "Flag as locked in with client";
        // The vendored Phosphor build is regular weight only — it has no
        // -fill variants, so the old ph-flag-fill drew an empty glyph on
        // exactly the flagged cells it was meant to emphasise. The active
        // state is carried by .cell-flag.active (solid amber border + wash).
        flagBtn.innerHTML = '<i class="ph ph-flag"></i>';
        flagBtn.addEventListener("click", guarded(async () => {
          if (flagged) {
            await api(`/api/rows/${row.rowId}/flags/${day}`, { method: "DELETE" });
          } else {
            await api(`/api/rows/${row.rowId}/flags`, { method: "POST", body: JSON.stringify({ day }) });
          }
          await refresh();
        }));
        controls.appendChild(flagBtn);
      }

      cell.appendChild(controls);
      rowDiv.appendChild(cell);
    });

    wrap.appendChild(rowDiv);

    const notes = document.createElement("div");
    notes.className = "job-notes";
    notes.id = `notes-${row.rowId}`;
    notes.hidden = true;
    const textarea = document.createElement("textarea");
    textarea.className = "input";
    textarea.placeholder = "Notes for this job…";
    textarea.value = row.notes || "";
    notes.appendChild(textarea);
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn btn-secondary";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", guarded(async () => {
      await api(`/api/jobs/${row.jobId}`, { method: "PATCH", body: JSON.stringify({ notes: textarea.value }) });
      toast("Notes saved");
      // Notes are per-job, so the same job's icon in the other panel needs
      // updating too; renderWeeks' snapshot keeps this panel open through it.
      // Swallowed on failure — the save itself already stuck, and a toast here
      // would contradict "Notes saved"; the next action or tick re-syncs.
      try {
        await refresh();
      } catch {}
    }));
    notes.appendChild(saveBtn);
    // Dragging the textarea's resize handle changes the editor's height with
    // no event — keep the other panel's compensation margin in step.
    if (window.ResizeObserver) new ResizeObserver(queueSync).observe(notes);
    wrap.appendChild(notes);

    return wrap;
  }

  function iconBtn(icon, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-ghost btn-icon";
    btn.title = title;
    btn.innerHTML = `<i class="ph ${icon}"></i>`;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function toggleNotes(rowId) {
    const el = document.getElementById(`notes-${rowId}`);
    if (el) el.hidden = !el.hidden;
    syncRowHeights();
  }

  // --- panel alignment ---
  // A job appearing in both panels of a week must sit on the same line, with
  // blank rows (null) padding the other panel. Anchors are the LCS of the two
  // panels' job-name sequences, so both panels' manual row order is respected —
  // if the orders conflict, the largest consistent set of jobs still aligns.
  // Unmatched rows between anchors pair up index-wise to keep the board short.
  //
  // Matching is by NAME, not jobId: the same job typed separately into each
  // panel creates two independent job records, and those used to sit on
  // unrelated lines despite reading identically on the board. Name matching is
  // a superset of the old behaviour — one job record in both panels has the
  // same name in both by definition.
  function alignKey(row) {
    return row.jobName.trim().toLowerCase();
  }
  function alignPanels(week) {
    const a = week.manufacturing;
    const b = week.installing;
    const keyA = a.map(alignKey);
    const keyB = b.map(alignKey);
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        dp[i][j] = keyA[i] === keyB[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const outA = [];
    const outB = [];
    let segA = [];
    let segB = [];
    function flushSegments() {
      for (let k = 0; k < Math.max(segA.length, segB.length); k++) {
        outA.push(segA[k] || null);
        outB.push(segB[k] || null);
      }
      segA = [];
      segB = [];
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (keyA[i] === keyB[j]) {
        flushSegments();
        outA.push(a[i++]);
        outB.push(b[j++]);
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        segA.push(a[i++]);
      } else {
        segB.push(b[j++]);
      }
    }
    while (i < a.length) segA.push(a[i++]);
    while (j < b.length) segB.push(b[j++]);
    flushSegments();
    return { manufacturing: outA, installing: outB };
  }

  function blankRowEl(todayIndex) {
    const rowDiv = document.createElement("div");
    rowDiv.className = "sched-row row-blank";
    const jobCell = document.createElement("div");
    jobCell.className = "job-cell";
    rowDiv.appendChild(jobCell);
    DAY_KEYS.forEach((day, i) => {
      const cell = document.createElement("div");
      cell.className = "sched-cell" + (i === todayIndex ? " today-col" : "");
      rowDiv.appendChild(cell);
    });
    return rowDiv;
  }

  // The two panels are independent grids, so paired lines only stay level if
  // we measure and match their heights (chips stack, names wrap). An open
  // notes editor adds height below its row; the margin compensates on the
  // other panel so lines further down stay aligned while someone types.
  function openNotesHeight(rowDiv) {
    const next = rowDiv.nextElementSibling;
    return next && next.classList.contains("job-notes") && !next.hidden ? next.offsetHeight : 0;
  }
  function syncRowHeights() {
    // The sticky week banner sits below the nav; nav height varies with
    // flex-wrap, so measure it into the CSS var the banner's `top` uses.
    // This runs on render/resize/fonts-ready — the same times it can change.
    document.documentElement.style.setProperty("--nav-h", `${document.querySelector(".nav").offsetHeight}px`);
    const stacked = window.matchMedia("(max-width: 900px)").matches;
    const pairs = [];
    for (const section of weeksContainer.querySelectorAll(".week-section")) {
      const grids = section.querySelectorAll(".panel .sched-grid");
      if (grids.length < 2) continue;
      const rowsA = [...grids[0].querySelectorAll(".sched-row:not(.sched-head)")];
      const rowsB = [...grids[1].querySelectorAll(".sched-row:not(.sched-head)")];
      for (const r of [...rowsA, ...rowsB]) {
        r.style.minHeight = "";
        r.style.marginBottom = "";
      }
      // Panels stack below 900px (blank rows are hidden there too) — pairing
      // by line no longer means anything visually, so leave heights natural.
      if (stacked) continue;
      for (let k = 0; k < Math.min(rowsA.length, rowsB.length); k++) pairs.push([rowsA[k], rowsB[k]]);
    }
    // All reads before all writes: one forced layout per call, not per pair —
    // this runs after every mutation on a TV-grade device.
    const measured = pairs.map(([a, b]) => ({
      a,
      b,
      h: Math.max(a.offsetHeight, b.offsetHeight),
      na: openNotesHeight(a),
      nb: openNotesHeight(b),
    }));
    for (const m of measured) {
      m.a.style.minHeight = `${m.h}px`;
      m.b.style.minHeight = `${m.h}px`;
      if (m.na !== m.nb) (m.na > m.nb ? m.b : m.a).style.marginBottom = `${Math.abs(m.na - m.nb)}px`;
    }
  }
  let syncTimer;
  function queueSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncRowHeights, 120);
  }

  // --- panel rendering ---
  function panelEl(week, panelDef, rows) {
    const panel = document.createElement("div");
    panel.className = "panel";

    const h3 = document.createElement("h3");
    h3.textContent = panelDef.label;
    panel.appendChild(h3);

    const grid = document.createElement("div");
    grid.className = "sched-grid";

    const today = localTodayStr();
    const dayOffset = Math.round((parseDate(today) - parseDate(week.start)) / 86400000);
    const todayIndex = dayOffset >= 0 && dayOffset < 5 ? dayOffset : -1;

    const head = document.createElement("div");
    head.className = "sched-row sched-head";
    const jobHead = document.createElement("div");
    jobHead.textContent = "Job";
    head.appendChild(jobHead);
    DAY_KEYS.forEach((day, i) => {
      const d = document.createElement("div");
      d.className = i === todayIndex ? "today-col" : "";
      d.textContent = `${DAY_LABELS[day]} ${fmtAUShort(addDays(week.start, i))}`;
      head.appendChild(d);
    });
    grid.appendChild(head);

    for (const row of rows) {
      grid.appendChild(row ? rowEl(row, panelDef.key, todayIndex) : blankRowEl(todayIndex));
    }

    wireDropTarget(grid, panelDef.key, week.start);
    panel.appendChild(grid);

    const addRow = document.createElement("div");
    addRow.className = "add-row";
    const input = document.createElement("input");
    input.className = "input";
    input.placeholder = "Add job…";
    input.setAttribute("list", "jobNamesList");
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn btn-primary";
    addBtn.textContent = "+ Add";
    const submitAdd = guarded(async () => {
      const name = input.value.trim();
      if (!name) return;
      const existing = state.jobs.find((j) => j.name.toLowerCase() === name.toLowerCase());
      const body = { weekStart: week.start, panel: panelDef.key };
      if (existing) body.jobId = existing.id;
      else body.jobName = name;
      await api("/api/rows", { method: "POST", body: JSON.stringify(body) });
      input.value = "";
      await refresh();
    });
    addBtn.addEventListener("click", submitAdd);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitAdd();
    });
    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    panel.appendChild(addRow);

    return panel;
  }

  function renderWeeks() {
    // The rebuild below wipes every notes panel — snapshot the open ones (and
    // any unsaved draft text) so a chip/flag edit elsewhere can't destroy them.
    const openNotes = new Map();
    for (const el of weeksContainer.querySelectorAll(".job-notes:not([hidden])")) {
      openNotes.set(el.id, el.querySelector("textarea").value);
    }

    weeksContainer.innerHTML = "";

    let datalist = document.getElementById("jobNamesList");
    if (!datalist) {
      datalist = document.createElement("datalist");
      datalist.id = "jobNamesList";
      document.body.appendChild(datalist);
    }
    datalist.innerHTML = "";
    for (const j of state.jobs) {
      const opt = document.createElement("option");
      opt.value = j.name;
      datalist.appendChild(opt);
    }

    if (!state.weeks.length) {
      weeksContainer.innerHTML = '<div class="empty-schedule">No schedule data.</div>';
      return;
    }

    for (const week of state.weeks) {
      const section = document.createElement("section");
      section.className = "week-section";

      const head = document.createElement("div");
      head.className = "week-head";
      const h2 = document.createElement("h2");
      h2.textContent = weekRangeLabel(week);
      head.appendChild(h2);
      section.appendChild(head);

      const cols = document.createElement("div");
      cols.className = "week-cols";
      const aligned = alignPanels(week);
      for (const panelDef of PANELS) cols.appendChild(panelEl(week, panelDef, aligned[panelDef.key]));
      section.appendChild(cols);

      // Page chrome, not board content: hidden in print and not drawn into the JPG.
      const finishBar = document.createElement("div");
      finishBar.className = "finish-week-bar";
      const finishBtn = document.createElement("button");
      finishBtn.type = "button";
      finishBtn.className = "btn btn-secondary";
      finishBtn.innerHTML = '<i class="ph ph-flag-checkered"></i> Finish week';
      finishBtn.addEventListener("click", () => openFinishWeek(week));
      finishBar.appendChild(finishBtn);
      section.appendChild(finishBar);

      weeksContainer.appendChild(section);
    }

    for (const [id, draft] of openNotes) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.hidden = false;
      const textarea = el.querySelector("textarea");
      if (textarea.value !== draft) textarea.value = draft;
    }

    syncRowHeights();
  }

  // --- "To start" backlog sidebar ---
  // Jobs waiting to be scheduled. One line each; drag a grip into a panel of
  // the shown week to place it (see wireDropTarget). Safe to call on its own.
  function backlogItemEl(item) {
    const el = document.createElement("div");
    el.className = "backlog-item";

    // Same drag-handle technique as the row grip: a dedicated draggable button,
    // with the whole item as the drag image.
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "btn btn-ghost btn-icon drag-grip";
    grip.title = "Drag into Manufacturing or Installing";
    grip.draggable = true;
    grip.innerHTML = '<i class="ph ph-dots-six-vertical"></i>';
    grip.addEventListener("dragstart", (e) => {
      backlogDrag = { id: item.id };
      e.dataTransfer.effectAllowed = "move";
      // Firefox drops a drag that carries no data payload.
      e.dataTransfer.setData("text/plain", String(item.id));
      e.dataTransfer.setDragImage(el, 12, 12);
      el.classList.add("dragging");
    });
    grip.addEventListener("dragend", () => {
      backlogDrag = null;
      el.classList.remove("dragging");
      clearDropMarkers();
    });
    el.appendChild(grip);

    const name = document.createElement("span");
    name.className = "backlog-name";
    name.textContent = item.name;
    name.title = item.name;
    el.appendChild(name);

    el.appendChild(iconBtn("ph-x", "Remove from To start", guarded(async () => {
      await api(`/api/jobs/backlog/${item.id}`, { method: "DELETE" });
      await refresh();
    })));
    return el;
  }

  function backlogAddRowEl(draft) {
    const addRow = document.createElement("div");
    addRow.className = "add-row";
    const input = document.createElement("input");
    input.className = "input";
    input.placeholder = "Add job…";
    input.value = draft;
    input.setAttribute("list", "jobNamesList");
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn btn-primary";
    addBtn.textContent = "+ Add";
    const submitAdd = guarded(async () => {
      const name = input.value.trim();
      if (!name) return;
      await api("/api/jobs/backlog", { method: "POST", body: JSON.stringify({ name }) });
      input.value = "";
      await refresh();
    });
    addBtn.addEventListener("click", submitAdd);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitAdd();
    });
    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    return addRow;
  }

  function renderBacklog() {
    // Rebuilding wipes the add-row, so keep any half-typed name across a refresh.
    const oldInput = backlogEl.querySelector(".add-row .input");
    const draft = oldInput ? oldInput.value : "";
    backlogEl.innerHTML = "";

    const head = document.createElement("div");
    head.className = "backlog-head";
    const h3 = document.createElement("h3");
    h3.textContent = "To start";
    const count = document.createElement("span");
    count.className = "backlog-count";
    count.textContent = String(state.backlog.length);
    head.appendChild(h3);
    head.appendChild(count);
    backlogEl.appendChild(head);

    const list = document.createElement("div");
    list.className = "backlog-list";
    if (!state.backlog.length) {
      const empty = document.createElement("div");
      empty.className = "backlog-empty";
      empty.textContent = "Nothing waiting.";
      list.appendChild(empty);
    }
    for (const item of state.backlog) list.appendChild(backlogItemEl(item));
    backlogEl.appendChild(list);

    backlogEl.appendChild(backlogAddRowEl(draft));
  }

  // Dragging a scheduled row onto "To start" unschedules it. Wired ONCE here on
  // the persistent panel element, not in renderBacklog (which rebuilds the
  // panel's children on every refresh). Only row drags (dragState) are accepted:
  // a backlog-item drag (backlogDrag) is already in the list, so it's refused.
  backlogEl.addEventListener("dragover", (e) => {
    if (!dragState) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    backlogEl.classList.add("drop-active");
  });
  backlogEl.addEventListener("dragleave", (e) => {
    if (!backlogEl.contains(e.relatedTarget)) backlogEl.classList.remove("drop-active");
  });
  backlogEl.addEventListener("drop", guarded(async (e) => {
    if (!dragState) return;
    e.preventDefault();
    const rowId = dragState.rowId;
    dragState = null;
    clearDropMarkers();
    // Deleting the row also drops its workers and day flags, so confirm first
    // when there is anything on it. An empty row goes straight through.
    const week = state.weeks[0];
    const row = week && [...week.manufacturing, ...week.installing].find((r) => r.rowId === rowId);
    if (row) {
      const hasWorkers = DAY_KEYS.some((d) => row.cells[d].length > 0);
      const hasFlags = DAY_KEYS.some((d) => row.flags && row.flags[d]);
      if ((hasWorkers || hasFlags) &&
          !confirm(`Send ${row.jobName} back to To start? The workers assigned to it this week will be cleared.`)) {
        return;
      }
    }
    await api(`/api/rows/${rowId}/move`, { method: "PATCH", body: JSON.stringify({ backlog: true }) });
    await refresh();
  }));

  // --- "Finish week" popup ---
  // Lists each job in the shown week once and asks where it is up to. The
  // answers go to POST /api/rows/finish-week, which sets up the following week.
  // The radio values ARE the server's outcome strings.
  const FINISH_OUTCOMES = [
    { value: "not_started", label: "Not started" },
    { value: "manufacturing", label: "Still manufacturing" },
    { value: "install", label: "Ready to install" },
    { value: "complete", label: "Complete" },
  ];
  // True while the request is in flight: blocks a second Done, and stops Esc or
  // a backdrop click from dismissing the popup mid-save.
  let finishBusy = false;

  // Backdrop click dismisses. Clicks inside the popup land on its children, so
  // only a click whose target is the dialog itself is the backdrop.
  finishDialog.addEventListener("click", (e) => {
    if (e.target === finishDialog && !finishBusy) finishDialog.close();
  });
  finishDialog.addEventListener("cancel", (e) => {
    if (finishBusy) e.preventDefault();
  });

  // One group per job name (alignKey), so a job sitting in both panels is one
  // line. Manufacturing is walked first, so the order is manufacturing rows,
  // then installing-only jobs.
  function finishGroups(week) {
    const groups = new Map();
    for (const [panelKey, rows] of [["manufacturing", week.manufacturing], ["installing", week.installing]]) {
      for (const row of rows) {
        const key = alignKey(row);
        if (!groups.has(key)) groups.set(key, { name: row.jobName, mfgJobId: null, instJobId: null });
        const g = groups.get(key);
        if (panelKey === "manufacturing" && g.mfgJobId === null) g.mfgJobId = row.jobId;
        if (panelKey === "installing" && g.instJobId === null) g.instJobId = row.jobId;
      }
    }
    return [...groups.values()];
  }

  // The jobId that carries a group's result. 'install' prefers the installing
  // row; every other outcome prefers the manufacturing row. Each falls back to
  // the other panel's row when it has none.
  function finishJobId(g, outcome) {
    const installFirst = outcome === "install";
    const first = installFirst ? g.instJobId : g.mfgJobId;
    const second = installFirst ? g.mfgJobId : g.instJobId;
    return first !== null ? first : second;
  }

  function finishWhere(g) {
    if (g.mfgJobId !== null && g.instJobId !== null) return "Manufacturing + Installing";
    return g.mfgJobId !== null ? "Manufacturing" : "Installing";
  }

  // Plain-words summary of the POST response, shown in the toast after Done.
  function finishSummary(res) {
    const carried = res.created.filter((c) => c.outcome !== "not_started").length;
    const toStart = res.created.length - carried;
    const already = res.skipped.length;
    const finished = res.completed.length;
    const parts = [];
    if (carried) parts.push(`${carried} carried over`);
    if (toStart) parts.push(`${toStart} to To start`);
    if (already) parts.push(`${already} already there`);
    if (finished) parts.push(`${finished} finished`);
    return parts.length ? `Next week set up: ${parts.join(", ")}` : "Next week set up: nothing to carry over";
  }

  // One line per job: name, where it sits now, and the segmented control.
  function finishItemEl(g, index) {
    const item = document.createElement("div");
    item.className = "finish-item";

    const info = document.createElement("div");
    info.className = "finish-info";
    const name = document.createElement("span");
    name.className = "finish-name";
    name.textContent = g.name;
    const where = document.createElement("span");
    where.className = "finish-where text-muted";
    where.textContent = finishWhere(g);
    info.append(name, where);

    // Real radio inputs (visually hidden, still tabbable and arrow-key driven)
    // inside labels styled as one joined control.
    const seg = document.createElement("div");
    seg.className = "finish-seg";
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", `${g.name} status`);
    for (const opt of FINISH_OUTCOMES) {
      const label = document.createElement("label");
      label.className = "finish-opt";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `fw-${index}`;
      input.value = opt.value;
      // Installing-only jobs default to Complete; every other job starts unanswered.
      if (opt.value === "complete" && g.mfgJobId === null) input.checked = true;
      const text = document.createElement("span");
      text.textContent = opt.label;
      label.append(input, text);
      seg.appendChild(label);
    }

    item.append(info, seg);
    return item;
  }

  function openFinishWeek(week) {
    const groups = finishGroups(week);
    if (!groups.length) {
      toast("No jobs in this week");
      return;
    }
    finishDialog.innerHTML = "";

    const body = document.createElement("div");
    body.className = "finish-body";
    const h2 = document.createElement("h2");
    h2.textContent = `Finish week — ${weekRangeLabel(week)}`;
    const help = document.createElement("p");
    help.className = "finish-help text-muted";
    help.textContent = "Say where each job is up to. This sets up next week.";
    const list = document.createElement("div");
    list.className = "finish-list";
    const foot = document.createElement("div");
    foot.className = "finish-foot";
    const count = document.createElement("span");
    count.className = "finish-count text-muted";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-secondary";
    cancel.textContent = "Cancel";
    const done = document.createElement("button");
    done.type = "button";
    done.className = "btn btn-primary";
    done.textContent = "Done";
    foot.append(count, cancel, done);
    body.append(h2, help, list, foot);
    finishDialog.appendChild(body);

    groups.forEach((g, i) => list.appendChild(finishItemEl(g, i)));

    // Single source of truth for the footer: the counter, and whether Done and
    // Cancel are usable (both locked while a save is in flight).
    const updateProgress = () => {
      let answered = 0;
      for (const item of list.children) {
        const picked = item.querySelector("input:checked");
        if (picked) answered++;
        item.classList.toggle("answered", !!picked);
        for (const opt of item.querySelectorAll(".finish-opt")) {
          opt.classList.toggle("selected", opt.querySelector("input").checked);
        }
      }
      count.textContent = `${answered} of ${groups.length} answered`;
      done.disabled = finishBusy || answered < groups.length;
      cancel.disabled = finishBusy;
    };
    list.addEventListener("change", updateProgress);
    cancel.addEventListener("click", () => finishDialog.close());
    done.addEventListener("click", guarded(async () => {
      // One entry per group. A jobId already used by an earlier group is dropped,
      // since the server rejects duplicate jobIds in one request.
      const seen = new Set();
      const results = [];
      groups.forEach((g, i) => {
        const outcome = list.querySelector(`input[name="fw-${i}"]:checked`).value;
        const jobId = finishJobId(g, outcome);
        if (seen.has(jobId)) return;
        seen.add(jobId);
        results.push({ jobId, outcome });
      });
      finishBusy = true;
      updateProgress();
      try {
        const res = await api("/api/rows/finish-week", {
          method: "POST",
          body: JSON.stringify({ weekStart: week.start, results }),
        });
        finishDialog.close();
        toast(finishSummary(res));
        // Land on the week that was just set up.
        state.weekStart = addDays(week.start, 7);
        await refresh();
      } finally {
        // On failure guarded() toasts the error; the answers stay put and Done
        // comes back so the user can retry.
        finishBusy = false;
        updateProgress();
      }
    }));

    updateProgress();
    finishDialog.showModal();
  }

  async function refresh() {
    // jobs included so a rename can't leave the add-job autocomplete offering
    // stale names (which silently creates duplicate jobs server-side).
    await Promise.all([loadWorkers(), loadJobs(), loadSchedule()]);
    renderedToday = localTodayStr();
    renderLegend();
    renderWeeks();
    renderBacklog();
    weekPicker.value = state.weekStart;
  }

  // --- nav controls ---
  document.getElementById("prevWeekBtn").addEventListener("click", guarded(async () => {
    state.weekStart = addDays(state.weekStart, -7);
    await refresh();
  }));
  document.getElementById("nextWeekBtn").addEventListener("click", guarded(async () => {
    state.weekStart = addDays(state.weekStart, 7);
    await refresh();
  }));
  document.getElementById("todayBtn").addEventListener("click", guarded(async () => {
    state.weekStart = mondayOf(localTodayStr());
    await refresh();
  }));
  weekPicker.addEventListener("change", guarded(async () => {
    if (!weekPicker.value) return;
    state.weekStart = mondayOf(weekPicker.value);
    await refresh();
  }));
  document.getElementById("exportPdfBtn").addEventListener("click", () => window.print());
  document.getElementById("exportJpgBtn").addEventListener("click", exportJpg);

  // --- JPG export: drawn straight from the loaded data, not a DOM screenshot ---
  function exportJpg() {
    // The "To start" backlog sidebar is intentionally not drawn into the export.
    if (!state.weeks.length) {
      toast("Nothing to export yet");
      return;
    }
    // Wider than it was: chips now sit in up to two columns per cell (mirroring
    // the board), and 132px left a two-column day unreadable.
    const dayW = 150;
    const jobW = 190;
    const panelW = jobW + dayW * 5;
    const gap = 28;
    const margin = 24;
    const chipH = 22;
    const chipGap = 4;
    const rowPad = 10;
    const headerH = 26;
    const panelTitleH = 24;
    const weekTitleH = 30;

    // Chips stack at most two deep before spilling into a new column (see
    // .sched-chips and the gridTemplateRows line in rowEl) — so a cell is at
    // most two chips tall no matter how many workers are on the day.
    const CHIP_ROWS = 2;
    function chipRowsUsed(n) {
      return Math.max(1, Math.min(n, CHIP_ROWS));
    }
    function rowHeight(row) {
      const deepest = Math.max(1, ...DAY_KEYS.map((d) => chipRowsUsed(row.cells[d].length)));
      return Math.max(34, rowPad * 2 + deepest * chipH + (deepest - 1) * chipGap);
    }

    // Mirrors the on-screen alignment: one shared height per line, both panels.
    const alignedWeeks = state.weeks.map((week) => alignPanels(week));
    const weekLines = alignedWeeks.map((aligned) =>
      aligned.manufacturing.map((r, i) => {
        const b = aligned.installing[i];
        return Math.max(r ? rowHeight(r) : 34, b ? rowHeight(b) : 34);
      })
    );

    let totalH = margin;
    const weekHeights = [];
    for (const lines of weekLines) {
      const bodyH = headerH + lines.reduce((a, h) => a + h, 0);
      const h = weekTitleH + panelTitleH + bodyH + gap;
      weekHeights.push(h);
      totalH += h;
    }
    totalH += margin;

    const canvas = document.createElement("canvas");
    const scale = 2;
    canvas.width = (margin * 2 + panelW * 2 + gap) * scale;
    canvas.height = totalH * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = "#0a0607";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textBaseline = "middle";
    ctx.font = "600 12px Inter, system-ui, sans-serif";

    let y = margin;
    state.weeks.forEach((week, wi) => {
      ctx.fillStyle = "#e9e9ed";
      ctx.font = "700 16px Inter, system-ui, sans-serif";
      ctx.fillText(weekRangeLabel(week), margin, y + 14);
      // Mirrors the board's accent week banner — a hard rule marking where
      // each week starts.
      ctx.strokeStyle = "#9184d9";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(margin, y + 26);
      ctx.lineTo(margin + panelW * 2 + gap, y + 26);
      ctx.stroke();
      ctx.lineWidth = 1;
      y += weekTitleH;

      [
        { key: "manufacturing", label: "MANUFACTURING", x: margin },
        { key: "installing", label: "INSTALLING", x: margin + panelW + gap },
      ].forEach(({ key, label, x }) => {
        let py = y;
        ctx.fillStyle = "#9184d9";
        ctx.font = "700 11px Inter, system-ui, sans-serif";
        ctx.fillText(label, x, py + 10);
        py += panelTitleH;

        ctx.strokeStyle = "#3f424d";
        ctx.fillStyle = "#9397ab";
        ctx.font = "600 10px Inter, system-ui, sans-serif";
        DAY_KEYS.forEach((day, i) => {
          ctx.fillText(`${DAY_LABELS[day].toUpperCase()} ${fmtAUShort(addDays(week.start, i))}`, x + jobW + i * dayW + 6, py + headerH / 2);
        });
        ctx.beginPath();
        ctx.moveTo(x, py + headerH);
        ctx.lineTo(x + panelW, py + headerH);
        ctx.stroke();
        py += headerH;

        alignedWeeks[wi][key].forEach((row, li) => {
          const h = weekLines[wi][li];
          if (row) {
            const hasNotes = !!(row.notes && row.notes.trim());
            ctx.fillStyle = "#e9e9ed";
            ctx.font = "500 12px Inter, system-ui, sans-serif";
            ctx.fillText(row.jobName, x, py + h / 2, hasNotes ? jobW - 24 : jobW - 10);
            if (hasNotes) {
              // Mirrors the board's orange notes icon.
              ctx.fillStyle = "#ff8c1a";
              ctx.beginPath();
              ctx.arc(x + jobW - 12, py + h / 2, 3.5, 0, Math.PI * 2);
              ctx.fill();
            }

            DAY_KEYS.forEach((day, i) => {
              const cellX = x + jobW + i * dayW;
              if (key === "installing" && row.flags && row.flags[day]) {
                ctx.fillStyle = "rgba(232, 179, 57, 0.12)";
                ctx.fillRect(cellX, py, dayW, h);
                ctx.fillStyle = "#e8b339";
                ctx.fillRect(cellX, py, 3, h);
              }
              // Column-major, two deep — the same fill order as the board's
              // .sched-chips grid: 2nd under 1st, 3rd beside 1st, 4th under 3rd.
              // Columns split the cell evenly, so names clip to their column
              // exactly like the board's ellipsis does.
              const chips = row.cells[day];
              const chipCols = Math.max(1, Math.ceil(chips.length / CHIP_ROWS));
              const colW = (dayW - 8) / chipCols;
              chips.forEach((chip, k) => {
                const cx = cellX + 4 + Math.floor(k / CHIP_ROWS) * colW;
                const cy = py + rowPad + (k % CHIP_ROWS) * chipH;
                const text = chip.name;
                ctx.font = "500 11px Inter, system-ui, sans-serif";
                const w = Math.min(colW - 4, ctx.measureText(text).width + 14);
                ctx.fillStyle = chip.bg;
                roundRect(ctx, cx, cy, w, chipH - 4, 5);
                ctx.fill();
                ctx.fillStyle = chip.fg;
                ctx.fillText(text, cx + 7, cy + (chipH - 4) / 2, w - 12);
              });
            });
          }

          ctx.strokeStyle = "#232532";
          ctx.beginPath();
          ctx.moveTo(x, py + h);
          ctx.lineTo(x + panelW, py + h);
          ctx.stroke();
          py += h;
        });
      });

      y += weekHeights[wi] - weekTitleH;
    });

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          toast("Export failed");
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `schedule-${state.weeks[0].start}.jpg`;
        a.click();
        URL.revokeObjectURL(url);
      },
      "image/jpeg",
      0.92
    );
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Row-height pairing depends on wrapping, so re-measure when the viewport
  // changes — and once the web font lands, since it shifts text metrics.
  window.addEventListener("resize", queueSync);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncRowHeights);

  // The board lives on an always-on workshop TV: once the local date rolls
  // over, re-render so the today highlight moves — and if the viewer was on
  // the current week, re-anchor so a new week surfaces on Monday morning.
  setInterval(async () => {
    const now = localTodayStr();
    if (now === renderedToday) return;
    try {
      if (state.weekStart === mondayOf(renderedToday)) state.weekStart = mondayOf(now);
      await refresh();
    } catch {
      // Server may be mid-restart overnight; renderedToday only advances on a
      // successful refresh, so the next tick retries.
    }
  }, 60000);

  // --- boot ---
  (async function init() {
    try {
      await refresh();
    } catch (e) {
      weeksContainer.innerHTML = `<div class="empty-schedule">Couldn't load the schedule: ${e.message}</div>`;
    }
  })();
})();
