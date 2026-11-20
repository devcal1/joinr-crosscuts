// The Projects dashboard under the Projects notes wall (/notes.html?dept=design; 0.2.0, Todd
// 2026-10-24; it was the separate Design/PM page, design.html). Shown only on dept=design and only
// to a user with design.view. (The New from Joinr and Benchtops tiles went in 0.2.24; Intake is its own
// section, intake.js.)
(function () {
  "use strict";
  if (new URLSearchParams(location.search).get("dept") !== "design") return;
  if (!window.cc || !window.cc.ready) return;

  function get(url) {
    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; });
  }

  // My projects (0.2.2, docs/plans/m23-contracts.md section 8): one line per owned job. Text only.
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var STAGE = { won: "Won", projects: "Projects", ordering: "Ordering", ready_to_cut: "Ready to cut", on_board: "On board" };
  function day(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? Number(m[3]) + " " + MONTHS[Number(m[2]) - 1] + " " + m[1] : "";
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var showAll = false;
  function loadMine() {
    var status = document.getElementById("pjMineStatus");
    var table = document.querySelector("#pjMine .pj-mine");
    get("/api/my-projects" + (showAll ? "?all=1" : "")).then(function (d) {
      if (!d || !Array.isArray(d.jobs)) {
        status.textContent = "My projects could not be loaded.";
        table.hidden = true;
        return;
      }
      var allBtn = document.getElementById("pjMineAll");
      allBtn.hidden = !d.canAll;
      document.getElementById("pjMineH").textContent = d.all ? "All projects" : "My projects";
      document.querySelector("#pjMine .pj-mine-owner").hidden = !d.all;
      var rows = document.getElementById("pjMineRows");
      rows.replaceChildren();
      d.jobs.forEach(function (j) {
        var tr = document.createElement("tr");
        var name = el("td");
        var a = el("a", null, j.name);
        a.href = "/project.html?id=" + j.id;
        name.append(a, el("span", "pj-sub", (STAGE[j.pipelineStage] || j.pipelineStage) + (j.clientName ? " · " + j.clientName : "")));
        // 0.2.4: open issues raised from the shift page.
        if (j.openIssues) {
          var iss = el("a", "pj-issue", j.openIssues + (j.openIssues === 1 ? " open issue" : " open issues"));
          iss.href = "/job.html?id=" + j.id + "#issues";
          name.append(iss);
        }
        tr.append(name);
        if (d.all) tr.append(el("td", null, j.owner ? j.owner.name : ""));
        var marks = el("td");
        j.marks.forEach(function (m) {
          var s = el("span", "pj-mk" + (m.done ? " pj-mk-done" : ""), m.mark);
          s.title = m.label + (m.done ? ": done" : ": not yet");
          marks.append(s);
        });
        tr.append(marks);
        var req = el("td", null, j.requestedInstallDate ? day(j.requestedInstallDate) : "Not set");
        if (j.promisedInstallDate) req.append(el("span", "pj-sub", "Promised " + day(j.promisedInstallDate)));
        tr.append(req);
        tr.append(el("td", null, j.revision ? j.revision + (j.revisionChanged ? " (changed)" : "") : "None"));
        var o = j.ordering;
        var ord = el("td", null, o ? (o.total ? o.ordered + " of " + o.total + " ordered" : "No order lines") : "");
        if (o && o.latestEta) ord.append(el("span", "pj-sub", "Latest ETA " + day(o.latestEta)));
        tr.append(ord);
        var mine = j.pipelineStage === "won" || j.pipelineStage === "projects";
        tr.append(el("td", mine ? "pj-wait" : null, j.waitingOn));
        rows.append(tr);
      });
      table.hidden = !d.jobs.length;
      status.textContent = d.jobs.length ? "" : d.all ? "No owned jobs in progress." : "You own no jobs in progress.";
    });
  }

  window.cc.ready.then(function () {
    if (!window.cc.can("design.view")) return;
    document.getElementById("pjMine").hidden = false;
    document.getElementById("pjMineAll").addEventListener("click", function () {
      showAll = !showAll;
      this.setAttribute("aria-pressed", showAll ? "true" : "false");
      this.classList.toggle("hs-btn-primary", showAll);
      this.textContent = showAll ? "Show mine only" : "Show all owners";
      loadMine();
    });
    loadMine();
  });
})();
