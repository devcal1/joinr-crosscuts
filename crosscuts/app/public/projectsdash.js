// The Projects dashboard under the Projects notes wall (/notes.html?dept=design; 0.2.0, Todd
// 2026-10-24; it was the separate Design/PM page, design.html). Shown only on dept=design and only
// to a user with design.view. Each tile is its link even if its numbers can't be fetched.
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
    document.getElementById("pjDash").hidden = false;

    // New from Joinr: how many quotes are waiting, and how many changed after a decision.
    var jStat = document.getElementById("joinrStat");
    get("/api/joinr/intake?state=new&countsOnly=1").then(function (data) {
      var c = data && data.counts;
      if (!c || typeof c.new !== "number") return;
      var n = document.createElement("strong");
      n.textContent = String(c.new);
      jStat.replaceChildren(n, document.createTextNode(" waiting for a person"));
      if (typeof c.changed === "number" && c.changed > 0) {
        var b = document.createElement("span");
        b.className = "hs-badge hs-badge-check";
        b.textContent = c.changed + " changed";
        jStat.append(document.createTextNode(" "), b);
      }
      jStat.hidden = false;
    });

    // Benchtops (docs/plans/m12-contracts.md section 9.4): drafts and unsent changes, and installs
    // in the next two weeks (orange, attend to this) of orders still needing sending.
    var sStat = document.getElementById("stoneStat");
    var soon = document.getElementById("stoneSoon");
    get("/api/stone/summary").then(function (s) {
      if (!s || typeof s.drafts !== "number" || typeof s.changed !== "number") return;
      var d = document.createElement("strong");
      d.textContent = String(s.drafts);
      var c = document.createElement("strong");
      c.textContent = String(s.changed);
      sStat.replaceChildren(d, document.createTextNode(s.drafts === 1 ? " draft · " : " drafts · "),
        c, document.createTextNode(" changed since sent"));
      sStat.hidden = false;
      if (typeof s.installsSoon === "number" && s.installsSoon > 0) {
        soon.textContent = s.installsSoon + (s.installsSoon === 1 ? " install" : " installs") + " in the next 2 weeks";
        soon.className = "pj-tile-stat pj-soon";
        soon.hidden = false;
      }
    });
  });
})();
