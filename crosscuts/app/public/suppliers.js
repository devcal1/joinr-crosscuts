// Supplier accounts (/suppliers.html[?period=YYYY-MM][&print=blank]): the monthly checklist of
// supplier statements, three months side by side, its print, and the blank paper form
// (docs/plans/m9-contracts.md sections 7.2, 7.3 and 9.2; the paper form is m9-plan section 1.4).
//
// The page shows three months as compact lists, one line per supplier: the month before, the
// centre month (?period=, default this month in Sydney) and the month after. Each month is its own
// pane (makePane); every pane is editable with invoices.edit. Previous / Next shift all three by a
// month. Print and the blank form are the centre month's. Next month is the last one there is
// (approved by Todd 2026-10-24).
//
// Each supplier's line saves on its own: a change commits on blur (Total, Note) or on choosing (the
// statement state, the ticks), as one PUT per line carrying the updatedAt it last saw. A line has at
// most one request in flight; changes made meanwhile are queued and sent after it, and what is typed
// while a save is in flight is never overwritten. A 409 shows its sentence on that row with Reload; a
// refused value outlines its cell in orange with the sentence under the row. The note and the
// statement file are in a detail line under the row, opened from the supplier's name.
//
// Month arithmetic and money come from public/periods.js (window.Periods). Without invoices.edit the
// page is read-only: every write control is left out. User text goes in via textContent only.
(function () {
  "use strict";

  const P = window.Periods;
  const $ = (id) => document.getElementById(id);

  // Supplier accounts only now (Admin accounts were folded in by migration 054, 2026-10-31). The
  // KINDS table stays so the words and API base live in one place.
  const KINDS = {
    supplier: {
      api: "/api/suppliers", page: "/suppliers.html", title: "Supplier accounts",
      one: "supplier", many: "suppliers", One: "Supplier", Many: "Suppliers",
      form: "Supplier statements form", entity: "supplier_statement",
    },
  };
  const K = KINDS[document.body.dataset.kind] || KINDS.supplier;

  const STATES = [
    ["have", "Have"],
    ["waiting", "Waiting"],
    ["na", "N/A"],
  ];
  const STATE_WORD = { have: "Have statement", waiting: "Waiting", na: "N/A" };
  const TICKS = [
    ["reconciled", "Reconciled", "R"],
    ["paid", "Paid", "P"],
    ["myob", "Entered in MYOB", "M"],
  ];
  const ACCEPT_EXT = ["pdf", "jpg", "jpeg", "png"];
  const MAX_BYTES = 25 * 1024 * 1024;
  const MAX_CENTS = 1000000000;
  const CHECK = "✓"; // a check mark character, not an icon (contracts section 9.2)
  const DASH = "—";
  const STATE_PAUSE_MS = 700; // arrow keys in the statement choice: save after this pause

  const UNREADABLE_TOTAL = "Can't read the total: type an amount like 1,234.50";
  const TOO_BIG_TOTAL = "The total can be at most $10,000,000.00";

  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }
  // 0.2.7: Paid on a supplier line, and on an individual invoice, is users.admin's (Admin accounts
  // keeps its own rule: anyone who edits).
  function canPay() {
    return can("users.admin");
  }
  // The audit link is for admins only: the admin role, and the audit page's own key.
  function isAdmin() {
    const me = window.cc && window.cc.me;
    const roles = me && Array.isArray(me.roles) ? me.roles : [];
    return roles.includes("admin") && can("audit.view");
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
      // as shared.js api(): a locked account goes to the login page with locked=1
      const body401 = await res.json().catch(() => ({}));
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = (body401 && body401.locked ? "/login.html?locked=1&next=" : "/login.html?next=") + next;
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
  let centre = null; // the centre month
  let panes = []; // [before, centre, after]; a pane outside the months there are is null
  let showArchived = false;
  let suppliers = [];
  let leaving = false; // navigating away on purpose: no unsaved-changes prompt
  let rowSeq = 0;

  function lastPeriod() {
    return P.addMonths(current, P.MAX_AHEAD_MONTHS);
  }
  function defaultPeriod() {
    return current < P.HISTORY_START ? P.HISTORY_START : current;
  }
  function inRange(p) {
    return P.validPeriod(p) && p >= P.HISTORY_START && p <= lastPeriod();
  }
  function centrePane() {
    return panes[1] || null;
  }
  function allRows() {
    const out = [];
    for (const pn of panes) if (pn) out.push(...pn.rows);
    return out;
  }

  // ------------------------------------------------------------ the header ---

  function renderHeader() {
    $("suMonth").textContent = P.longLabel(centre);
    document.title = `${K.title} ${P.longLabel(centre)} - Crosscuts`;
    const prev = centre > P.HISTORY_START ? P.addMonths(centre, -1) : null;
    const next = centre < lastPeriod() ? P.addMonths(centre, 1) : null;
    const pb = $("suPrev");
    const nb = $("suNext");
    const tb = $("suToday");
    pb.disabled = !prev;
    nb.disabled = !next;
    tb.disabled = centre === defaultPeriod();
    pb.dataset.to = prev || "";
    nb.dataset.to = next || "";
    pb.setAttribute("aria-label", prev ? `Previous month: centre on ${P.longLabel(prev)}` : "Previous month");
    nb.setAttribute("aria-label", next ? `Next month: centre on ${P.longLabel(next)}` : "Next month");
    $("suBlank").href = `${K.page}?period=${centre}&print=blank`;
    $("suPrint").setAttribute("aria-label", `Print ${P.longLabel(centre)}`);
    $("suMeta").textContent = canEdit
      ? "Each line saves on its own as you change it. Open a name for its note and statement file."
      : "View only. Open a name for its note and statement file.";
  }

  function syncUrl() {
    history.replaceState(null, "", `${location.pathname}?period=${centre}`);
  }

  function say(text) {
    $("suLive").textContent = text;
  }

  // --------------------------------------------------------------- the rows ---

  // A row: {pane, id, name, server: the line as last saved, committed: {total, note} texts as last
  // committed, tr, detailTr, msgTr, ..., chain: the line's request queue, busy, saveQueued, stale,
  // refused, error}.
  function lineTotalText(line) {
    return line.totalCents == null ? "" : P.dollars(line.totalCents);
  }
  // No total for a line that should have one: never saved, or Waiting (or Have) with no total.
  function isMissing(line) {
    return line.state !== "na" && line.totalCents == null;
  }
  function missingSentence(line) {
    return line.state === "have" ? "Information missing: no total yet" : "Information missing: waiting on statement";
  }

  function makeRow(pane, line) {
    const R = {
      pane,
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
      open: false,
    };
    const key = `${++rowSeq}`;
    R.tr = el("tr", { class: "su-row", "data-id": String(R.id) });
    R.detailId = `su-det-${key}`;
    R.nameBtn = el("button", {
      type: "button", class: "su-name", "aria-expanded": "false", "aria-controls": R.detailId,
    });
    R.nameText = el("span", { class: "su-name-text", text: R.name });
    R.nameBtn.append(R.nameText);
    R.marks = el("span", { class: "su-marks" });
    R.warnEl = el("span", { class: "su-warn" });
    R.stateEl = el("span", { class: "su-rowstate" });
    R.nameTd = el("th", { scope: "row", class: "su-c-name" },
      el("span", { class: "su-namebox" }, R.nameBtn, R.marks, R.warnEl, R.stateEl));
    R.stateTd = el("td", { class: "su-c-state" });
    R.totalTd = el("td", { class: "su-c-total num" });
    R.tickTds = {};
    for (const [k] of TICKS) R.tickTds[k] = el("td", { class: "su-c-tick" });
    // One line: name, statement, REC, MYOB, then the heroes: Total and Paid (Todd 2026-10-31).
    R.tr.append(R.nameTd, R.stateTd, R.tickTds.reconciled, R.tickTds.myob, R.totalTd, R.tickTds.paid);

    // The detail line: the note and the statement file.
    R.noteBox = el("div", { class: "su-det-note" });
    R.fileBox = el("div", { class: "su-det-file" });
    R.detailTr = el("tr", { class: "su-detail", id: R.detailId },
      el("td", { colspan: "6" }, el("div", { class: "su-det" },
        el("span", { class: "su-det-label", text: "Note" }), R.noteBox,
        el("span", { class: "su-det-label", text: "Statement file" }), R.fileBox)));
    if (canEdit) {
      const del = el("button", {
        type: "button", class: "hs-btn hs-btn-stop su-mini", text: "Delete from this month",
        "aria-label": `Delete ${R.name} from ${P.longLabel(pane.period)}`,
      });
      del.addEventListener("click", () => removeLine(R));
      R.detailTr.firstChild.firstChild.append(el("span", { class: "su-det-label" }), el("div", { class: "su-det-del" }, del));
    }
    R.detailTr.hidden = true;

    R.msgId = `su-msg-${key}`;
    R.msgTd = el("td", { colspan: "6", id: R.msgId });
    R.msgTr = el("tr", { class: "su-msgrow" }, R.msgTd);
    R.msgTr.hidden = true;

    R.nameBtn.addEventListener("click", () => toggleDetail(R));
    // A click anywhere on the row that isn't a control opens or closes it too.
    R.tr.addEventListener("click", (e) => {
      if (e.target.closest("input, label, button, a, select, textarea")) return;
      toggleDetail(R);
    });

    if (canEdit) buildEditCells(R);
    else buildReadCells(R);
    renderFile(R);
    renameRow(R, R.name, true);
    return R;
  }

  function toggleDetail(R, force) {
    R.open = force == null ? !R.open : !!force;
    R.detailTr.hidden = !R.open;
    R.nameBtn.setAttribute("aria-expanded", R.open ? "true" : "false");
    R.tr.classList.toggle("su-row-open", R.open);
  }

  function buildReadCells(R) {
    const l = R.server;
    const cls = l.state === "have" ? "hs-badge-teal" : l.state === "na" ? "hs-badge-na" : "hs-badge-check";
    R.stateTd.replaceChildren(el("span", { class: `hs-badge su-badge ${cls}`, text: l.state === "have" ? "Have" : STATE_WORD[l.state] || l.state }));
    R.totalTd.textContent = l.state === "na" && l.totalCents == null ? DASH : P.dollars(l.totalCents || 0);
    for (const [k, label] of TICKS) {
      if (k === "paid") R.tickTds[k].replaceChildren(el("span", { class: "su-paid su-paid-ro" + (l[k] ? " su-paid-on" : ""), text: "Paid", "aria-label": l[k] ? "Paid" : "Not paid" }));
      else R.tickTds[k].replaceChildren(l[k] ? el("span", { class: "su-tick-ro", text: CHECK, "aria-label": label, role: "img" }) : "");
    }
    R.noteBox.replaceChildren(el("span", { class: "su-note-ro", text: l.note || "No note." }));
  }

  function buildEditCells(R) {
    // The statement state: one of three, as radios (arrow keys move and choose).
    R.radioGroup = el("div", { class: "su-seg", role: "radiogroup" });
    R.radios = {};
    // A click chooses at once. Arrow keys move through the choices (each step checks one), so the
    // line saves once the user settles on one: a short pause, Space or Enter, or leaving the choice.
    R.stKeys = false;
    R.stTimer = 0;
    for (const [v, label] of STATES) {
      const input = el("input", { type: "radio", name: `su-st-${R.pane.period}-${R.id}`, value: v });
      input.addEventListener("change", () => {
        if (!input.checked) return;
        const byKeys = R.stKeys;
        R.stKeys = false;
        clearTimeout(R.stTimer);
        R.stTimer = 0;
        if (byKeys) R.stTimer = setTimeout(() => flushState(R), STATE_PAUSE_MS);
        else commit(R);
      });
      R.radios[v] = input;
      R.radioGroup.append(el("label", { class: `su-seg-opt su-seg-${v}` }, input, el("span", { text: label })));
    }
    R.radioGroup.addEventListener("keydown", (e) => {
      if (/^Arrow/.test(e.key)) R.stKeys = true;
      else if (e.key === " " || e.key === "Enter") flushState(R);
    });
    R.radioGroup.addEventListener("focusout", (e) => {
      if (!R.radioGroup.contains(e.relatedTarget)) flushState(R);
    });
    R.stateTd.replaceChildren(R.radioGroup);

    R.totalIn = el("input", {
      class: "su-in su-in-total", type: "text", inputmode: "decimal", autocomplete: "off",
      spellcheck: "false", maxlength: "20",
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
      const input = el("input", { type: "checkbox" });
      // 0.2.7 (m28-contracts.md section 2): on Supplier accounts only users.admin ticks Paid.
      if (k === "paid" && !canPay()) {
        input.disabled = true;
        input.title = "Admin ticks paid";
      }
      input.addEventListener("change", () => commit(R));
      R.ticks[k] = input;
      if (k === "paid") R.tickTds[k].replaceChildren(el("label", { class: "su-paid", title: input.title || label }, input, el("span", { class: "su-paid-word", text: "Paid" })));
      else R.tickTds[k].replaceChildren(el("label", { class: "su-tick", title: label }, input));
    }

    R.noteIn = el("input", {
      class: "su-in su-in-note", type: "text", autocomplete: "off", maxlength: "500",
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
    R.noteBox.replaceChildren(R.noteIn);

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

  function renameRow(R, name, force) {
    if (name === R.name && !force) return;
    R.name = name;
    R.nameText.textContent = name;
    const month = P.longLabel(R.pane.period);
    R.nameBtn.setAttribute("aria-label", `${name}, ${month}: note and statement file`);
    R.nameBtn.title = name;
    if (!canEdit) return;
    R.radioGroup.setAttribute("aria-label", `Statement, ${name}, ${month}`);
    R.totalIn.setAttribute("aria-label", `Total, ${name}, ${month}`);
    R.noteIn.setAttribute("aria-label", `Note, ${name}, ${month}`);
    for (const [k, label] of TICKS) R.ticks[k].setAttribute("aria-label", `${label}, ${name}, ${month}`);
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
    R.fileBox.replaceChildren(...kids);
    R.fileBox.classList.toggle("su-bad-cell", !!R.fileError);
  }

  // The row's small marks: Note / File when there is one, the missing-information warning, and the
  // total's placeholder ($0.00 when missing, a dash for N/A).
  function renderInfo(R) {
    const l = R.server;
    R.marks.replaceChildren();
    if (l.note) R.marks.append(el("span", { class: "su-mark", text: "Note", title: l.note }));
    if (l.file) R.marks.append(el("span", { class: "su-mark", text: "File", title: l.file.name }));
    R.warnEl.replaceChildren();
    if (isMissing(l)) {
      const s = missingSentence(l);
      R.warnEl.title = s;
      R.warnEl.append(el("span", { class: "su-warn-long", text: s }), el("span", { class: "su-warn-short", text: "Missing", "aria-hidden": "true" }));
      R.tr.classList.add("su-row-missing");
    } else {
      R.warnEl.removeAttribute("title");
      R.tr.classList.remove("su-row-missing");
    }
    if (canEdit) R.totalIn.placeholder = l.state === "na" ? DASH : "$0.00";
    else buildReadCells(R);
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

    // Orange outline on the refused cell; a refused note or a file problem opens the detail line.
    if (canEdit) {
      const field = R.refused ? R.refused.field : null;
      setBad(R.totalIn, field === "total", R);
      setBad(R.noteIn, field === "note", R);
      R.radioGroup.classList.toggle("su-bad", field === "state");
      if (field === "state") R.radioGroup.setAttribute("aria-describedby", R.msgId);
      else R.radioGroup.removeAttribute("aria-describedby");
      for (const [k] of TICKS) R.tickTds[k].classList.toggle("su-bad-cell", field === k);
      R.nameTd.classList.toggle("su-bad-cell", field === "row");
      if ((field === "note" || R.fileError) && !R.open) toggleDetail(R, true);
    }
    R.fileBox.classList.toggle("su-bad-cell", !!R.fileError);

    let st = R.flash;
    let cls = "su-rowstate";
    if (R.busy) st = R.busyText || "Saving...";
    else if (R.stale || R.refused || R.error) {
      st = "Not saved";
      cls += " su-rowstate-bad";
    }
    R.stateEl.textContent = st || "";
    R.stateEl.className = cls;
    renderInfo(R);
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
      R.pane.updateSummary();
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

  // A statement state chosen with the arrow keys and still waiting for the pause: save it now.
  function flushState(R) {
    if (!R.stTimer) return;
    clearTimeout(R.stTimer);
    R.stTimer = 0;
    commit(R);
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
    const sentPeriod = R.pane.period;
    R.busyText = "Saving...";
    renderMsg(R);
    try {
      const line = await call("PUT", `${K.api}/months/${sentPeriod}/${R.id}`, Object.assign({}, body, { updatedAt: R.server.updatedAt }));
      if (R.dead) return;
      applyServer(R, line, body);
      R.refused = refused;
      R.error = null;
      R.flash = "Saved";
      say(`Saved the line for ${R.name}, ${P.longLabel(sentPeriod)}.`);
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
      } else if (e.status === 404 && (await dropIfGone(R))) {
        // No longer listed in this month (archived elsewhere): the row has gone with a sentence.
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

  // After a 404 on one line: the line as the server has it now. {gone: true} when the supplier isn't
  // listed in this month any more (archived elsewhere): the pane's rows are brought in line (unsaved
  // typing on other rows is kept) and the pane's status line says why the row went. Otherwise
  // {line}, or null when the month couldn't be loaded.
  async function lineNow(R) {
    const pane = R.pane;
    let m;
    try {
      m = await call("GET", `${K.api}/months/${pane.period}`);
    } catch (e) {
      return null;
    }
    if (R.dead) return { gone: true };
    const fresh = (m.lines || []).find((l) => l.supplier.id === R.id);
    if (fresh) return { line: fresh };
    pane.month = m;
    pane.syncRows(m.lines || []);
    pane.renderAfterSync();
    const s = `${R.name} isn't listed in ${P.longLabel(pane.period)} any more (it was archived elsewhere), so the change wasn't saved.`;
    pane.setStatus(s);
    say(s);
    return { gone: true };
  }
  async function dropIfGone(R) {
    const now = await lineNow(R);
    return !!(now && now.gone);
  }

  async function reloadRow(R, btn) {
    const pane = R.pane;
    if (btn) btn.disabled = true;
    let line = R.stale ? R.stale.line : null;
    try {
      const m = await call("GET", `${K.api}/months/${pane.period}`);
      if (R.dead) return;
      pane.month = m;
      const fresh = (m.lines || []).find((l) => l.supplier.id === R.id);
      if (!fresh) {
        // No longer listed in this month: show the month as it now is.
        R.stale = null;
        pane.syncRows(m.lines || [], { force: true });
        pane.renderAfterSync();
        say(`${R.name} isn't listed in ${P.longLabel(pane.period)} any more.`);
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
    pane.updateSummary();
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
    if (!ACCEPT_EXT.includes(ext)) return "That file type isn't allowed: attach a PDF or a photo (JPEG or PNG)";
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
      R.flash = "";
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
        const line = await call("POST", `${K.api}/months/${R.pane.period}/${R.id}/file`, fd);
        if (R.dead) return;
        if (R.stale) R.stale.line = line;
        else applyServer(R, line, before);
        R.fileError = null;
        R.flash = old ? "File replaced" : "File attached";
        say(`${old ? "Replaced" : "Attached"} the statement for ${R.name}: ${file.name}.`);
      } catch (e) {
        if (R.dead) return;
        R.flash = "";
        if (e.status === 404 && (await dropIfGone(R))) return;
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
    if (!confirm(`Remove the statement ${f.name} from the line for ${R.name} (${P.longLabel(R.pane.period)})?`)) return;
    enqueue(R, async () => {
      if (R.dead) return;
      R.busyText = "Removing...";
      renderMsg(R);
      const before = baseOf(R.server);
      try {
        // The DELETE removes whatever file the line has, so first make sure it is still the one this
        // row shows: someone else may have replaced or removed it meanwhile.
        const now = await lineNow(R);
        if (R.dead || (now && now.gone)) return;
        if (!now) throw new Error("Couldn't check the statement first; try again");
        const saved = now.line.file;
        if (!saved || saved.id !== f.id) {
          // Show the file as saved now. The line's updatedAt stays as last seen, so a later change
          // to the row meets the 409 and its Reload.
          R.server = Object.assign({}, R.server, { file: saved || null });
          R.flash = "";
          R.fileError = saved
            ? `Not removed: someone else had replaced this statement with ${saved.name}.`
            : "Not removed: someone else had already removed this statement.";
          renderFile(R);
          say(R.fileError);
          return;
        }
        // fileId: the server refuses (409) if the line holds another file by the time this arrives.
        const line = await call("DELETE", `${K.api}/months/${R.pane.period}/${R.id}/file?fileId=${encodeURIComponent(f.id)}`);
        if (R.dead) return;
        applyServer(R, line, before);
        R.fileError = null;
        R.flash = "File removed";
        say(`Removed the statement for ${R.name}.`);
      } catch (e) {
        if (R.dead) return;
        R.flash = "";
        if (e.status === 404 || e.status === 409) {
          // Removed (or replaced) elsewhere meanwhile, or the supplier was archived: show the file as
          // saved now. The line's updatedAt stays as last seen, so a later change meets the 409.
          const now = await lineNow(R);
          if (now && now.gone) return;
          if (now && now.line) {
            R.server = Object.assign({}, R.server, { file: now.line.file });
            R.fileError = now.line.file
              ? `Not removed: someone else had already replaced this statement with ${now.line.file.name}.`
              : "Not removed: someone else had already removed this statement.";
            renderFile(R);
            say(R.fileError);
            return;
          }
        }
        R.fileError = `Not removed. ${e.message}`;
        say(R.fileError);
      } finally {
        R.busyText = "";
      }
    }).then(() => focusFileTool(R));
  }

  // Deletes the supplier's line from this month (the server keeps it hidden, with an audit row).
  function removeLine(R) {
    if (R.dead) return;
    const month = P.longLabel(R.pane.period);
    if (!confirm(`Delete ${R.name} from ${month}? It will no longer be listed in ${month}.`)) return;
    enqueue(R, async () => {
      if (R.dead) return;
      R.busyText = "Deleting...";
      renderMsg(R);
      try {
        await call("DELETE", `${K.api}/months/${R.pane.period}/${R.id}`);
      } catch (e) {
        if (e.status !== 404) {
          R.busyText = "";
          R.error = `Not deleted. ${e.message}`;
          renderMsg(R);
          say(R.error);
          return;
        }
      }
      R.busyText = "";
      const pane = R.pane;
      try {
        const m = await call("GET", `${K.api}/months/${pane.period}`);
        pane.month = m;
        pane.syncRows(m.lines || []);
        pane.renderAfterSync();
      } catch (e) {
        toast(`Error: ${e.message}`);
      }
      const s = `Deleted ${R.name} from ${month}.`;
      pane.setStatus(s);
      say(s);
    });
  }

  function focusFileTool(R) {
    if (R.dead) return;
    const b = R.fileBox.querySelector("button");
    if (b) b.focus();
  }

  // ------------------------------------------------------------ dirty lines ---

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
    return allRows().filter(isDirty);
  }

  // Lets a focused field commit, then waits for every line's requests.
  async function settle() {
    const rows = allRows();
    const a = document.activeElement;
    if (a && rows.some((R) => R.tr.contains(a) || R.detailTr.contains(a)) && typeof a.blur === "function") {
      a.blur();
      a.focus();
    }
    await Promise.all(allRows().map((R) => R.chain));
  }

  async function confirmLeave() {
    await settle();
    const dirty = dirtyRows();
    if (!dirty.length) return true;
    const names = dirty.slice(0, 5).map((R) => `${R.name} (${P.label(R.pane.period)})`).join(", ") + (dirty.length > 5 ? ", ..." : "");
    return confirm(`Some lines aren't saved (${names}). Leave them unsaved?`);
  }

  // ------------------------------------------------------------- a month pane ---

  // One month's column: its heading, Left to pay, and the compact list. `slot` is 0, 1 or 2 (before,
  // centre, after).
  function makePane(period, slot) {
    const pane = { period, slot, month: null, rows: [], loadSeq: 0 };
    const label = P.longLabel(period);
    const isCurrent = period === current;
    const headId = `su-col-h-${slot}`;
    pane.statusEl = el("p", { class: "su-status", role: "status" });
    pane.emptyEl = el("p", { class: "su-empty" });
    pane.emptyEl.hidden = true;
    pane.leftValue = el("span", { class: "su-left-value", text: DASH });
    pane.leftMissing = el("span", { class: "su-left-missing" });
    pane.leftMeta = el("span", { class: "su-left-meta" });
    pane.tbody = el("tbody");
    const headRow = el("tr", null,
      el("th", { scope: "col", class: "su-c-name", text: K.One }),
      el("th", { scope: "col", class: "su-c-state", text: "Statement" }),
      ...[["reconciled", "REC"], ["myob", "MYOB"]].map(([k, t]) => el("th", { scope: "col", class: "su-c-tick" },
        el("abbr", { title: TICKS.find((x) => x[0] === k)[1], "aria-label": TICKS.find((x) => x[0] === k)[1], text: t }))),
      el("th", { scope: "col", class: "su-c-total num", text: "Total" }),
      el("th", { scope: "col", class: "su-c-paid", text: "Paid" }));
    pane.table = el("table", { class: "su-table", "aria-labelledby": headId }, el("thead", null, headRow), pane.tbody);
    pane.table.hidden = true;
    pane.root = el("section", {
      class: `su-col su-col-${["before", "centre", "after"][slot]}${isCurrent ? " su-col-cur" : ""}`,
      "aria-labelledby": headId,
    },
      el("div", { class: "su-col-head" },
        el("h2", { class: "su-col-month", id: headId, text: label }),
        isCurrent ? el("span", { class: "su-col-tag", text: "This month" }) : null),
      el("div", { class: "su-left" },
        el("span", { class: "su-left-label", text: "Left to pay" }),
        pane.leftValue, pane.leftMissing, pane.leftMeta),
      pane.statusEl, pane.emptyEl,
      el("p", { class: "su-key", text: "REC = Reconciled · MYOB = Entered in MYOB" }), pane.table);
    // 0.2.7 (m28-contracts.md section 2): Individual invoices, below the supplier accounts.
    pane.ind = null;
    if (K === KINDS.supplier && window.Payables) {
      pane.ind = window.Payables.block(period, {
        canEdit,
        canPay: canPay(),
        onLoad: () => pane.updateSummary(),
        onChange: (info) => {
          if (info && info.suppliersChanged) {
            loadSuppliers();
            for (const q of panes) if (q && q.refresh) q.refresh().catch(() => {});
          }
          for (const q of panes) if (q && q !== pane && q.ind) q.ind.load();
        },
      });
      pane.root.append(pane.ind.root);
    }

    pane.setStatus = (text) => {
      pane.statusEl.textContent = text || "";
    };

    // Brings the rows in line with the lines: new ones are made, gone ones removed, and a row with
    // something unsaved keeps it (unless force).
    pane.syncRows = (lines, opts) => {
      const force = !!(opts && opts.force);
      const byId = new Map(pane.rows.map((R) => [R.id, R]));
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
          R = makeRow(pane, line);
        }
        next.push(R);
      }
      for (const R of byId.values()) R.dead = true;
      pane.rows = next;
      pane.tbody.replaceChildren();
      for (const R of pane.rows) {
        pane.tbody.append(R.tr, R.detailTr, R.msgTr);
        renderMsg(R);
      }
    };

    pane.renderAfterSync = () => {
      const has = pane.rows.length > 0;
      pane.table.hidden = !has;
      pane.emptyEl.hidden = has;
      pane.emptyEl.textContent = has ? "" :
        `No ${K.many} are listed for ${label}.` + (canEdit && slot === 1 ? ` Add one with Add ${K.one} below.` : "");
      pane.updateSummary();
    };

    pane.counts = () => {
      const c = { have: 0, waiting: 0, na: 0, listed: pane.rows.length, totalCents: 0, withTotal: 0, reconciled: 0, paid: 0, myob: 0, leftCents: 0, missing: 0 };
      for (const R of pane.rows) {
        const l = R.server;
        if (c[l.state] != null) c[l.state]++;
        if (l.totalCents != null) {
          c.totalCents += l.totalCents;
          c.withTotal++;
        }
        if (!l.paid && l.state !== "na" && l.totalCents != null) c.leftCents += l.totalCents;
        if (isMissing(l)) c.missing++;
        for (const [k] of TICKS) if (l[k]) c[k]++;
      }
      return c;
    };

    pane.updateSummary = () => {
      owingSoon();
      if (!pane.month) {
        pane.leftValue.textContent = DASH;
        pane.leftMissing.textContent = "";
        pane.leftMeta.textContent = "";
        return;
      }
      const c = pane.counts();
      // 0.2.7: Left to pay and the missing count include the individual invoices.
      if (pane.ind) {
        c.leftCents += pane.ind.leftCents();
        c.missing += pane.ind.missing();
      }
      pane.leftValue.textContent = P.dollars(c.leftCents);
      pane.leftMissing.textContent = c.missing
        ? `${c.missing} missing ${DASH} total not final`
        : "";
      pane.leftMeta.textContent = c.listed
        ? `${countsLine(c)}. Statements ${P.dollars(c.totalCents)}. Paid ${c.paid} of ${c.listed}.`
        : "";
    };

    pane.load = async (opts) => {
      const seq = ++pane.loadSeq;
      pane.setStatus("Loading...");
      try {
        const m = await call("GET", `${K.api}/months/${period}`);
        if (seq !== pane.loadSeq) return;
        pane.month = m;
        pane.setStatus(opts && opts.notice ? opts.notice : "");
        pane.syncRows(m.lines || []);
        pane.renderAfterSync();
        if (pane.ind) pane.ind.load();
      } catch (e) {
        if (seq !== pane.loadSeq) return;
        pane.month = null;
        for (const R of pane.rows) R.dead = true;
        pane.rows = [];
        pane.tbody.replaceChildren();
        pane.table.hidden = true;
        pane.emptyEl.hidden = true;
        pane.setStatus(`Couldn't load ${label}: ${e.message}`);
        pane.updateSummary();
      }
    };

    // Again, after a change to the suppliers (unsaved lines keep their values).
    pane.refresh = async () => {
      const seq = ++pane.loadSeq;
      const m = await call("GET", `${K.api}/months/${period}`);
      if (seq !== pane.loadSeq) return;
      pane.month = m;
      pane.setStatus("");
      pane.syncRows(m.lines || []);
      pane.renderAfterSync();
    };

    pane.kill = () => {
      pane.loadSeq++;
      for (const R of pane.rows) {
        R.dead = true;
        clearTimeout(R.stTimer);
      }
      pane.rows = [];
    };
    return pane;
  }

  // ---------------------------------------------------- money still owing ---
  function renderOwe(box, title, list, totalCents, none, totalLabel) {
    box.replaceChildren(el("h2", { text: title }));
    if (!list.length) {
      box.append(el("p", { class: "su-owe-none", text: none }));
      return;
    }
    const ul = el("ul", { class: "su-owe-list" });
    for (const m of list) {
      const a = el("a", { href: `${K.page}?period=${m.period}`, title: `${m.count} not paid` },
        el("span", { text: m.label }), el("span", { class: "su-owe-amt", text: P.dollars(m.cents) }));
      a.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
        e.preventDefault();
        goMonth(m.period);
      });
      ul.append(el("li", null, a));
    }
    box.append(ul, el("div", { class: "su-owe-total" }, el("span", { text: totalLabel || "Total" }), el("span", { text: P.dollars(totalCents) })));
  }
  // The summary changes as lines save; the side panels catch up once things have been quiet a moment.
  let owingTimer = null;
  function owingSoon() {
    clearTimeout(owingTimer);
    owingTimer = setTimeout(loadOwing, 1500);
  }
  async function loadOwing() {
    try {
      const d = await call("GET", `${K.api}/outstanding`);
      renderOwe($("suOweBefore"), "Still unpaid, earlier months", d.before, d.beforeCents, "Nothing unpaid from earlier months.");
      renderOwe($("suOweAfter"), `Owing, next ${d.aheadMonths} months`, d.after, d.afterCents, `Nothing owing in the next ${d.aheadMonths} months.`, `Total, next ${d.aheadMonths} months`);
    } catch (e) {
      $("suOweBefore").replaceChildren();
      $("suOweAfter").replaceChildren();
    }
  }

  // A column for a month there is no list for (before the history starts, or too far ahead).
  function makeGap(period, slot) {
    const before = period < P.HISTORY_START;
    return el("section", { class: `su-col su-col-gap su-col-${["before", "centre", "after"][slot]}` },
      el("div", { class: "su-col-head" }, el("h2", { class: "su-col-month", text: P.longLabel(period) })),
      el("p", {
        class: "su-empty",
        text: before
          ? `The lists start in ${P.longLabel(P.HISTORY_START)}.`
          : `The lists go up to ${P.longLabel(lastPeriod())}.`,
      }));
  }

  function countsLine(c) {
    return `Have ${c.have}, Waiting ${c.waiting}, N/A ${c.na} of ${c.listed}`;
  }

  async function showMonths(p, opts) {
    for (const pn of panes) if (pn) pn.kill();
    centre = p;
    if (!(opts && opts.keepUrl)) syncUrl();
    renderHeader();
    const cols = $("suCols");
    cols.replaceChildren();
    panes = [-1, 0, 1].map((d, slot) => {
      const per = P.addMonths(p, d);
      if (!inRange(per)) {
        cols.append(makeGap(per, slot));
        return null;
      }
      const pn = makePane(per, slot);
      cols.append(pn.root);
      return pn;
    });
    await Promise.all(panes.map((pn) => pn && pn.load(pn.slot === 1 ? { notice: opts && opts.notice } : null)));
  }

  async function goMonth(to) {
    if (!to || !inRange(to) || to === centre) return;
    if (!(await confirmLeave())) return;
    await showMonths(to);
  }

  // ------------------------------------------------------- the suppliers list ---

  async function loadSuppliers() {
    if (!canEdit) return;
    const st = $("suManageStatus");
    try {
      const data = await call("GET", `${K.api}${showArchived ? "?all=1" : ""}`);
      suppliers = data.suppliers || [];
      st.textContent = "";
      renderSuppliers();
    } catch (e) {
      st.textContent = `Couldn't load the ${K.many}: ${e.message}`;
    }
  }

  function renderSuppliers() {
    const list = $("suSupplierList");
    list.replaceChildren();
    const shown = suppliers.filter((s) => showArchived || !s.archived);
    if (!shown.length) {
      list.append(el("li", { class: "su-none", text: showArchived ? `No ${K.many} yet.` : `No ${K.many} yet. Add the first with Add ${K.one}.` }));
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

  // After a change to the suppliers: the list and the three months again.
  async function afterSupplierChange() {
    await settle();
    await Promise.all([loadSuppliers(), loadOwing(), ...panes.map((pn) => pn && pn.refresh())]);
  }

  async function setArchived(s, archived) {
    if (archived && !confirm(`Archive ${s.name}? It won't be listed from ${P.longLabel(current)} on. Months that already have a line for it keep it.`)) return;
    await call("PATCH", `${K.api}/${s.id}`, { archived });
    toast(archived ? `Archived ${s.name}.` : `Restored ${s.name}.`);
    await afterSupplierChange();
    const item = $("suSupplierList").querySelector(`.su-sitem[data-id="${s.id}"] button:last-child`);
    (item || $("suShowArchived")).focus();
  }

  function openAdd() {
    $("suAddError").textContent = "";
    $("suAddName").value = "";
    $("suAddNote").textContent = `Listed from ${P.longLabel(centre)} (the centre month) on.`;
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
      $("suAddError").textContent = `Give the ${K.one} a name`;
      $("suAddName").focus();
      return;
    }
    ok.disabled = true;
    $("suAddError").textContent = "";
    try {
      const s = await call("POST", K.api, { name, fromPeriod: centre });
      $("suAddDlg").close();
      toast(`Added ${s.name}.`);
      await afterSupplierChange();
      const cp = centrePane();
      const R = cp ? cp.rows.find((x) => x.id === s.id) : null;
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
      $("suRenameError").textContent = `Give the ${K.one} a name`;
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
      const updated = await call("PATCH", `${K.api}/${s.id}`, { name });
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
    return `${K.title} ${P.longLabel(centre)}`;
  }

  // The centre month's list as saved, for paper.
  function buildPrint() {
    const box = $("suPrintMonth");
    box.replaceChildren();
    const pane = centrePane();
    const rows = pane ? pane.rows : [];
    const head = el("div", { class: "su-p-head" },
      el("div", null,
        el("h1", { class: "su-p-h1", text: K.title }),
        el("p", { class: "su-p-month", text: P.longLabel(centre) })),
      el("p", { class: "su-p-meta", text: `Printed ${longDate(todayISO())}` }));
    box.append(head);
    if (!rows.length) {
      box.append(el("p", { class: "su-p-empty", text: `No ${K.many} are listed for ${P.longLabel(centre)}.` }));
      return;
    }
    const table = el("table", { class: "su-p-table" });
    const cols = el("colgroup", null,
      el("col", { class: "su-pc-name" }), el("col", { class: "su-pc-state" }), el("col", { class: "su-pc-total" }),
      el("col", { class: "su-pc-tick" }), el("col", { class: "su-pc-tick" }), el("col", { class: "su-pc-tick" }),
      el("col", { class: "su-pc-note" }));
    const hr = el("tr");
    for (const [t, cls] of [[K.One, ""], ["Statement", ""], ["Total", "num"], ["Reconciled", "tick"], ["Paid", "tick"], ["MYOB", "tick"], ["Note", ""]]) {
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
    const c = pane.counts();
    const ft = el("tfoot", null, el("tr", null,
      el("th", { scope: "row", colspan: "2", text: countsLine(c) }),
      el("td", { class: "su-p-num", text: P.dollars(c.totalCents) }),
      ...TICKS.map(([k]) => el("td", { class: "su-p-tick", text: String(c[k]) })),
      el("td")));
    table.append(cols, el("thead", null, hr), tb, ft);
    box.append(table);
    box.append(el("p", { class: "su-p-foot", text: `${countsLine(c)}. Total of the statements: ${P.dollars(c.totalCents)}. Left to pay: ${P.dollars(c.leftCents)}. Reconciled ${c.reconciled}, Paid ${c.paid}, Entered in MYOB ${c.myob} of ${c.listed}.` }));
    printIndividual(box, pane);
  }

  // 0.2.7 (m28-contracts.md section 2): the month's individual invoices on the print.
  function printIndividual(box, pane) {
    const d = pane && pane.ind && pane.ind.data;
    if (!d || !d.lines.length) return;
    box.append(el("h2", { class: "su-p-h2", text: "Individual invoices" }));
    const t = el("table", { class: "su-p-ind" });
    const hr = el("tr");
    for (const [x, cls] of [["Payee", ""], ["For", ""], ["Due", ""], ["Amount", "num"], ["MYOB", "tick"], ["Paid", ""]]) {
      hr.append(el("th", { scope: "col", class: cls ? `su-p-${cls}` : null, text: x }));
    }
    const tb = el("tbody");
    for (const l of d.lines) {
      tb.append(el("tr", null,
        el("th", { scope: "row", text: l.payee }),
        el("td", { text: l.description || "" }),
        el("td", { text: l.dueDate ? longDate(l.dueDate) : "" }),
        el("td", { class: "su-p-num", text: l.amountCents == null ? "Missing" : P.dollars(l.amountCents) }),
        el("td", { class: "su-p-tick", text: l.myob ? CHECK : "" }),
        el("td", { text: l.paid ? longDate(l.paidDate) : "" })));
    }
    t.append(el("thead", null, hr), tb);
    box.append(t);
    box.append(el("p", { class: "su-p-foot", text: `${d.counts.listed} individual invoices. Left to pay: ${P.dollars(d.leftCents)}. Paid ${d.counts.paid} of ${d.counts.listed}.` }));
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
    [`${K.One} name`, "su-fc-name"],
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
  // An A4 page is 273 mm high inside its 12 mm margins; the heading takes about 14 mm and the
  // column titles 11 mm, leaving about 248 mm. The rows get 245 mm of it (borders and rounding).
  const FORM_ROWS_MM = 245;

  function buildForm(names) {
    const sheet = el("article", { class: "su-sheet" });
    sheet.append(el("div", { class: "su-f-head" },
      el("h1", { class: "su-f-h1", text: K.Many }),
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
    // Tall rows for handwriting, sized from the space left on an A4 page under the heading and the
    // column titles (FORM_ROWS_MM), so the paper form's 27 suppliers and 5 blank rows fit on one
    // page; never under 7 mm (a longer list runs on to a second page, the column titles repeated).
    const h = Math.max(7, Math.min(12, Math.floor((FORM_ROWS_MM / n) * 10) / 10));
    if (h < 9) table.classList.add("su-f-tight"); // smaller names, so two lines still fit the row
    for (let i = 0; i < n; i++) {
      const tr = el("tr");
      tr.style.height = `${h}mm`;
      // a long name is cut to two lines rather than making its row taller
      const name = i < names.length ? el("div", { class: "su-f-nm", text: names[i] }) : null;
      tr.append(el("td", { class: "su-f-name" }, name));
      for (let j = 1; j < FORM_COLS.length; j++) tr.append(el("td"));
      tb.append(tr);
    }
    table.append(cg, el("thead", null, hr), tb);
    sheet.append(table);
    return sheet;
  }

  async function bootBlank() {
    $("suBlankView").hidden = false;
    document.title = K.form;
    const asked = params.get("period");
    const p = asked && inRange(asked) ? asked : defaultPeriod();
    $("suBlankBack").href = `${K.page}?period=${p}`;
    const pages = $("suBlankPages");
    const state = $("suBlankState");
    let names = [];
    try {
      const m = await call("GET", `${K.api}/months/${p}`);
      names = (m.lines || []).map((l) => l.supplier.name);
      state.textContent = `${names.length} ${names.length === 1 ? K.one : K.many} listed for ${P.longLabel(p)}, then ${BLANK_ROWS} blank rows. The month is left blank to fill in.`;
    } catch (e) {
      pages.replaceChildren(el("p", { class: "su-message su-error", text: `Couldn't load the ${K.many} for ${P.longLabel(p)}: ${e.message}` }));
      return;
    }
    pages.replaceChildren(buildForm(names));
    const btn = $("suBlankPrint");
    btn.disabled = false;
    btn.addEventListener("click", () => {
      document.title = K.form;
      window.print();
    });
  }

  // ------------------------------------------------------------------- boot ---

  function wire() {
    $("suPrev").addEventListener("click", () => goMonth($("suPrev").dataset.to));
    $("suNext").addEventListener("click", () => goMonth($("suNext").dataset.to));
    $("suToday").addEventListener("click", () => goMonth(defaultPeriod()));
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
      for (const R of allRows()) flushState(R); // a state chosen by arrow keys starts saving now
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
    if (isAdmin()) {
      const a = $("suAudit");
      a.href = `/audit.html?entityType=${encodeURIComponent(K.entity)}`;
      $("suAuditBox").hidden = false;
    }
    const asked = params.get("period");
    let notice = "";
    let p = defaultPeriod();
    if (asked) {
      if (inRange(asked)) p = asked;
      else notice = `There is no ${K.one} list for that month (they go from ${P.label(P.HISTORY_START)} to ${P.label(lastPeriod())}); showing ${P.longLabel(p)}.`;
    }
    await Promise.all([showMonths(p, { notice }), loadSuppliers(), loadOwing()]);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
