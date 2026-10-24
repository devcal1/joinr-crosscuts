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

  window.cc.ready.then(function () {
    if (!window.cc.can("design.view")) return;
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
