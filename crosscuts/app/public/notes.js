// Department notes page: /notes.html?dept=<id>&week=<Monday>. A week wall, one column per weekday,
// of sticky notes. Talks to /api/notes (routes/notes.js, docs/plans/notes-contracts.md). Every
// piece of note text is set with textContent; line breaks are kept by the CSS (white-space:
// pre-wrap), never by markup.
(function () {
  "use strict";

  var BODY_MAX = 2000;
  var params = new URLSearchParams(location.search);
  var dept = params.get("dept") || "";

  function el(tag, props) {
    var node = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i] != null) node.append(arguments[i]);
    return node;
  }
  function $(id) { return document.getElementById(id); }

  var titleEl = $("title");
  var messageEl = $("message");
  var boardEl = $("board");
  var wallEl = $("wall");
  var composer = $("composer");
  var bodyEl = $("body");
  var dayEl = $("day");
  var postBtn = $("post");
  var countEl = $("count");
  var errorEl = $("error");
  var addBtn = $("addBtn");

  var data = null;     // the week on screen, as the server sent it
  var editing = 0;     // id of the note being edited or removed (the wall is not redrawn while one is)

  // ---------- times ----------

  var SYD = "Australia/Sydney";
  function sydDate(iso) {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: SYD });
  }
  // "11:20 am"; with the day in front ("Mon 12 Oct 9:10 am") when it was posted on another day
  // than the one the note sits under.
  function signedAt(iso, noteDate) {
    var d = new Date(iso);
    var time = d.toLocaleTimeString("en-AU", { timeZone: SYD, hour: "numeric", minute: "2-digit" });
    if (sydDate(iso) === noteDate) return time;
    return d.toLocaleDateString("en-AU", { timeZone: SYD, weekday: "short", day: "numeric", month: "short" }).replace(",", "") + " " + time;
  }

  function plusDays(date, n) {
    return new Date(Date.parse(date + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  }
  function dayLabel(date) {
    return new Date(date + "T00:00:00Z").toLocaleDateString("en-AU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).replace(",", "");
  }

  function showMessage(text) {
    messageEl.textContent = text;
    messageEl.hidden = false;
    boardEl.hidden = true;
  }

  // ---------- one note ----------

  function dayOptions(select, days, selected) {
    select.replaceChildren();
    days.forEach(function (d) {
      var o = el("option", { value: d.date, text: d.label });
      if (d.date === selected) o.selected = true;
      select.append(o);
    });
  }

  function noteItem(n) {
    var li = el("article", { class: "nt-note", "data-id": n.id });
    li.append(el("p", { class: "nt-text", text: n.body }));
    var sign = el("div", { class: "nt-sign" }, n.author.name + " · " + signedAt(n.createdAt, n.date));
    if (n.edited) sign.append(el("span", { class: "nt-edited", text: " (edited)" }));
    li.append(sign);
    var foot = el("div", { class: "nt-foot" });
    foot.append(ackButton(li, n));
    if (n.acks.names.length) foot.append(el("span", { class: "nt-ackers", text: n.acks.names.join(", ") }));
    if (n.canEdit) {
      var actions = el("div", { class: "nt-actions" });
      var edit = el("button", { type: "button", class: "hs-btn", text: "Edit" });
      var remove = el("button", { type: "button", class: "hs-btn", text: "Remove" });
      edit.addEventListener("click", function () { startEdit(li, n); });
      remove.addEventListener("click", function () { askRemove(li, n); });
      actions.append(edit, remove);
      foot.append(actions);
    }
    li.append(foot);
    return li;
  }

  // The thumbs-up: a button for anyone but the author (whose own mark is shown but inactive).
  function ackButton(li, n) {
    var mine = n.acks.mine;
    var btn = el("button", {
      type: "button",
      class: "nt-ack",
      "aria-pressed": n.canAck ? (mine ? "true" : "false") : false,
      "aria-label": !n.canAck ? "Thumbs-up (you can't acknowledge your own note)" : mine ? "Take back your thumbs-up" : "Give this note a thumbs-up",
      title: !n.canAck ? "You can't acknowledge your own note" : mine ? "Take back your thumbs-up" : "Thumbs-up",
      disabled: !n.canAck,
    });
    btn.append(el("i", { class: "ph ph-thumbs-up", "aria-hidden": "true" }));
    btn.append(el("span", { class: "nt-ack-count", text: n.acks.count ? String(n.acks.count) : "" }));
    if (n.canAck) {
      btn.addEventListener("click", async function () {
        btn.disabled = true;
        try {
          var saved = await api("/api/notes/" + n.id + "/ack", { method: mine ? "DELETE" : "PUT" });
          li.replaceWith(noteItem(saved));
        } catch (e) {
          btn.disabled = false;
          flash(li, e.message);
        }
      });
    }
    return btn;
  }

  function flash(li, text) {
    var old = li.querySelector(".nt-flash");
    if (old) old.remove();
    li.append(el("p", { class: "nt-edit-msg nt-flash", role: "alert", text: text }));
  }

  function startEdit(li, n) {
    if (editing) return;
    editing = n.id;
    var text = el("textarea", { class: "hs-input nt-body-input", rows: "4", maxlength: String(BODY_MAX), "aria-label": "Edit note" });
    text.value = n.body;
    // The days a note may move to: its own day, today and later this week, and the week after
    // (so a Friday note can still go to Monday).
    var days = [];
    function addDay(d) { if (!days.some(function (x) { return x.date === d.date; })) days.push(d); }
    data.days.forEach(function (d) { if (d.date === n.date) addDay({ date: d.date, label: d.label }); });
    data.formDays.forEach(addDay);
    for (var i = 0; i < 5; i++) {
      var date = plusDays(data.weekStart, 7 + i);
      if (data.formDays.length && date > data.formDays[0].date) addDay({ date: date, label: dayLabel(date) });
    }
    days.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var day = el("select", { class: "hs-input", "aria-label": "Day" });
    dayOptions(day, days, n.date);
    var msg = el("span", { class: "nt-edit-msg", role: "alert" });
    var save = el("button", { type: "button", class: "hs-btn", text: "Save" });
    var cancel = el("button", { type: "button", class: "hs-btn", text: "Cancel" });
    var row = el("div", { class: "nt-edit-row" }, day, save, cancel, msg);
    li.replaceChildren(el("div", { class: "nt-edit" }, text, row));
    text.focus();
    cancel.addEventListener("click", function () { editing = 0; li.replaceWith(noteItem(n)); });
    save.addEventListener("click", async function () {
      msg.textContent = "";
      save.disabled = true;
      try {
        var saved = await api("/api/notes/" + n.id, {
          method: "PATCH",
          body: JSON.stringify({ body: text.value, date: day.value, updatedAt: n.updatedAt }),
        });
        editing = 0;
        // A note moved to a day of another week takes you to that week.
        await load(saved.weekStart, saved.weekStart !== data.weekStart ? "push" : null);
      } catch (e) {
        msg.textContent = e.message;
        save.disabled = false;
      }
    });
  }

  function askRemove(li, n) {
    if (editing) return;
    editing = n.id;
    var sure = el("span", { class: "nt-sure", text: "Remove this note?" });
    var yes = el("button", { type: "button", class: "hs-btn", text: "Remove" });
    var keep = el("button", { type: "button", class: "hs-btn", text: "Keep" });
    var msg = el("span", { class: "nt-edit-msg", role: "alert" });
    var actions = li.querySelector(".nt-actions");
    actions.replaceChildren(sure, yes, keep, msg);
    keep.addEventListener("click", function () { editing = 0; li.replaceWith(noteItem(n)); });
    yes.addEventListener("click", async function () {
      yes.disabled = true;
      try {
        await api("/api/notes/" + n.id, { method: "DELETE" });
        editing = 0;
        await load(data.weekStart);
      } catch (e) {
        msg.textContent = e.message;
        yes.disabled = false;
      }
    });
  }

  // ---------- the wall ----------

  function render() {
    $("weekHead").textContent = data.heading;
    $("thisBtn").disabled = data.current;
    addBtn.hidden = !data.canAdd;
    wallEl.replaceChildren();
    data.days.forEach(function (d) {
      var head = el("h2", { class: "nt-day-head" }, d.label);
      if (d.today) head.append(el("span", { text: " · today" }));
      var stack = el("div", { class: "nt-stack" });
      d.notes.forEach(function (n) { stack.append(noteItem(n)); });
      var col = el("section", { class: "nt-day" + (d.today ? " nt-day-today" : ""), "data-date": d.date }, head, stack);
      if (d.canAdd) {
        var add = el("button", { type: "button", class: "nt-new", text: "+ New note" });
        add.addEventListener("click", function () { openComposer(d.date); });
        col.append(add);
      } else if (!d.notes.length) {
        col.append(el("p", { class: "nt-none", text: "No notes" }));
      }
      wallEl.append(col);
    });
  }

  function urlFor(week) {
    return "?dept=" + encodeURIComponent(dept) + "&week=" + encodeURIComponent(week);
  }

  // Loads a week (a Monday; none = this week) and draws it. `push` adds a history entry.
  async function load(week, push) {
    var q = "/api/notes?dept=" + encodeURIComponent(dept) + (week ? "&week=" + encodeURIComponent(week) : "");
    var d = await api(q);
    var changed = !data || data.weekStart !== d.weekStart;
    data = d;
    titleEl.textContent = d.deptLabel + " notes";
    document.title = d.deptLabel + " notes - Crosscuts";
    messageEl.hidden = true;
    boardEl.hidden = false;
    if (changed) closeComposer();
    render();
    if (push === "push") history.pushState(null, "", urlFor(d.weekStart));
    else if (push === "replace") history.replaceState(null, "", urlFor(d.weekStart));
  }

  async function go(week, push) {
    editing = 0;
    try {
      await load(week, push);
    } catch (e) {
      messageEl.textContent = e.message;
      messageEl.hidden = false;
    }
  }

  $("lastBtn").addEventListener("click", function () { if (data) go(data.prev, "push"); });
  $("nextBtn").addEventListener("click", function () { if (data) go(data.next, "push"); });
  $("thisBtn").addEventListener("click", function () { if (data) go(data.thisWeek, "push"); });
  window.addEventListener("popstate", function () {
    var w = new URLSearchParams(location.search).get("week");
    go(w || null);
  });

  // ---------- the add form ----------

  function updateCount() {
    var n = bodyEl.value.length;
    countEl.textContent = n ? n + " / " + BODY_MAX : "";
    countEl.className = "nt-count" + (n > BODY_MAX - 200 ? " nt-count-near" : "");
  }
  bodyEl.addEventListener("input", updateCount);

  function openComposer(date) {
    if (!data || !data.formDays.length) return;
    var pick = date && data.formDays.some(function (d) { return d.date === date; }) ? date : data.defaultDate;
    dayOptions(dayEl, data.formDays, pick);
    errorEl.textContent = "";
    composer.hidden = false;
    composer.scrollIntoView({ block: "nearest" });
    bodyEl.focus();
  }
  function closeComposer() {
    composer.hidden = true;
    bodyEl.value = "";
    errorEl.textContent = "";
    updateCount();
  }

  addBtn.addEventListener("click", function () { if (composer.hidden) openComposer(); else bodyEl.focus(); });
  $("cancel").addEventListener("click", closeComposer);
  composer.addEventListener("keydown", function (e) { if (e.key === "Escape") closeComposer(); });

  composer.addEventListener("submit", async function (e) {
    e.preventDefault();
    errorEl.textContent = "";
    if (!bodyEl.value.trim()) {
      errorEl.textContent = "Write something to leave a note";
      bodyEl.focus();
      return;
    }
    postBtn.disabled = true;
    try {
      var saved = await api("/api/notes", {
        method: "POST",
        body: JSON.stringify({ dept: dept, date: dayEl.value, body: bodyEl.value }),
      });
      closeComposer();
      // A note for a day in another week (a weekend post goes to Monday) takes you to that week.
      var other = saved.weekStart !== data.weekStart;
      await load(saved.weekStart, other ? "push" : null);
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      postBtn.disabled = false;
    }
  });

  // A tab left open shows fresh notes (and the right "today") when it is next looked at.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || boardEl.hidden || editing || !composer.hidden) return;
    load(data.weekStart).catch(function () {});
  });

  // ---------- start ----------

  (async function start() {
    if (!dept) {
      showMessage("Choose a department's Notes page from the menu.");
      return;
    }
    try {
      await load(params.get("week") || null, "replace");
    } catch (e) {
      if (/^Forbidden/.test(e.message)) showMessage("These notes are only for the people in that department. You don't have access to them.");
      else if (/Unknown department/.test(e.message)) showMessage("There is no Notes page for that department. Choose one from the menu.");
      else if (/^week must be/.test(e.message)) {
        try { await load(null, "replace"); } catch (e2) { showMessage(e2.message); }
      } else showMessage(e.message);
    }
  })();
})();
