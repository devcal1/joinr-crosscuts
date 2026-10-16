// Pay-run prints (/payprint.html, docs/plans/m8-contracts.md section 8.3). Read-only: it builds
// A4 pages from the pay-runs API and "Print" is the browser's own print dialog (Save as PDF).
//   ?start=YYYY-MM-DD&what=sheets[&person=<personId>]  blank fortnightly timesheets, one per person, landscape
//   ?start=YYYY-MM-DD&what=overtime                    the blank overtime log
//   ?id=N&what=summary                                 the pay-run summary, landscape
// The printed timesheets carry nothing but the name and the dates (Decisions 1 and 5): staff fill
// them in by hand. All hour display goes through PayMaths (public/paymaths.js).
(function () {
  "use strict";

  var PM = window.PayMaths;
  var pagesEl = document.getElementById("pp-pages");
  var btnPrint = document.getElementById("pp-print");
  var btnBack = document.getElementById("pp-back");
  var stateEl = document.getElementById("pp-state");

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var OFF_GRID = "That date doesn't start a pay fortnight";

  // The paper's columns (contracts 8.2, ON SITE not OFF SITE). `tot` marks the ones the TOTALS row
  // adds up; the rest have no box in that row.
  var COLUMNS = [
    { key: "date", label: "Date" },
    { key: "day", label: "Day" },
    { key: "start", label: "Start" },
    { key: "finish", label: "Finish" },
    { key: "lunch", label: "Lunch" },
    { key: "phol", label: "P HOL", tot: true },
    { key: "sick", label: "SICK", tot: true },
    { key: "arl", label: "ARL", tot: true },
    { key: "onsite", label: "ON SITE", tot: true },
    { key: "job", label: "JOB" },
    { key: "total", label: "Total", tot: true },
    { key: "ot", label: "OT", tot: true },
    { key: "dt", label: "DT", tot: true },
  ];

  // The MYOB lines (Decision 11 and the lead's defaults), in the paper's summary-block order.
  var SUMMARY_LINES = [
    { key: "normalMin", label: "Normal Time" },
    { key: "otMin", label: "Over Time" },
    { key: "dtMin", label: "Double Time" },
    { key: "pholMin", label: "Public Holiday" },
    { key: "arlMin", label: "Annual Leave" },
    { key: "sickMin", label: "Personal Leave" },
    { key: "onsiteMin", label: "On Site" },
  ];

  // ---- small helpers (text only, never innerHTML) ---------------------------

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }

  function validDate(s) {
    if (typeof s !== "string" || !DATE_RE.test(s)) return false;
    var d = new Date(s + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  // "2026-10-05" -> "5 Oct 2026"
  function longDate(s) {
    return PM.shortDate(s) + " " + s.slice(0, 4);
  }

  // An ISO timestamp -> its Sydney date, "14 Oct 2026".
  function sydneyDate(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return "";
    var parts = new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney", year: "numeric", month: "numeric", day: "numeric",
    }).formatToParts(d);
    var get = function (t) {
      var p = parts.find(function (x) { return x.type === t; });
      return p ? Number(p.value) : 0;
    };
    return get("day") + " " + MONTHS[get("month") - 1] + " " + get("year");
  }

  function byName(a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""), "en", { sensitivity: "base" });
  }

  function notFoundMessage(e, fallback) {
    var msg = e && e.message ? e.message : "";
    if (/\(404\)/.test(msg) || /^not found$/i.test(msg)) return "Pay run not found";
    return msg || fallback;
  }

  // ---- page frame -----------------------------------------------------------

  function fail(message) {
    pagesEl.textContent = "";
    pagesEl.appendChild(el("p", "pp-message pp-error", message));
    btnPrint.disabled = true;
    btnPrint.onclick = null;
    stateEl.textContent = "";
    stateEl.className = "pp-state";
    document.title = "Print - Crosscuts";
  }

  // Shows the built pages and arms Print. The title is the default PDF filename, so Ctrl+P is
  // right too.
  function show(pages, title) {
    pagesEl.textContent = "";
    pages.forEach(function (p) { pagesEl.appendChild(p); });
    document.title = title;
    btnPrint.disabled = false;
    btnPrint.onclick = function () {
      document.title = title;
      window.print();
    };
  }

  function sheet(extraClass) {
    return el("article", "pp-sheet" + (extraClass ? " " + extraClass : ""));
  }

  // ---- the blank fortnightly timesheet --------------------------------------

  function field(label, value, cls) {
    var f = el("div", "pp-field" + (cls ? " " + cls : ""));
    add(f, el("span", "pp-label", label), el("span", "pp-value", value));
    return f;
  }

  function timesheetPage(person, start) {
    var page = sheet("pp-form pp-land pp-ts");
    page.setAttribute("aria-label", "Timesheet for " + person.name);

    var head = el("header", "pp-form-head");
    add(head, el("h1", "pp-h1", "Fortnightly timesheet"));
    var fields = el("div", "pp-fields");
    add(fields,
      field("Employee", person.name, "pp-field-name"),
      field("From", longDate(start)),
      field("To", longDate(PM.endOf(start))));
    head.appendChild(fields);
    page.appendChild(head);

    var table = el("table", "pp-grid");
    var cols = el("colgroup");
    COLUMNS.forEach(function (c) { cols.appendChild(el("col", "pp-c-" + c.key)); });
    table.appendChild(cols);

    var thead = el("thead");
    var hr = el("tr");
    COLUMNS.forEach(function (c) {
      var th = el("th", "pp-h-" + c.key, c.label);
      th.scope = "col";
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var dates = PM.fortnightDates(start);
    [dates.slice(0, 5), dates.slice(5)].forEach(function (week) {
      var tb = el("tbody", "pp-week");
      week.forEach(function (date) {
        var tr = el("tr");
        COLUMNS.forEach(function (c) {
          var td = el("td", "pp-d-" + c.key);
          if (c.key === "date") td.textContent = PM.shortDate(date);
          else if (c.key === "day") td.textContent = PM.DAY_LABELS[PM.dayKeyOf(date)] || "";
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      table.appendChild(tb);
    });

    var tfoot = el("tfoot");
    var fr = el("tr");
    var lbl = el("th", "pp-totals-label", "TOTALS");
    lbl.scope = "row";
    lbl.colSpan = 2;
    fr.appendChild(lbl);
    COLUMNS.slice(2).forEach(function (c) {
      fr.appendChild(el("td", c.tot ? "pp-tot" : "pp-nil"));
    });
    tfoot.appendChild(fr);
    table.appendChild(tfoot);
    page.appendChild(table);

    var lower = el("div", "pp-lower");
    var notes = el("section", "pp-notes");
    add(notes, el("h2", "pp-label", "Notes"), el("div", "pp-box"));
    var sign = el("div", "pp-sign");
    add(sign,
      add(el("div", "pp-line pp-line-sig"), el("span", "pp-label", "Signature"), el("span", "pp-rule")),
      add(el("div", "pp-line pp-line-date"), el("span", "pp-label", "Date"), el("span", "pp-rule")));
    notes.appendChild(sign);
    var sum = el("section", "pp-sumblock");
    sum.appendChild(el("h2", "pp-label", "Summary (hours)"));
    var st = el("table", "pp-sumtable");
    var sb = el("tbody");
    SUMMARY_LINES.forEach(function (line) {
      var tr = el("tr");
      var th = el("th", null, line.label);
      th.scope = "row";
      add(tr, th, el("td", "pp-blank"));
      sb.appendChild(tr);
    });
    st.appendChild(sb);
    sum.appendChild(st);
    add(lower, notes, sum);
    page.appendChild(lower);
    return page;
  }

  async function loadSheets(start, personId) {
    var home = await api("/api/payruns");
    var anchor = home && home.rules && home.rules.anchor;
    if (!PM.onGrid(start, anchor)) return fail(OFF_GRID);

    // The run's sheets when a pay run exists for that start, else everyone on the pay run.
    var run = ((home && home.payRuns) || []).find(function (r) { return r.startDate === start; });
    var people;
    if (run) {
      var full = await api("/api/payruns/" + encodeURIComponent(run.id));
      people = (full.timesheets || []).map(function (s) {
        return { id: s.person ? s.person.id : null, name: s.name };
      });
    } else {
      var res = await api("/api/payruns/people");
      people = ((res && res.people) || [])
        .filter(function (p) { return p.onPayRun && !p.archived; })
        .map(function (p) { return { id: p.id, name: p.name }; });
    }
    people.sort(byName);

    if (personId) {
      people = people.filter(function (p) { return p.id != null && String(p.id) === personId; });
      if (!people.length) return fail("That person has no timesheet in this fortnight");
    }
    if (!people.length) return fail("Nobody is on the pay run for this fortnight");

    var label = PM.fortnightLabel(start);
    show(people.map(function (p) { return timesheetPage(p, start); }),
      personId ? "Timesheet " + people[0].name + " " + label : "Timesheets " + label);
    stateEl.className = "pp-state";
    stateEl.textContent = people.length === 1 ? "1 timesheet, " + label : people.length + " timesheets, " + label;
  }

  // ---- the blank overtime log (Decision 9) ----------------------------------

  var OT_ROWS = 20;

  function overtimePage(start) {
    var page = sheet("pp-otlog");
    var head = el("header", "pp-form-head");
    add(head, el("h1", "pp-h1", "Overtime log"));
    var fields = el("div", "pp-fields");
    add(fields,
      field("From", longDate(start)),
      field("To", longDate(PM.endOf(start))),
      el("div", "pp-field pp-field-name"));
    head.appendChild(fields);
    page.appendChild(head);

    var table = el("table", "pp-ot");
    var cols = el("colgroup");
    ["date", "name", "hours", "job"].forEach(function (k) { cols.appendChild(el("col", "pp-o-" + k)); });
    table.appendChild(cols);
    var thead = el("thead");
    var hr = el("tr");
    ["Date", "Name", "Hours", "Job"].forEach(function (t) {
      var th = el("th", null, t);
      th.scope = "col";
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tb = el("tbody");
    for (var i = 0; i < OT_ROWS; i++) {
      var tr = el("tr");
      for (var j = 0; j < 4; j++) tr.appendChild(el("td"));
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    page.appendChild(table);
    return page;
  }

  async function loadOvertime(start) {
    var home = await api("/api/payruns");
    var anchor = home && home.rules && home.rules.anchor;
    if (!PM.onGrid(start, anchor)) return fail(OFF_GRID);
    var label = PM.fortnightLabel(start);
    show([overtimePage(start)], "Overtime log " + label);
    stateEl.className = "pp-state";
    stateEl.textContent = "Overtime log, " + label;
  }

  // ---- the pay-run summary (contracts 6.4), landscape -----------------------

  function rulesLine(rules) {
    if (!rules) return "";
    return "Ordinary " + PM.hours(rules.ordinaryMonThuMin) + " h Mon–Thu, " + PM.hours(rules.ordinaryFriMin) +
      " h Fri; first " + PM.hours(rules.otBandMin) + " h overtime, then double time";
  }

  function summaryPage(sum, run) {
    var pr = sum.payRun || {};
    var open = pr.status !== "finalised";
    var page = sheet("pp-land pp-summary" + (open ? " pp-is-draft" : ""));

    if (open) page.appendChild(el("p", "pp-draft", "DRAFT: not finalised"));

    var head = el("header", "pp-sum-head");
    var left = el("div");
    add(left, el("h1", "pp-h1", "Pay run summary"), el("p", "pp-sum-label", pr.label || PM.fortnightLabel(pr.startDate)));
    var meta = el("div", "pp-sum-meta");
    if (open) {
      meta.appendChild(el("p", null, "Not finalised: numbers can still change"));
    } else {
      var by = run && run.finalisedBy && run.finalisedBy.name ? " by " + run.finalisedBy.name : "";
      var when = sydneyDate(pr.finalisedAt || (run && run.finalisedAt));
      meta.appendChild(el("p", null, "Finalised" + (when ? " " + when : "") + by));
      if (pr.myobEnteredDate && validDate(pr.myobEnteredDate)) {
        meta.appendChild(el("p", null, "Entered in MYOB " + longDate(pr.myobEnteredDate)));
      }
    }
    add(head, left, meta);
    page.appendChild(head);

    var table = el("table", "pp-sum");
    var cols = el("colgroup");
    cols.appendChild(el("col", "pp-s-name"));
    SUMMARY_LINES.forEach(function () { cols.appendChild(el("col", "pp-s-num")); });
    cols.appendChild(el("col", "pp-s-notes"));
    table.appendChild(cols);

    var thead = el("thead");
    var hr = el("tr");
    var thName = el("th", "pp-s-left", "Name");
    thName.scope = "col";
    hr.appendChild(thName);
    SUMMARY_LINES.forEach(function (line) {
      var th = el("th", "pp-num", line.label);
      th.scope = "col";
      hr.appendChild(th);
    });
    var thNotes = el("th", "pp-s-left", "Notes");
    thNotes.scope = "col";
    hr.appendChild(thNotes);
    thead.appendChild(hr);
    table.appendChild(thead);

    var tb = el("tbody");
    var rows = (sum.rows || []).slice().sort(byName);
    if (!rows.length) {
      var er = el("tr");
      var etd = el("td", "pp-empty", "No timesheets in this pay run");
      etd.colSpan = SUMMARY_LINES.length + 2;
      er.appendChild(etd);
      tb.appendChild(er);
    }
    rows.forEach(function (r) {
      var tr = el("tr");
      var th = el("th", "pp-s-left", r.name);
      th.scope = "row";
      tr.appendChild(th);
      SUMMARY_LINES.forEach(function (line) { tr.appendChild(el("td", "pp-num", PM.hours(r[line.key] || 0))); });
      tr.appendChild(el("td", "pp-s-notes-cell", (r.notes || "").trim()));
      tb.appendChild(tr);
    });
    table.appendChild(tb);

    var tf = el("tfoot");
    var fr = el("tr");
    var ft = el("th", "pp-s-left", "Totals");
    ft.scope = "row";
    fr.appendChild(ft);
    var totals = sum.totals || {};
    SUMMARY_LINES.forEach(function (line) { fr.appendChild(el("td", "pp-num", PM.hours(totals[line.key] || 0))); });
    fr.appendChild(el("td"));
    tf.appendChild(fr);
    table.appendChild(tf);
    page.appendChild(table);

    var foot = el("footer", "pp-sum-foot");
    add(foot,
      el("p", null, "Worked out with: " + rulesLine(sum.rules) + "."),
      el("p", null, "Hours in decimal hours, as MYOB takes them. Normal Time is ordinary hours worked; leave and public holidays are listed separately."));
    page.appendChild(foot);
    return page;
  }

  async function loadSummary(id) {
    btnBack.href = "/payrun.html?id=" + encodeURIComponent(id);
    var both = await Promise.all([
      api("/api/payruns/" + encodeURIComponent(id) + "/summary"),
      api("/api/payruns/" + encodeURIComponent(id)),
    ]);
    var sum = both[0] || {};
    var run = both[1] || {};
    var pr = sum.payRun || {};
    var label = pr.label || (validDate(pr.startDate) ? PM.fortnightLabel(pr.startDate) : "");
    show([summaryPage(sum, run)], ("Pay run summary " + label).trim());

    var finalised = pr.status === "finalised";
    var myob = finalised && pr.myobEnteredDate;
    stateEl.className = "pp-state hs-badge " + (myob ? "hs-badge-teal" : finalised ? "hs-badge-na" : "hs-badge-check");
    stateEl.textContent = myob ? "Entered in MYOB" : finalised ? "Finalised" : "Open";
  }

  // ---- start ----------------------------------------------------------------

  var q = new URLSearchParams(location.search);
  var what = q.get("what");
  var start = q.get("start");
  var id = q.get("id");
  var person = q.get("person");

  function go(p, fallback) {
    p.catch(function (e) { fail(notFoundMessage(e, fallback)); });
  }

  if (what === "summary") {
    if (!id || !/^[1-9]\d*$/.test(id)) fail("Pay run not found");
    else go(loadSummary(id), "The summary could not be loaded");
  } else if (what === "sheets" || what === "overtime") {
    if (!validDate(start)) fail(OFF_GRID);
    else if (what === "overtime") go(loadOvertime(start), "The overtime log could not be loaded");
    else if (person !== null && !/^[1-9]\d*$/.test(person)) fail("That person has no timesheet in this fortnight");
    else go(loadSheets(start, person), "The timesheets could not be loaded");
  } else {
    fail("Nothing to print. Open this page from Pay runs.");
  }
})();
