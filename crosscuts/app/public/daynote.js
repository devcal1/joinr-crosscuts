// Add / edit day note dialog, shared by the Dashboard, the Pay runs page and a pay run's page
// (docs/plans/payrun-notes-plan.md, "Add day note"). Admin only: the server enforces users.admin.
//
//   DayNote.open({ personId, workerId, date, onSaved })   all optional
//
// personId / workerId preselect the person (personId wins); date is "YYYY-MM-DD" (default today in
// Australia/Sydney); onSaved(answer) runs after a successful PUT with the PUT's JSON answer.
// Load after shared.js (toast) and before the page script. Style: daynote.css (dn- classes).
(function () {
  "use strict";

  var API = "/api/payruns";
  var MAX = 500;
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  var dlg = null;
  var f = {}; // form parts
  var st = null; // state for the open dialog

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  function parseISO(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  }

  // "Thu 5 Nov"
  function shortDay(s) {
    var d = parseISO(s);
    return d ? WEEKDAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] : s;
  }

  // "5 Nov, 11:20 am" in Sydney time
  function stamp(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var p = {};
    new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(d)
      .forEach(function (x) { p[x.type] = x.value; });
    return p.day + " " + p.month + ", " + p.hour + ":" + p.minute + " " + String(p.dayPeriod || "").toLowerCase();
  }

  // fetch that keeps the whole error body (api() in shared.js keeps only the sentence, and the
  // stale 409 carries the current note in its body)
  async function call(path, options) {
    var res = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...((options && options.headers) || {}) },
    });
    if (res.status === 401) {
      var next = encodeURIComponent(location.pathname + location.search);
      location.href = "/login.html?next=" + next;
      return new Promise(function () {});
    }
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      var err = new Error(body.error || "Request failed (" + res.status + ")");
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  function byLine(n) {
    return (n.by && n.by.name ? n.by.name + " · " : "") + stamp(n.updatedAt);
  }

  function build() {
    dlg = el("dialog", "cc-dialog dn-dialog");
    dlg.setAttribute("aria-label", "Day note");
    var form = el("form", "cc-dialog-form");
    form.noValidate = true;
    f.title = el("h2", "cc-dialog-title", "Add day note");

    function field(label, control, id) {
      var wrap = el("div", "cc-field");
      var lab = el("label", "cc-field-label", label);
      control.id = id;
      lab.htmlFor = id;
      wrap.append(lab, control);
      return wrap;
    }

    f.person = el("select", "hs-input");
    f.date = el("input", "hs-input");
    f.date.type = "date";
    f.run = el("p", "dn-run");
    f.note = el("textarea", "hs-input");
    f.note.maxLength = MAX;
    f.note.placeholder = "What happened today";
    f.count = el("p", "dn-count", "0 / " + MAX);
    f.by = el("p", "dn-by");
    f.by.hidden = true;
    f.mine = el("textarea", "hs-input dn-mine");
    f.mine.readOnly = true;
    f.mine.rows = 3;
    f.mineWrap = field("Your text (not saved)", f.mine, "dnMine");
    f.mineWrap.hidden = true;
    f.err = el("p", "cc-dialog-error");
    f.err.setAttribute("role", "alert");

    f.remove = el("button", "hs-btn hs-btn-stop", "Remove note");
    f.remove.type = "button";
    f.cancel = el("button", "hs-btn", "Cancel");
    f.cancel.type = "button";
    f.save = el("button", "hs-btn hs-btn-primary", "Save note");
    f.save.type = "submit";
    var acts = el("div", "cc-dialog-actions");
    acts.append(f.remove, f.cancel, f.save);

    form.append(
      f.title,
      field("Person", f.person, "dnPerson"),
      field("Day", f.date, "dnDate"),
      f.run,
      f.mineWrap,
      field("Note", f.note, "dnNote"),
      f.count,
      f.by,
      f.err,
      acts
    );
    dlg.append(form);
    document.body.append(dlg);

    f.person.addEventListener("change", lookup);
    f.date.addEventListener("change", lookup);
    f.note.addEventListener("input", updateCount);
    f.cancel.addEventListener("click", function () { dlg.close(); });
    f.remove.addEventListener("click", onRemove);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      send(f.note.value);
    });
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg) dlg.close(); // backdrop click
    });
  }

  function updateCount() {
    f.count.textContent = f.note.value.length + " / " + MAX;
  }

  function personKey() {
    var m = /^(p|w):(\d+)$/.exec(f.person.value || "");
    if (!m) return null;
    return m[1] === "p" ? { personId: +m[2] } : { workerId: +m[2] };
  }

  function personLabel() {
    var o = f.person.selectedOptions && f.person.selectedOptions[0];
    return o ? o.textContent : "";
  }

  function firstName() {
    var o = f.person.selectedOptions && f.person.selectedOptions[0];
    return (o && o.dataset.first) || personLabel();
  }

  function setRun(parts, stop) {
    f.run.textContent = "";
    f.run.className = "dn-run" + (stop ? " dn-run-stop" : "");
    parts.forEach(function (p) {
      if (typeof p === "string") f.run.append(document.createTextNode(p));
      else f.run.append(el("b", "", p.b));
    });
  }

  function block(on) {
    st.blocked = on;
    f.save.disabled = on;
    f.remove.disabled = on;
  }

  // Title, Remove and the by line from the current note (or none).
  function showNoteMeta(note) {
    f.title.textContent = note ? "Edit day note" : "Add day note";
    f.remove.hidden = !note;
    f.by.hidden = !note;
    if (note) f.by.textContent = byLine(note);
  }

  function showAnswer(a) {
    st.answer = a;
    var fn = a.fortnight;
    var first = firstName();
    st.updatedAt = a.dayNote ? a.dayNote.updatedAt : null;
    var finalised = fn.status === "finalised";
    block(finalised);
    if (finalised) {
      setRun(["The ", { b: fn.label }, " pay run is finalised. Reopen it to change its notes."], true);
    } else if (fn.status === "none") {
      setRun(["The ", { b: fn.label }, " pay run isn't started yet. The note is kept and shows on " + first + "'s sheet when it is."]);
    } else if (!fn.hasSheet) {
      setRun(["The ", { b: fn.label }, " pay run has no sheet for " + first + " yet. The note is kept and shows when their sheet is added."]);
    } else {
      setRun([a.dayNote ? "On the " : "Goes on the ", { b: fn.label }, " pay run (open)."]);
    }
    showNoteMeta(a.dayNote);
  }

  // GET what the dialog needs for this person and day; set the note box from it.
  async function lookup() {
    var key = personKey();
    var date = f.date.value;
    f.err.textContent = "";
    f.mineWrap.hidden = true;
    var seq = ++st.seq;
    st.answer = null;
    if (!key || !date) {
      setRun([]);
      block(true);
      return;
    }
    var qs = (key.personId != null ? "personId=" + key.personId : "workerId=" + key.workerId) + "&date=" + encodeURIComponent(date);
    try {
      var a = await call(API + "/day-notes?" + qs);
      if (seq !== st.seq) return;
      showAnswer(a);
      f.note.value = a.dayNote ? a.dayNote.note : "";
      updateCount();
    } catch (e) {
      if (seq !== st.seq) return;
      st.updatedAt = null;
      showNoteMeta(null);
      setRun([e.message], true);
      block(true);
    }
  }

  async function send(text) {
    var key = personKey();
    if (!key || st.blocked || !st.answer) return;
    var removing = text === "";
    if (removing && !st.answer.dayNote) {
      f.err.textContent = "Write a note first";
      f.note.focus();
      return;
    }
    f.err.textContent = "";
    f.save.disabled = true;
    f.remove.disabled = true;
    var typed = f.note.value;
    var body = { date: f.date.value, note: text, updatedAt: st.updatedAt };
    if (key.personId != null) body.personId = key.personId;
    else body.workerId = key.workerId;
    try {
      var a = await call(API + "/day-notes", { method: "PUT", body: JSON.stringify(body) });
      var who = personLabel();
      var cb = st.onSaved;
      dlg.close();
      toast((removing ? "Note removed for " : "Note saved for ") + who + ", " + shortDay(body.date) + ".");
      if (typeof cb === "function") cb(a);
    } catch (e) {
      block(false);
      if (e.status === 409 && e.body && "dayNote" in e.body) {
        // Stale: theirs goes in the box; what was typed stays above it, readable and selectable.
        var cur = e.body.dayNote;
        f.mine.value = typed;
        f.mineWrap.hidden = false;
        f.note.value = cur ? cur.note : "";
        updateCount();
        st.updatedAt = cur ? cur.updatedAt : null;
        st.answer = { ...st.answer, dayNote: cur };
        showNoteMeta(cur);
        f.err.textContent = "Someone else changed this note; here is theirs. Yours wasn't saved.";
        f.mine.focus();
        f.mine.select();
      } else if (e.status === 409) {
        // finalised meanwhile
        block(true);
        f.err.textContent = e.message;
      } else {
        f.err.textContent = e.message;
      }
    }
  }

  function onRemove() {
    if (st.blocked || !st.answer || !st.answer.dayNote) return;
    if (!window.confirm("Remove this day note?")) return;
    send("");
  }

  async function open(opts) {
    opts = opts || {};
    if (!dlg) build();
    st = { seq: 0, blocked: true, answer: null, updatedAt: null, onSaved: opts.onSaved };
    f.err.textContent = "";
    f.mineWrap.hidden = true;
    f.note.value = "";
    updateCount();
    showNoteMeta(null);
    f.run.textContent = "";
    f.save.disabled = true;
    f.date.value = /^\d{4}-\d{2}-\d{2}$/.test(opts.date || "") ? opts.date : todayISO();
    f.person.textContent = "";
    if (!dlg.open) dlg.showModal();
    f.note.focus();

    var people;
    try {
      var r = await call(API + "/people");
      people = (r.people || []).filter(function (p) { return p.onPayRun && !p.archived; });
    } catch (e) {
      f.err.textContent = e.message;
      return;
    }
    if (!dlg.open) return;
    var pick = null;
    people.forEach(function (p) {
      var o = el("option", "", p.name);
      o.value = p.id != null ? "p:" + p.id : "w:" + p.workerId;
      o.dataset.first = p.firstName || p.baseName || p.name;
      f.person.append(o);
      if (opts.personId != null) {
        if (p.id === opts.personId) pick = o.value;
      } else if (opts.workerId != null && p.workerId === opts.workerId) {
        pick = o.value;
      }
    });
    if (pick) f.person.value = pick;
    await lookup();
  }

  window.DayNote = { open: open };
})();
