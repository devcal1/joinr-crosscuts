// The job bonus and bonuses owed prints (/bonusprint.html; docs/plans/m13-contracts.md section 8.1).
// Gated by bonuses.manage (lib/pages.js), an owner-only key.
//
//   ?id=N        one job bonus                  GET /api/bonuses/:id
//                a draft prints a ruled DRAFT – NOT CONFIRMED box instead of the confirmed date,
//                with the live figures (the current rate and share points)
//   ?summary=1   bonuses owed, as of today      GET /api/bonuses/summary
//
// On screen the sheet sits on a white paper box with Print and Back; on paper only the sheet prints
// (A4 portrait, black on white, no letterhead; bonusprint.css). document.title names the sheet, so a
// saved PDF is named after it. Every value goes in through textContent. Classes are bp-.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const CHECKS = [
    { key: "drawn", label: "Drawn (Mozaik)" },
    { key: "ordered", label: "Ordered" },
    { key: "assembled", label: "Assembled" },
    { key: "installed", label: "Installed" },
    { key: "noFuss", label: "No fuss" },
    { key: "onTime", label: "On time" },
    { key: "hours", label: "Hours" },
  ];

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
    return node;
  }

  function todayISO() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  }

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
  }

  function money(cents) {
    if (cents == null || !Number.isFinite(cents)) return "–";
    const c = Math.abs(Math.round(cents));
    const dollars = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${cents < 0 ? "-" : ""}$${dollars}.${String(c % 100).padStart(2, "0")}`;
  }

  function pct(bp) {
    if (bp == null) return "–";
    return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, "0")}%`;
  }

  function hours(min) {
    return min == null ? "–" : (min / 60).toFixed(2);
  }

  function person(p) {
    if (!p) return "–";
    return (p.name || `Person ${p.personId}`) + (p.archived ? " (left)" : "");
  }

  function setStatus(msg) {
    $("bpStatus").textContent = msg || "";
  }

  // A sentence instead of a sheet (no access, not found, no connection).
  function refuse(msg) {
    const sheet = $("bpSheet");
    sheet.classList.add("bp-sheet-error");
    sheet.replaceChildren(el("p", { class: "bp-error", text: msg }));
    $("bpPrint").disabled = true;
    document.title = "Bonus print - Crosscuts";
  }

  function failText(e, what) {
    if (e instanceof TypeError) return "Couldn't reach the server. Reload to try again.";
    const m = (e && e.message) || "";
    if (/not found/i.test(m)) return `There is no ${what}.`;
    if (/forbidden|permission|access|not allowed/i.test(m)) return `You don't have access to ${what}.`;
    return m || "That didn't load. Reload to try again.";
  }

  function kv(rows) {
    const dl = el("dl", { class: "bp-kv" });
    for (const [label, value, strong] of rows) {
      dl.append(el("dt", { text: label }), el("dd", { class: strong ? "bp-strong" : null, text: value }));
    }
    return dl;
  }

  function block(title, ...kids) {
    return el("section", { class: "bp-block" }, el("h2", { class: "bp-blockh", text: title }), ...kids);
  }

  // cols: [[label, class]]; rows: arrays of cell text; foot: an optional totals row.
  function table(cols, rows, foot) {
    const head = el("tr", {}, cols.map(([label, cls]) => el("th", { scope: "col", class: cls || null, text: label })));
    const body = el("tbody", {}, rows.map((r) => el("tr", {}, r.map((v, i) => el("td", { class: cols[i][1] || null, text: v })))));
    const t = el("table", { class: "bp-table" }, el("thead", {}, head), body);
    if (foot) t.append(el("tfoot", {}, el("tr", {}, foot.map((v, i) => el("td", { class: cols[i][1] || null, text: v })))));
    return t;
  }

  function titleRow(h1, sub, meta) {
    const dl = el("dl", { class: "bp-meta" });
    for (const [k, v] of meta) dl.append(el("dt", { text: k }), el("dd", { text: v }));
    return el("div", { class: "bp-titlerow" },
      el("div", { class: "bp-titlebox" }, el("h1", { class: "bp-h1", text: h1 }), sub ? el("p", { class: "bp-sub", text: sub }) : null),
      meta.length ? dl : null);
  }

  // ---- one job bonus ---------------------------------------------------------------------------

  function bonusSheet(b) {
    const draft = b.status !== "confirmed";
    const out = [];
    if (draft) out.push(el("p", { class: "bp-stamp", text: "DRAFT – NOT CONFIRMED" }));
    out.push(titleRow("Job bonus", b.job.name || `Job ${b.job.id}`, draft ? [] : [["Confirmed", fmtDate(b.confirmedDate)]]));
    if (draft) out.push(el("p", { class: "bp-small", text: `Live figures with the rate and share points as of ${fmtDate(todayISO())}. They change until the bonus is confirmed.` }));

    // figures and people
    const figs = kv([
      ["Price", money(b.priceCents), true],
      ["Rate", pct(b.rateBp)],
      ["Possible", money(b.possibleCents)],
      ["Earned", money(b.earnedCents), true],
      ["Lost", money(b.lostCents)],
    ]);
    const people = kv([
      ["Ran by", person(b.ranBy)],
      ["Checked by", person(b.checkedBy)],
    ]);

    // the seven checks
    const checks = el("ul", { class: "bp-checks" });
    for (const c of CHECKS) {
      const on = !!b.checks[c.key];
      const suggested = c.key === "hours" && !b.hoursCheck.setByHand ? " (suggested)" : "";
      checks.append(el("li", {}, el("span", { class: "bp-box", text: on ? "[x]" : "[ ]" }), el("span", { text: c.label + suggested })));
    }
    out.push(el("div", { class: "bp-blocks" },
      block("Figures", figs),
      block("Checks", checks, el("p", { class: "bp-ticked", text: `Ticked ${b.ticked} of 7` })),
      block("People", people),
      block("Hours",
        table(
          [["", "bp-c-label"], ["Factory", "bp-num"], ["Install", "bp-num"], ["Total", "bp-num"]],
          [
            ["Quoted", hours(b.hours.quotedFactoryMin), hours(b.hours.quotedInstallMin), total(b.hours.quotedFactoryMin, b.hours.quotedInstallMin)],
            ["Actual", hours(b.hours.actualFactoryMin), hours(b.hours.actualInstallMin), total(b.hours.actualFactoryMin, b.hours.actualInstallMin)],
          ]),
        el("p", { class: "bp-small", text: b.hours.quotedFromJoinr ? "In hours. Quoted from Joinr (factory and site doubled back from the quote)." : "In hours." }))));

    // the shares
    const cols = [["Person", ""], ["Points", "bp-c-points"], ["Share", "bp-num"]];
    if (!draft) cols.push(["Paid", "bp-c-paid"]);
    const rows = b.shares.map((s) => {
      const r = [s.name || `Person ${s.personId}`, `${s.points} of ${b.totalPoints}`, money(s.shareCents)];
      if (!draft) {
        r.push(s.paid ? `Paid ${fmtDate(s.paid.date)}${s.paid.payRun ? `, pay run from ${fmtDate(s.paid.payRun.startDate)}` : ""}` : "Owed");
      }
      return r;
    });
    const sum = b.shares.reduce((n, s) => n + s.shareCents, 0);
    const foot = ["Total", `${b.totalPoints} points`, money(sum)];
    if (!draft) foot.push(b.owedCents > 0 ? `Owed ${money(b.owedCents)}` : "All paid");
    out.push(block("Shares", rows.length ? table(cols, rows, foot) : el("p", { class: "bp-small", text: b.priceCents == null ? "No price yet, so no shares." : "No shares." })));

    if (b.note) out.push(block("Note", el("p", { class: "bp-pre", text: b.note })));
    out.push(el("p", { class: "bp-foot", text: `Printed ${fmtDate(todayISO())}` }));
    return out;
  }

  function total(a, b) {
    return a == null || b == null ? "–" : hours(a + b);
  }

  // ---- bonuses owed ----------------------------------------------------------------------------

  function summarySheet(s, today) {
    const out = [titleRow("Bonuses owed", null, [["Date", fmtDate(today)]])];
    const people = s.people || [];
    if (!people.length) {
      out.push(el("p", { class: "bp-small bp-gap", text: "No confirmed bonuses yet, so nobody has earned a share." }));
      return out;
    }
    const cols = [["Person", ""], ["Earned", "bp-num"], ["Paid", "bp-num"], ["Owed", "bp-num"]];
    out.push(block("Earned, paid and owed",
      table(cols,
        people.map((p) => [p.name + (p.archived ? " (left)" : ""), money(p.earnedCents), money(p.paidCents), money(p.owedCents)]),
        ["Total", money(s.totals.earnedCents), money(s.totals.paidCents), money(s.totals.owedCents)])));
    const owing = people.filter((p) => p.owedCents > 0);
    if (!owing.length) {
      out.push(el("p", { class: "bp-small bp-gap", text: "Nothing is owed." }));
      return out;
    }
    for (const p of owing) {
      out.push(block(`${p.name}${p.archived ? " (left)" : ""}: owed ${money(p.owedCents)}`,
        table([["Job", ""], ["Confirmed", "bp-c-date"], ["Share", "bp-num"]],
          p.owed.map((o) => [o.jobName, fmtDate(o.confirmedDate), money(o.shareCents)]),
          ["Total", "", money(p.owedCents)])));
    }
    return out;
  }

  // ---- boot -----------------------------------------------------------------------------------

  async function boot() {
    $("bpPrint").addEventListener("click", () => window.print());
    const q = new URLSearchParams(location.search);
    const id = q.get("id");
    const sheet = $("bpSheet");
    if (window.cc && window.cc.ready) await window.cc.ready;
    try {
      if (q.get("summary") === "1") {
        $("bpBack").href = "bonuses.html#owed";
        $("bpBack").textContent = "Back to the owed list";
        const s = await api("/api/bonuses/summary");
        const today = todayISO();
        sheet.replaceChildren(...summarySheet(s, today));
        document.title = `Bonuses owed ${fmtDate(today)}`;
      } else if (id && /^[1-9]\d*$/.test(id)) {
        $("bpBack").href = `bonuses.html?id=${encodeURIComponent(id)}`;
        $("bpBack").textContent = "Back to the bonus";
        const b = await api(`/api/bonuses/${encodeURIComponent(id)}`);
        sheet.replaceChildren(...bonusSheet(b));
        document.title = `Bonus ${b.job.name || ""}`.trim();
      } else {
        refuse("Nothing to print: open a bonus or the owed list and choose Print.");
        return;
      }
      $("bpPrint").disabled = false;
      setStatus("");
    } catch (e) {
      refuse(failText(e, q.get("summary") === "1" ? "bonus summary" : "such bonus"));
    }
  }

  boot();
})();
