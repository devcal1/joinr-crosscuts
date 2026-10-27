// Needs install date (0.2.3, docs/plans/m24-contracts.md section 5), under the Scheduling notes wall
// (/notes.html?dept=scheduling), for board.edit: jobs with everything ordered and no promised
// install date, with the requested date and the latest ETA, and a Confirm install date dialog.
(function () {
  "use strict";
  if (new URLSearchParams(location.search).get("dept") !== "scheduling") return;
  if (!window.cc || !window.cc.ready) return;

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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
  var dlg = document.getElementById("niDlg");
  var current = null;

  function load() {
    var status = document.getElementById("niStatus");
    var table = document.querySelector(".ni-table");
    api("/api/install-dates/needed").then(function (d) {
      var rows = document.getElementById("niRows");
      rows.replaceChildren();
      d.jobs.forEach(function (j) {
        var tr = document.createElement("tr");
        var name = el("td");
        var a = el("a", null, j.name);
        a.href = "/job.html?id=" + j.id;
        name.append(a);
        if (j.clientName) name.append(el("span", "pj-sub", j.clientName));
        // 0.2.4: open issues raised from the shift page.
        if (j.openIssues) {
          var iss = el("a", "pj-issue", j.openIssues + (j.openIssues === 1 ? " open issue" : " open issues"));
          iss.href = "/job.html?id=" + j.id + "#issues";
          name.append(iss);
        }
        tr.append(name, el("td", null, j.requestedInstallDate ? day(j.requestedInstallDate) : "Not given"), el("td", null, j.latestEta ? day(j.latestEta) : "None given"));
        var btn = el("button", "hs-btn hs-btn-primary", "Confirm install date");
        btn.type = "button";
        btn.addEventListener("click", function () { open(j); });
        var td = el("td");
        td.append(btn);
        tr.append(td);
        rows.append(tr);
      });
      table.hidden = !d.jobs.length;
      status.textContent = d.jobs.length ? "" : "Every fully ordered job has an install date.";
    }).catch(function (e) {
      status.textContent = "The list could not be loaded: " + e.message;
    });
  }

  function open(j) {
    current = j;
    document.getElementById("niDlgJob").textContent = j.name + (j.requestedInstallDate ? " · requested " + day(j.requestedInstallDate) : "");
    document.getElementById("niDate").value = j.requestedInstallDate || "";
    document.getElementById("niDlgErr").textContent = "";
    dlg.showModal();
  }
  document.getElementById("niCancel").addEventListener("click", function () { dlg.close(); });
  document.getElementById("niForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var date = document.getElementById("niDate").value;
    if (!date) {
      document.getElementById("niDlgErr").textContent = "Choose a date.";
      return;
    }
    api("/api/job-records/" + current.id + "/confirm-install", { method: "POST", body: JSON.stringify({ date: date }) })
      .then(function () { dlg.close(); load(); })
      .catch(function (e) { document.getElementById("niDlgErr").textContent = e.message; });
  });

  window.cc.ready.then(function () {
    if (!window.cc.can("board.edit")) return;
    document.getElementById("needsInstall").hidden = false;
    load();
  });
})();
