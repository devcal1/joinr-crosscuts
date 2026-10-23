// Alarm holders and codes (/alarms.html; docs/plans/m13-contracts.md sections 5 and 10.4). Talks to
// /api/alarms (routes/alarms.js); every rule lives in lib/alarms.js and lib/alarmcode.js, and the
// page only hides what a user can't use (cc.can()). The page is gated by alarms.manage
// (lib/pages.js), an owner-only key.
//
// The codes (section 1, Boundaries; section 5.3): the overview never carries a code, only whether
// one is set and readable. A code reaches the page only from POST /slots/:id/reveal (Show), goes
// into its cell as text (never an attribute, the URL, storage, the clipboard or the console), and
// is taken out of the DOM again after 30 seconds, by Hide, when the page is hidden or left, before
// a print, and whenever the table is drawn again. The mask is the same length for every code. A
// typed code shows as dots (a text input masked in alarms.css, so phones keep the number pad;
// section 12.2), is sent once and its input emptied after every save, refused or not. There is no
// alarm print (section 10.4), and the page hides itself on paper.
//
// Leavers (a person who has left, holding a slot still in use) are listed first in orange. A
// missing key file shows the orange block and turns code saving off. Every value goes in as text.
// The dialogs are built on OrderUI's frame (orderui.js). Page classes are al-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MASK = "••••••"; // the same six dots whatever the code
  const SHOW_MS = 30000;
  const TYPES = [["office", "Office"], ["staff", "Staff"], ["temp", "Temp"]];
  const TYPE_LABEL = Object.fromEntries(TYPES);
  const OTHER = "__other";
  const CODE_RE = /^[0-9]{1,12}$/;

  let data = null;      // the last overview
  let loadSeq = 0;
  // Every code on screen: {slotId, cell, button, timer}. Emptied by hideAll().
  const shown = new Map();

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

  function ui() {
    return window.OrderUI.ui;
  }

  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  }

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  function setStatus(text, kind) {
    const s = $("alStatus");
    s.textContent = text || "";
    s.className = "al-status" + (kind ? " al-status-" + kind : "");
  }

  function setMsg(id, text, kind) {
    const m = $(id);
    m.textContent = text || "";
    m.className = "al-msg" + (kind ? " al-msg-" + kind : "");
  }

  function failText(e) {
    return e instanceof TypeError ? "Couldn't reach the server. Try again." : (e && e.message) || "That didn't work. Try again.";
  }

  // A refusal from inside a dialog: the dialog shows the sentence and stays open.
  function refusal(e) {
    const err = new Error(failText(e));
    if (!(e instanceof TypeError)) err.refused = true;
    return err;
  }

  function send(path, method, body) {
    return api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  // ================================================================ showing a code ===

  // Takes one shown code out of the DOM: the cell gets the mask back, the button says Show.
  function hideOne(slotId) {
    const s = shown.get(slotId);
    if (!s) return;
    clearTimeout(s.timer);
    shown.delete(slotId);
    s.cell.replaceChildren(document.createTextNode(MASK));
    s.cell.classList.remove("al-code-shown");
    if (s.button && s.button.isConnected) {
      s.button.textContent = "Show";
      s.button.setAttribute("aria-pressed", "false");
      s.button.setAttribute("aria-label", "Show the code for slot " + s.slotNo);
    }
  }

  function hideAll() {
    for (const id of [...shown.keys()]) hideOne(id);
  }

  async function showCode(slot, cell, button) {
    if (shown.has(slot.id)) {
      hideOne(slot.id);
      return;
    }
    // Busy without disabling the button, so keyboard focus stays on it.
    if (button.getAttribute("aria-busy") === "true") return;
    button.setAttribute("aria-busy", "true");
    let r;
    try {
      r = await send("/api/alarms/slots/" + slot.id + "/reveal", "POST", {});
    } catch (e) {
      button.removeAttribute("aria-busy");
      setStatus(failText(e), "err");
      // A 409 (no code, the key missing or unreadable) means the page is behind: draw it again.
      if (!(e instanceof TypeError)) load({ keepStatus: true });
      return;
    }
    button.removeAttribute("aria-busy");
    // The table may have been drawn again while the request was out: then the code isn't shown.
    if (!cell.isConnected || document.visibilityState === "hidden") return;
    const code = r && typeof r.code === "string" ? r.code : "";
    cell.replaceChildren(document.createTextNode(code));
    cell.classList.add("al-code-shown");
    button.textContent = "Hide";
    button.setAttribute("aria-pressed", "true");
    button.setAttribute("aria-label", "Hide the code for slot " + slot.slot);
    shown.set(slot.id, { cell, button, slotNo: slot.slot, timer: setTimeout(() => hideOne(slot.id), SHOW_MS) });
  }

  // Leaving the page, hiding it, or printing it takes every code out of the DOM.
  window.addEventListener("pagehide", hideAll);
  window.addEventListener("beforeprint", hideAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hideAll();
  });

  // ================================================================ the page ===

  function holderCell(s) {
    const td = el("td", { class: "al-c-holder", "data-label": "Holder" }, el("span", { class: "al-strong", text: s.name || "" }));
    if (s.leaver) td.append(" ", el("span", { class: "al-left", text: "left" }));
    else if (s.personId == null) td.append(el("span", { class: "al-note", text: "Not on the pay list" }));
    return td;
  }

  function codeCell(s, keyState) {
    const td = el("td", { class: "al-c-code", "data-label": "Code" });
    if (!s.code.set) {
      td.append(el("span", { class: "al-none", text: "none" }));
      return td;
    }
    if (!s.code.readable) {
      td.append(el("span", { class: "al-unread", text: "can't be read" }));
      return td;
    }
    const value = el("span", { class: "al-code", "aria-live": "polite" });
    value.textContent = MASK;
    const btn = el("button", { class: "hs-btn al-show", type: "button", "aria-pressed": "false", text: "Show" });
    btn.setAttribute("aria-label", "Show the code for slot " + s.slot);
    btn.addEventListener("click", () => showCode(s, value, btn));
    td.append(el("span", { class: "al-codebox" }, value, btn));
    if (keyState === "missing") btn.hidden = true;
    return td;
  }

  function rowActions(s) {
    const box = el("div", { class: "al-rowacts" });
    const edit = el("button", { class: "hs-btn", type: "button", text: "Edit" });
    edit.setAttribute("aria-label", "Edit slot " + s.slot);
    edit.addEventListener("click", () => slotDialog(s));
    box.append(edit);
    if (s.code.set) {
      const clear = el("button", { class: "hs-btn", type: "button", text: "Clear code" });
      clear.setAttribute("aria-label", "Clear the code for slot " + s.slot);
      clear.addEventListener("click", () => clearDialog(s));
      box.append(clear);
    }
    const rm = el("button", { class: "hs-btn hs-btn-stop", type: "button", text: "Remove" });
    rm.setAttribute("aria-label", "Remove slot " + s.slot);
    rm.addEventListener("click", () => removeDialog(s));
    box.append(rm);
    return box;
  }

  function renderLeavers(slots) {
    const box = $("alLeavers");
    const leavers = slots.filter((s) => s.leaver);
    box.replaceChildren(...leavers.map((s) =>
      el("p", { class: "al-leaver", text: `${s.name} has left: change or remove slot ${s.slot}` })));
    box.hidden = !leavers.length;
  }

  function renderSlots(d) {
    hideAll();
    const inUse = d.slots.filter((s) => !s.removedDate);
    const removed = d.slots.filter((s) => s.removedDate);
    $("alEmpty").hidden = inUse.length > 0;
    $("alWrap").hidden = !inUse.length;
    $("alRows").replaceChildren(...inUse.map((s) => el("tr", { class: s.leaver ? "al-row-leaver" : null },
      el("td", { class: "al-c-slot", "data-label": "Slot" }, el("span", { class: "al-slotno", text: String(s.slot) })),
      holderCell(s),
      el("td", { class: "al-c-type", "data-label": "Type", text: TYPE_LABEL[s.type] || s.type }),
      el("td", { class: s.givenDate ? "al-c-date" : "al-c-date al-blank", "data-label": "Given", text: fmtDate(s.givenDate) }),
      codeCell(s, d.keyState),
      el("td", { class: s.note ? "al-c-note" : "al-c-note al-blank", "data-label": "Note", text: s.note || "" }),
      el("td", { class: "al-c-act" }, rowActions(s)))));

    const det = $("alRemoved");
    det.hidden = !removed.length;
    $("alRemovedCount").textContent = removed.length ? "(" + removed.length + ")" : "";
    $("alRemovedRows").replaceChildren(...removed.map((s) => {
      const restore = el("button", { class: "hs-btn", type: "button", text: "Restore" });
      restore.setAttribute("aria-label", "Restore slot " + s.slot);
      restore.addEventListener("click", () => restoreSlot(s, restore));
      return el("tr", { class: "al-row-off" },
        el("td", { class: "al-c-slot", "data-label": "Slot", text: String(s.slot) }),
        el("td", { class: "al-c-holder", "data-label": "Holder", text: s.name || "" }),
        el("td", { class: "al-c-type", "data-label": "Type", text: TYPE_LABEL[s.type] || s.type }),
        el("td", { class: s.givenDate ? "al-c-date" : "al-c-date al-blank", "data-label": "Given", text: fmtDate(s.givenDate) }),
        el("td", { class: "al-c-date", "data-label": "Removed", text: fmtDate(s.removedDate) }),
        el("td", { class: s.note ? "al-c-note" : "al-c-note al-blank", "data-label": "Note", text: s.note || "" }),
        el("td", { class: "al-c-act" }, restore));
    }));
  }

  function renderCompany(c) {
    $("alCoName").value = c.name || "";
    $("alCoAccount").value = c.accountNumber || "";
    $("alCoContact").value = c.contactName || "";
    $("alCoPhone").value = c.phone || "";
  }

  function renderTimes(times) {
    $("alTimesRows").replaceChildren(...times.map((t) => {
      const arms = el("input", { class: "hs-input al-time", type: "time", "data-day": String(t.day), "data-which": "armsAt" });
      arms.value = t.armsAt || "";
      arms.setAttribute("aria-label", t.label + " arms at");
      const disarms = el("input", { class: "hs-input al-time", type: "time", "data-day": String(t.day), "data-which": "disarmsAt" });
      disarms.value = t.disarmsAt || "";
      disarms.setAttribute("aria-label", t.label + " disarms at");
      return el("tr", null,
        el("th", { scope: "row", class: "al-day", text: t.label }),
        el("td", null, arms),
        el("td", null, disarms));
    }));
  }

  function render(d, opts) {
    data = d;
    renderLeavers(d.slots);
    $("alKey").hidden = d.keyState !== "missing";
    renderSlots(d);
    if (!opts || !opts.keepForms) {
      renderCompany(d.company);
      renderTimes(d.times);
    }
    $("alSlots").hidden = false;
    $("alLower").hidden = false;
  }

  async function load(opts) {
    const seq = ++loadSeq;
    let d;
    try {
      d = await api("/api/alarms");
    } catch (e) {
      if (seq !== loadSeq) return;
      if (data) setStatus(failText(e), "err");
      else setStatus(/forbidden|access|permission/i.test((e && e.message) || "") ? "You don't have access to Alarms." : failText(e), "err");
      return;
    }
    if (seq !== loadSeq || !d) return;
    render(d, { keepForms: !!(opts && opts.keepForms) });
    if (!opts || !opts.keepStatus) setStatus("");
  }

  // ================================================================ dialogs ===

  function personOptions(select, slot) {
    select.append(el("option", { value: "", text: "Choose a holder" }));
    const people = (data && data.people) || [];
    let current = null;
    for (const p of people) {
      const value = p.id != null ? "p:" + p.id : "w:" + p.workerId;
      const opt = el("option", { value, text: p.name || "" });
      select.append(opt);
      if (slot && slot.personId != null && p.id === slot.personId) current = value;
    }
    // The present holder may have left (archived people aren't on the list): keep them choosable
    // for this slot only, as the server does.
    if (slot && slot.personId != null && !current) {
      current = "p:" + slot.personId;
      select.append(el("option", { value: current, text: (slot.name || "") + " (left)" }));
    }
    select.append(el("option", { value: OTHER, text: "Someone else…" }));
    if (slot) select.value = slot.personId != null ? current : OTHER;
  }

  function slotDialog(slot) {
    const U = ui();
    const editing = !!slot;
    const today = todayISO();
    const missing = data && data.keyState === "missing";

    const num = el("input", { class: "hs-input al-num", type: "number", min: "1", max: "999", step: "1", inputmode: "numeric", autocomplete: "off" });
    num.value = editing ? String(slot.slot) : "";
    const holder = el("select", { class: "hs-input" });
    personOptions(holder, slot);
    const name = U.textInput(editing && slot.personId == null ? slot.name : "", 100);
    const nameBox = U.field("Name", name, { hint: "A temp, a cleaner or anyone not on the pay list." });
    const type = el("select", { class: "hs-input" },
      el("option", { value: "", text: "Choose a type" }),
      ...TYPES.map(([v, label]) => el("option", { value: v, text: label })));
    type.value = editing ? slot.type : "";
    const given = U.dateInput(editing ? slot.givenDate : "", null, today);
    const note = U.textArea(editing ? slot.note : "", 500, 2);
    const code = el("input", {
      class: "hs-input al-codein", type: "text", inputmode: "numeric", autocomplete: "off", maxlength: "12",
      spellcheck: "false", autocapitalize: "off", autocorrect: "off",
    });
    let codeHint;
    if (missing) {
      code.disabled = true;
      codeHint = "The alarm code key is missing, so a new code can't be saved until it's restored.";
    } else if (editing && slot.code.set) {
      codeHint = "Leave empty to keep the saved code. Clear code is in the slot's row.";
    } else {
      codeHint = "1 to 12 digits. Leave empty for no code.";
    }

    const syncName = () => { nameBox.hidden = holder.value !== OTHER; };
    holder.addEventListener("change", syncName);
    syncName();

    const fields = [
      U.field("Slot number", num),
      U.field("Holder", holder),
      nameBox,
      U.field("Type", type),
      U.field("Date given", given),
      U.field("Code", code, { hint: codeHint }),
      U.field("Note", note, { wide: true }),
    ];

    // The input a server sentence is about (section 12.3, B-m6), or null.
    const fieldFor = (m) => {
      if (/^Slot \d+ is already in use|slot number/i.test(m)) return num;
      if (/^Give the holder|^Holder name/i.test(m)) return holder.value === OTHER ? name : holder;
      if (/^Holder must be/i.test(m)) return holder;
      if (/^The type/i.test(m)) return type;
      if (/date given/i.test(m)) return given;
      if (/^The code/i.test(m)) return code;
      if (/^Note/i.test(m)) return note;
      return null;
    };

    return U.dialog({
      title: editing ? "Edit slot " + slot.slot : "Add slot",
      fields,
      wide: true,
      submit: editing ? "Save" : "Add slot",
      focus: num,
      keepDisabled: true, // a missing key keeps the code box off after a refusal
      run: async () => {
        const typed = code.value.trim();
        code.value = ""; // never kept, whatever the answer
        const again = typed ? ". Type the code again." : "";
        const slotNo = Number(num.value);
        if (!num.value.trim() || !Number.isInteger(slotNo) || slotNo < 1 || slotNo > 999) {
          throw U.fail("The slot number must be a whole number from 1 to 999" + again, num);
        }
        if (!holder.value) throw U.fail("Give the holder: a person or a name" + again, holder);
        if (holder.value === OTHER && !name.value.trim()) throw U.fail("Give the holder: a person or a name" + again, name);
        if (!type.value) throw U.fail("Choose the type" + again, type);
        if (typed && !CODE_RE.test(typed)) throw U.fail("The code must be 1 to 12 digits. Type the code again.", code);

        const body = {};
        const holderBody = () => {
          if (holder.value === OTHER) return { holderName: name.value.trim() };
          const [kind, id] = holder.value.split(":");
          return kind === "w" ? { workerId: Number(id) } : { personId: Number(id) };
        };
        if (!editing) {
          Object.assign(body, { slot: slotNo, type: type.value }, holderBody());
          if (given.value) body.givenDate = given.value;
          if (note.value.trim()) body.note = note.value;
          if (typed) body.code = typed;
        } else {
          if (slotNo !== slot.slot) body.slot = slotNo;
          const wasOther = slot.personId == null;
          if (holder.value === OTHER) {
            if (!wasOther || name.value.trim() !== slot.name) body.holderName = name.value.trim();
          } else if (holder.value !== "p:" + slot.personId) {
            Object.assign(body, holderBody());
          }
          if (type.value !== slot.type) body.type = type.value;
          if ((given.value || null) !== (slot.givenDate || null)) body.givenDate = given.value || null;
          if (note.value.trim() !== (slot.note || "")) body.note = note.value;
          if (typed) body.code = typed;
          if (!Object.keys(body).length) return undefined; // nothing changed
        }
        try {
          const r = editing
            ? await send("/api/alarms/slots/" + slot.id, "PATCH", body)
            : await send("/api/alarms/slots", "POST", body);
          return r;
        } catch (e) {
          const err = refusal(e);
          err.field = fieldFor(err.message);
          if (typed) err.message = err.message.replace(/[.!?]?$/, ".") + " The code wasn't saved: type it again.";
          throw err;
        }
      },
    }).then((r) => after(r, editing ? "Slot " + slot.slot + " saved." : "Slot added."));
  }

  // Paste list: one slot per line, "slot name code" split by tabs (a spreadsheet copy) or spaces,
  // the code optional. A name matching one person on the pay list (any case) is that person, type
  // Staff; any other name is typed in as it is, type Temp. Every line is checked before anything
  // is sent; then each goes to POST /slots in turn, so a slot already in use is refused on its own
  // line and the rest still go in. The box is emptied whatever the answer: codes aren't kept.
  function parsePaste(text) {
    const people = (data && data.people) || [];
    const used = new Set(((data && data.slots) || []).filter((s) => !s.removedDate).map((s) => s.slot));
    const rows = [];
    const errors = [];
    const seen = new Set();
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const parts = line.split(/\t+|\s{2,}/).map((p) => p.trim()).filter(Boolean);
      const words = parts.length >= 2 ? parts : line.split(/\s+/);
      const slotNo = Number(words[0]);
      let code = null;
      let nameParts = words.slice(1);
      if (nameParts.length > 1 && CODE_RE.test(nameParts[nameParts.length - 1])) code = nameParts.pop();
      const name = nameParts.join(" ").trim();
      const where = "Line " + (i + 1);
      if (!/^\d+$/.test(words[0]) || slotNo < 1 || slotNo > 999) return errors.push(where + ": the slot number must be 1 to 999.");
      if (!name) return errors.push(where + ": no name.");
      if (name.length > 100) return errors.push(where + ": the name is over 100 characters.");
      if (seen.has(slotNo)) return errors.push(where + ": slot " + slotNo + " is listed twice.");
      if (used.has(slotNo)) return errors.push(where + ": slot " + slotNo + " is already in use.");
      seen.add(slotNo);
      const matches = people.filter((p) => (p.name || "").trim().toLowerCase() === name.toLowerCase());
      const body = { slot: slotNo };
      if (matches.length === 1) {
        const p = matches[0];
        Object.assign(body, p.id != null ? { personId: p.id } : { workerId: p.workerId }, { type: "staff" });
      } else {
        Object.assign(body, { holderName: name, type: "temp" });
      }
      if (code) body.code = code;
      rows.push({ body, name, matched: matches.length === 1 });
    });
    return { rows, errors };
  }

  function pasteDialog() {
    const U = ui();
    const missing = data && data.keyState === "missing";
    const box = U.textArea("", 20000, 10);
    box.setAttribute("spellcheck", "false");
    box.setAttribute("autocomplete", "off");
    return U.dialog({
      title: "Paste list",
      note: "One slot per line: slot number, name, code. Copy the rows straight from a spreadsheet.",
      hint: "A name that matches someone on the pay list is linked to them as Staff; any other name goes in as Temp. Change the type afterwards with Edit."
        + (missing ? " The alarm code key is missing, so lines with a code will be refused." : ""),
      fields: [U.field("Slots", box, { wide: true })],
      wide: true,
      submit: "Add slots",
      focus: box,
      run: async () => {
        const { rows, errors } = parsePaste(box.value);
        if (errors.length) throw U.fail(errors.slice(0, 5).join(" ") + (errors.length > 5 ? " (and " + (errors.length - 5) + " more)" : ""), box);
        if (!rows.length) throw U.fail("Paste at least one line.", box);
        box.value = ""; // codes aren't kept on the page
        const failed = [];
        let added = 0;
        for (const r of rows) {
          try {
            await send("/api/alarms/slots", "POST", r.body);
            added++;
          } catch (e) {
            failed.push("slot " + r.body.slot + " (" + failText(e).replace(/[.!?]$/, "") + ")");
          }
        }
        return { added, failed, linked: rows.filter((r) => r.matched).length };
      },
    }).then((r) => {
      if (!r) return;
      const msg = r.added + " slot" + (r.added === 1 ? "" : "s") + " added, " + r.linked + " linked to the pay list."
        + (r.failed.length ? " Not added: " + r.failed.join("; ") + "." : "");
      return after({ refused: false }, msg);
    });
  }

  function clearDialog(slot) {
    return ui().dialog({
      title: "Clear the code for slot " + slot.slot + "?",
      note: `The saved code for ${slot.name} is removed from Crosscuts. The alarm panel isn't changed.`,
      submit: "Clear code",
      submitClass: "hs-btn-stop",
      focus: "cancel",
      run: async () => {
        try {
          return await send("/api/alarms/slots/" + slot.id, "PATCH", { code: null });
        } catch (e) {
          throw refusal(e);
        }
      },
    }).then((r) => after(r, "The code for slot " + slot.slot + " was cleared."));
  }

  function removeDialog(slot) {
    const U = ui();
    const today = todayISO();
    const date = U.dateInput(today, slot.givenDate || null, today);
    return U.dialog({
      title: "Remove slot " + slot.slot,
      note: `${slot.name} no longer holds slot ${slot.slot}.` + (slot.code.set ? " The saved code will be cleared." : ""),
      fields: [U.field("Date removed", date)],
      submit: "Remove slot",
      submitClass: "hs-btn-stop",
      focus: date,
      run: async () => {
        try {
          return await send("/api/alarms/slots/" + slot.id + "/remove", "POST", date.value ? { removedDate: date.value } : {});
        } catch (e) {
          const err = refusal(e);
          if (/removed date/i.test(err.message)) err.field = date;
          throw err;
        }
      },
    }).then((r) => after(r, "Slot " + slot.slot + " removed."));
  }

  async function restoreSlot(slot, button) {
    button.disabled = true;
    try {
      await send("/api/alarms/slots/" + slot.id + "/restore", "POST", {});
    } catch (e) {
      button.disabled = false;
      setStatus(failText(e), "err");
      return;
    }
    await load({ keepForms: true, keepStatus: true });
    setStatus("Slot " + slot.slot + " restored, with no code.", "ok");
    focusTitle();
  }

  function focusTitle() {
    const t = $("alTitle");
    if (t) t.focus();
  }

  // After a dialog: a save reloads the page; a refusal the user closed reloads it too (someone
  // else may have changed the slot); a cancel does nothing. The table is drawn again, so the
  // button that opened the dialog may be gone: focus goes to the heading, by the status line.
  async function after(r, okText) {
    if (r === null) return;
    await load({ keepForms: true, keepStatus: true });
    if (r && r.refused) setStatus("The slots were reloaded as they are now.");
    else setStatus(okText, "ok");
    focusTitle();
  }

  // ================================================================ company and times ===

  $("alCompany").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    setMsg("alCompanyMsg", "");
    try {
      const c = await send("/api/alarms/company", "PUT", {
        name: $("alCoName").value,
        accountNumber: $("alCoAccount").value,
        contactName: $("alCoContact").value,
        phone: $("alCoPhone").value,
      });
      if (c) renderCompany(c);
      setMsg("alCompanyMsg", "Saved.", "ok");
    } catch (ex) {
      setMsg("alCompanyMsg", failText(ex), "err");
    }
    btn.disabled = false;
  });

  $("alTimes").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    const days = new Map();
    for (const inp of $("alTimesRows").querySelectorAll("input.al-time")) {
      const day = Number(inp.dataset.day);
      if (!days.has(day)) days.set(day, { day, armsAt: null, disarmsAt: null });
      days.get(day)[inp.dataset.which] = inp.value || null;
    }
    btn.disabled = true;
    setMsg("alTimesMsg", "");
    try {
      const t = await send("/api/alarms/times", "PUT", { days: [...days.values()] });
      if (Array.isArray(t)) renderTimes(t);
      setMsg("alTimesMsg", "Saved.", "ok");
    } catch (ex) {
      setMsg("alTimesMsg", failText(ex), "err");
    }
    btn.disabled = false;
  });

  $("alAdd").addEventListener("click", () => slotDialog(null));
  $("alPaste").addEventListener("click", () => pasteDialog());

  (async () => {
    await (window.cc && window.cc.ready ? window.cc.ready : Promise.resolve());
    if (!can("alarms.manage")) {
      setStatus("You don't have access to Alarms.", "err");
      return;
    }
    load();
  })();
})();
