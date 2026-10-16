// Job bonuses (/bonuses.html; docs/plans/m13-contracts.md sections 4 and 10.2). Gated by
// bonuses.manage (lib/pages.js), an owner-only key: the owner holds it, and only the owner grants it.
//
//   /bonuses.html#jobs        the bonus list, with a filter (#jobs:draft, #jobs:confirmed, #jobs:owed)
//   /bonuses.html#owed        earned, paid and owed per person; Mark all paid; Print
//   /bonuses.html#settings    the rate and the share points (the total is added up, never typed)
//   /bonuses.html?id=N        one job bonus: a draft to fill in and confirm, or a confirmed one to pay
//
// Every rule lives in lib/bonuses.js; this page only hides what can't be used and shows the
// server's sentences. A draft's figures are worked out here as the form changes (section 4.1, the
// same maths) so the effect of a tick shows before Save; what the server answers is what counts.
// Money is integer cents, hours are minutes in the API and hours (two decimals) on the page.
// Every value goes in through textContent. Dialogs are OrderUI.ui's (the shell's cc-dialog frame).
// M13 4.3 (contracts section 12.3): a draft's figures use the settings read again after Save, Fill
// from Joinr and Reopen and as Confirm opens (whose dialog says what is earned); a 409 draws the
// bonus again as the server has it, saying unsaved changes weren't kept; a refusal marks and
// focuses the input it is about; after each dialog focus goes to the status line or the heading.
// Classes are bo-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Section 4.1: the seven checks, equal weight, in this order.
  const CHECKS = [
    { key: "drawn", label: "Drawn (Mozaik)" },
    { key: "ordered", label: "Ordered" },
    { key: "assembled", label: "Assembled" },
    { key: "installed", label: "Installed" },
    { key: "noFuss", label: "No fuss" },
    { key: "onTime", label: "On time" },
    { key: "hours", label: "Hours" },
  ];
  // The four hours (section 4.4): API key, form key, label.
  const HOURS = [
    { key: "quotedFactoryMin", f: "qf", label: "Quoted factory hours" },
    { key: "quotedInstallMin", f: "qi", label: "Quoted install hours" },
    { key: "actualFactoryMin", f: "af", label: "Actual factory hours" },
    { key: "actualInstallMin", f: "ai", label: "Actual install hours" },
  ];
  const FILTERS = ["draft", "confirmed", "owed", "all"];
  const TABS = ["jobs", "owed", "settings"];
  const NOTE_MAX = 1000;
  const PRICE_MAX = 10000000000;
  const MIN_MAX = 600000;

  // ------------------------------------------------------------------ helpers ---

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
    return node;
  }

  function can(key) {
    return window.cc && typeof window.cc.can === "function" ? !!window.cc.can(key) : false;
  }

  const ui = () => window.OrderUI.ui;

  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  }

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  // $1,234.56 from whole cents (exact: no float division of the dollars).
  function money(cents) {
    if (cents == null || !Number.isFinite(cents)) return "–";
    const neg = cents < 0;
    const c = Math.abs(Math.round(cents));
    const dollars = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${neg ? "-" : ""}$${dollars}.${String(c % 100).padStart(2, "0")}`;
  }

  // A rate in basis points as a percent to two places: 150 -> "1.50%".
  function pct(bp) {
    if (bp == null) return "–";
    return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, "0")}%`;
  }

  // Minutes as hours to two decimals ("" for none).
  function hoursText(min) {
    return min == null ? "" : (min / 60).toFixed(2);
  }

  // A typed dollar amount as cents: "" -> null, not a sum -> NaN.
  function parseMoney(text) {
    const t = String(text || "").replace(/[$,\s]/g, "");
    if (!t) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
    const [d, c = ""] = t.split(".");
    const cents = Number(d) * 100 + Number((c + "00").slice(0, 2));
    return cents <= PRICE_MAX ? cents : NaN;
  }

  // Typed hours as minutes (any decimal, stored as round(hours x 60)): "" -> null, else NaN.
  function parseHours(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return NaN;
    const m = Math.round(Number(t) * 60);
    return m <= MIN_MAX ? m : NaN;
  }

  // A typed percent (two places at most) as basis points, else NaN.
  function parsePercent(text) {
    const t = String(text || "").replace(/[%\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
    const [w, f = ""] = t.split(".");
    const bp = Number(w) * 100 + Number((f + "00").slice(0, 2));
    return bp <= 10000 ? bp : NaN;
  }

  // Section 4.1's maths, for the live preview of a draft (lib/bonuses.js is the authority).
  function floorDiv(a, b) {
    let q = Math.floor(a / b);
    while (q * b > a) q -= 1;
    while ((q + 1) * b <= a) q += 1;
    return q;
  }
  const roundDiv = (n, d) => floorDiv(2 * n + d, 2 * d);

  function figures(priceCents, rateBp, ticked) {
    if (priceCents == null || !Number.isFinite(priceCents)) return { possibleCents: null, earnedCents: null, lostCents: null };
    const possibleCents = roundDiv(priceCents * rateBp, 10000);
    const earnedCents = roundDiv(priceCents * rateBp * ticked, 70000);
    return { possibleCents, earnedCents, lostCents: possibleCents - earnedCents };
  }

  // Shares above 0 cents, in the settings' order; the leftover cents go to the largest remainders
  // (ties: more points, the settings' order, the lower person id).
  function splitShares(earnedCents, holders) {
    const live = holders
      .map((h, order) => ({ personId: h.personId, name: h.name, points: h.points, order }))
      .filter((h) => h.points > 0);
    const total = live.reduce((s, h) => s + h.points, 0);
    if (!total || !(earnedCents > 0)) return [];
    let given = 0;
    for (const h of live) {
      const n = earnedCents * h.points;
      h.shareCents = floorDiv(n, total);
      h.rem = n - h.shareCents * total;
      given += h.shareCents;
    }
    const ranked = [...live].sort((a, b) => b.rem - a.rem || b.points - a.points || a.order - b.order || a.personId - b.personId);
    for (let i = 0; i < earnedCents - given; i += 1) ranked[i].shareCents += 1;
    return live.filter((h) => h.shareCents > 0);
  }

  // A request as shared.js api() makes it (the same 401 handling), keeping the answer's status: a
  // network failure becomes a sentence; an answer from the server is marked `refused` (so a dialog
  // closed after it reloads what it showed) and carries `status`, so a 409 (the bonus changed
  // elsewhere) can reload the page rather than leave a stale draft (section 12.3, B-m1).
  async function send(path, options) {
    let res;
    try {
      res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options && options.headers) } });
    } catch (e) {
      throw new Error("Couldn't reach the server. Try again.");
    }
    if (res.status === 401 && !location.pathname.startsWith("/login.html")) {
      const body = await res.json().catch(() => ({}));
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = (body.locked ? "/login.html?locked=1&next=" : "/login.html?next=") + next;
      return new Promise(() => {}); // the page is navigating away
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const e = new Error(body.error || `Request failed (${res.status})`);
      e.refused = true;
      e.status = res.status;
      throw e;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // An input a refusal on the page's own forms is about: marked invalid until changed, and
  // focused (the dialogs do the same through OrderUI's error.field).
  function markInput(n) {
    if (!n) return;
    n.setAttribute("aria-invalid", "true");
    const off = () => {
      n.removeAttribute("aria-invalid");
      n.removeEventListener("input", off);
      n.removeEventListener("change", off);
    };
    n.addEventListener("input", off);
    n.addEventListener("change", off);
    n.focus();
  }

  function unmarkIn(box) {
    if (box) for (const n of box.querySelectorAll("[aria-invalid]")) n.removeAttribute("aria-invalid");
  }

  // "Sentence." with one full stop.
  const stop = (s) => String(s || "").replace(/[.!?]?$/, ".");

  const post = (path, body) => send(path, { method: "POST", body: JSON.stringify(body || {}) });

  function failText(e, what) {
    if (e instanceof TypeError) return "Couldn't reach the server. Reload to try again.";
    const m = (e && e.message) || "";
    if (/not found/i.test(m)) return `There is no ${what}.`;
    if (/forbidden|permission|access|not allowed/i.test(m)) return `You don't have access to ${what}.`;
    return m || "That didn't load. Reload to try again.";
  }

  function setStatus(msg, kind) {
    const s = $("boStatus");
    s.textContent = msg || "";
    s.className = "bo-status" + (kind ? ` bo-status-${kind}` : "");
  }

  // A job's name: a link to the job page only with jobs.view (section 10).
  function jobName(job, cls) {
    const name = job.name || `Job ${job.id}`;
    if (can("jobs.view")) return el("a", { class: cls || "bo-joblink", href: `/job.html?id=${encodeURIComponent(job.id)}`, text: name });
    return el("span", { class: cls ? `${cls} bo-strong` : "bo-strong", text: name });
  }

  function personLabel(p) {
    if (!p) return "–";
    const name = p.name || `Person ${p.personId}`;
    return p.archived ? `${name} (left)` : name;
  }

  // "6 Oct 2026 to 19 Oct 2026" for a pay run.
  function payRunLabel(r) {
    if (!r) return "";
    return r.endDate ? `${fmtDate(r.startDate)} to ${fmtDate(r.endDate)}` : `from ${fmtDate(r.startDate)}`;
  }

  // Pay runs for the Mark paid pickers (the summary's payRuns, newest first), read once.
  let payRunsCache = null;
  async function payRuns() {
    if (!payRunsCache) payRunsCache = (await send("/api/bonuses/summary")).payRuns || [];
    return payRunsCache;
  }

  function payRunSelect(runs) {
    const s = el("select", { class: "hs-input" }, el("option", { value: "", text: "None" }));
    for (const r of runs) s.append(el("option", { value: String(r.id), text: `Pay run ${payRunLabel(r)}` }));
    return s;
  }

  // ------------------------------------------------------------- the tabs ---

  let tab = "jobs";
  let filter = "all";

  function parseHash() {
    const m = /^#(jobs|owed|settings)(?::(draft|confirmed|owed|all))?$/.exec(location.hash);
    return { tab: m ? m[1] : "jobs", filter: m && m[2] ? m[2] : "all" };
  }

  function readHash() {
    ({ tab, filter } = parseHash());
  }

  // Leaving the Settings tab with changes not saved asks first (a 4.2 nit). Resolves true to go on.
  async function mayLeaveSettings(next) {
    if (tab !== "settings" || next === "settings" || !settingsDirty()) return true;
    const r = await ui().dialog({
      title: "Leave the settings?",
      note: "Your changes to the rate or the share points aren't saved. Leave without saving them?",
      submit: "Leave without saving",
      cancel: "Keep editing",
      focus: "cancel",
      run: () => ({ ok: true }),
    });
    return !!(r && r.ok);
  }

  async function switchTab(name, focus) {
    if (!(await mayLeaveSettings(name))) return;
    showTab(name, focus);
  }

  function writeHash() {
    const h = tab === "jobs" && filter !== "all" ? `#jobs:${filter}` : `#${tab}`;
    if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
  }

  function showTab(name, focus) {
    tab = TABS.includes(name) ? name : "jobs";
    writeHash();
    for (const b of document.querySelectorAll(".bo-tab")) {
      const on = b.dataset.tab === tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    $("boJobs").hidden = tab !== "jobs";
    $("boOwed").hidden = tab !== "owed";
    $("boSettings").hidden = tab !== "settings";
    setStatus("Loading...");
    const load = tab === "jobs" ? loadJobs : tab === "owed" ? loadOwed : loadSettings;
    load()
      .then(() => {
        if (notice) setStatus(notice, "ok");
        notice = null;
      })
      .catch((e) => setStatus(failText(e, "bonus list"), "err"));
  }

  // A sentence to show once the list has loaded ("Deleted." after a bonus is deleted).
  let notice = null;

  function wireTabs() {
    const tabs = [...document.querySelectorAll(".bo-tab")];
    for (const b of tabs) {
      b.addEventListener("click", () => switchTab(b.dataset.tab));
      // Arrow keys move between the tabs (the tablist pattern); Tab goes into the panel.
      b.addEventListener("keydown", (e) => {
        const i = tabs.indexOf(b);
        let j = -1;
        if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
        else if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") j = 0;
        else if (e.key === "End") j = tabs.length - 1;
        if (j < 0) return;
        e.preventDefault();
        switchTab(tabs[j].dataset.tab, true);
      });
    }
    $("boFilter").addEventListener("change", () => {
      filter = FILTERS.includes($("boFilter").value) ? $("boFilter").value : "all";
      writeHash();
      loadJobs().catch((e) => setStatus(failText(e, "bonus list"), "err"));
    });
    $("boNew").addEventListener("click", newBonus);
    window.addEventListener("hashchange", async () => {
      const next = parseHash();
      if (!(await mayLeaveSettings(next.tab))) {
        writeHash(); // stay on #settings
        return;
      }
      ({ tab, filter } = next);
      $("boFilter").value = filter;
      showTab(tab);
    });
  }

  // ------------------------------------------------------------------ Jobs ---

  function cell(label, cls, ...kids) {
    return el("td", { class: cls || null, "data-label": label }, ...kids);
  }

  async function loadJobs() {
    $("boFilter").value = filter;
    const r = await send(`/api/bonuses?status=${encodeURIComponent(filter)}`);
    const rows = $("boJobRows");
    rows.replaceChildren();
    const list = r.bonuses || [];
    const words = { draft: "No draft bonuses.", confirmed: "No confirmed bonuses.", owed: "Nothing is owed.", all: "No bonuses yet." };
    $("boJobsEmpty").textContent = list.length ? "" : `${words[filter]} Start one with New bonus.`;
    $("boJobsEmpty").hidden = list.length > 0;
    $("boJobsWrap").hidden = list.length === 0;
    for (const b of list) {
      const confirmed = b.status === "confirmed";
      rows.append(
        el(
          "tr",
          {},
          cell("Job", "bo-c-job", jobName(b.job), b.job.archived ? el("span", { class: "bo-note", text: "Archived job" }) : null),
          cell("Status", "bo-c-status", statusBadge(b), confirmed ? el("span", { class: "bo-note", text: fmtDate(b.confirmedDate) }) : null),
          cell("Price", "bo-c-money", money(b.priceCents)),
          cell("Ticked", "bo-c-ticked", `${b.ticked} of 7`),
          cell("Earned", "bo-c-money", money(b.earnedCents)),
          cell("Lost", "bo-c-money", money(b.lostCents)),
          cell("Owed", "bo-c-money" + (b.owedCents > 0 ? " bo-attend" : ""), confirmed ? money(b.owedCents) : "–"),
          cell("", "bo-c-open", el("a", { class: "hs-btn", href: `bonuses.html?id=${encodeURIComponent(b.id)}`, text: "Open", "aria-label": `Open the bonus for ${b.job.name}` }))
        )
      );
    }
    setStatus("");
  }

  function statusBadge(b) {
    if (b.status === "confirmed") return el("span", { class: "hs-badge hs-badge-teal", text: "Confirmed" });
    return el("span", { class: "hs-badge hs-badge-na", text: "Draft" });
  }

  // New bonus: a job search (jobs that already have a bonus are shown but can't be chosen), then
  // POST and open it.
  async function newBonus() {
    const search = el("input", { class: "hs-input", type: "search", autocomplete: "off", maxlength: "100", placeholder: "Part of the job's name" });
    const listId = "bo-jobpick-" + Math.random().toString(36).slice(2, 8);
    const results = el("div", { class: "bo-jobpick ou-wide", id: listId, role: "radiogroup", "aria-label": "Jobs" });
    const msg = el("p", { class: "bo-hint bo-jobpick-msg ou-wide", role: "status", text: "Loading..." });
    let seq = 0;
    let timer = null;

    async function find() {
      const mine = ++seq;
      msg.textContent = "Loading...";
      let r;
      try {
        r = await send(`/api/bonuses/jobs?q=${encodeURIComponent(search.value.trim())}`);
      } catch (e) {
        if (mine === seq) msg.textContent = e.message;
        return;
      }
      if (mine !== seq) return;
      results.replaceChildren();
      const jobs = r.jobs || [];
      msg.textContent = jobs.length ? (jobs.length === 50 ? "The first 50 matches. Type more of the name to narrow it." : "") : "No job matches.";
      for (const j of jobs) {
        const radio = el("input", { type: "radio", name: listId, value: String(j.id), disabled: j.hasBonus, "data-has-bonus": j.hasBonus ? "1" : null });
        const bits = [j.stage ? String(j.stage).replace(/_/g, " ") : "", j.archived ? "archived" : "", j.hasBonus ? "has a bonus" : ""].filter(Boolean);
        results.append(
          el("label", { class: "bo-jobopt" + (j.hasBonus ? " bo-jobopt-off" : "") },
            radio,
            el("span", { class: "bo-jobopt-name", text: j.name }),
            bits.length ? el("span", { class: "bo-jobopt-meta", text: bits.join(" · ") }) : null)
        );
      }
    }
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(find, 250);
    });
    // Enter in the search box searches now rather than submitting the dialog.
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(timer);
        find();
      }
    });
    find();

    const created = await ui().dialog({
      title: "New bonus",
      note: "Choose the job. The price comes from the job's value and the quoted hours from its Joinr quote, where there are any.",
      fields: [ui().field("Find a job", search, { wide: true }), results, msg],
      submit: "Create bonus",
      focus: search,
      wide: true,
      // Jobs that already have a bonus stay unchoosable after a refusal (section 12.3, B-m2).
      keepDisabled: true,
      run: async () => {
        const chosen = results.querySelector("input:checked");
        if (!chosen) throw ui().fail("Choose a job first.", results);
        // (every control is off while sending, so the job's own mark tells, not `disabled`)
        if (chosen.dataset.hasBonus === "1") throw ui().fail("That job already has a bonus. Choose another.", results);
        try {
          return await post("/api/bonuses", { jobId: Number(chosen.value) });
        } catch (e) {
          // The list may be behind (a bonus made elsewhere): search again, so it shows as it is.
          if (e.refused) find();
          throw e;
        }
      },
    });
    clearTimeout(timer);
    if (created && created.id) location.href = `bonuses.html?id=${encodeURIComponent(created.id)}`;
  }

  // ------------------------------------------------------------------ Owed ---

  async function loadOwed() {
    const s = await send("/api/bonuses/summary");
    payRunsCache = s.payRuns || [];
    const people = s.people || [];
    const body = $("boOwedRows");
    body.replaceChildren();
    $("boOwedFoot").replaceChildren();
    $("boOwedEmpty").textContent = people.length ? "" : "No confirmed bonuses yet, so nobody has earned a share.";
    $("boOwedEmpty").hidden = people.length > 0;
    $("boOwedWrap").hidden = people.length === 0;
    for (const p of people) {
      body.append(
        el("tr", {},
          cell("Person", "bo-c-person", el("span", { class: "bo-strong", text: personLabel(p) })),
          cell("Earned", "bo-c-money", money(p.earnedCents)),
          cell("Paid", "bo-c-money", money(p.paidCents)),
          cell("Owed", "bo-c-money" + (p.owedCents > 0 ? " bo-attend" : ""), money(p.owedCents)))
      );
    }
    if (people.length) {
      $("boOwedFoot").append(
        el("tr", { class: "bo-total-row" },
          cell("", "bo-c-person", el("span", { class: "hs-label", text: "Total" })),
          cell("Earned", "bo-c-money", money(s.totals.earnedCents)),
          cell("Paid", "bo-c-money", money(s.totals.paidCents)),
          cell("Owed", "bo-c-money", money(s.totals.owedCents)))
      );
    }

    const box = $("boOwedPeople");
    box.replaceChildren();
    for (const p of people.filter((x) => x.owedCents > 0)) {
      const lines = el("tbody");
      for (const o of p.owed) {
        lines.append(
          el("tr", {},
            cell("Job", "bo-c-job", jobName({ id: o.jobId, name: o.jobName })),
            cell("Confirmed", "bo-c-date", fmtDate(o.confirmedDate)),
            cell("Share", "bo-c-money", money(o.shareCents)),
            cell("", "bo-c-open", el("a", { class: "hs-btn", href: `bonuses.html?id=${encodeURIComponent(o.bonusId)}`, text: "Open", "aria-label": `Open the bonus for ${o.jobName}` })))
        );
      }
      const pay = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Mark all paid", "aria-label": `Mark all paid for ${p.name}` });
      pay.addEventListener("click", () => markAllPaid(p));
      box.append(
        el("section", { class: "bo-card bo-owedcard", "aria-label": `Owed to ${p.name}` },
          el("div", { class: "bo-owedhead" },
            el("h2", { class: "bo-h2 bo-h2-inline", text: personLabel(p) }),
            el("span", { class: "bo-owedsum", text: `Owed ${money(p.owedCents)}` }),
            pay),
          el("div", { class: "bo-wrap bo-wrap-inner" },
            el("table", { class: "bo-table bo-table-lines" },
              el("thead", {}, el("tr", {},
                el("th", { scope: "col", class: "bo-c-job", text: "Job" }),
                el("th", { scope: "col", class: "bo-c-date", text: "Confirmed" }),
                el("th", { scope: "col", class: "bo-c-money", text: "Share" }),
                el("th", { scope: "col", class: "bo-c-open" }, el("span", { class: "bo-sr", text: "Open" })))),
              lines)))
      );
    }
    setStatus("");
  }

  // Mark all paid: every share owed to the person, guarded by the list shown (section 4.4).
  async function markAllPaid(p) {
    const runs = payRunsCache || (await payRuns().catch(() => []));
    const latest = p.owed.reduce((d, o) => (o.confirmedDate > d ? o.confirmedDate : d), "");
    const date = ui().dateInput(todayISO(), latest, todayISO());
    const run = payRunSelect(runs);
    const n = p.owed.length;
    const r = await ui().dialog({
      title: "Mark all paid",
      note: `Mark ${n} owed ${n === 1 ? "share" : "shares"} paid to ${p.name}: ${money(p.owedCents)} in all.`,
      fields: [ui().field("Date paid", date), ui().field("Pay run (optional)", run, { hint: "Only a note of which finalised pay run it went in; bonuses don't change a pay run." })],
      submit: "Mark paid",
      focus: date,
      run: async () => {
        if (!date.value) throw ui().fail("Enter the date paid.", date);
        const body = { bonusIds: p.owed.map((o) => o.bonusId), paidDate: date.value };
        if (run.value) body.payRunId = Number(run.value);
        try {
          return await post(`/api/bonuses/people/${encodeURIComponent(p.personId)}/paid`, body);
        } catch (e) {
          e.field = paidField(e.message, date, run);
          throw e;
        }
      },
    });
    if (r) {
      await loadOwed().catch((e) => setStatus(failText(e, "summary"), "err"));
      if (r.refused) setStatus("The owed list was reloaded as it is now.");
      else setStatus(`Marked ${p.name}'s shares paid.`, "ok");
      focusTitle(); // the list was drawn again: focus goes to the heading, by the status line
    }
  }

  // The Mark paid input a server sentence is about (section 12.3, B-m6): the date or the pay run
  // ("Choose a finalised pay run", "No such pay run").
  function paidField(m, date, run) {
    if (/paid date/i.test(m)) return date;
    if (/pay run/i.test(m)) return run;
    return null;
  }

  function focusTitle() {
    $("boTitle").focus();
  }

  // -------------------------------------------------------------- Settings ---

  let people = []; // GET /api/bonuses/people: current pay list people
  let holders = []; // the settings form: [{value, name, archived, points (text)}]

  // A person's select value: "p:<pay_people id>", or "w:<worker id>" for a worker with no row yet.
  const personValue = (p) => (p.id != null ? `p:${p.id}` : `w:${p.workerId}`);

  function personRef(value) {
    const m = /^([pw]):(\d+)$/.exec(value || "");
    if (!m) return null;
    return m[1] === "p" ? { personId: Number(m[2]) } : { workerId: Number(m[2]) };
  }

  // A select of the pay list, with `extra` (a person already set who has left) kept as an option.
  function personSelect(value, extra, blankLabel) {
    const s = el("select", { class: "hs-input" });
    if (blankLabel) s.append(el("option", { value: "", text: blankLabel }));
    const values = new Set();
    for (const p of people) {
      values.add(personValue(p));
      s.append(el("option", { value: personValue(p), text: p.name }));
    }
    if (extra && !values.has(extra.value)) s.append(el("option", { value: extra.value, text: `${extra.name || "Unknown"} (left)` }));
    s.value = value || "";
    return s;
  }

  async function loadPeople() {
    people = (await send("/api/bonuses/people")).people || [];
  }

  async function loadSettings() {
    const [s] = await Promise.all([send("/api/bonuses/settings"), loadPeople()]);
    fillSettings(s);
    setStatus("");
  }

  function fillSettings(s) {
    $("boRate").value = pct(s.rateBp).replace("%", "");
    holders = s.holders.map((h) => ({ value: `p:${h.personId}`, name: h.name, archived: h.archived, points: String(h.points) }));
    unmarkIn($("boSettings"));
    $("boSettingsMsg").textContent = ""; // a sentence about the form before it was filled again
    $("boSettingsMsg").className = "bo-msg";
    renderHolders();
    settingsSaved = settingsNow();
  }

  // The settings form as text, to tell whether it has changes not saved.
  let settingsSaved = null;
  function settingsNow() {
    return JSON.stringify([$("boRate").value.trim(), holders.map((h) => [h.value, h.points.trim()])]);
  }
  function settingsDirty() {
    return settingsSaved !== null && !$("boSettings").hidden && settingsNow() !== settingsSaved;
  }

  function holderTotal() {
    let total = 0;
    let bad = false;
    for (const h of holders) {
      const t = h.points.trim();
      if (/^\d+$/.test(t) && Number(t) <= 1000) total += Number(t);
      else bad = true;
    }
    return { total, bad };
  }

  function renderTotal() {
    const { total, bad } = holderTotal();
    $("boTotal").textContent = `Share total: ${total} ${total === 1 ? "point" : "points"}${bad ? " (some points aren't whole numbers from 0 to 1000)" : ""}`;
    $("boTotal").classList.toggle("bo-attend", bad);
  }

  function renderHolders(focus) {
    const list = $("boHolders");
    list.replaceChildren();
    $("boHoldersEmpty").hidden = holders.length > 0;
    holders.forEach((h, i) => {
      const sel = personSelect(h.value, h.archived || !people.some((p) => personValue(p) === h.value) ? { value: h.value, name: h.name } : null, h.value ? null : "Choose a person");
      sel.setAttribute("aria-label", `Person ${i + 1}`);
      sel.addEventListener("change", () => {
        h.value = sel.value;
        const p = people.find((x) => personValue(x) === sel.value);
        if (p) {
          h.name = p.name;
          h.archived = false;
        }
      });
      const pts = el("input", { class: "hs-input bo-points", type: "text", inputmode: "numeric", autocomplete: "off", maxlength: "4", "aria-label": `Points for person ${i + 1}` });
      pts.value = h.points;
      pts.addEventListener("input", () => {
        h.points = pts.value;
        renderTotal();
      });
      const up = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Up", disabled: i === 0, "aria-label": `Move person ${i + 1} up` });
      const down = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Down", disabled: i === holders.length - 1, "aria-label": `Move person ${i + 1} down` });
      const remove = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Remove", "aria-label": `Remove person ${i + 1}` });
      const move = (d, which) => {
        const [x] = holders.splice(i, 1);
        holders.splice(i + d, 0, x);
        renderHolders({ index: i + d, which });
      };
      up.addEventListener("click", () => move(-1, "up"));
      down.addEventListener("click", () => move(1, "down"));
      remove.addEventListener("click", () => {
        holders.splice(i, 1);
        renderHolders({ index: Math.min(i, holders.length - 1), which: "select" });
      });
      const li = el("li", { class: "bo-holder" },
        el("span", { class: "bo-holder-n", "aria-hidden": "true", text: String(i + 1) }),
        el("div", { class: "bo-holder-person" }, sel),
        el("div", { class: "bo-holder-points" }, pts, el("span", { class: "bo-hint", "aria-hidden": "true", text: "points" })),
        el("div", { class: "bo-holder-moves" }, up, down, remove));
      list.append(li);
      if (focus && focus.index === i) {
        const target = focus.which === "up" ? (up.disabled ? down : up) : focus.which === "down" ? (down.disabled ? up : down) : sel;
        setTimeout(() => target.focus(), 0);
      }
    });
    if (focus && !holders.length) setTimeout(() => $("boAddHolder").focus(), 0);
    renderTotal();
  }

  function wireSettings() {
    $("boAddHolder").addEventListener("click", () => {
      const used = new Set(holders.map((h) => h.value));
      const next = people.find((p) => !used.has(personValue(p)));
      holders.push({ value: next ? personValue(next) : "", name: next ? next.name : "", archived: false, points: "1" });
      renderHolders({ index: holders.length - 1, which: "select" });
    });
    $("boSettings").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("boSettingsMsg");
      const say = (text, kind) => {
        msg.textContent = text;
        msg.className = "bo-msg" + (kind ? ` bo-msg-${kind}` : "");
      };
      unmarkIn($("boSettings"));
      // A refusal names its input: it is marked and focused (section 12.3, B-m6).
      const line = (i) => $("boHolders").children[i];
      const rateBp = parsePercent($("boRate").value);
      if (!Number.isFinite(rateBp)) {
        say("The bonus rate must be a percent from 0 to 100, with two decimal places at most.", "err");
        markInput($("boRate"));
        return;
      }
      const out = [];
      for (const [i, h] of holders.entries()) {
        const ref = personRef(h.value);
        if (!ref) {
          say(`Choose a person for line ${i + 1}, or remove it.`, "err");
          markInput(line(i) && line(i).querySelector("select"));
          return;
        }
        const t = h.points.trim();
        if (!/^\d+$/.test(t) || Number(t) > 1000) {
          say("Share points must be whole numbers from 0 to 1000.", "err");
          markInput(line(i) && line(i).querySelector("input"));
          return;
        }
        out.push({ ...ref, points: Number(t) });
      }
      const btn = $("boSettingsSave");
      btn.disabled = true;
      say("Saving...");
      let named = null;
      try {
        const s = await send("/api/bonuses/settings", { method: "PUT", body: JSON.stringify({ rateBp, holders: out }) });
        await loadPeople().catch(() => {});
        fillSettings(s);
        say("Saved. Drafts follow the new rate and points; confirmed bonuses keep theirs.", "ok");
      } catch (err) {
        say(err.message, "err");
        if (/bonus rate/i.test(err.message)) named = $("boRate");
        else {
          // "<name> is listed twice": the second line with that name.
          const twice = /^(.*) is listed twice/.exec(err.message);
          const at = twice ? holders.map((h, i) => (h.name === twice[1] ? i : -1)).filter((i) => i >= 0)[1] : undefined;
          if (at !== undefined && line(at)) named = line(at).querySelector("select");
        }
      } finally {
        btn.disabled = false;
        if (named) markInput(named);
        else msg.focus();
      }
    });
  }

  // ------------------------------------------------------------ one bonus ---

  let bonus = null; // the server's bonus object (section 4.3)
  let form = null; // the draft form's values (text, as typed)
  let live = null; // the settings, for a draft's live shares
  let jobValue = null; // the job's value (cents), for the price note; null when unknown
  let view = null; // the bonus view's live nodes

  function formFrom(b) {
    const f = {
      price: b.priceCents == null ? "" : (b.priceCents / 100).toFixed(2),
      ranBy: b.ranBy ? `p:${b.ranBy.personId}` : "",
      checkedBy: b.checkedBy ? `p:${b.checkedBy.personId}` : "",
      checks: {},
      // The Hours check's hand value: null while it follows the suggestion.
      hoursHand: b.hoursCheck.setByHand ? b.checks.hours : null,
      note: b.note || "",
    };
    for (const h of HOURS) f[h.f] = hoursText(b.hours[h.key]);
    for (const c of CHECKS) if (c.key !== "hours") f.checks[c.key] = !!b.checks[c.key];
    return f;
  }

  // The hours as minutes (null for empty, NaN for not a number).
  function formMinutes() {
    const out = {};
    for (const h of HOURS) out[h.key] = parseHours(form[h.f]);
    return out;
  }

  function suggestionOf(mins) {
    const v = HOURS.map((h) => mins[h.key]);
    if (v.some((x) => x == null || !Number.isFinite(x))) return null;
    return mins.actualFactoryMin + mins.actualInstallMin <= mins.quotedFactoryMin + mins.quotedInstallMin;
  }

  // The PATCH body for what changed, or {error} for a value that can't be sent.
  function changes() {
    const b = bonus;
    const body = {};
    const price = parseMoney(form.price);
    if (Number.isNaN(price)) return { error: "The price must be dollars and cents, for example 30000.00.", field: "price" };
    if (price !== b.priceCents) body.priceCents = price;
    for (const k of ["ranBy", "checkedBy"]) {
      const was = b[k] ? `p:${b[k].personId}` : "";
      if (form[k] !== was) body[k] = form[k] ? personRef(form[k]) : null;
    }
    const mins = formMinutes();
    for (const h of HOURS) {
      if (Number.isNaN(mins[h.key])) return { error: `${h.label} must be a number of hours from 0 to 10000.`, field: h.f };
      if (mins[h.key] !== b.hours[h.key]) body[h.key] = mins[h.key];
    }
    const checks = {};
    for (const c of CHECKS) {
      if (c.key === "hours") continue;
      if (form.checks[c.key] !== !!b.checks[c.key]) checks[c.key] = form.checks[c.key];
    }
    const hoursWas = b.hoursCheck.setByHand ? b.checks.hours : null;
    if (form.hoursHand !== hoursWas) checks.hours = form.hoursHand;
    if (Object.keys(checks).length) body.checks = checks;
    const note = form.note.trim();
    if (note.length > NOTE_MAX) return { error: `Note must be ${NOTE_MAX} characters or fewer.`, field: "note" };
    if (note !== (b.note || "")) body.note = note;
    return { body };
  }

  function dirty() {
    if (!bonus || bonus.status !== "draft" || !form) return false;
    const c = changes();
    return !!c.error || Object.keys(c.body).length > 0;
  }

  // The bonus form's input a server sentence is about (section 4.4's labels), as a form key.
  function formFieldFor(m) {
    if (/^The price/i.test(m)) return "price";
    for (const h of HOURS) if (m.startsWith(h.label)) return h.f;
    if (/^Ran by/i.test(m)) return "ranBy";
    if (/^Checked by/i.test(m)) return "checkedBy";
    if (/^Note/i.test(m)) return "note";
    return null;
  }

  window.addEventListener("beforeunload", (e) => {
    if (dirty() || settingsDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  async function loadBonus(id) {
    const [b] = await Promise.all([send(`/api/bonuses/${encodeURIComponent(id)}`), loadPeople()]);
    bonus = b;
    live = b.status === "draft" ? await send("/api/bonuses/settings") : null;
    jobValue = null;
    if (can("jobs.view") && can("jobs.value")) {
      try {
        const job = await api(`/api/job-records/${encodeURIComponent(b.job.id)}`);
        jobValue = job && Number.isFinite(job.valueCents) ? job.valueCents : null;
      } catch (e) {
        jobValue = null; // the note is only a help; leave it out
      }
    }
    form = formFrom(b);
    renderBonus();
    setStatus("");
  }

  // Replace the bonus from a server answer; `keepForm` keeps what's typed except the given keys.
  function applyBonus(b, refill) {
    bonus = b;
    if (refill === "all" || b.status !== "draft") form = formFrom(b);
    else if (Array.isArray(refill)) {
      const fresh = formFrom(b);
      for (const k of refill) form[k] = fresh[k];
    }
    renderBonus();
  }

  // A labelled field. `o.control` is what's shown when the input sits inside a wrapper (the price's
  // "$"); `o.note` is a hint line the input is described by.
  function field(label, input, opts) {
    const o = opts || {};
    const id = "bo-f-" + Math.random().toString(36).slice(2, 8);
    input.id = id;
    const box = el("div", { class: "bo-field" + (o.wide ? " bo-wide" : "") }, el("label", { class: o.srLabel ? "bo-sr" : "hs-label bo-flabel", for: id, text: label }), o.control || input);
    if (o.note) {
      o.note.id = id + "-n";
      input.setAttribute("aria-describedby", o.note.id);
      box.append(o.note);
    }
    return box;
  }

  function renderBonus() {
    const b = bonus;
    const draft = b.status === "draft";
    const sec = $("boBonus");
    sec.replaceChildren();
    $("boTitle").textContent = b.job.name ? `Bonus: ${b.job.name}` : "Bonus";
    document.title = `Bonus: ${b.job.name || ""} - Crosscuts`;
    const actions = $("boHeadActions");
    actions.replaceChildren(el("a", { class: "hs-btn", href: "bonuses.html#jobs", text: "All bonuses" }));

    // The job, the status and who confirmed it.
    const meta = el("div", { class: "bo-meta" },
      el("p", { class: "bo-meta-line" },
        el("span", { class: "hs-label", text: "Job" }), jobName(b.job),
        b.job.archived ? el("span", { class: "bo-note", text: "Archived job" }) : null),
      el("p", { class: "bo-meta-line" },
        el("span", { class: "hs-label", text: "Status" }), statusBadge(b),
        b.confirmed ? el("span", { class: "bo-note", text: `Confirmed ${fmtDate(b.confirmedDate)}${b.confirmed.by ? ` by ${b.confirmed.by.name}` : ""}` }) : null));
    sec.append(meta);

    const f = el("form", { class: "bo-form", novalidate: true, autocomplete: "off" });
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      if (draft) save();
    });
    view = {};

    // ---- price and people
    const price = el("input", { class: "hs-input", type: "text", inputmode: "decimal", maxlength: "16", disabled: !draft });
    price.value = draft ? form.price : b.priceCents == null ? "" : money(b.priceCents).replace("$", "");
    view.priceNote = el("span", { class: "bo-hint" });
    price.addEventListener("input", () => {
      form.price = price.value;
      refresh();
    });
    const ran = personSelect(draft ? form.ranBy : b.ranBy ? `p:${b.ranBy.personId}` : "", b.ranBy ? { value: `p:${b.ranBy.personId}`, name: b.ranBy.name } : null, "Nobody yet");
    const checked = personSelect(draft ? form.checkedBy : b.checkedBy ? `p:${b.checkedBy.personId}` : "", b.checkedBy ? { value: `p:${b.checkedBy.personId}`, name: b.checkedBy.name } : null, "Nobody yet");
    ran.disabled = !draft;
    checked.disabled = !draft;
    ran.addEventListener("change", () => {
      form.ranBy = ran.value;
      refresh();
    });
    checked.addEventListener("change", () => {
      form.checkedBy = checked.value;
      refresh();
    });
    view.inputs = { price, ranBy: ran, checkedBy: checked };
    f.append(el("section", { class: "bo-card" },
      el("h2", { class: "bo-h2", text: "Price and people" }),
      el("div", { class: "bo-grid bo-grid-3" },
        field("Price (inc GST)", price, { control: el("div", { class: "bo-prefix" }, el("span", { "aria-hidden": "true", text: "$" }), price), note: view.priceNote }),
        field("Ran by", ran),
        field("Checked by", checked))));

    // ---- hours
    const hourInputs = {};
    const hoursGrid = el("div", { class: "bo-grid bo-grid-4" });
    for (const h of HOURS) {
      const inp = el("input", { class: "hs-input", type: "text", inputmode: "decimal", maxlength: "10", disabled: !draft });
      inp.value = draft ? form[h.f] : hoursText(b.hours[h.key]);
      inp.addEventListener("input", () => {
        form[h.f] = inp.value;
        refresh();
      });
      hourInputs[h.f] = inp;
      view.inputs[h.f] = inp;
      hoursGrid.append(field(h.label, inp));
    }
    view.joinrNote = el("p", { class: "bo-hint bo-joinr", text: "From Joinr (factory and site doubled back from the quote)" });
    const hoursCard = el("section", { class: "bo-card" }, el("h2", { class: "bo-h2", text: "Hours" }), hoursGrid, view.joinrNote);
    if (draft) {
      const fill = el("button", { type: "button", class: "hs-btn", text: "Fill from Joinr" });
      fill.addEventListener("click", () => fillFromJoinr(fill));
      view.fillMsg = el("p", { class: "bo-msg", role: "status" });
      hoursCard.append(el("div", { class: "bo-actions" }, fill), view.fillMsg);
    }
    f.append(hoursCard);

    // ---- the seven checks
    const list = el("ul", { class: "bo-checks" });
    view.checkInputs = {};
    for (const c of CHECKS) {
      const cb = el("input", { type: "checkbox", disabled: !draft });
      view.checkInputs[c.key] = cb;
      const li = el("li", { class: "bo-check" }, el("label", { class: "bo-checklabel" }, cb, el("span", { text: c.label })));
      if (c.key === "hours") {
        cb.addEventListener("change", () => {
          form.hoursHand = cb.checked;
          refresh();
        });
        view.suggest = el("span", { class: "bo-suggest" });
        li.append(view.suggest);
        if (draft) {
          view.useSuggestion = el("button", { type: "button", class: "hs-btn hs-btn-quiet bo-usesug", text: "Use suggestion" });
          view.useSuggestion.addEventListener("click", () => {
            form.hoursHand = null;
            refresh();
            cb.focus();
          });
          li.append(view.useSuggestion);
        }
      } else {
        cb.addEventListener("change", () => {
          form.checks[c.key] = cb.checked;
          refresh();
        });
      }
      list.append(li);
    }
    view.ticked = el("p", { class: "bo-ticked", "aria-live": "polite" });
    f.append(el("section", { class: "bo-card" }, el("h2", { class: "bo-h2", text: "Checks" }), list, view.ticked));

    // ---- the figures and shares
    view.figs = el("div", { class: "hs-kvt bo-figs" });
    view.sharesBox = el("div", {});
    f.append(el("section", { class: "bo-card" },
      el("h2", { class: "bo-h2", text: draft ? "Figures (live)" : "Figures (as confirmed)" }),
      view.figs,
      el("h3", { class: "bo-h3", text: draft ? "Shares preview" : "Shares" }),
      view.sharesBox));

    // ---- the note
    const note = el("textarea", { class: "hs-input bo-area", maxlength: String(NOTE_MAX), rows: "3", disabled: !draft });
    note.value = draft ? form.note : b.note || "";
    view.inputs.note = note;
    note.addEventListener("input", () => {
      form.note = note.value;
      refresh();
    });
    f.append(el("section", { class: "bo-card" }, el("h2", { class: "bo-h2", text: "Note" }), field("Note", note, { wide: true, srLabel: true })));

    // ---- actions by state
    const bar = el("div", { class: "bo-actions" });
    view.dirtyLine = el("p", { class: "bo-dirty", text: "Not saved yet." });
    view.msg = el("p", { class: "bo-msg", role: "status", tabindex: "-1" });
    if (draft) {
      view.save = el("button", { type: "submit", class: "hs-btn hs-btn-primary", text: "Save" });
      const confirmBtn = el("button", { type: "button", class: "hs-btn", text: "Confirm" });
      confirmBtn.addEventListener("click", confirmBonus);
      const del = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Delete" });
      del.addEventListener("click", deleteBonus);
      bar.append(view.save, confirmBtn, del);
    } else if (!b.shares.some((s) => s.paid)) {
      const reopen = el("button", { type: "button", class: "hs-btn", text: "Reopen" });
      reopen.addEventListener("click", reopenBonus);
      bar.append(reopen);
    }
    bar.append(el("a", { class: "hs-btn bo-push", href: `bonusprint.html?id=${encodeURIComponent(b.id)}`, text: "Print" }));
    f.append(el("div", { class: "bo-actionbox" }, bar, view.dirtyLine, view.msg));
    if (!draft && b.shares.some((s) => s.paid)) {
      f.querySelector(".bo-actionbox").append(el("p", { class: "bo-hint", text: "A share has been paid, so this bonus can't be reopened until that's undone." }));
    }

    sec.append(f);
    refresh();
  }

  // A draft's figures from the form and the settings last read from the server (`live`, read again
  // after Save, Fill from Joinr and Reopen, and when Confirm opens: section 12.3, B-M1). The same
  // maths as lib/bonuses.js, so with the settings as they are it is what the server works out.
  function draftFigures() {
    const suggested = suggestionOf(formMinutes());
    const hoursOn = form.hoursHand !== null ? form.hoursHand : suggested === true;
    const ticked = CHECKS.reduce((n, c) => n + ((c.key === "hours" ? hoursOn : form.checks[c.key]) ? 1 : 0), 0);
    const priceNow = parseMoney(form.price);
    const rateBp = live ? live.rateBp : bonus.rateBp;
    const figs = figures(Number.isNaN(priceNow) ? null : priceNow, rateBp, ticked);
    const shares = figs.earnedCents == null ? [] : splitShares(figs.earnedCents, live ? live.holders : []);
    return { ticked, rateBp, figs, shares, totalPoints: live ? live.totalPoints : bonus.totalPoints, priceNow };
  }

  // The settings as they are now, for a draft's figures; the last ones are kept if it fails.
  async function readSettings() {
    try {
      live = await send("/api/bonuses/settings");
    } catch (e) {
      // keep the settings already read; the figures shown are then from those
    }
  }

  // Redraw everything that follows the form: notes, the Hours suggestion, the figures, the shares.
  function refresh() {
    const b = bonus;
    const draft = b.status === "draft";
    const mins = draft ? formMinutes() : b.hours;
    const suggested = draft ? suggestionOf(mins) : b.hoursCheck.suggested;

    // the price note: while the price equals the job's value (inc GST)
    const priceNow = draft ? parseMoney(form.price) : b.priceCents;
    const fromJob = jobValue != null && priceNow === jobValue;
    view.priceNote.textContent = fromJob ? "From the job's value, including GST" : "";
    view.priceNote.hidden = !fromJob;

    // the Joinr note: while the quoted pair is as filled from Joinr (and not changed since)
    const quotedSame = mins.quotedFactoryMin === b.hours.quotedFactoryMin && mins.quotedInstallMin === b.hours.quotedInstallMin;
    view.joinrNote.hidden = !(b.hours.quotedFromJoinr && quotedSame);

    // the checks
    let hoursOn;
    let byHand;
    if (draft) {
      byHand = form.hoursHand !== null;
      hoursOn = byHand ? form.hoursHand : suggested === true;
      for (const c of CHECKS) view.checkInputs[c.key].checked = c.key === "hours" ? hoursOn : form.checks[c.key];
    } else {
      byHand = b.hoursCheck.setByHand;
      hoursOn = b.checks.hours;
      for (const c of CHECKS) view.checkInputs[c.key].checked = !!b.checks[c.key];
    }
    const sugWord = suggested === true ? "yes" : suggested === false ? "no" : "unknown";
    view.suggest.textContent = `Suggested: ${sugWord}${byHand ? " (set by hand)" : ""}`;
    if (view.useSuggestion) view.useSuggestion.hidden = !byHand;
    const ticked = draft
      ? CHECKS.reduce((n, c) => n + ((c.key === "hours" ? hoursOn : form.checks[c.key]) ? 1 : 0), 0)
      : b.ticked;
    view.ticked.textContent = `Ticked ${ticked} of 7`;

    // the figures: a draft's from the form and the current settings; a confirmed one's frozen
    let figs;
    let shares;
    let totalPoints;
    let rateBp;
    if (draft) {
      ({ rateBp, figs, shares, totalPoints } = draftFigures());
    } else {
      rateBp = b.rateBp;
      figs = { possibleCents: b.possibleCents, earnedCents: b.earnedCents, lostCents: b.lostCents };
      shares = b.shares;
      totalPoints = b.totalPoints;
    }
    view.figs.replaceChildren();
    for (const [k, v] of [["Rate", pct(rateBp)], ["Possible", money(figs.possibleCents)], ["Earned", money(figs.earnedCents)], ["Lost", money(figs.lostCents)]]) {
      view.figs.append(el("div", { class: "k", text: k }), el("div", { class: "v bo-num", text: v }));
    }
    renderShares(shares, totalPoints, draft, figs, priceNow);

    if (draft) {
      const d = dirty();
      view.dirtyLine.hidden = !d;
      view.save.disabled = !d;
    } else {
      view.dirtyLine.hidden = true;
    }
  }

  function renderShares(shares, totalPoints, draft, figs, priceNow) {
    const box = view.sharesBox;
    box.replaceChildren();
    if (!shares.length) {
      let why = "No shares.";
      if (draft && (priceNow == null || Number.isNaN(priceNow))) why = "Fill in the price to see the shares.";
      else if (draft && !totalPoints) why = "Nobody has share points yet: set them on the Settings tab.";
      else if (figs.earnedCents === 0) why = "Nothing earned, so no shares.";
      box.append(el("p", { class: "bo-empty bo-empty-small", text: why }));
      return;
    }
    const body = el("tbody");
    for (const s of shares) {
      const tr = el("tr", {},
        cell("Person", "bo-c-person", el("span", { class: "bo-strong", text: s.name || `Person ${s.personId}` })),
        cell("Points", "bo-c-points", `${s.points} of ${totalPoints}`),
        cell("Share", "bo-c-money", money(s.shareCents)));
      if (!draft) {
        if (s.paid) {
          const run = s.paid.payRun ? ` (pay run from ${fmtDate(s.paid.payRun.startDate)})` : "";
          tr.append(cell("Paid", "bo-c-paid", `Paid ${fmtDate(s.paid.date)}${run}`));
          const undo = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Undo paid", "aria-label": `Undo paid for ${s.name}` });
          undo.addEventListener("click", () => undoPaid(s));
          tr.append(cell("", "bo-c-act", undo));
        } else {
          tr.append(cell("Paid", "bo-c-paid bo-attend", "Owed"));
          const pay = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Mark paid", "aria-label": `Mark paid for ${s.name}` });
          pay.addEventListener("click", () => markPaid(s));
          tr.append(cell("", "bo-c-act", pay));
        }
      }
      body.append(tr);
    }
    const head = el("tr", {},
      el("th", { scope: "col", class: "bo-c-person", text: "Person" }),
      el("th", { scope: "col", class: "bo-c-points", text: "Points" }),
      el("th", { scope: "col", class: "bo-c-money", text: "Share" }));
    if (!draft) {
      head.append(el("th", { scope: "col", class: "bo-c-paid", text: "Paid" }), el("th", { scope: "col", class: "bo-c-act" }, el("span", { class: "bo-sr", text: "Action" })));
    }
    box.append(el("div", { class: "bo-wrap bo-wrap-inner" }, el("table", { class: "bo-table bo-table-shares" + (draft ? "" : " bo-table-paid") }, el("thead", {}, head), body)));
  }

  function say(text, kind) {
    if (!view || !view.msg) return setStatus(text, kind);
    view.msg.textContent = text || "";
    view.msg.className = "bo-msg" + (kind ? ` bo-msg-${kind}` : "");
  }

  // Say a sentence by the action buttons and move focus to it: after every dialog and Save the
  // form is drawn again, so the control that was used may be gone (section 12.3, B-m5).
  function sayHere(text, kind) {
    say(text, kind);
    if (view && view.msg && view.msg.isConnected) view.msg.focus();
    else focusTitle();
  }

  // Draw the bonus again as the server has it now, after a refusal or a 409 (the bonus changed
  // elsewhere: confirmed, reopened, deleted). `sentence` is said after it, with "Your unsaved
  // changes weren't kept." when the form had changes that were not saved (section 12.3, B-m1).
  async function reloadBonus(sentence, lost) {
    const id = bonus.id;
    try {
      await loadBonus(id);
    } catch (e) {
      // gone (deleted elsewhere) or unreachable: nothing left to edit
      form = null;
      view = null;
      $("boBonus").hidden = true;
      $("boBonus").replaceChildren();
      $("boHeadActions").replaceChildren(el("a", { class: "hs-btn", href: "bonuses.html#jobs", text: "All bonuses" }));
      setStatus(`${sentence ? stop(sentence) + " " : ""}${failText(e, "such bonus")}${lost ? " Your unsaved changes weren't kept." : ""}`, "err");
      focusTitle();
      return;
    }
    const parts = [sentence ? stop(sentence) : "", "The bonus was reloaded as it is now.", lost ? "Your unsaved changes weren't kept." : ""];
    sayHere(parts.filter(Boolean).join(" "), "err");
  }

  async function save() {
    unmarkIn($("boBonus"));
    const c = changes();
    if (c.error) {
      say(c.error, "err");
      markInput(view.inputs[c.field]);
      return;
    }
    if (!Object.keys(c.body).length) return sayHere("Nothing to save.");
    view.save.disabled = true;
    say("Saving...");
    let b;
    try {
      b = await send(`/api/bonuses/${bonus.id}`, { method: "PATCH", body: JSON.stringify(c.body) });
    } catch (e) {
      if (e.status === 409 || e.status === 404) return reloadBonus(e.message, true);
      say(e.message, "err");
      view.save.disabled = false;
      const key = formFieldFor(e.message);
      if (key && view.inputs[key]) markInput(view.inputs[key]);
      else view.msg.focus();
      return;
    }
    // The figures follow the settings as they are now, not as they were when the page loaded.
    await readSettings();
    applyBonus(b, "all");
    sayHere("Saved.", "ok");
  }

  async function fillFromJoinr(btn) {
    btn.disabled = true;
    view.fillMsg.textContent = "Filling...";
    view.fillMsg.className = "bo-msg";
    let b;
    try {
      b = await post(`/api/bonuses/${bonus.id}/joinr-hours`);
    } catch (e) {
      // A 409 is either "No Joinr hours for this job" or the bonus changed elsewhere (confirmed):
      // the bonus as the server has it now tells which.
      if (e.status === 404) return reloadBonus(e.message, dirty());
      if (e.status === 409) {
        const now = await send(`/api/bonuses/${encodeURIComponent(bonus.id)}`).catch(() => null);
        if (!now || now.status !== bonus.status || now.updatedAt !== bonus.updatedAt) return reloadBonus(e.message, dirty());
      }
      view.fillMsg.textContent = e.message;
      view.fillMsg.className = "bo-msg bo-msg-err";
      btn.disabled = false;
      btn.focus();
      return;
    }
    await readSettings();
    applyBonus(b, ["qf", "qi"]); // keeps everything else typed
    view.fillMsg.textContent = "Quoted hours filled from Joinr.";
    view.fillMsg.className = "bo-msg bo-msg-ok";
    view.fillMsg.previousElementSibling.querySelector("button").focus();
  }

  // Confirm: a date (default today, never in the future); unsaved changes are saved first. The
  // dialog says what will be frozen: the form's figures with the settings read as it opens (B-M1).
  async function confirmBonus() {
    unmarkIn($("boBonus"));
    const c = changes();
    if (c.error) {
      say(c.error, "err");
      markInput(view.inputs[c.field]);
      return;
    }
    const unsaved = Object.keys(c.body).length > 0;
    await readSettings();
    refresh();
    const d = draftFigures();
    if (d.priceNow == null) {
      say("Fill in the price before confirming.", "err");
      markInput(view.inputs.price);
      return;
    }
    const n = d.shares.length;
    const split = n ? `, shared by ${n} ${n === 1 ? "person" : "people"}` : d.figs.earnedCents > 0 ? ", but nobody has share points" : "";
    const date = ui().dateInput(todayISO(), null, todayISO());
    let saved = false;
    let conflict = null; // a 409 or 404 seen in the dialog: the bonus changed elsewhere
    const r = await ui().dialog({
      title: "Confirm bonus",
      note: `Confirm the bonus for ${bonus.job.name}? Earned ${money(d.figs.earnedCents)} of a possible ${money(d.figs.possibleCents)} (${pct(d.rateBp)}, ${d.ticked} of 7 ticked)${split}. The figures and shares are frozen with the current rate and share points.`,
      fields: [ui().field("Confirmed date", date)],
      hint: unsaved ? "Your unsaved changes are saved first." : null,
      submit: "Confirm",
      focus: date,
      run: async () => {
        if (!date.value) throw ui().fail("Enter the confirmed date.", date);
        try {
          if (unsaved && !saved) {
            await send(`/api/bonuses/${bonus.id}`, { method: "PATCH", body: JSON.stringify(c.body) });
            saved = true;
          }
          return await post(`/api/bonuses/${bonus.id}/confirm`, { confirmedDate: date.value });
        } catch (e) {
          if (e.status === 409 || e.status === 404) conflict = e.message;
          if (/confirmed date/i.test(e.message)) e.field = date;
          throw e;
        }
      },
    });
    if (r && r.id) {
      payRunsCache = null;
      applyBonus(r, "all");
      // The settings could still change between the dialog opening and the confirm.
      if (r.earnedCents !== d.figs.earnedCents) sayHere(`Confirmed. Earned ${money(r.earnedCents)}: the rate or share points changed while the dialog was open.`, "ok");
      else sayHere("Confirmed.", "ok");
    } else if (conflict !== null) {
      await reloadBonus(conflict, unsaved && !saved);
      if (saved && view) sayHere(`${stop(conflict)} Your changes were saved, but the bonus isn't confirmed.`, "err");
    } else if (saved) {
      await reloadBonus("", false);
      if (view) sayHere("Your changes were saved, but the bonus isn't confirmed.", "err");
    }
  }

  async function deleteBonus() {
    const r = await ui().dialog({
      title: "Delete bonus",
      note: `Delete the draft bonus for ${bonus.job.name}? This can't be undone.`,
      submit: "Delete",
      submitClass: "hs-btn-stop",
      focus: "cancel",
      run: () => send(`/api/bonuses/${bonus.id}`, { method: "DELETE" }),
    });
    if (r && r.ok) {
      form = null; // nothing left to lose
      location.href = "bonuses.html?deleted=1#jobs"; // the list says "Deleted."
    } else if (r && r.refused) {
      await reloadBonus("", dirty());
    }
  }

  async function reopenBonus() {
    const r = await ui().dialog({
      title: "Reopen bonus",
      note: `Reopen the bonus for ${bonus.job.name}? It goes back to a draft. The current rate and share points will apply when it is confirmed again.`,
      submit: "Reopen",
      focus: "cancel",
      run: () => post(`/api/bonuses/${bonus.id}/reopen`),
    });
    if (r && r.id) {
      payRunsCache = null;
      await readSettings();
      applyBonus(r, "all");
      sayHere("Reopened as a draft.", "ok");
    } else if (r && r.refused) {
      await reloadBonus("", false);
    }
  }

  async function markPaid(s) {
    let runs = [];
    try {
      runs = await payRuns();
    } catch (e) {
      runs = [];
    }
    const date = ui().dateInput(todayISO(), bonus.confirmedDate, todayISO());
    const run = payRunSelect(runs);
    const r = await ui().dialog({
      title: "Mark paid",
      note: `${s.name}'s share of the bonus for ${bonus.job.name}: ${money(s.shareCents)}.`,
      fields: [ui().field("Date paid", date), ui().field("Pay run (optional)", run, { hint: "Only a note of which finalised pay run it went in; bonuses don't change a pay run." })],
      submit: "Mark paid",
      focus: date,
      run: async () => {
        if (!date.value) throw ui().fail("Enter the date paid.", date);
        const body = { paidDate: date.value };
        if (run.value) body.payRunId = Number(run.value);
        try {
          return await post(`/api/bonuses/${bonus.id}/shares/${encodeURIComponent(s.personId)}/paid`, body);
        } catch (e) {
          e.field = paidField(e.message, date, run);
          throw e;
        }
      },
    });
    afterPaid(r, `Marked ${s.name}'s share paid.`);
  }

  async function undoPaid(s) {
    const r = await ui().dialog({
      title: "Undo paid",
      note: `Mark ${s.name}'s share (${money(s.shareCents)}) as owed again? It was marked paid ${fmtDate(s.paid.date)}.`,
      submit: "Undo paid",
      focus: "cancel",
      run: () => post(`/api/bonuses/${bonus.id}/shares/${encodeURIComponent(s.personId)}/paid`, { undo: true }),
    });
    afterPaid(r, `${s.name}'s share is owed again.`);
  }

  async function afterPaid(r, okText) {
    if (r && r.id) {
      applyBonus(r, "all");
      sayHere(okText, "ok");
    } else if (r && r.refused) {
      await reloadBonus("", false);
    }
  }

  // ------------------------------------------------------------------ boot ---

  async function boot() {
    if (window.cc && window.cc.ready) await window.cc.ready;
    if (!window.OrderUI) {
      setStatus("The page didn't load completely. Reload to try again.", "err");
      return;
    }
    const raw = new URLSearchParams(location.search).get("id");
    if (raw !== null) {
      if (!/^[1-9]\d*$/.test(raw)) {
        setStatus("There is no such bonus.", "err");
        return;
      }
      $("boBonus").hidden = false;
      setStatus("Loading...");
      try {
        await loadBonus(Number(raw));
      } catch (e) {
        $("boBonus").hidden = true;
        $("boHeadActions").replaceChildren(el("a", { class: "hs-btn", href: "bonuses.html#jobs", text: "All bonuses" }));
        setStatus(failText(e, "such bonus"), "err");
      }
      return;
    }
    // After a bonus is deleted its page comes here with ?deleted=1: the list says so, once.
    if (new URLSearchParams(location.search).get("deleted") === "1") {
      notice = "Deleted.";
      history.replaceState(null, "", location.pathname + location.hash);
    }
    $("boLists").hidden = false;
    readHash();
    wireTabs();
    wireSettings();
    showTab(tab);
  }

  boot();
})();
