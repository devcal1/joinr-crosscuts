// The shared order-line dialogs (docs/plans/m10-contracts.md section 6): Received, Delivery note,
// Undo received and Edit line, plus the delivery-note block for a table cell and the list of
// actions a user may take on a line. Used by the Deliveries page, the Orders page and the job
// page's Orders section; this is the only place these dialogs are built.
//
//   <link rel="stylesheet" href="/orderui.css">
//   <script src="/shared.js"></script> ... <script src="/orderui.js"></script>
//
//   OrderUI.receive(line)      -> Promise<{order, job} | {refused: true} | null>
//   OrderUI.note(line)         -> Promise<{order, job} | {refused: true} | null>
//   OrderUI.undoReceived(line) -> Promise<{order, job} | {refused: true} | null>
//   OrderUI.edit(line)         -> Promise<{order, job} | {refused: true} | null>
//   OrderUI.noteBlock(line)    -> HTMLElement | null
//   OrderUI.actions(line)      -> {receive, note, undoReceived, edit, markOrdered, undoOrdered, cancel}
//
// `line` is an order object (lib/orders.js present(), with jobName when the list has it). Each
// dialog resolves to the server's response, or null when the user cancels (Cancel, Escape, the
// backdrop, or nothing changed). A refused request shows its sentence inside the dialog, which
// stays open; when the user then closes it without a later save going through, the dialog
// resolves {refused: true} instead of null, because the server refused the line as it is now
// (someone else may have changed it), so the page should reload its list. A sentence the
// dialog gives itself before sending (an empty date, say) is not a refusal: closing after it
// still resolves null. Each dialog is described by its line paragraph (aria-describedby).
// Focus stays inside the open dialog and goes back to the control that opened it.
// Who may do what is decided by the server (lib/orders.js); cc.can() only hides what a user can't
// use. Every value goes in as text. Styles (ou- classes) are in orderui.css.
(function () {
  "use strict";
  if (window.OrderUI) return;

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const NOTE_MAX = 500;
  const SUPPLIER_MAX = 200;
  const DESCRIPTION_MAX = 500;
  const NOTES_MAX = 2000;

  // The page should link /orderui.css in its head; this is a fallback so the dialogs never show
  // unstyled.
  function ensureStyles() {
    if (document.querySelector('link[rel="stylesheet"][href$="orderui.css"]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/orderui.css";
    document.head.appendChild(link);
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

  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }

  // Today in Sydney, YYYY-MM-DD (en-CA formats as ISO).
  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  }

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  // A UTC timestamp as its Sydney date, "d Mon yyyy".
  function fmtStamp(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    return fmtDate(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(t)));
  }

  // The earlier of two YYYY-MM-DD dates (either may be missing).
  function earlier(a, b) {
    if (!validDate(a)) return validDate(b) ? b : "";
    if (!validDate(b)) return a;
    return a < b ? a : b;
  }

  function validDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }

  // "Job name: Supplier, description" (the job name only when the list carries it).
  function lineName(line) {
    let s = line.supplier || "";
    if (line.description) s += ", " + line.description;
    return line.jobName ? `${line.jobName}: ${s}` : s;
  }

  // PATCH through shared.js api(); a failed request throws its {error} sentence. An answer from
  // the server (not a network failure) is marked `refused`.
  async function patch(line, body) {
    try {
      return await api("/api/orders/" + encodeURIComponent(line.id), { method: "PATCH", body: JSON.stringify(body) });
    } catch (e) {
      if (e instanceof TypeError) throw new Error("Couldn't reach the server. Try again.");
      if (e && typeof e === "object") e.refused = true;
      throw e;
    }
  }

  let open = null; // the dialog on screen; a second call replaces it (its promise resolves null)

  // A modal on the shell's cc-dialog frame. spec: {title, note, hint, fields, submit,
  // submitClass, cancel, focus, wide, run}. `focus` is the control to start on: a node, or
  // "cancel" for the cancel button (a confirm's safe choice); the submit button otherwise.
  // `run()` returns a promise of the response to resolve with, undefined to close with null
  // (nothing to send), or throws a sentence to show (marked `refused` when the server said no).
  function dialog(spec) {
    ensureStyles();
    if (open) open.dismiss();
    const opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;

    return new Promise((resolve) => {
      let result = null;
      let refused = false;
      let busy = false;
      const uid = Math.random().toString(36).slice(2, 8);
      const titleId = "ou-title-" + uid;
      const lineId = "ou-line-" + uid;
      const err = el("p", { class: "cc-dialog-error ou-error", role: "alert" });
      const cancel = el("button", { type: "button", class: "hs-btn", text: spec.cancel || "Cancel" });
      const go = el("button", { type: "submit", class: "hs-btn " + (spec.submitClass || "hs-btn-primary"), text: spec.submit });
      const form = el("form", { class: "cc-dialog-form ou-form", method: "dialog", novalidate: true },
        el("h2", { class: "cc-dialog-title", id: titleId, text: spec.title }),
        spec.note ? el("p", { class: "cc-dialog-note ou-line", id: lineId, text: spec.note }) : null,
        spec.fields && spec.fields.length ? el("div", { class: "ou-fields" }, ...spec.fields) : null,
        spec.hint ? el("p", { class: "cc-dialog-note ou-hint", text: spec.hint }) : null,
        err,
        el("div", { class: "cc-dialog-actions" }, cancel, go));
      const dlg = el("dialog", { class: "cc-dialog ou-dialog" + (spec.wide ? " ou-dialog-wide" : ""), "aria-labelledby": titleId,
        "aria-describedby": spec.note ? lineId : null }, form);
      document.body.append(dlg);
      const start = spec.focus === "cancel" ? cancel : spec.focus || go;

      const me = { dismiss: () => dlg.open && dlg.close() };
      open = me;

      function setBusy(on) {
        busy = on;
        for (const n of form.querySelectorAll("button, input, textarea, select")) n.disabled = on;
      }

      cancel.addEventListener("click", () => dlg.close());
      // The backdrop closes it, as the shell's dialogs do (not while a request is out).
      dlg.addEventListener("mousedown", (e) => {
        if (e.target === dlg && !busy) dlg.close();
      });
      // Escape closes it (the browser's cancel), except while a request is out.
      dlg.addEventListener("cancel", (e) => {
        if (busy) e.preventDefault();
      });
      // Keep Tab inside the dialog.
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
        if (open === me) open = null;
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
          if (start && typeof start.focus === "function") start.focus();
        }
      });

      dlg.showModal();
      start.focus();
    });
  }

  function fieldBox(label, input, opts) {
    const o = opts || {};
    const id = "ou-f-" + Math.random().toString(36).slice(2, 8);
    input.id = id;
    const box = el("div", { class: "cc-field ou-field" + (o.wide ? " ou-wide" : "") },
      el("label", { class: "cc-field-label", for: id, text: label }), input);
    if (o.hint) {
      const hid = id + "-h";
      box.append(el("span", { class: "ou-field-hint", id: hid, text: o.hint }));
      input.setAttribute("aria-describedby", hid);
    }
    return box;
  }

  function dateInput(value, min, max) {
    const n = el("input", { class: "hs-input ou-date", type: "date", min: min || null, max: max || null });
    n.value = value || "";
    return n;
  }

  function textInput(value, max, list) {
    const n = el("input", { class: "hs-input", type: "text", maxlength: String(max), autocomplete: "off", list: list || null });
    n.value = value || "";
    return n;
  }

  function textArea(value, max, rows) {
    const n = el("textarea", { class: "hs-input ou-text", maxlength: String(max), rows: String(rows || 3) });
    n.value = value || "";
    return n;
  }

  // ---------------------------------------------------------------- actions ---

  function actions(line) {
    const s = line && line.status;
    const live = s === "to_order" || s === "ordered" || s === "received";
    const placed = s === "ordered" || s === "received";
    const receive = can("orders.receive");
    const edit = can("orders.edit");
    const mark = can("orders.mark_ordered");
    return {
      receive: s === "ordered" && receive,
      note: placed && receive,
      undoReceived: s === "received" && receive,
      edit: live && (edit || (placed && mark) || (s === "received" && receive)),
      markOrdered: s === "to_order" && mark,
      undoOrdered: s === "ordered" && mark,
      cancel: live && edit,
    };
  }

  // ------------------------------------------------------------- note block ---

  // Who wrote the note is only known when the line's last change was the note itself (the line
  // keeps one updatedBy, not one per field).
  function noteBlock(line) {
    const text = line && typeof line.deliveryNote === "string" ? line.deliveryNote.trim() : "";
    if (!text) return null;
    const box = el("div", { class: "ou-note" + (line.status === "ordered" ? " ou-note-open" : "") },
      el("span", { class: "ou-note-label", text: "Delivery note" }),
      el("span", { class: "ou-note-text", text }));
    const when = fmtStamp(line.deliveryNoteAt);
    const who = line.updatedBy && line.updatedBy.name && line.deliveryNoteAt && line.updatedAt === line.deliveryNoteAt
      ? line.updatedBy.name : "";
    const meta = [who, when].filter(Boolean).join(", ");
    if (meta) box.append(el("span", { class: "ou-note-meta", text: meta }));
    return box;
  }

  // ---------------------------------------------------------------- dialogs ---

  function receive(line) {
    const today = todayISO();
    const date = dateInput(today, line.orderedDate || null, today);
    const note = textArea(line.deliveryNote || "", NOTE_MAX, 3);
    return dialog({
      title: "Received",
      note: lineName(line) + (line.orderedDate ? `. Ordered ${fmtDate(line.orderedDate)}.` : "."),
      fields: [
        fieldBox("Date received", date),
        fieldBox("Delivery note (optional)", note, { wide: true, hint: "Up to 500 characters. Empty the box to clear a note." }),
      ],
      hint: "Mark it received when everything on the line has arrived. If part is missing or damaged, use Delivery note instead and leave it ordered.",
      submit: "Mark received",
      focus: date,
      run: () => {
        if (!validDate(date.value)) throw new Error("Choose the date it arrived");
        const body = { status: "received", receivedDate: date.value };
        const n = note.value.trim();
        if (n !== (line.deliveryNote || "").trim()) body.deliveryNote = n;
        return patch(line, body);
      },
    });
  }

  function note(line) {
    const had = (line.deliveryNote || "").trim();
    const box = textArea(had, NOTE_MAX, 4);
    return dialog({
      title: "Delivery note",
      note: lineName(line) + ".",
      fields: [fieldBox("Note", box, { wide: true, hint: "Short, damaged or part delivered. Up to 500 characters. Empty the box to clear the note." })],
      hint: line.status === "ordered" ? "The line stays ordered. Ordering is told about a new note." : "Ordering is told about a new note.",
      submit: "Save note",
      focus: box,
      run: () => {
        const n = box.value.trim();
        if (n === had) return undefined;
        return patch(line, { deliveryNote: n });
      },
    });
  }

  function undoReceived(line) {
    return dialog({
      title: "Undo received?",
      note: lineName(line) + (line.receivedDate ? `. Received ${fmtDate(line.receivedDate)}.` : "."),
      hint: "It goes back to ordered and waits for delivery again. Its delivery note stays.",
      submit: "Undo received",
      cancel: "Keep received",
      focus: "cancel",
      run: () => patch(line, { status: "ordered" }),
    });
  }

  let suppliersPromise = null;
  function supplierList() {
    if (!can("orders.view")) return Promise.resolve([]);
    if (!suppliersPromise) {
      suppliersPromise = api("/api/orders/suppliers").catch(() => {
        suppliersPromise = null;
        return [];
      });
    }
    return suppliersPromise;
  }

  function edit(line) {
    const today = todayISO();
    const top = [];
    const dates = [];
    const bottom = [];
    const read = []; // [key, input, before, kind], in the order they show
    let list = null;
    const editText = can("orders.edit");
    if (editText) {
      list = el("datalist", { id: "ou-suppliers" });
      const sup = textInput(line.supplier, SUPPLIER_MAX, "ou-suppliers");
      const desc = textInput(line.description, DESCRIPTION_MAX);
      const exp = dateInput(line.expectedDate || "", null, null);
      top.push(fieldBox("Supplier", sup, { wide: true }), fieldBox("Description", desc, { wide: true }),
        fieldBox("Expected", exp, { hint: "Empty for no date yet." }));
      read.push(["supplier", sup, line.supplier || "", "text"], ["description", desc, line.description || "", "text"],
        ["expectedDate", exp, line.expectedDate || null, "date-or-null"]);
    }
    const placed = line.status === "ordered" || line.status === "received";
    const received = line.status === "received";
    // On a received line the ordered date can't be after the received date, nor the received
    // date before the ordered date (the server refuses both); when both show, each follows the
    // other as it is changed.
    let od = null;
    let rd = null;
    if (placed && can("orders.mark_ordered")) {
      od = dateInput(line.orderedDate || "", null, received ? earlier(today, line.receivedDate) : today);
      dates.push(fieldBox("Ordered", od));
      read.push(["orderedDate", od, line.orderedDate || null, "date"]);
    }
    if (received && can("orders.receive")) {
      rd = dateInput(line.receivedDate || "", line.orderedDate || null, today);
      dates.push(fieldBox("Received", rd));
      read.push(["receivedDate", rd, line.receivedDate || null, "date"]);
    }
    if (od && rd) {
      od.addEventListener("input", () => { rd.min = validDate(od.value) ? od.value : line.orderedDate || ""; });
      rd.addEventListener("input", () => { od.max = earlier(today, validDate(rd.value) ? rd.value : line.receivedDate); });
    }
    if (editText) {
      const notes = textArea(line.notes || "", NOTES_MAX, 3);
      bottom.push(fieldBox("Notes", notes, { wide: true }));
      read.push(["notes", notes, line.notes || "", "text"]);
    }
    const fields = top.concat(dates, bottom);
    if (!read.length) {
      return dialog({
        title: "Edit line",
        note: lineName(line) + ".",
        hint: "You can't change this line.",
        submit: "Close",
        cancel: "Cancel",
        run: () => undefined,
      });
    }
    if (list) {
      supplierList().then((names) => {
        for (const n of names) list.append(el("option", { value: n }));
      });
      fields.push(list);
    }
    return dialog({
      title: "Edit line",
      note: lineName(line) + ".",
      fields,
      wide: read.length > 2,
      submit: "Save",
      focus: read[0][1],
      run: () => {
        const body = {};
        for (const [key, input, before, kind] of read) {
          if (kind === "text") {
            const v = input.value.trim();
            if (key === "supplier" && !v) throw new Error("Type the supplier");
            if (v !== String(before).trim()) body[key] = v;
          } else {
            const v = input.value || null;
            if (v !== null && !validDate(v)) throw new Error("That isn't a whole date");
            if (kind === "date" && v === null) {
              throw new Error(key === "orderedDate" ? "The ordered date can't be empty" : "The received date can't be empty");
            }
            if (v !== before) body[key] = v;
          }
        }
        if (!Object.keys(body).length) return undefined;
        return patch(line, body);
      },
    });
  }

  window.OrderUI = { receive, note, undoReceived, edit, noteBlock, actions };
})();
