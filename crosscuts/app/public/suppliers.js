// Supplier accounts (/suppliers.html[?period=YYYY-MM][&print=blank]): the monthly checklist of
// supplier statements, its print, and the blank paper form (docs/plans/m9-contracts.md sections 7.2,
// 7.3 and 9.2; the paper form is m9-plan section 1.4).
//
// Each supplier's line saves on its own: a change commits on blur (Total, Note) or on choosing (the
// statement state, the ticks), as one PUT per line carrying the updatedAt it last saw. A line has at
// most one request in flight; changes made meanwhile are queued and sent after it, and what is typed
// while a save is in flight is never overwritten. A 409 shows its sentence on that row with Reload; a
// refused value outlines its cell in orange with the sentence under the row.
//
// Month arithmetic and money come from public/periods.js (window.Periods). Without invoices.edit the
// page is read-only: every write control is left out. User text goes in via textContent only.
(function () {
  "use strict";

  const P = window.Periods;
  const $ = (id) => document.getElementById(id);

  const STATES = [
    ["have", "Have statement"],
    ["waiting", "Waiting"],
    ["na", "N/A"],
  ];
  const STATE_WORD = { have: "Have statement", waiting: "Waiting", na: "N/A" };
  const TICKS = [
    ["reconciled", "Reconciled"],
    ["paid", "Paid"],
    ["myob", "Entered in MYOB"],
  ];
  const ACCEPT_EXT = ["pdf", "jpg", "jpeg", "png", "webp", "heic"];
  const MAX_BYTES = 25 * 1024 * 1024;
  const MAX_CENTS = 1000000000;
  const CHECK = "✓"; // a check mark character, not an icon (contracts section 9.2)

  const UNREADABLE_TOTAL = "Can't read the total: type an amount like 1,234.50";
  const TOO_BIG_TOTAL = "The total can be at most $10,000,000.00";

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

  // Today's date in Sydney, YYYY-MM-DD (en-CA formats as ISO).
  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function longDate(date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  // JSON or multipart call that keeps the response body on errors (a 409 brings .body.line).
  async function call(method, path, body) {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined || isForm ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      });
    } catch (e) {
      const err = new Error("Couldn't reach the server; try again");
      err.status = 0;
      err.body = null;
      throw err;
    }
    if (res.status === 401) {
      location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
      return new Promise(() => {}); // the page is navigating away
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------------ state ---

  const params = new URLSearchParams(location.search);
  const blankMode = params.get("print") === "blank";

  let canEdit = false;
  let today = todayISO();
  let current = P.currentPeriod(today);
  let period = null; // the month on screen
  let month = null; // the month object (section 7.3) as last loaded
  let rows = []; // one per line, in the month's order (see makeRow)
  let loadSeq = 0;
  let showArchived = false;
  let suppliers = [];
  let leaving = false; // navigating away on purpose: no unsaved-changes prompt

  function defaultPeriod() {
    const p = P.addMonths(current, -1); // statements for a month arrive after it ends
    return p < P.HISTORY_START ? P.HISTORY_START : p;
  }
  function inRange(p) {
    return P.validPeriod(p) && p >= P.HISTORY_START && p <= current;
  }

  // ------------------------------------------------------------ the header ---

  function renderHeader() {
    $("suMonth").textContent = P.longLabel(period);
    document.title = `Supplier accounts ${P.longLabel(period)} - Crosscuts`;
    const prev = month && "prev" in month ? month.prev : period > P.HISTORY_START ? P.addMonths(period, -1) : null;
    const next = month && "next" in month ? month.next : period < current ? P.addMonths(period, 1) : null;
    const pb = $("suPrev");
    const nb = $("suNext");
    pb.disabled = !prev;
    nb.disabled = !next;
    pb.dataset.to = prev || "";
    nb.dataset.to = next || "";
    pb.setAttribute("aria-label", prev ? `Previous month, ${P.longLabel(prev)}` : "Previous month");
    nb.setAttribute("aria-label", next ? `Next month, ${P.longLabel(next)}` : "Next month");
    $("suBlank").href = `/suppliers.html?period=${period}&print=blank`;
    const bits = [];
    if (period === current) bits.push("This month is still running; statements usually arrive after it ends.");
    bits.push(canEdit ? "Each line saves on its own as you change it." : "View only.");
    $("suMeta").textContent = bits.join(" ");
  }

  function syncUrl() {
    history.replaceState(null, "", `${location.pathname}?period=${period}`);
  }

  // --------------------------------------------------------------- the rows ---

  // A row: {id, name, server: the line as last saved, committed: {total, note} texts as last
  // committed, tr, msgTr, ..., chain: the line's request queue, busy, saveQueued, stale, refused,
  // error}.
  function lineTotalText(line) {
    return line.totalCents == null ? "" : P.dollars(line.totalCents);
  }

  function makeRow(line) {
    const R = {
      id: line.supplier.id,
      name: line.supplier.name,
      server: line,
      committed: { total: lineTotalText(line), note: line.note || "" },
      chain: Promise.resolve(),
      busy: 0,
      saveQueued: false,
      stale: null, // {sentence, line} after a 409
      refused: null, // {field, sentence}
      error: null, // a sentence: not saved for another reason
      fileError: null,
      flash: "",
      dead: false,
    };
    R.tr = el("tr", { class: "su-row", "data-id": String(R.id) });
    R.nameEl = el("span", { class: "su-name", text: R.name });
    R.stateEl = el("span", { class: "su-rowstate" });
    R.nameTd = el("th", { scope: "row", class: "su-c-name" }, R.nameEl, R.stateEl);
    R.stateTd = el("td", { class: "su-c-state" });
    R.totalTd = el("td", { class: "su-c-total num" });
    R.tickTds = {};
    for (const [k] of TICKS) R.tickTds[k] = el("td", { class: "su-c-tick" });
    R.noteTd = el("td", { class: "su-c-note" });
    R.fileTd = el("td", { class: "su-c-file" });
    R.tr.append(R.nameTd, R.stateTd, R.totalTd, R.tickTds.reconciled, R.tickTds.paid, R.tickTds.myob, R.noteTd, R.fileTd);
    R.msgId = `su-msg-${R.id}`;
    R.msgTd = el("td", { colspan: "8", id: R.msgId });
    R.msgTr = el("tr", { class: "su-msgrow" }, R.msgTd);
    R.msgTr.hidden = true;

    if (canEdit) buildEditCells(R);
    else buildReadCells(R);
    renderFile(R);
    return R;
  }

  function buildReadCells(R) {
    const l = R.server;
    const cls = l.state === "have" ? "hs-badge-teal" : l.state === "na" ? "hs-badge-na" : "hs-badge-check";
    R.stateTd.replaceChildren(el("span", { class: `hs-badge ${cls}`, text: STATE_WORD[l.state] || l.state }));
    R.totalTd.textContent = lineTotalText(l);
    for (const [k, label] of TICKS) {
      R.tickTds[k].replaceChildren(l[k] ? el("span", { class: "su-tick-ro", text: CHECK, "aria-label": label, role: "img" }) : "");
    }
    R.noteTd.replaceChildren(el("span", { class: "su-note-ro", text: l.note || "" }));
  }

  function buildEditCells(R) {
    const name = R.name;
    // The statement state: one of three, as radios (arrow keys move and choose).
    R.radioGroup = el("div", { class: "su-seg", role: "radiogroup", "aria-label": `Statement, ${name}` });
    R.radios = {};
    for (const [v, label] of STATES) {
      const input = el("input", { type: "radio", name: `su-st-${R.id}`, value: v });
      input.addEventListener("change", () => {
        if (input.checked) commit(R);
      });
      R.radios[v] = input;
      R.radioGroup.append(el("label", { class: `su-seg-opt su-seg-${v}` }, input, el("span", { text: label })));
    }
    R.stateTd.replaceChildren(R.radioGroup);

    R.totalIn = el("input", {
      class: "su-in su-in-total", type: "text", inputmode: "decimal", autocomplete: "off",
      spellcheck: "false", maxlength: "20", "aria-label": `Total, ${name}`,
    });
    R.totalIn.addEventListener("blur", () => {
      const v = P.parseDollars(R.totalIn.value);
      if (!Number.isNaN(v)) {
        const tidy = v == null ? "" : P.dollars(v);
        if (tidy !== R.totalIn.value) R.totalIn.value = tidy;
      }
      R.committed.total = R.totalIn.value;
      commit(R);
    });
    R.totalIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        R.totalIn.blur();
        R.totalIn.focus();
      }
    });
    R.totalTd.replaceChildren(R.totalIn);

    R.ticks = {};
    for (const [k, label] of TICKS) {
      const input = el("input", { type: "checkbox", "aria-label": `${label}, ${name}` });
      input.addEventListener("change", () => commit(R));
      R.ticks[k] = input;
      R.tickTds[k].replaceChildren(el("label", { class: "su-tick" }, input));
    }

    R.noteIn = el("input", {
      class: "su-in su-in-note", type: "text", autocomplete: "off", maxlength: "500",
      "aria-label": `Note, ${name}`,
    });
    R.noteIn.addEventListener("blur", () => {
      R.committed.note = R.noteIn.value;
      commit(R);
    });
    R.noteIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        R.noteIn.blur();
        R.noteIn.focus();
      }
    });
    R.noteTd.replaceChildren(R.noteIn);

    setAllUi(R, R.server);
  }

  // Puts a line's values into the row's controls.
  function setAllUi(R, line) {
    R.committed = { total: lineTotalText(line), note: line.note || "" };
    if (!canEdit) {
      buildReadCells(R);
      return;
    }
    for (const [v] of STATES) R.radios[v].checked = line.state === v;
    R.totalIn.value = R.committed.total;
    R.noteIn.value = R.committed.note;
    for (const [k] of TICKS) R.ticks[k].checked = !!line[k];
  }

  function renameRow(R, name) {
    if (name === R.name) return;
    R.name = name;
    R.nameEl.textContent = name;
    if (!canEdit) return;
    R.radioGroup.setAttribute("aria-label", `Statement, ${name}`);
    R.totalIn.setAttribute("aria-label", `Total, ${name}`);
    R.noteIn.setAttribute("aria-label", `Note, ${name}`);
    for (const [k, label] of TICKS) R.ticks[k].setAttribute("aria-label", `${label}, ${name}`);
    renderFile(R);
  }

  function renderFile(R) {
    const f = R.server.file;
    const kids = [];
    if (f) {
      const a = el("a", { class: "su-file", href: f.url, target: "_blank", rel: "noopener", text: f.name });
      a.setAttribute("aria-label", `Statement for ${R.name}: ${f.name} (opens in a new tab)`);
      kids.push(a);
    } else if (!canEdit) {
      kids.push(el("span", { class: "su-none", text: "None" }));
    }
    if (canEdit && !R.stale) {
      const tools = el("span", { class: "su-filetools" });
      const attach = el("button", {
        type: "button", class: "hs-btn su-mini",
        text: f ? "Replace" : "Attach",
        "aria-label": f ? `Replace the statement for ${R.name}` : `Attach a statement for ${R.name}`,
      });
      attach.addEventListener("click", () => pickFor(R));
      tools.append(attach);
      if (f) {
        const rm = el("button", {
          type: "button", class: "hs-btn hs-btn-stop su-mini", text: "Remove",
          "aria-label": `Remove the statement for ${R.name}`,
        });
        rm.addEventListener("click", () => removeFile(R));
        tools.append(rm);
      }
      kids.push(tools);
    }
    R.fileTd.replaceChildren(...kids);
    R.fileTd.classList.toggle("su-bad-cell", !!R.fileError);
  }

  // The row's message line (409, refused value, other errors) and its small saving state.
  function renderMsg(R) {
    const td = R.msgTd;
    td.replaceChildren();
    const box = el("div", { class: "su-msg" });
    let any = false;
    if (R.stale) {
      any = true;
      box.append(el("span", { class: "su-msg-text", text: R.stale.sentence }));
      const b = el("button", { type: "button", class: "hs-btn hs-btn-check su-mini", text: "Reload", "aria-label": `Reload the line for ${R.name}` });
      b.addEventListener("click", () => reloadRow(R, b));
      box.append(b);
      box.append(el("span", { class: "su-msg-hint", text: "Reloading shows the saved line; what you changed here is dropped." }));
    } else {
      for (const s of [R.refused && R.refused.sentence, R.error, R.fileError]) {
        if (!s) continue;
        any = true;
        box.append(el("span", { class: "su-msg-text", text: s }));
      }
    }
    if (any) td.append(box);
    R.msgTr.hidden = !any;

    // Orange outline on the refused cell.
    if (canEdit) {
      const field = R.refused ? R.refused.field : null;
      setBad(R.totalIn, field === "total", R);
      setBad(R.noteIn, field === "note", R);
      R.radioGroup.classList.toggle("su-bad", field === "state");
      if (field === "state") R.radioGroup.setAttribute("aria-describedby", R.msgId);
      else R.radioGroup.removeAttribute("aria-describedby");
      for (const [k] of TICKS) R.tickTds[k].classList.toggle("su-bad-cell", field === k);
      R.nameTd.classList.toggle("su-bad-cell", field === "row");
    }
    R.fileTd.classList.toggle("su-bad-cell", !!R.fileError);

    let st = R.flash;
    let cls = "su-rowstate";
    if (R.busy) st = R.busyText || "Saving...";
    else if (R.stale || R.refused || R.error) {
      st = "Not saved";
      cls += " su-rowstate-bad";
    }
    R.stateEl.textContent = st || "";
    R.stateEl.className = cls;
  }

  function setBad(input, on, R) {
    input.classList.toggle("su-bad", on);
    if (on) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", R.msgId);
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  }

  // Which cell a server's 400 sentence is about (the server names the value it refused).
  function fieldOf(sentence) {
    const s = String(sentence || "").toLowerCase();
    if (/total|amount|\$/.test(s)) return "total";
    if (/note/.test(s)) return "note";
    if (/reconcil/.test(s)) return "reconciled";
    if (/myob/.test(s)) return "myob";
    if (/\bpaid\b/.test(s)) return "paid";
    if (/state|statement|have|waiting|n\/a/.test(s)) return "state";
    return "row";
  }

  // ------------------------------------------------------------------ saving ---

  // Runs fn after the line's earlier requests, one at a time.
  function enqueue(R, fn) {
    R.busy++;
    const p = R.chain.then(fn).catch((e) => {
      console.error(e); // a bug, not a refused request: those are handled inside fn
    }).finally(() => {
      R.busy--;
      if (!R.dead) renderMsg(R);
      updateFooter();
    });
    R.chain = p;
    renderMsg(R);
    return p;
  }

  function uiState(R) {
    for (const [v] of STATES) if (R.radios[v].checked) return v;
    return R.server.state;
  }

  // The body to send, from the committed texts and the chosen state and ticks. A value that can't
  // be read is refused (its cell outlined) and the saved value is sent in its place, so the rest of
  // the line still saves.
  function buildBody(R) {
    let refused = null;
    let totalCents = P.parseDollars(R.committed.total);
    if (Number.isNaN(totalCents)) {
      refused = { field: "total", sentence: UNREADABLE_TOTAL, client: true };
      totalCents = R.server.totalCents;
    } else if (totalCents != null && Math.abs(totalCents) > MAX_CENTS) {
      refused = { field: "total", sentence: TOO_BIG_TOTAL, client: true };
      totalCents = R.server.totalCents;
    }
    const body = {
      state: uiState(R),
      totalCents: totalCents == null ? null : totalCents,
      note: R.committed.note.trim(),
      reconciled: R.ticks.reconciled.checked,
      paid: R.ticks.paid.checked,
      myob: R.ticks.myob.checked,
    };
    return { body, refused };
  }

  function sameAsServer(R, body) {
    const l = R.server;
    return body.state === l.state && (body.totalCents ?? null) === (l.totalCents ?? null) &&
      body.note === (l.note || "") && body.reconciled === !!l.reconciled &&
      body.paid === !!l.paid && body.myob === !!l.myob;
  }

  // Commits the line: queues one save, which reads the values when it runs, so changes made while
  // a save is in flight go in the next request and nothing is sent twice.
  function commit(R) {
    if (!canEdit || R.dead) return;
    if (R.stale) {
      renderMsg(R);
      return; // reload first; sending would only meet the same 409
    }
    // A refusal the browser can see shows at once, even with a save in flight.
    const pre = buildBody(R);
    if (pre.refused) {
      R.refused = pre.refused;
      renderMsg(R);
    } else if (R.refused && R.refused.client) {
      R.refused = null;
      renderMsg(R);
    }
    if (R.saveQueued) return;
    R.saveQueued = true;
    enqueue(R, () => {
      R.saveQueued = false;
      return save(R);
    });
  }

  async function save(R) {
    if (R.dead || R.stale) return;
    const { body, refused } = buildBody(R);
    if (sameAsServer(R, body)) {
      R.refused = refused;
      R.error = null;
      return;
    }
    const sentPeriod = period;
    R.busyText = "Saving...";
    renderMsg(R);
    try {
      const line = await call("PUT", `/api/suppliers/months/${sentPeriod}/${R.id}`, Object.assign({}, body, { updatedAt: R.server.updatedAt }));
      if (R.dead) return;
      applyServer(R, line, body);
      R.refused = refused;
      R.error = null;
      R.flash = "Saved";
      say(`Saved the line for ${R.name}.`);
    } catch (e) {
      if (R.dead) return;
      R.flash = "";
      if (e.status === 409 && e.body && e.body.line) {
        R.stale = { sentence: e.body.error || "Someone else changed this line; reload it", line: e.body.line };
        R.refused = null;
        R.error = null;
        renderFile(R); // the file tools wait for the reload too
        say(`Not saved: ${R.stale.sentence}`);
      } else if (e.status === 400) {
        R.refused = { field: fieldOf(e.message), sentence: e.message, client: false };
        say(`Not saved: ${e.message}`);
      } else {
        R.error = `Not saved. ${e.message}`;
        say(R.error);
      }
    } finally {
      R.busyText = "";
    }
  }

  // Takes the server's line. A control the user has changed since `base` (what was sent, or what
  // the server had) keeps what they typed; the rest show the saved values.
  function applyServer(R, line, base) {
    R.server = line;
    renameRow(R, line.supplier.name);
    if (!canEdit) {
      buildReadCells(R);
      renderFile(R);
      return;
    }
    // Total and Note: the committed text takes the saved value unless it was changed after `base`;
    // a field being typed in keeps what is in it (its blur commits it).
    if (P.parseDollars(R.committed.total) === (base.totalCents ?? null)) {
      R.committed.total = lineTotalText(line);
      if (document.activeElement !== R.totalIn) R.totalIn.value = R.committed.total;
    }
    if (R.committed.note.trim() === (base.note || "")) {
      R.committed.note = line.note || "";
      if (document.activeElement !== R.noteIn) R.noteIn.value = R.committed.note;
    }
    if (uiState(R) === base.state) for (const [v] of STATES) R.radios[v].checked = line.state === v;
    for (const [k] of TICKS) {
      if (R.ticks[k].checked === !!base[k]) R.ticks[k].checked = !!line[k];
    }
    renderFile(R);
  }

  function baseOf(line) {
    return {
      state: line.state, totalCents: line.totalCents ?? null, note: line.note || "",
      reconciled: !!line.reconciled, paid: !!line.paid, myob: !!line.myob,
    };
  }

  async function reloadRow(R, btn) {
    if (btn) btn.disabled = true;
    let line = R.stale ? R.stale.line : null;
    try {
      const m = await call("GET", `/api/suppliers/months/${period}`);
      if (R.dead) return;
      month = m;
      const fresh = (m.lines || []).find((l) => l.supplier.id === R.id);
      if (!fresh) {
        // No longer listed in this month: show the month as it now is.
        R.stale = null;
        syncRows(m.lines || [], { force: true });
        renderAfterSync();
        say(`${R.name} isn't listed in ${P.longLabel(period)} any more.`);
        return;
      }
      line = fresh;
    } catch (e) {
      if (!line) {
        toast(`Error: ${e.message}`);
        if (btn) btn.disabled = false;
        return;
      }
    }
    R.server = line;
    R.stale = null;
    R.refused = null;
    R.error = null;
    R.fileError = null;
    R.flash = "Reloaded";
    renameRow(R, line.supplier.name);
    setAllUi(R, line);
    renderFile(R);
    renderMsg(R);
    updateFooter();
    say(`Reloaded the saved line for ${R.name}.`);
    const first = canEdit ? R.radios[line.state] || R.totalIn : null;
    if (first) first.focus();
  }

  // ------------------------------------------------------------------- files ---

  let pickRow = null;
  function pickFor(R) {
    if (!canEdit || R.stale) return;
    pickRow = R;
    const input = $("suPick");
    input.value = "";
    input.click();
  }

  function checkFile(file) {
    const ext = ((/\.([^.]+)$/.exec(file.name) || [])[1] || "").toLowerCase();
    if (!ACCEPT_EXT.includes(ext)) return "That file type isn't allowed: attach a PDF or a photo (JPEG, PNG, WebP or HEIC)";
    if (file.size > MAX_BYTES) return "That file is too big (25 MB at most)";
    if (file.size === 0) return "That file is empty";
    return "";
  }

  function onPicked() {
    const R = pickRow;
    pickRow = null;
    const input = $("suPick");
    const file = input.files && input.files[0];
    input.value = "";
    if (!R || !file || R.dead) return;
    const bad = checkFile(file);
    if (bad) {
      R.fileError = bad;
      renderMsg(R);
      focusFileTool(R);
      return;
    }
    const old = R.server.file;
    if (old && !confirm(`Replace the statement for ${R.name} (${old.name}) with ${file.name}?`)) {
      focusFileTool(R);
      return;
    }
    enqueue(R, async () => {
      if (R.dead) return;
      R.busyText = "Uploading...";
      renderMsg(R);
      const before = baseOf(R.server);
      try {
        const fd = new FormData();
        fd.append("file", file, file.name);
        const line = await call("POST", `/api/suppliers/months/${period}/${R.id}/file`, fd);
        if (R.dead) return;
        if (R.stale) R.stale.line = line;
        else applyServer(R, line, before);
        R.fileError = null;
        R.flash = old ? "File replaced" : "File attached";
        say(`${old ? "Replaced" : "Attached"} the statement for ${R.name}: ${file.name}.`);
      } catch (e) {
        if (R.dead) return;
        R.fileError = `Not attached. ${e.message}`;
        say(R.fileError);
      } finally {
        R.busyText = "";
      }
    }).then(() => focusFileTool(R));
  }

  function removeFile(R) {
    const f = R.server.file;
    if (!f || R.stale) return;
    if (!confirm(`Remove the statement ${f.name} from the line for ${R.name} (${P.longLabel(period)})?`)) return;
    enqueue(R, async () => {
      if (R.dead) return;
      R.busyText = "Removing...";
      renderMsg(R);
      const before = baseOf(R.server);
      try {
        const line = await call("DELETE", `/api/suppliers/months/${period}/${R.id}/file`);
        if (R.dead) return;
        applyServer(R, line, before);
        R.fileError = null;
        R.flash = "File removed";
        say(`Removed the statement for ${R.name}.`);
      } catch (e) {
        if (R.dead) return;
        R.fileError = `Not removed. ${e.message}`;
        say(R.fileError);
      } finally {
        R.busyText = "";
      }
    }).then(() => focusFileTool(R));
  }

  function focusFileTool(R) {
    if (R.dead) return;
    const b = R.fileTd.querySelector("button");
    if (b) b.focus();
  }

  // ------------------------------------------------------------- the month ---

  function say(text) {
    $("suLive").textContent = text;
  }

  function isDirty(R) {
    if (!canEdit) return false;
    if (R.busy || R.stale || R.refused || R.error) return true;
    const t = P.parseDollars(R.totalIn.value);
    const b = {
      state: uiState(R), totalCents: Number.isNaN(t) ? NaN : t, note: R.noteIn.value.trim(),
      reconciled: R.ticks.reconciled.checked, paid: R.ticks.paid.checked, myob: R.ticks.myob.checked,
    };
    return !sameAsServer(R, b);
  }
  function dirtyRows() {
    return rows.filter(isDirty);
  }

  // Lets a focused field commit, then waits for every line's requests.
  async function settle() {
    const a = document.activeElement;
    if (a && rows.some((R) => R.tr.contains(a)) && typeof a.blur === "function") {
      a.blur();
      a.focus();
    }
    await Promise.all(rows.map((R) => R.chain));
  }

  async function confirmLeave() {
    await settle();
    const dirty = dirtyRows();
    if (!dirty.length) return true;
    const names = dirty.slice(0, 5).map((R) => R.name).join(", ") + (dirty.length > 5 ? ", ..." : "");
    return confirm(`Some lines for ${P.longLabel(period)} aren't saved (${names}). Leave them unsaved?`);
  }

  // Brings the rows in line with the lines: new ones are made, gone ones removed, and a row with
  // something unsaved keeps it (unless force).
  function syncRows(lines, opts) {
    const force = !!(opts && opts.force);
    const byId = new Map(rows.map((R) => [R.id, R]));
    const next = [];
    for (const line of lines) {
      let R = byId.get(line.supplier.id);
      if (R) {
        byId.delete(R.id);
        if (force || !isDirty(R)) {
          R.server = line;
          R.stale = null;
          R.refused = null;
          R.error = null;
          R.fileError = null;
          renameRow(R, line.supplier.name);
          setAllUi(R, line);
          renderFile(R);
        } else {
          renameRow(R, line.supplier.name);
        }
      } else {
        R = makeRow(line);
      }
      next.push(R);
    }
    for (const R of byId.values()) R.dead = true;
    rows = next;
    const body = $("suRows");
    body.replaceChildren();
    for (const R of rows) {
      body.append(R.tr, R.msgTr);
      renderMsg(R);
    }
  }

  function renderAfterSync() {
    const has = rows.length > 0;
    $("suTableWrap").hidden = !has;
    const empty = $("suEmpty");
    empty.hidden = has;
    empty.textContent = has ? "" :
      `No suppliers are listed for ${P.longLabel(period)}.` + (canEdit ? " Add one with Add supplier below." : "");
    updateFooter();
  }

  function counts() {
    const c = { have: 0, waiting: 0, na: 0, listed: rows.length, totalCents: 0, withTotal: 0, reconciled: 0, paid: 0, myob: 0 };
    for (const R of rows) {
      const l = R.server;
      if (c[l.state] != null) c[l.state]++;
      if (l.totalCents != null) {
        c.totalCents += l.totalCents;
        c.withTotal++;
      }
      for (const [k] of TICKS) if (l[k]) c[k]++;
    }
    return c;
  }
  function countsLine(c) {
    return `Have ${c.have}, Waiting ${c.waiting}, N/A ${c.na} of ${c.listed}`;
  }

  function updateFooter() {
    const tr = $("suFoot");
    if (!rows.length) {
      tr.replaceChildren();
      return;
    }
    const c = counts();
    tr.replaceChildren(
      el("th", { scope: "row", colspan: "2", class: "su-foot-counts", text: countsLine(c) }),
      el("td", { class: "num su-foot-total", text: P.dollars(c.totalCents) }),
      ...TICKS.map(([k, label]) => el("td", { class: "su-c-tick su-foot-tick", text: `${c[k]} of ${c.listed}`, title: label })),
      el("td", { colspan: "2" })
    );
  }

  async function loadMonth(p, opts) {
    const seq = ++loadSeq;
    period = p;
    if (!(opts && opts.keepUrl)) syncUrl();
    renderHeader();
    const status = $("suStatus");
    status.hidden = false;
    status.textContent = "Loading...";
    try {
      const m = await call("GET", `/api/suppliers/months/${p}`);
      if (seq !== loadSeq) return;
      month = m;
      status.textContent = opts && opts.notice ? opts.notice : "";
      status.hidden = !status.textContent;
      renderHeader();
      if (opts && opts.fresh) {
        for (const R of rows) R.dead = true;
        rows = [];
      }
      syncRows(m.lines || []);
      renderAfterSync();
    } catch (e) {
      if (seq !== loadSeq) return;
      month = null;
      for (const R of rows) R.dead = true;
      rows = [];
      $("suRows").replaceChildren();
      $("suTableWrap").hidden = true;
      $("suEmpty").hidden = true;
      status.hidden = false;
      status.textContent = `Couldn't load ${P.longLabel(p)}: ${e.message}`;
    }
  }

  async function goMonth(to) {
    if (!to || !inRange(to) || to === period) return;
    if (!(await confirmLeave())) return;
    await loadMonth(to, { fresh: true });
  }

  // ------------------------------------------------------- the suppliers list ---

  async function loadSuppliers() {
    if (!canEdit) return;
    const st = $("suManageStatus");
    try {
      const data = await call("GET", `/api/suppliers${showArchived ? "?all=1" : ""}`);
      suppliers = data.suppliers || [];
      st.textContent = "";
      renderSuppliers();
    } catch (e) {
      st.textContent = `Couldn't load the suppliers: ${e.message}`;
    }
  }

  function renderSuppliers() {
    const list = $("suSupplierList");
    list.replaceChildren();
    const shown = suppliers.filter((s) => showArchived || !s.archived);
    if (!shown.length) {
      list.append(el("li", { class: "su-none", text: showArchived ? "No suppliers yet." : "No suppliers yet. Add the first with Add supplier." }));
      return;
    }
    for (const s of shown) {
      const li = el("li", { class: "su-sitem" + (s.archived ? " su-sitem-arch" : ""), "data-id": String(s.id) });
      li.append(el("span", { class: "su-sname", text: s.name }));
      const meta = el("span", { class: "su-smeta" });
      if (s.archived) {
        meta.append(el("span", { class: "hs-badge hs-badge-na", text: "Archived" }));
        meta.append(el("span", { text: ` from ${P.label(s.archivedFrom)}` }));
      } else {
        meta.append(el("span", { text: `Listed from ${P.label(s.fromPeriod)}` }));
      }
      li.append(meta);
      const tools = el("span", { class: "su-stools" });
      const ren = el("button", { type: "button", class: "hs-btn su-mini", text: "Rename", "aria-label": `Rename ${s.name}` });
      ren.addEventListener("click", () => openRename(s));
      tools.append(ren);
      if (s.archived) {
        const res = el("button", { type: "button", class: "hs-btn su-mini", text: "Restore", "aria-label": `Restore ${s.name}` });
        res.addEventListener("click", once(res, () => setArchived(s, false)));
        tools.append(res);
      } else {
        const arc = el("button", { type: "button", class: "hs-btn su-mini", text: "Archive", "aria-label": `Archive ${s.name}` });
        arc.addEventListener("click", once(arc, () => setArchived(s, true)));
        tools.append(arc);
      }
      li.append(tools);
      list.append(li);
    }
  }

  // Runs an action with its control disabled until it finishes, so a double click can't send it twice.
  function once(ctrl, fn) {
    return guarded(async (...args) => {
      if (ctrl.disabled) return;
      ctrl.disabled = true;
      try {
        await fn(...args);
      } finally {
        ctrl.disabled = false;
      }
    });
  }

  // After a change to the suppliers: the list and the month again (unsaved lines keep their values).
  async function afterSupplierChange() {
    await settle();
    await Promise.all([loadSuppliers(), refreshMonth()]);
  }
  async function refreshMonth() {
    const seq = ++loadSeq;
    const m = await call("GET", `/api/suppliers/months/${period}`);
    if (seq !== loadSeq) return;
    month = m;
    renderHeader();
    syncRows(m.lines || []);
    renderAfterSync();
  }

  async function setArchived(s, archived) {
    if (archived && !confirm(`Archive ${s.name}? It won't be listed from ${P.longLabel(current)} on. Months that already have a line for it keep it.`)) return;
    await call("PATCH", `/api/suppliers/${s.id}`, { archived });
    toast(archived ? `Archived ${s.name}.` : `Restored ${s.name}.`);
    await afterSupplierChange();
    const item = $("suSupplierList").querySelector(`.su-sitem[data-id="${s.id}"] button:last-child`);
    (item || $("suShowArchived")).focus();
  }

  function openAdd() {
    $("suAddError").textContent = "";
    $("suAddName").value = "";
    $("suAddNote").textContent = `Listed from ${P.longLabel(period)} (the month on screen) on.`;
    $("suAddOk").disabled = false;
    $("suAddDlg").showModal();
    $("suAddName").focus();
  }

  async function submitAdd(e) {
    e.preventDefault();
    const ok = $("suAddOk");
    if (ok.disabled) return;
    const name = $("suAddName").value.trim();
    if (!name) {
      $("suAddError").textContent = "Give the supplier a name";
      $("suAddName").focus();
      return;
    }
    ok.disabled = true;
    $("suAddError").textContent = "";
    try {
      const s = await call("POST", "/api/suppliers", { name, fromPeriod: period });
      $("suAddDlg").close();
      toast(`Added ${s.name}.`);
      await afterSupplierChange();
      const R = rows.find((x) => x.id === s.id);
      if (R && canEdit) (R.radios[R.server.state] || R.totalIn).focus();
      else $("suAdd").focus();
    } catch (err) {
      $("suAddError").textContent = err.message;
      ok.disabled = false;
      $("suAddName").focus();
    }
  }

  let renaming = null;
  function openRename(s) {
    renaming = s;
    $("suRenameError").textContent = "";
    $("suRenameName").value = s.name;
    $("suRenameOk").disabled = false;
    $("suRenameDlg").showModal();
    $("suRenameName").focus();
    $("suRenameName").select();
  }

  async function submitRename(e) {
    e.preventDefault();
    const ok = $("suRenameOk");
    const s = renaming;
    if (ok.disabled || !s) return;
    const name = $("suRenameName").value.trim();
    if (!name) {
      $("suRenameError").textContent = "Give the supplier a name";
      $("suRenameName").focus();
      return;
    }
    if (name === s.name) {
      $("suRenameDlg").close();
      return;
    }
    ok.disabled = true;
    $("suRenameError").textContent = "";
    try {
      const updated = await call("PATCH", `/api/suppliers/${s.id}`, { name });
      $("suRenameDlg").close();
      toast(`Renamed ${s.name} to ${updated.name}.`);
      await afterSupplierChange();
      const b = $("suSupplierList").querySelector(`.su-sitem[data-id="${s.id}"] button`);
      if (b) b.focus();
    } catch (err) {
      $("suRenameError").textContent = err.message;
      ok.disabled = false;
      $("suRenameName").focus();
    }
  }

  // ------------------------------------------------------------- the prints ---

  function printTitle() {
    return `Supplier accounts ${P.longLabel(period)}`;
  }

  // The month's list as saved, for paper.
  function buildPrint() {
    const box = $("suPrintMonth");
    box.replaceChildren();
    const head = el("div", { class: "su-p-head" },
      el("div", null,
        el("h1", { class: "su-p-h1", text: "Supplier accounts" }),
        el("p", { class: "su-p-month", text: P.longLabel(period) })),
      el("p", { class: "su-p-meta", text: `Printed ${longDate(todayISO())}` }));
    box.append(head);
    if (!rows.length) {
      box.append(el("p", { class: "su-p-empty", text: `No suppliers are listed for ${P.longLabel(period)}.` }));
      return;
    }
    const table = el("table", { class: "su-p-table" });
    const cols = el("colgroup", null,
      el("col", { class: "su-pc-name" }), el("col", { class: "su-pc-state" }), el("col", { class: "su-pc-total" }),
      el("col", { class: "su-pc-tick" }), el("col", { class: "su-pc-tick" }), el("col", { class: "su-pc-tick" }),
      el("col", { class: "su-pc-note" }));
    const hr = el("tr");
    for (const [t, cls] of [["Supplier", ""], ["Statement", ""], ["Total", "num"], ["Reconciled", "tick"], ["Paid", "tick"], ["MYOB", "tick"], ["Note", ""]]) {
      hr.append(el("th", { scope: "col", class: cls ? `su-p-${cls}` : null, text: t }));
    }
    const tb = el("tbody");
    for (const R of rows) {
      const l = R.server;
      const tr = el("tr");
      tr.append(el("th", { scope: "row", text: R.name }));
      tr.append(el("td", { text: STATE_WORD[l.state] || l.state }));
      tr.append(el("td", { class: "su-p-num", text: lineTotalText(l) }));
      for (const [k] of TICKS) tr.append(el("td", { class: "su-p-tick", text: l[k] ? CHECK : "" }));
      tr.append(el("td", { class: "su-p-note", text: l.note || "" }));
      tb.append(tr);
    }
    const c = counts();
    const ft = el("tfoot", null, el("tr", null,
      el("th", { scope: "row", colspan: "2", text: countsLine(c) }),
      el("td", { class: "su-p-num", text: P.dollars(c.totalCents) }),
      ...TICKS.map(([k]) => el("td", { class: "su-p-tick", text: String(c[k]) })),
      el("td")));
    table.append(cols, el("thead", null, hr), tb, ft);
    box.append(table);
    box.append(el("p", { class: "su-p-foot", text: `${countsLine(c)}. Total of the statements: ${P.dollars(c.totalCents)}. Reconciled ${c.reconciled}, Paid ${c.paid}, Entered in MYOB ${c.myob} of ${c.listed}.` }));
  }

  let titleBeforePrint = null;
  function beforePrint() {
    if (blankMode) return;
    buildPrint();
    if (titleBeforePrint == null) titleBeforePrint = document.title;
    document.title = printTitle();
  }
  function afterPrint() {
    if (blankMode) return;
    if (titleBeforePrint != null) document.title = titleBeforePrint;
    titleBeforePrint = null;
  }

  async function printMonth() {
    await settle();
    beforePrint();
    window.print();
  }

  // ------------------------------------------------------ the blank paper form ---

  const FORM_COLS = [
    ["Supplier name", "su-fc-name"],
    ["Have statement", "su-fc-wide"],
    ["Waiting", "su-fc-box"],
    ["N/A", "su-fc-box"],
    ["Total", "su-fc-total"],
    ["Reconciled", "su-fc-wide"],
    ["Paid", "su-fc-box"],
    ["MYOB", "su-fc-box"],
    ["Notes", "su-fc-notes"],
  ];
  const BLANK_ROWS = 5;

  function buildForm(names) {
    const sheet = el("article", { class: "su-sheet" });
    sheet.append(el("div", { class: "su-f-head" },
      el("h1", { class: "su-f-h1", text: "Suppliers" }),
      el("div", { class: "su-f-line" }, el("span", { class: "su-f-label", text: "Month" }), el("span", { class: "su-f-rule" }))));
    const table = el("table", { class: "su-form" });
    const cg = el("colgroup");
    const hr = el("tr");
    for (const [t, cls] of FORM_COLS) {
      cg.append(el("col", { class: cls }));
      hr.append(el("th", { scope: "col", text: t }));
    }
    const tb = el("tbody");
    const n = names.length + BLANK_ROWS;
    // Tall rows for handwriting; they shrink a little for a long list (8 mm at least).
    const h = Math.max(8, Math.min(12, Math.floor((236 / n) * 10) / 10));
    for (let i = 0; i < n; i++) {
      const tr = el("tr");
      tr.style.height = `${h}mm`;
      tr.append(el("td", { class: "su-f-name", text: i < names.length ? names[i] : "" }));
      for (let j = 1; j < FORM_COLS.length; j++) tr.append(el("td"));
      tb.append(tr);
    }
    table.append(cg, el("thead", null, hr), tb);
    sheet.append(table);
    return sheet;
  }

  async function bootBlank() {
    $("suBlankView").hidden = false;
    document.title = "Supplier statements form";
    const asked = params.get("period");
    const p = asked && inRange(asked) ? asked : defaultPeriod();
    $("suBlankBack").href = `/suppliers.html?period=${p}`;
    const pages = $("suBlankPages");
    const state = $("suBlankState");
    let names = [];
    try {
      const m = await call("GET", `/api/suppliers/months/${p}`);
      names = (m.lines || []).map((l) => l.supplier.name);
      state.textContent = `${names.length} ${names.length === 1 ? "supplier" : "suppliers"} listed for ${P.longLabel(p)}, then ${BLANK_ROWS} blank rows. The month is left blank to fill in.`;
    } catch (e) {
      pages.replaceChildren(el("p", { class: "su-message su-error", text: `Couldn't load the suppliers for ${P.longLabel(p)}: ${e.message}` }));
      return;
    }
    pages.replaceChildren(buildForm(names));
    const btn = $("suBlankPrint");
    btn.disabled = false;
    btn.addEventListener("click", () => {
      document.title = "Supplier statements form";
      window.print();
    });
  }

  // ------------------------------------------------------------------- boot ---

  function wire() {
    $("suPrev").addEventListener("click", () => goMonth($("suPrev").dataset.to));
    $("suNext").addEventListener("click", () => goMonth($("suNext").dataset.to));
    $("suPrint").addEventListener("click", once($("suPrint"), printMonth));
    $("suBlank").addEventListener("click", async (e) => {
      // Leaving the page: let a focused field save first, and ask about anything unsaved.
      e.preventDefault();
      const href = $("suBlank").href;
      if (await confirmLeave()) {
        leaving = true;
        location.href = href;
      }
    });
    $("suPick").addEventListener("change", onPicked);
    $("suAdd").addEventListener("click", openAdd);
    $("suAddForm").addEventListener("submit", submitAdd);
    $("suAddCancel").addEventListener("click", () => $("suAddDlg").close());
    $("suRenameForm").addEventListener("submit", submitRename);
    $("suRenameCancel").addEventListener("click", () => $("suRenameDlg").close());
    for (const id of ["suAddDlg", "suRenameDlg"]) {
      $(id).addEventListener("mousedown", (e) => {
        if (e.target === $(id)) $(id).close();
      });
    }
    $("suShowArchived").addEventListener("change", () => {
      showArchived = $("suShowArchived").checked;
      loadSuppliers();
    });
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    window.addEventListener("beforeunload", (e) => {
      if (leaving) return;
      if (dirtyRows().length) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  async function boot() {
    if (window.cc && window.cc.ready) await window.cc.ready;
    today = todayISO();
    current = P.currentPeriod(today);
    if (blankMode) {
      await bootBlank();
      return;
    }
    canEdit = can("invoices.edit");
    document.body.classList.toggle("su-ro", !canEdit);
    wire();
    $("suMonthView").hidden = false;
    $("suManage").hidden = !canEdit;
    const asked = params.get("period");
    let notice = "";
    let p = defaultPeriod();
    if (asked) {
      if (inRange(asked)) p = asked;
      else notice = `There is no supplier list for that month (they go from ${P.label(P.HISTORY_START)} to this month); showing ${P.longLabel(p)}.`;
    }
    await Promise.all([loadMonth(p, { notice }), loadSuppliers()]);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
