// Admin > Tasks: recurring tasks (0.2.0, docs/plans/m20-recurring-tasks.md). Lists the rules from
// /api/recurring; Add and Edit open one dialog; Pause, Resume and Delete act straight away (Delete
// asks first). Every piece of user text is set with textContent.
(function () {
  "use strict";

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function $(id) { return document.getElementById(id); }
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
  function fmt(d) {
    if (!d) return "";
    var p = d.split("-");
    return Number(p[2]) + " " + MONTHS[Number(p[1]) - 1] + " " + p[0];
  }

  async function api(method, url, body) {
    var opts = { method: method, headers: { Accept: "application/json" } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    var res = await fetch(url, opts);
    if (res.status === 204) return null;
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.error) || "Something went wrong (" + res.status + ")");
    return data;
  }

  var statusEl = $("rtStatus");
  var rowsEl = $("rtRows");
  var wrapEl = $("rtWrap");
  var emptyEl = $("rtEmpty");
  var dlg = $("rtDlg");
  var form = $("rtForm");
  var errEl = $("fError");
  var state = null;
  var editing = null; // the rule being edited, or null for a new one

  function setStatus(t) { statusEl.textContent = t || ""; }

  function forText(r) {
    return r.assignee ? r.assignee.name : r.deptLabel + " (department)";
  }

  function render() {
    rowsEl.replaceChildren();
    var rules = state.rules;
    wrapEl.hidden = rules.length === 0;
    emptyEl.hidden = rules.length > 0;
    rules.forEach(function (r) {
      var task = el("td", { "data-label": "Task" }, el("span", { class: "rt-task", text: r.title }));
      if (r.notes) task.append(el("span", { class: "rt-note", text: r.notes }));
      var rep = el("td", { "data-label": "Repeats", text: r.repeatText });
      rep.append(el("span", { class: "rt-sub", text: "From " + fmt(r.startDate) + (r.endDate ? " to " + fmt(r.endDate) : "") }));
      if (r.leadDays) rep.append(el("span", { class: "rt-sub", text: "Shows " + r.leadDays + (r.leadDays === 1 ? " day" : " days") + " before" }));
      var next = el("td", { "data-label": "Next due", text: r.nextDue ? fmt(r.nextDue) : r.active ? "None (ended)" : "Paused" });
      if (r.made) next.append(el("span", { class: "rt-sub", text: r.made + (r.made === 1 ? " made so far" : " made so far") }));
      var st = el("td", { "data-label": "State" },
        el("span", { class: r.active ? "hs-badge hs-badge-teal" : "hs-badge hs-badge-na", text: r.active ? "Active" : "Paused" }));
      var edit = el("button", { type: "button", class: "hs-btn", text: "Edit", "aria-label": "Edit " + r.title });
      edit.addEventListener("click", function () { openDialog(r); });
      var toggle = el("button", { type: "button", class: "hs-btn", text: r.active ? "Pause" : "Resume", "aria-label": (r.active ? "Pause " : "Resume ") + r.title });
      toggle.addEventListener("click", function () { act(function () { return api("POST", "/api/recurring/" + r.id + (r.active ? "/pause" : "/resume"), { updatedAt: r.updatedAt }); }, r.active ? "Paused." : "Resumed: it starts again from today."); });
      var del = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Delete", "aria-label": "Delete " + r.title });
      del.addEventListener("click", function () {
        if (!confirm("Delete “" + r.title + "”? No more tasks will be made from it. Tasks it has already made stay.")) return;
        act(function () { return api("DELETE", "/api/recurring/" + r.id); }, "Deleted. Tasks it already made stay.");
      });
      var actions = el("td", null, el("div", { class: "rt-actions" }, edit, toggle, del));
      rowsEl.append(el("tr", { class: r.active ? "" : "rt-paused" }, task,
        el("td", { "data-label": "For", text: forText(r) }), rep, next, st, actions));
    });
  }

  async function load(msg) {
    try {
      state = await api("GET", "/api/recurring");
      render();
      setStatus(msg || "");
    } catch (e) {
      setStatus(e.message);
    }
  }

  async function act(fn, msg) {
    try {
      await fn();
      await load(msg);
    } catch (e) {
      setStatus(e.message);
      await load(e.message);
    }
  }

  // ---------- the dialog ----------

  function fillFor() {
    var sel = $("fFor");
    sel.replaceChildren();
    var dg = el("optgroup", { label: "A department (one shared task)" });
    state.depts.forEach(function (d) { dg.append(el("option", { value: "dept:" + d.id, text: d.label })); });
    var pg = el("optgroup", { label: "One person" });
    state.people.forEach(function (p) { pg.append(el("option", { value: "user:" + p.id, text: p.name })); });
    sel.append(el("option", { value: "", text: "Choose..." }), dg, pg);
  }

  function showCustom() {
    var custom = $("fRepeat").value === "custom";
    Array.prototype.forEach.call(document.querySelectorAll(".rt-custom"), function (n) { n.hidden = !custom; });
  }
  $("fRepeat").addEventListener("change", showCustom);

  function openDialog(r) {
    editing = r || null;
    fillFor();
    $("rtDlgTitle").textContent = r ? "Edit recurring task" : "Add recurring task";
    $("fTitle").value = r ? r.title : "";
    $("fNotes").value = r ? r.notes : "";
    $("fFor").value = r ? (r.assignee ? "user:" + r.assignee.id : "dept:" + r.dept) : "";
    $("fRepeat").value = r ? r.repeat : "monthly";
    $("fEvery").value = r && r.repeatEvery ? r.repeatEvery : 2;
    $("fUnit").value = r && r.repeatUnit ? r.repeatUnit : "week";
    $("fStart").value = r ? r.startDate : state.today;
    $("fEnd").value = r && r.endDate ? r.endDate : "";
    $("fLead").value = r ? r.leadDays : 0;
    errEl.textContent = "";
    showCustom();
    dlg.showModal();
    $("fTitle").focus();
  }

  $("rtAdd").addEventListener("click", function () { if (state) openDialog(null); });
  $("fCancel").addEventListener("click", function () { dlg.close(); });

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    var who = $("fFor").value;
    var body = {
      title: $("fTitle").value,
      notes: $("fNotes").value,
      assigneeId: who.indexOf("user:") === 0 ? Number(who.slice(5)) : null,
      dept: who.indexOf("dept:") === 0 ? who.slice(5) : null,
      repeat: $("fRepeat").value,
      startDate: $("fStart").value,
      endDate: $("fEnd").value || null,
      leadDays: Number($("fLead").value || 0),
    };
    if (body.repeat === "custom") {
      body.repeatEvery = Number($("fEvery").value);
      body.repeatUnit = $("fUnit").value;
    } else {
      body.repeatEvery = null;
      body.repeatUnit = null;
    }
    if (editing) body.updatedAt = editing.updatedAt;
    var save = $("fSave");
    save.disabled = true;
    try {
      if (editing) await api("PATCH", "/api/recurring/" + editing.id, body);
      else await api("POST", "/api/recurring", body);
      dlg.close();
      await load(editing ? "Saved." : "Added.");
      $("rtTitle").focus();
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      save.disabled = false;
    }
  });

  load();
})();
