// Workshop > Maintenance (0.2.6, docs/plans/m27-contracts.md section 4). Lists the maintenance items
// from /api/maintenance; Add and Edit open one dialog; Pause, Resume and Delete act straight away
// (Delete asks first); each open occurrence has Confirm actioned (with an optional note), and the
// last one done can be undone. Every piece of user text is set with textContent.
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
    var p = d.slice(0, 10).split("-");
    return Number(p[2]) + " " + MONTHS[Number(p[1]) - 1] + " " + p[0];
  }
  function stamp(iso) {
    try {
      return new Date(iso).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", year: "numeric" });
    } catch (e) {
      return fmt(iso);
    }
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

  var statusEl = $("mtStatus");
  var rowsEl = $("mtRows");
  var dlg = $("mtDlg");
  var doneDlg = $("mtDoneDlg");
  var state = null;
  var editing = null;
  var confirming = null; // {item, occ}

  function setStatus(t) { statusEl.textContent = t || ""; }

  function dueCell(it) {
    var td = el("td", { "data-label": "Due now" });
    if (!it.open.length) {
      td.append(el("span", { class: "mt-sub", text: "Nothing open" }));
      return td;
    }
    it.open.forEach(function (o) {
      var line = el("div", { class: "mt-occ" });
      var when = o.overdue ? "Overdue: due " + fmt(o.dueDate) + " (" + o.daysOverdue + (o.daysOverdue === 1 ? " day)" : " days)") : "Due " + fmt(o.dueDate);
      line.append(el("span", { class: o.overdue ? "mt-overdue" : "", text: when }));
      var b = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Confirm actioned", "aria-label": "Confirm " + it.title + " actioned, due " + fmt(o.dueDate) });
      b.addEventListener("click", function () { openDone(it, o); });
      line.append(b);
      td.append(line);
    });
    return td;
  }

  function render() {
    rowsEl.replaceChildren();
    var items = state.items;
    $("mtWrap").hidden = items.length === 0;
    $("mtEmpty").hidden = items.length > 0;
    items.forEach(function (it) {
      var item = el("td", { "data-label": "Item" }, el("span", { class: "mt-item", text: it.title }));
      if (it.notes) item.append(el("span", { class: "mt-note", text: it.notes }));
      var rep = el("td", { "data-label": "Repeats", text: it.repeatText });
      rep.append(el("span", { class: "mt-sub", text: "From " + fmt(it.startDate) + (it.endDate ? " to " + fmt(it.endDate) : "") }));
      var next = el("td", { "data-label": "Next due", text: it.nextDue ? fmt(it.nextDue) : it.active ? "None (ended)" : "Paused" });
      var last = el("td", { "data-label": "Last done" });
      if (it.lastDone) {
        last.append(el("span", { text: stamp(it.lastDone.at) + " by " + it.lastDone.by.name }));
        last.append(el("span", { class: "mt-sub", text: "Due " + fmt(it.lastDone.dueDate) }));
        if (it.lastDone.note) last.append(el("span", { class: "mt-note", text: it.lastDone.note }));
      } else {
        last.append(el("span", { class: "mt-sub", text: "Not yet" }));
      }
      var edit = el("button", { type: "button", class: "hs-btn", text: "Edit", "aria-label": "Edit " + it.title });
      edit.addEventListener("click", function () { openDialog(it); });
      var toggle = el("button", { type: "button", class: "hs-btn", text: it.active ? "Pause" : "Resume", "aria-label": (it.active ? "Pause " : "Resume ") + it.title });
      toggle.addEventListener("click", function () {
        act(function () { return api("POST", "/api/maintenance/" + it.id + (it.active ? "/pause" : "/resume"), { updatedAt: it.updatedAt }); }, it.active ? "Paused." : "Resumed: it starts again from today.");
      });
      var del = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Delete", "aria-label": "Delete " + it.title });
      del.addEventListener("click", function () {
        if (!confirm("Delete “" + it.title + "”? It will not come up again. What has been recorded stays.")) return;
        act(function () { return api("DELETE", "/api/maintenance/" + it.id); }, "Deleted.");
      });
      var actions = el("td", null, el("div", { class: "mt-actions" }, edit, toggle, del));
      rowsEl.append(el("tr", { class: it.active ? "" : "mt-paused" }, item, rep, next, last, dueCell(it), actions));
    });
  }

  async function load(msg) {
    try {
      state = await api("GET", "/api/maintenance");
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
      await load(e.message);
    }
  }

  // ---------- Add / Edit ----------

  function showCustom() {
    var custom = $("mRepeat").value === "custom";
    Array.prototype.forEach.call(document.querySelectorAll(".mt-custom"), function (n) { n.hidden = !custom; });
  }
  $("mRepeat").addEventListener("change", showCustom);

  function openDialog(it) {
    editing = it || null;
    $("mtDlgTitle").textContent = it ? "Edit maintenance item" : "Add maintenance item";
    $("mTitle").value = it ? it.title : "";
    $("mNotes").value = it ? it.notes : "";
    $("mRepeat").value = it ? it.repeat : "monthly";
    $("mEvery").value = it && it.repeatEvery ? it.repeatEvery : 3;
    $("mUnit").value = it && it.repeatUnit ? it.repeatUnit : "month";
    $("mStart").value = it ? it.startDate : state.today;
    $("mEnd").value = it && it.endDate ? it.endDate : "";
    $("mLead").value = it ? it.leadDays : 0;
    $("mError").textContent = "";
    showCustom();
    dlg.showModal();
    $("mTitle").focus();
  }

  $("mtAdd").addEventListener("click", function () { if (state) openDialog(null); });
  $("mCancel").addEventListener("click", function () { dlg.close(); });

  $("mtForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var body = {
      title: $("mTitle").value,
      notes: $("mNotes").value,
      repeat: $("mRepeat").value,
      startDate: $("mStart").value,
      endDate: $("mEnd").value || null,
      leadDays: Number($("mLead").value || 0),
      repeatEvery: null,
      repeatUnit: null,
    };
    if (body.repeat === "custom") {
      body.repeatEvery = Number($("mEvery").value);
      body.repeatUnit = $("mUnit").value;
    }
    if (editing) body.updatedAt = editing.updatedAt;
    var save = $("mSave");
    save.disabled = true;
    try {
      if (editing) await api("PATCH", "/api/maintenance/" + editing.id, body);
      else await api("POST", "/api/maintenance", body);
      dlg.close();
      await load(editing ? "Saved." : "Added.");
      $("mtTitle").focus();
    } catch (err) {
      $("mError").textContent = err.message;
    } finally {
      save.disabled = false;
    }
  });

  // ---------- Confirm actioned ----------

  function openDone(it, o) {
    confirming = { item: it, occ: o };
    $("mtDoneWhat").textContent = it.title + ", due " + fmt(o.dueDate) + ".";
    $("mtDoneNote").value = "";
    $("mtDoneError").textContent = "";
    doneDlg.showModal();
    $("mtDoneNote").focus();
  }

  $("mtDoneCancel").addEventListener("click", function () { doneDlg.close(); });

  $("mtDoneForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (!confirming) return;
    var save = $("mtDoneSave");
    save.disabled = true;
    try {
      await api("POST", "/api/maintenance/occurrences/" + confirming.occ.taskId + "/done", { note: $("mtDoneNote").value });
      doneDlg.close();
      await load("Confirmed actioned: " + confirming.item.title + ".");
      $("mtTitle").focus();
    } catch (err) {
      $("mtDoneError").textContent = err.message;
    } finally {
      save.disabled = false;
    }
  });

  load();
})();
