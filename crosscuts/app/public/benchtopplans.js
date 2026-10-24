// The Benchtops page's list of benchtop plans (0.2.0, docs/plans/m21-benchtop-designer.md), shown
// under the stone orders on the list view only (no ?id or ?job). GET /api/benchtop-plans
// (design.view, as the page). Text goes in through textContent.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const q = new URLSearchParams(location.search);
  if (q.has("id") || q.has("job")) return;

  function td(text, cls) {
    const n = document.createElement("td");
    n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }

  function fmt(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  }

  (async () => {
    await (window.cc && window.cc.ready);
    let r;
    try {
      r = await api("/api/benchtop-plans");
    } catch (e) {
      return;
    }
    $("bpList").hidden = false;
    const plans = r.plans || [];
    $("bpEmpty").hidden = plans.length > 0;
    $("bpWrap").hidden = plans.length === 0;
    $("bpRows").replaceChildren(...plans.map((p) => {
      const tr = document.createElement("tr");
      const a = document.createElement("a");
      a.className = "hs-btn hs-btn-primary";
      a.href = "/benchtop.html?plan=" + p.id;
      a.textContent = "Open";
      a.setAttribute("aria-label", "Open the benchtop plan for " + p.jobName);
      const open = document.createElement("td");
      open.append(a);
      tr.append(td(p.jobName + (p.archived ? " (archived)" : "")), td(String(p.pieces)), td(p.revision ? "Rev " + p.revision : "Not printed"), td(fmt(p.updatedAt)), open);
      return tr;
    }));
  })();
})();
