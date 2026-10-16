// Department notes page: /notes.html?dept=<id>. Talks to /api/notes (routes/notes.js,
// docs/plans/notes-contracts.md). Every piece of note text is set with textContent; line breaks
// are kept by the CSS (white-space: pre-wrap), never by markup.
(function () {
  "use strict";

  var BODY_MAX = 2000;
  var dept = new URLSearchParams(location.search).get("dept") || "";

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
  var sheetsEl = $("sheets");
  var composer = $("composer");
  var bodyEl = $("body");
  var addBtn = $("add");
  var countEl = $("count");
  var errorEl = $("error");
  var olderEl = $("older");
  var olderBtn = $("olderBtn");

  var state = { weeks: [], more: false, next: null };
  var editing = 0; // id of the note being edited (the lists are not redrawn while one is)

  // ---------- times ----------

  function weekOf(weekStart) {
    var d = new Date(weekStart + "T00:00:00Z");
    return "Week of " + d.toLocaleDateString("en-AU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
  }
  function signedAt(iso) {
    return new Date(iso).toLocaleString("en-AU", {
      timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
    });
  }

  function showMessage(text) {
    messageEl.textContent = text;
    messageEl.hidden = false;
    sheetsEl.hidden = true;
  }

  // ---------- one note ----------

  function noteItem(n) {
    var li = el("li", { class: "nt-note" + (n.canEdit ? " nt-mine" : ""), "data-id": n.id });
    li.append(el("p", { class: "nt-text", text: n.body }));
    var sign = el("div", { class: "nt-sign" });
    sign.append(el("span", { class: "nt-author", text: n.author.name }));
    sign.append(el("span", { class: "nt-time", text: signedAt(n.createdAt) + (n.edited ? " (edited)" : "") }));
    if (n.canEdit) {
      var actions = el("div", { class: "nt-actions" });
      var edit = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Edit" });
      var remove = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Remove" });
      edit.addEventListener("click", function () { startEdit(li, n); });
      remove.addEventListener("click", function () { askRemove(li, n); });
      actions.append(edit, remove);
      sign.append(actions);
    }
    li.append(sign);
    return li;
  }

  function startEdit(li, n) {
    if (editing) return;
    editing = n.id;
    var text = el("textarea", { class: "hs-input nt-body-input", rows: "4", maxlength: String(BODY_MAX), "aria-label": "Edit note" });
    text.value = n.body;
    var msg = el("span", { class: "nt-edit-msg", role: "alert" });
    var save = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Save" });
    var cancel = el("button", { type: "button", class: "hs-btn", text: "Cancel" });
    var row = el("div", { class: "nt-edit-row" }, save, cancel, msg);
    var box = el("div", { class: "nt-edit" }, text, row);
    li.replaceChildren(box);
    text.focus();
    cancel.addEventListener("click", function () { editing = 0; li.replaceWith(noteItem(n)); });
    save.addEventListener("click", async function () {
      msg.textContent = "";
      save.disabled = true;
      try {
        var saved = await api("/api/notes/" + n.id, {
          method: "PATCH",
          body: JSON.stringify({ body: text.value, updatedAt: n.updatedAt }),
        });
        editing = 0;
        li.replaceWith(noteItem(saved));
      } catch (e) {
        msg.textContent = e.message;
        save.disabled = false;
      }
    });
  }

  function askRemove(li, n) {
    if (editing) return;
    var sure = el("span", { class: "nt-sure", text: "Remove this note?" });
    var yes = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Remove" });
    var keep = el("button", { type: "button", class: "hs-btn", text: "Keep" });
    var msg = el("span", { class: "nt-edit-msg", role: "alert" });
    var actions = li.querySelector(".nt-actions");
    actions.replaceChildren(sure, yes, keep, msg);
    keep.addEventListener("click", function () { li.replaceWith(noteItem(n)); });
    yes.addEventListener("click", async function () {
      yes.disabled = true;
      try {
        await api("/api/notes/" + n.id, { method: "DELETE" });
        await reload();
      } catch (e) {
        msg.textContent = e.message;
        yes.disabled = false;
      }
    });
  }

  // ---------- the sheets ----------

  function fillList(listEl, emptyEl, week) {
    listEl.replaceChildren();
    week.notes.forEach(function (n) { listEl.append(noteItem(n)); });
    emptyEl.hidden = week.notes.length > 0;
  }

  function render() {
    var thisWeek = state.weeks[0];
    var lastWeek = state.weeks[1];
    $("thisLabel").textContent = weekOf(thisWeek.weekStart);
    $("lastLabel").textContent = weekOf(lastWeek.weekStart);
    fillList($("thisList"), $("thisEmpty"), thisWeek);
    fillList($("lastList"), $("lastEmpty"), lastWeek);
    olderBtn.hidden = !state.more;
  }

  function olderSection(week) {
    var list = el("ol", { class: "nt-list" });
    week.notes.forEach(function (n) { list.append(noteItem(n)); });
    return el(
      "section", { class: "nt-week" },
      el("h2", { class: "nt-week-head" }, weekOf(week.weekStart)),
      list
    );
  }

  // Takes a fresh answer for this and last week. Older weeks already opened stay, unless the
  // week has rolled over since (then the sheet starts again from the new last week).
  function apply(data) {
    var same = state.weeks.length && state.weeks[0].weekStart === data.weeks[0].weekStart;
    state.weeks = data.weeks;
    if (!same || !olderEl.children.length) {
      state.more = data.more;
      state.next = data.next;
      olderEl.replaceChildren();
    }
    render();
  }

  async function load() {
    var data = await api("/api/notes?dept=" + encodeURIComponent(dept));
    titleEl.textContent = data.deptLabel + " notes";
    document.title = data.deptLabel + " notes - Crosscuts";
    messageEl.hidden = true;
    sheetsEl.hidden = false;
    apply(data);
  }

  async function reload() {
    editing = 0;
    await load();
  }

  async function loadOlder() {
    olderBtn.disabled = true;
    try {
      var data = await api("/api/notes?dept=" + encodeURIComponent(dept) + "&before=" + encodeURIComponent(state.next));
      data.weeks.forEach(function (w) { olderEl.append(olderSection(w)); });
      state.more = data.more;
      state.next = data.next;
      olderBtn.hidden = !state.more;
    } catch (e) {
      errorEl.textContent = e.message;
    } finally {
      olderBtn.disabled = false;
    }
  }

  // ---------- the composer ----------

  function updateCount() {
    var n = bodyEl.value.length;
    countEl.textContent = n ? n + " / " + BODY_MAX : "";
    countEl.className = "nt-count" + (n > BODY_MAX - 200 ? " nt-count-near" : "");
  }
  bodyEl.addEventListener("input", updateCount);

  composer.addEventListener("submit", async function (e) {
    e.preventDefault();
    errorEl.textContent = "";
    if (!bodyEl.value.trim()) {
      errorEl.textContent = "Write something to leave a note";
      bodyEl.focus();
      return;
    }
    addBtn.disabled = true;
    try {
      await api("/api/notes", { method: "POST", body: JSON.stringify({ dept: dept, body: bodyEl.value }) });
      bodyEl.value = "";
      updateCount();
      await reload();
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      addBtn.disabled = false;
    }
  });

  olderBtn.addEventListener("click", loadOlder);

  // A tab left open over a week change shows the new sheet when it is next looked at.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || sheetsEl.hidden || editing) return;
    if (document.activeElement === bodyEl && bodyEl.value) return;
    api("/api/notes?dept=" + encodeURIComponent(dept)).then(function (data) {
      if (editing || !state.weeks.length) return;
      apply(data);
    }).catch(function () {});
  });

  // ---------- start ----------

  (async function start() {
    if (!dept) {
      showMessage("Choose a department's Notes page from the menu.");
      return;
    }
    try {
      await load();
    } catch (e) {
      if (/^Forbidden/.test(e.message)) showMessage("These notes are only for the people in that department. You don't have access to them.");
      else if (/Unknown department/.test(e.message)) showMessage("There is no Notes page for that department. Choose one from the menu.");
      else showMessage(e.message);
    }
  })();
})();
