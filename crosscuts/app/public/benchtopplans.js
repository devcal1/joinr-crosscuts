// The Benchtops page's list of benchtop plans (0.2.0, docs/plans/m21-benchtop-designer.md), shown
// under the stone orders on the list view only (no ?id or ?job). GET /api/benchtop-plans
// (design.view, as the page). Text goes in through textContent.
// 0.2.21 (Todd, 2026-11-16): job number, client and project manager columns; the job name links to
// the job's Benchtops section; Find a plan filters the list; New benchtop plan (jobs.edit) picks a
// job by type-ahead (GET /api/job-records?q=, jobs.view) and opens /benchtop.html?job=N. A job that
// already has a plan opens that plan (one plan per job); an archived job without a plan is not offered.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const q = new URLSearchParams(location.search);
  if (q.has("id") || q.has("job")) return;

  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function td(label, text, cls) {
    const n = node("td", cls, text);
    n.setAttribute("data-label", label);
    return n;
  }

  function fmt(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  }

  let plans = [];

  function planFor(jobId) {
    return plans.find((p) => String(p.jobId) === String(jobId));
  }

  function jobCell(p) {
    const cell = td("Job", null);
    const name = p.jobName + (p.archived ? " (archived)" : "");
    if (can("jobs.view")) {
      const a = node("a", "so-joblink", name);
      a.href = "/job.html?id=" + encodeURIComponent(p.jobId) + "#benchtops";
      cell.append(a);
    } else cell.append(node("span", "so-jobname", name));
    return cell;
  }

  function render() {
    const words = $("bpFind").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = plans.filter((p) => {
      const hay = [p.jobNumber, p.jobName, p.clientName, p.ownerName].filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    $("bpEmpty").textContent = plans.length ? "No benchtop plans match." : "No benchtop plans yet.";
    $("bpEmpty").hidden = shown.length > 0;
    $("bpWrap").hidden = shown.length === 0;
    $("bpRows").replaceChildren(...shown.map((p) => {
      const tr = document.createElement("tr");
      const a = node("a", "hs-btn hs-btn-primary", "Open");
      a.href = "/benchtop.html?plan=" + p.id;
      a.setAttribute("aria-label", "Open the benchtop plan for " + p.jobName);
      const open = td("", null, "so-c-open");
      open.append(a);
      tr.append(
        td("Job no.", p.jobNumber || "", "bp-jnum" + (p.jobNumber ? "" : " so-blank")),
        jobCell(p),
        td("Client", p.clientName || "", p.clientName ? "" : "so-blank"),
        td("Project manager", p.ownerName || "No owner"),
        td("Pieces", String(p.pieces)),
        td("Revision", p.revision ? "Rev " + p.revision : "Not printed"),
        td("Updated", fmt(p.updatedAt)),
        open
      );
      return tr;
    }));
  }

  // ---- New benchtop plan: pick a job ----
  function setupPicker() {
    if (!can("jobs.edit") || !can("jobs.view")) return;
    const btn = $("bpNew");
    const box = $("bpPick");
    const input = $("bpPickIn");
    const list = $("bpPickList");
    btn.hidden = false;
    let seq = 0;
    let hits = [];
    let active = -1;
    let timer = null;

    function closeList() {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      active = -1;
    }
    function openBox(on) {
      box.hidden = !on;
      btn.setAttribute("aria-expanded", on ? "true" : "false");
      closeList();
      if (on) {
        input.value = "";
        input.focus();
      } else btn.focus();
    }
    function mark() {
      [...list.children].forEach((li, i) => li.setAttribute("aria-selected", i === active ? "true" : "false"));
      if (active >= 0) {
        input.setAttribute("aria-activedescendant", "bpPick-" + active);
        list.children[active].scrollIntoView({ block: "nearest" });
      } else input.removeAttribute("aria-activedescendant");
    }
    function go(j) {
      if (!j) return;
      const p = planFor(j.id);
      location.href = p ? "/benchtop.html?plan=" + p.id : "/benchtop.html?job=" + encodeURIComponent(j.id);
    }
    function option(text, cls) {
      const li = node("li", cls, text);
      li.setAttribute("role", "option");
      return li;
    }
    async function search() {
      const text = input.value.trim();
      const mine = ++seq;
      if (!text) {
        closeList();
        return;
      }
      let res;
      try {
        res = await api("/api/job-records?q=" + encodeURIComponent(text));
      } catch (e) {
        res = [];
      }
      if (mine !== seq) return;
      hits = (Array.isArray(res) ? res : []).filter((j) => !j.archived || planFor(j.id)).slice(0, 10);
      active = hits.length ? 0 : -1;
      if (!hits.length) {
        const none = option("No jobs match.");
        none.setAttribute("aria-disabled", "true");
        list.replaceChildren(none);
      } else {
        list.replaceChildren(...hits.map((j, i) => {
          const li = option(null);
          li.id = "bpPick-" + i;
          li.setAttribute("aria-selected", "false");
          if (j.jobNumber) li.append(node("span", "bp-jno", j.jobNumber));
          li.append(node("span", "bp-jname", j.name));
          if (j.clientName) li.append(node("span", "bp-jclient", j.clientName));
          if (planFor(j.id)) li.append(node("span", "bp-has", "Has a plan"));
          li.addEventListener("mousedown", (ev) => {
            ev.preventDefault();
            go(j);
          });
          return li;
        }));
      }
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      mark();
    }

    btn.addEventListener("click", () => openBox(box.hidden));
    $("bpPickCancel").addEventListener("click", () => openBox(false));
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(search, 150);
    });
    input.addEventListener("blur", () => setTimeout(closeList, 100));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" && hits.length) {
        ev.preventDefault();
        active = (active + 1) % hits.length;
        mark();
      } else if (ev.key === "ArrowUp" && hits.length) {
        ev.preventDefault();
        active = (active - 1 + hits.length) % hits.length;
        mark();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (active >= 0) go(hits[active]);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        if (!list.hidden) closeList();
        else openBox(false);
      }
    });
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
    plans = r.plans || [];
    $("bpFind").addEventListener("input", render);
    setupPicker();
    render();
  })();
})();
