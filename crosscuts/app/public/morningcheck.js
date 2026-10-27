// The Morning check (0.2.5, docs/plans/m26-contracts.md section 2), under the Scheduling notes wall
// (/notes.html?dept=scheduling), for board.edit: the previous working day's jobs with a production
// stage pick and a short note (each saved as it changes), then what needs attention (rows with
// nobody on them, Ready to cut jobs not placed, installs this week without a promised date, open
// job issues), and Done for today. Text only.
(function () {
  "use strict";
  if (new URLSearchParams(location.search).get("dept") !== "scheduling") return;
  if (!window.cc || !window.cc.ready) return;

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var PANEL = { installing: "Install", manufacturing: "Manufacturing" };
  function longDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return "";
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return DAYS[d.getUTCDay()] + " " + Number(m[3]) + " " + MONTHS[Number(m[2]) - 1];
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function link(href, text) {
    var a = el("a", null, text);
    a.href = href;
    return a;
  }
  var data = null;

  function save(j, stageSel, noteIn, msg) {
    msg.textContent = "Saving...";
    api("/api/morning-check/jobs/" + j.id, {
      method: "PUT",
      body: JSON.stringify({ date: data.date, stage: stageSel.value || null, note: noteIn.value }),
    })
      .then(function () { msg.textContent = "Saved"; })
      .catch(function (e) { msg.textContent = e.message; });
  }

  function row(j) {
    var tr = document.createElement("tr");
    var name = el("td");
    name.append(link("/job.html?id=" + j.id, j.name), el("span", "mc-sub", j.panels.map(function (p) { return PANEL[p] || p; }).join(" + ") + (j.clientName ? " · " + j.clientName : "")));
    tr.append(name, el("td", null, j.people.join(", ")));
    var sel = el("select", "hs-input");
    sel.setAttribute("aria-label", "Stage for " + j.name);
    sel.append(new Option("Not set", ""));
    j.stages.forEach(function (s) { sel.append(new Option(s.label, s.key)); });
    sel.value = j.dayStage || "";
    var stageTd = el("td");
    stageTd.append(sel);
    if (!j.dayStage && j.currentStage) {
      var cur = j.stages.filter(function (s) { return s.key === j.currentStage; })[0];
      if (cur) stageTd.append(el("span", "mc-sub", "Was " + cur.label));
    }
    var note = el("input", "hs-input");
    note.type = "text";
    note.maxLength = 300;
    note.value = j.note || "";
    note.setAttribute("aria-label", "Note for " + j.name);
    var msg = el("span", "mc-sub");
    msg.setAttribute("role", "status");
    sel.addEventListener("change", function () { save(j, sel, note, msg); });
    note.addEventListener("change", function () { save(j, sel, note, msg); });
    var noteTd = el("td");
    noteTd.append(note, msg);
    tr.append(stageTd, noteTd);
    return tr;
  }

  function group(title, items, render) {
    if (!items.length) return null;
    var box = el("div", "mc-group");
    box.append(el("h3", "mc-h3", title + " (" + items.length + ")"));
    var ul = el("ul", "mc-list");
    items.forEach(function (it) {
      var li = el("li");
      render(li, it);
      ul.append(li);
    });
    box.append(ul);
    return box;
  }

  function render() {
    var d = data;
    document.getElementById("mcH").textContent = "Morning check: " + longDay(d.date);
    var status = document.getElementById("mcStatus");
    var parts = [];
    if (d.done) parts.push((d.doneToday ? "Done today" : "Last done " + longDay(d.done.doneOn)) + (d.done.by && d.done.by.name ? " by " + d.done.by.name : "") + ".");
    if (!d.jobs.length) parts.push("Nobody was on the board that day.");
    status.textContent = parts.join(" ");
    var rows = document.getElementById("mcRows");
    rows.replaceChildren.apply(rows, d.jobs.map(row));
    document.querySelector(".mc-table").hidden = !d.jobs.length;
    var attend = document.getElementById("mcAttend");
    attend.replaceChildren();
    [
      group("Rows with nobody on them this week", d.emptyRows, function (li, r) {
        li.append(link("/schedule.html", r.name), el("span", "mc-sub", " " + (PANEL[r.panel] || r.panel)));
      }),
      group("Ready to cut, not on the board", d.readyNotPlaced, function (li, j) {
        li.append(link("/job.html?id=" + j.id, j.name), el("span", "mc-sub", j.clientName ? " " + j.clientName : ""));
      }),
      group("Installs this week with no promised date", d.installsNoPromised, function (li, j) {
        li.append(link("/job.html?id=" + j.id, j.name), el("span", "mc-sub", j.clientName ? " " + j.clientName : ""));
      }),
      group("Open job issues", d.openIssues, function (li, i) {
        li.append(link("/job.html?id=" + i.jobId + "#issues", i.jobName), el("span", "mc-issue", " " + i.body));
      }),
    ].forEach(function (g) { if (g) attend.append(g); });
    var btn = document.getElementById("mcDone");
    btn.textContent = d.doneToday ? "Done again" : "Done for today";
  }

  function load() {
    api("/api/morning-check")
      .then(function (d) {
        data = d;
        render();
        if (location.hash === "#morningCheck") document.getElementById("morningCheck").scrollIntoView({ block: "start" });
      })
      .catch(function (e) {
        document.getElementById("mcStatus").textContent = "The morning check could not be loaded: " + e.message;
      });
  }

  document.getElementById("mcDone").addEventListener("click", function () {
    var btn = document.getElementById("mcDone");
    btn.disabled = true;
    api("/api/morning-check/done", { method: "POST", body: JSON.stringify({ date: data ? data.date : undefined }) })
      .then(function () { load(); })
      .catch(function (e) { document.getElementById("mcStatus").textContent = e.message; })
      .then(function () { btn.disabled = false; });
  });

  window.cc.ready.then(function () {
    if (!window.cc.can("board.edit")) return;
    document.getElementById("morningCheck").hidden = false;
    load();
  });
})();
