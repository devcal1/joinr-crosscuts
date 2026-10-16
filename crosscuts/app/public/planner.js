// Planner page (docs/plans/m7-contracts.md section 12): this week and next as the hero (two rows of
// seven tall day tiles), the Monday-to-Sunday month grid at the side, layer buttons, event detail
// and edit dialogs, the phone layout and print.
// Talks to /api/planner (section 9) and /api/job-records (the job picker, as taskui.js does).
// Every date and time is Sydney calendar text from the server ("YYYY-MM-DD", "HH:MM"); the page
// never reads the browser's clock or zone, and "today" is always the server's.
// All user text goes into the DOM through textContent (el's "text" prop) or attribute values.
// Layer marker colours (the --layer-* tokens) are the planner's named exception in CLAUDE.md
// "Look and feel"; they are used only through the pl-l-<layer> classes in planner.css.
(function () {
  "use strict";

  var DAY = 24 * 60 * 60 * 1000;
  var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // Section 5.1, the order used everywhere.
  var LAYER_ORDER = ["company", "install", "accounts", "design_pm", "scheduling", "workshop", "personal"];
  var LAYER_LABELS = {
    company: "Company-wide",
    install: "Install & hardware",
    accounts: "Accounts",
    design_pm: "Design/PM",
    scheduling: "Scheduling/Production",
    workshop: "Workshop",
    personal: "Personal",
  };
  // Section 7.5.
  var REMINDERS_TIMED = ["start", "min15", "hour1", "day1"];
  var REMINDERS_ALL_DAY = ["morning", "day_before"];
  var REMINDER_LABELS = {
    start: "At the start",
    min15: "15 minutes before",
    hour1: "1 hour before",
    day1: "1 day before",
    morning: "7:00 on the day",
    day_before: "7:00 the day before",
  };
  var REPEAT_OPTIONS = [
    ["none", "Never"],
    ["weekly", "Every week"],
    ["fortnightly", "Every two weeks"],
    ["monthly", "Every month"],
    ["annually", "Every year"],
    ["custom", "Custom\u2026"],
  ];
  var REPEAT_LABELS = { weekly: "Every week", fortnightly: "Every two weeks", monthly: "Every month", annually: "Every year" };
  var REPEAT_UNITS = ["day", "week", "month", "year"];
  var EVERY_DEFAULT = 2;
  var UNIT_DEFAULT = "week";
  var SCREEN_LANES = 3; // items a day in the month grid on screen, then "+N more"
  var PRINT_LANES = 4; // and on paper, so a busy month still fits one A4 landscape page (M7 · 4.3)
  var TILE_CAP = 6; // items in a day tile of the two weeks on screen, then "+N more" (all on paper)
  var CHANGE_LATER_NOTE = "Change these for this and all later.";
  var WARN_SERIES = "One-off changes to this event will be replaced.";
  var WARN_SPLIT = "Later one-off changes will be replaced.";

  // ---------- calendar maths on YYYY-MM-DD strings (UTC midnights, so no zone gets in) ----------

  function toMs(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  }
  function toDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }
  function isDate(s) {
    return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(toMs(s)) && toDate(toMs(s)) === s;
  }
  function addDays(s, n) {
    return toDate(toMs(s) + n * DAY);
  }
  function dayIndex(s) {
    return (new Date(toMs(s)).getUTCDay() + 6) % 7; // Monday 0 ... Sunday 6
  }
  function mondayOf(s) {
    return addDays(s, -dayIndex(s));
  }
  function daysBetween(a, b) {
    return Math.round((toMs(b) - toMs(a)) / DAY);
  }
  function firstOfMonth(s) {
    return s.slice(0, 8) + "01";
  }
  function addMonths(first, n) {
    var d = new Date(toMs(first));
    d.setUTCMonth(d.getUTCMonth() + n);
    return toDate(d.getTime());
  }

  // ---------- text ----------

  function dayNum(s) {
    return String(Number(s.slice(8, 10)));
  }
  function withYear(s) {
    return state.today && s.slice(0, 4) !== state.today.slice(0, 4);
  }
  // "Thu 8 Oct" (and the year when it isn't this year).
  function fmtDay(s) {
    if (!isDate(s)) return s || "";
    var d = new Date(toMs(s));
    var out = DAY_NAMES[dayIndex(s)] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()];
    return withYear(s) ? out + " " + d.getUTCFullYear() : out;
  }
  // "30 Nov" (and the year when it isn't this year).
  function fmtShort(s) {
    if (!isDate(s)) return s || "";
    var d = new Date(toMs(s));
    var out = d.getUTCDate() + " " + MONTHS[d.getUTCMonth()];
    return withYear(s) ? out + " " + d.getUTCFullYear() : out;
  }
  // "11 Oct 2026".
  function fmtLong(s) {
    if (!isDate(s)) return s || "";
    var d = new Date(toMs(s));
    return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }
  // "5–11 Oct", or "28 Sep – 4 Oct" across a month end.
  function fmtRange(a, b) {
    if (a === b) return fmtShort(a);
    if (a.slice(0, 7) === b.slice(0, 7)) return dayNum(a) + "–" + fmtShort(b);
    return fmtShort(a) + " – " + fmtShort(b);
  }
  function fmtMonth(first) {
    var d = new Date(toMs(first));
    return MONTHS_LONG[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }
  // "09:00" -> "9:00" (24-hour, no leading zero).
  function fmtTime(t) {
    var m = /^(\d{2}):(\d{2})$/.exec(t || "");
    return m ? Number(m[1]) + ":" + m[2] : t || "";
  }
  function timeText(item) {
    if (item.allDay || !item.startTime) return "";
    return item.endTime ? fmtTime(item.startTime) + "–" + fmtTime(item.endTime) : fmtTime(item.startTime);
  }
  function endOf(item) {
    return item.end || item.start;
  }
  function whenText(item) {
    if (item.allDay || !item.startTime) {
      var end = endOf(item);
      return end && end !== item.start ? fmtDay(item.start) + " – " + fmtDay(end) : fmtDay(item.start);
    }
    return fmtDay(item.start) + ", " + timeText(item);
  }
  // "Every 3 weeks"; "Every day" for 1 day.
  function everyText(every, unit) {
    return "Every " + (Number(every) === 1 ? unit : every + " " + unit + "s");
  }
  function repeatText(repeat, until, every, unit) {
    if (!repeat || repeat === "none") return "";
    var base = repeat === "custom" ? everyText(every, unit) : REPEAT_LABELS[repeat] || repeat;
    return base + (until ? " until " + fmtShort(until) : "");
  }
  function layerLabel(id) {
    return state.labels[id] || LAYER_LABELS[id] || id;
  }
  function addMinutes(t, n) {
    var m = /^(\d{2}):(\d{2})$/.exec(t || "");
    if (!m) return "";
    var total = Math.min(Number(m[1]) * 60 + Number(m[2]) + n, 23 * 60 + 59);
    var hh = Math.floor(total / 60), mm = total % 60;
    return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
  }

  // ---------- DOM ----------

  function $(id) {
    return document.getElementById(id);
  }
  function el(tag, props) {
    var node = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v === false || v === null || v === undefined) return;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid);
    }
    return node;
  }

  // ---------- requests (errors carry .status and .body, so a 409 brings .body.event) ----------

  async function call(method, path, body) {
    var res = await fetch(path, {
      method: method,
      credentials: "same-origin",
      headers: body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
      return new Promise(function () {});
    }
    var data = null;
    if (res.status !== 204) {
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
    }
    if (!res.ok) {
      var err = new Error((data && data.error) || "Request failed (" + res.status + ")");
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  // ---------- state ----------

  var state = {
    userId: 0,
    today: null,
    layers: [], // [{id, label, canPost}], visible layers only
    labels: {},
    defaultLayer: null,
    canEdit: false,
    canJobs: false,
    off: new Set(), // layer ids switched off
    month: null, // first of the month shown
    gridFrom: null,
    monthData: null,
    weekData: null,
    selected: null, // the day listed under the compact month (phone)
    monthSeq: 0,
  };

  function storeKey(name) {
    return "cc.planner." + name + "." + state.userId;
  }
  function readOff() {
    try {
      var raw = localStorage.getItem(storeKey("layersOff"));
      var list = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(list) ? list.filter(function (x) { return typeof x === "string"; }) : []);
    } catch (e) {
      return new Set();
    }
  }
  function writeOff() {
    try {
      localStorage.setItem(storeKey("layersOff"), JSON.stringify(Array.from(state.off)));
    } catch (e) {
      /* storage blocked: the choice lasts until the page is left */
    }
  }
  function readLastLayer() {
    try {
      return localStorage.getItem(storeKey("lastLayer"));
    } catch (e) {
      return null;
    }
  }
  function writeLastLayer(id) {
    try {
      localStorage.setItem(storeKey("lastLayer"), id);
    } catch (e) {
      /* not remembered */
    }
  }

  function postable() {
    return state.layers.filter(function (l) { return l.canPost; });
  }
  function canCreate() {
    return state.canEdit && postable().length > 0;
  }
  function isOn(layerId) {
    return !state.off.has(layerId);
  }
  function shown(list) {
    return (list || []).filter(function (it) { return isOn(it.layer); });
  }
  function onDay(list, d) {
    return list.filter(function (it) { return it.start <= d && endOf(it) >= d; });
  }
  // All-day items first (in the server's order), then timed ones by start time.
  function dayOrder(list) {
    var allDay = list.filter(function (it) { return it.allDay || !it.startTime; });
    var timed = list.filter(function (it) { return !(it.allDay || !it.startTime); });
    timed.sort(function (a, b) { return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0; });
    return allDay.concat(timed);
  }
  function bandFor(data, monday) {
    if (!data || !isOn("install")) return null;
    var hit = (data.weeks || []).filter(function (w) { return w.weekStart === monday; })[0];
    if (!hit) return null;
    if (!(hit.manufacturing || []).length && !(hit.installing || []).length) return null;
    return hit;
  }
  // The two weeks are always this week and next, whatever month the grid shows.
  function fortnightFrom() {
    return mondayOf(state.today);
  }
  function inFortnight(d) {
    var from = fortnightFrom();
    return !!state.today && d >= from && d <= addDays(from, 13);
  }
  // The loaded events that cover a day: the two weeks' for those days (the month may have moved).
  function itemsFor(d) {
    var data = inFortnight(d) && state.weekData ? state.weekData : state.monthData;
    return data ? shown(data.events) : [];
  }
  function findItem(id) {
    var lists = [state.monthData, state.weekData];
    for (var i = 0; i < lists.length; i++) {
      var d = lists[i];
      if (!d) continue;
      var hit = (d.events || []).filter(function (it) { return it.id === id; })[0];
      if (hit) return hit;
    }
    return null;
  }

  function say(text, kind) {
    var s = $("plStatus");
    s.textContent = text || "";
    s.className = "pl-status" + (kind === "err" ? " pl-status-err" : "");
  }

  // ---------- item chips ----------

  // A clickable item: the layer marker (a 3 px left edge; Personal an outline), the time, the
  // title, "overdue" for overdue invoices and the source label on automatic items. On paper the
  // marker goes and the layer name in brackets comes first.
  function chip(item, opts) {
    var o = opts || {};
    var cls = "pl-chip pl-l-" + item.layer;
    if (o.compact) cls += " pl-chip-sm";
    if (o.bar) cls += " pl-bar";
    if (item.overdue) cls += " pl-overdue";
    var full = (timeText(item) ? timeText(item) + " " : "") + item.title + (item.overdue ? " (overdue)" : "");
    var b = el("button", { type: "button", class: cls, title: full });
    b.append(el("span", { class: "pl-pre", text: "[" + layerLabel(item.layer) + "] " }));
    if (!item.allDay && item.startTime) {
      b.append(el("span", { class: "pl-time", text: o.compact ? fmtTime(item.startTime) : timeText(item) }), " ");
    }
    b.append(el("span", { class: "pl-title", text: item.title }));
    if (item.overdue) b.append(" ", el("span", { class: "pl-flag", text: "overdue" }));
    if (item.sourceLabel) b.append(" ", el("span", { class: "pl-src", text: item.sourceLabel }));
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      openDetail(item);
    });
    return b;
  }

  // "Manufacturing: A, B" and "Installing: C" for a week, from the board band.
  function bandBlock(band, cls) {
    var box = el("div", { class: cls });
    function line(label, jobs) {
      var p = el("p", { class: "pl-band-line" });
      p.append(el("span", { class: "pl-pre", text: "[" + layerLabel("install") + "] " }));
      p.append(el("span", { class: "pl-band-k", text: label + ": " }));
      jobs.forEach(function (j, i) {
        if (i) p.append(", ");
        p.append(j.link ? el("a", { href: j.link, text: j.name }) : el("span", { text: j.name }));
      });
      return p;
    }
    if ((band.manufacturing || []).length) box.append(line("Manufacturing", band.manufacturing));
    if ((band.installing || []).length) box.append(line("Installing", band.installing));
    return box;
  }

  // ---------- the month grid (desktop and print) ----------

  function placeAt(node, col, colEnd, row) {
    node.style.gridColumn = col + " / " + colEnd;
    node.style.gridRow = String(row);
    return node;
  }
  // Grid rows in a week: 1 band, 2 day numbers, 3-5 the screen lanes, 6 "+N more" on screen,
  // 7 the extra lane printed (8-9 spare), 10 "+N more" on paper (and the filler).
  function laneRow(lane) {
    return lane < SCREEN_LANES ? 3 + lane : 4 + lane;
  }

  function weekRow(monday, items, band) {
    var sunday = addDays(monday, 6);
    var row = el("div", { class: "pl-wk" });
    if (band) row.append(placeAt(bandBlock(band, "pl-band"), 1, 8, 1));
    for (var c = 0; c < 7; c++) {
      (function (d, col) {
        var out = d.slice(0, 7) !== state.month.slice(0, 7);
        var cell = el("div", { class: "pl-cell" + (col === 0 ? " pl-first" : "") + (out ? " pl-out" : "") + (d === state.today ? " pl-today" : "") });
        cell.style.gridColumn = String(col + 1);
        cell.style.gridRow = "2 / -1";
        if (canCreate()) {
          cell.classList.add("pl-cell-add");
          cell.addEventListener("click", function () { openForm({ date: d }); });
        }
        row.append(cell);
        var num = el("button", {
          type: "button",
          class: "pl-num" + (out ? " pl-out" : "") + (d === state.today ? " pl-num-today" : ""),
          text: dayNum(d),
          "aria-label": fmtDay(d) + (d === state.today ? ", today" : "") + (inFortnight(d) ? ": show it in the two weeks" : ": list the day"),
        });
        // A day in the two weeks is shown there (scrolled to and highlighted); any other day is listed.
        num.addEventListener("click", function (e) {
          e.stopPropagation();
          if (!showTile(d)) openDay(d);
        });
        row.append(placeAt(num, col + 1, col + 2, 2));
      })(addDays(monday, c), c);
    }

    var inWeek = items.filter(function (it) { return it.start <= sunday && endOf(it) >= monday; });
    var multi = inWeek.filter(function (it) { return endOf(it) !== it.start; });
    var single = inWeek.filter(function (it) { return endOf(it) === it.start; });
    multi.sort(function (a, b) {
      if (a.start !== b.start) return a.start < b.start ? -1 : 1;
      return daysBetween(b.start, endOf(b)) - daysBetween(a.start, endOf(a));
    });
    var lanes = [];
    var hiddenScreen = [0, 0, 0, 0, 0, 0, 0];
    var hiddenPrint = [0, 0, 0, 0, 0, 0, 0];
    function free(l, a, b) {
      for (var i = a; i <= b; i++) if (lanes[l] && lanes[l][i]) return false;
      return true;
    }
    function place(it, a, b) {
      var l = 0;
      while (!free(l, a, b)) l++;
      lanes[l] = lanes[l] || [];
      for (var i = a; i <= b; i++) {
        lanes[l][i] = true;
        if (l >= SCREEN_LANES) hiddenScreen[i]++;
        if (l >= PRINT_LANES) hiddenPrint[i]++;
      }
      if (l >= PRINT_LANES) return;
      var node = chip(it, { compact: true, bar: a !== b });
      if (it.start < monday) node.classList.add("pl-cont-l");
      if (endOf(it) > sunday) node.classList.add("pl-cont-r");
      if (l >= SCREEN_LANES) node.classList.add("pl-printonly");
      row.append(placeAt(node, a + 1, b + 2, laneRow(l)));
    }
    multi.forEach(function (it) {
      place(it, Math.max(0, daysBetween(monday, it.start)), Math.min(6, daysBetween(monday, endOf(it))));
    });
    single.forEach(function (it) {
      var col = daysBetween(monday, it.start);
      place(it, col, col);
    });
    for (var k = 0; k < 7; k++) {
      (function (col, d) {
        if (hiddenScreen[col] > 0) {
          var more = el("button", {
            type: "button",
            class: "pl-more pl-screenonly",
            text: "+" + hiddenScreen[col] + " more",
            "aria-label": hiddenScreen[col] + " more on " + fmtDay(d),
          });
          more.addEventListener("click", function (e) {
            e.stopPropagation();
            openDay(d);
          });
          row.append(placeAt(more, col + 1, col + 2, 3 + SCREEN_LANES));
        }
        if (hiddenPrint[col] > 0) {
          row.append(placeAt(el("span", { class: "pl-more pl-printonly", text: "+" + hiddenPrint[col] + " more" }), col + 1, col + 2, 10));
        }
      })(k, addDays(monday, k));
    }
    return row;
  }

  function renderGrid() {
    var grid = $("plGrid");
    var head = el("div", { class: "pl-dow", "aria-hidden": "true" });
    DAY_NAMES.forEach(function (n) { head.append(el("span", { text: n })); });
    var kids = [head];
    var items = state.monthData ? shown(state.monthData.events) : [];
    for (var w = 0; w < 6; w++) {
      var monday = addDays(state.gridFrom, 7 * w);
      kids.push(weekRow(monday, items, bandFor(state.monthData, monday)));
    }
    grid.replaceChildren.apply(grid, kids);
  }

  // ---------- the compact month (phone) ----------

  function renderCompact() {
    var box = $("plCompact");
    var head = el("div", { class: "pl-dow", "aria-hidden": "true" });
    DAY_NAMES.forEach(function (n) { head.append(el("span", { text: n.slice(0, 1) })); });
    var days = el("div", { class: "pl-cdays" });
    var items = state.monthData ? shown(state.monthData.events) : [];
    for (var i = 0; i < 42; i++) {
      (function (d) {
        var list = onDay(items, d);
        var out = d.slice(0, 7) !== state.month.slice(0, 7);
        var b = el("button", {
          type: "button",
          class: "pl-cday" + (out ? " pl-out" : "") + (d === state.today ? " pl-today" : ""),
          "aria-pressed": String(d === state.selected),
          "aria-label": fmtDay(d) + (list.length ? ", " + list.length + (list.length === 1 ? " item" : " items") : ", nothing on"),
        });
        b.append(el("span", { class: "pl-cnum", text: dayNum(d) }));
        var dots = el("span", { class: "pl-dots", "aria-hidden": "true" });
        list.slice(0, 3).forEach(function (it) { dots.append(el("span", { class: "pl-dot pl-l-" + it.layer })); });
        b.append(dots);
        if (list.length) b.append(el("span", { class: "pl-count", "aria-hidden": "true", text: String(list.length) }));
        b.addEventListener("click", function () {
          state.selected = d;
          renderCompact();
          renderDayList();
        });
        days.append(b);
      })(addDays(state.gridFrom, i));
    }
    box.replaceChildren(head, days);
  }

  function renderDayList() {
    var box = $("plDayList");
    var d = state.selected;
    if (!d) {
      box.replaceChildren();
      return;
    }
    var items = dayOrder(onDay(state.monthData ? shown(state.monthData.events) : [], d));
    var head = el("div", { class: "pl-daylist-head" }, el("h3", { class: "pl-h3", text: fmtDay(d) }));
    if (canCreate()) {
      var add = el("button", { type: "button", class: "hs-btn", text: "Add" , "aria-label": "New event on " + fmtDay(d) });
      add.addEventListener("click", function () { openForm({ date: d }); });
      head.append(add);
    }
    var list = el("div", { class: "pl-list" });
    items.forEach(function (it) { list.append(chip(it)); });
    if (!items.length) list.append(el("p", { class: "pl-none", text: "Nothing on." }));
    box.replaceChildren(head, list);
  }

  // ---------- this week and next ----------

  // The fuller item for a day tile: when ("9:00–10:00", "All day" or "12–14 Oct" for an item over
  // several days), the title over up to three lines, then the source label (automatic items) and the
  // layer name, small. The marker is the chip's left edge as everywhere; on paper the layer name in
  // brackets comes first and the line runs on.
  function itemCard(item) {
    var cls = "pl-chip pl-item pl-l-" + item.layer + (item.overdue ? " pl-overdue" : "");
    var when = timeText(item);
    var multi = endOf(item) !== item.start;
    var full = (when ? when + " " : "") + item.title + (item.overdue ? " (overdue)" : "");
    var b = el("button", { type: "button", class: cls, title: full });
    b.append(el("span", { class: "pl-pre", text: "[" + layerLabel(item.layer) + "] " }));
    var w = el("span", { class: "pl-item-when" });
    if (when) w.append(el("span", { class: "pl-time", text: when }));
    else if (multi) w.append(el("span", { class: "pl-time pl-when-span", text: fmtRange(item.start, endOf(item)) }));
    else w.append(el("span", { class: "pl-time pl-when-allday", text: "All day" }));
    if (item.overdue) w.append(" ", el("span", { class: "pl-flag", text: "overdue" }));
    b.append(w, " ", el("span", { class: "pl-title", text: item.title }));
    var meta = el("span", { class: "pl-item-meta" });
    if (item.sourceLabel) meta.append(el("span", { class: "pl-src", text: item.sourceLabel }), " ");
    meta.append(el("span", { class: "pl-item-layer", text: layerLabel(item.layer) }));
    b.append(" ", meta);
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      openDetail(item);
    });
    return b;
  }

  // "Installing: job" on that job's assigned days, from the board band.
  function installCard(j) {
    var line = el(j.link ? "a" : "span", { class: "pl-chip pl-item pl-chip-static pl-l-install", href: j.link || null });
    line.append(
      el("span", { class: "pl-pre", text: "[" + layerLabel("install") + "] " }),
      el("span", { class: "pl-item-when" }, el("span", { class: "pl-time pl-when-allday", text: "All day" })),
      " ",
      el("span", { class: "pl-title", text: "Installing: " + j.name }),
      " ",
      el("span", { class: "pl-item-meta" }, el("span", { class: "pl-src", text: "Board" }), " ", el("span", { class: "pl-item-layer", text: layerLabel("install") }))
    );
    return line;
  }

  // One day tile: the day and date, every item (up to TILE_CAP on screen, then "+N more"; all on
  // paper), "Nothing on." when empty, and an Add button for those who may post.
  function dayTile(d, items, band) {
    var today = d === state.today;
    var tile = el("div", { class: "pl-tile" + (today ? " pl-today" : ""), "data-date": d, tabindex: "-1", role: "group", "aria-label": fmtDay(d) + (today ? ", today" : "") });
    var head = el(
      "h3",
      { class: "pl-tile-h" },
      el("span", { class: "pl-tile-dow", text: DAY_NAMES[dayIndex(d)] }),
      el("span", { class: "pl-tile-date", text: fmtShort(d) })
    );
    if (today) head.append(el("span", { class: "pl-tag", text: "Today" }));
    tile.append(head);
    var cards = dayOrder(onDay(items, d)).map(itemCard);
    if (band) {
      (band.installing || []).forEach(function (j) {
        if ((j.days || []).includes(d)) cards.push(installCard(j));
      });
    }
    var list = el("div", { class: "pl-list pl-tile-list" });
    cards.forEach(function (c, i) {
      if (i >= TILE_CAP) c.classList.add("pl-printonly");
      list.append(c);
    });
    if (!cards.length) list.append(el("p", { class: "pl-none", text: "Nothing on." }));
    tile.append(list);
    if (cards.length > TILE_CAP) {
      var rest = cards.length - TILE_CAP;
      var more = el("button", { type: "button", class: "pl-more pl-screenonly", text: "+" + rest + " more", "aria-label": rest + " more on " + fmtDay(d) });
      more.addEventListener("click", function (e) {
        e.stopPropagation();
        openDay(d);
      });
      tile.append(more);
    }
    if (canCreate()) {
      var add = el("button", { type: "button", class: "pl-tile-add pl-screenonly", text: "Add", "aria-label": "New event on " + fmtDay(d) });
      add.addEventListener("click", function (e) {
        e.stopPropagation();
        openForm({ date: d });
      });
      tile.append(add);
      // The tile's empty area starts a new event on that day too.
      tile.classList.add("pl-cell-add");
      tile.addEventListener("click", function (e) {
        if (e.target.closest("a, button")) return;
        openForm({ date: d });
      });
    }
    return tile;
  }

  // This week and next: a heading and the board band over each week's row of seven tiles, every
  // day shown even when empty (a list of days on the phone).
  function renderWeeks() {
    var box = $("plWeeks");
    if (!state.weekData) return;
    var items = shown(state.weekData.events);
    var from = fortnightFrom();
    var kids = [];
    for (var w = 0; w < 2; w++) {
      var monday = addDays(from, 7 * w);
      var sunday = addDays(monday, 6);
      var band = bandFor(state.weekData, monday);
      var name = w === 0 ? "This week" : "Next week";
      var sec = el("section", { class: "pl-wk2", "aria-label": name + ", " + fmtRange(monday, sunday) });
      var title = el("h2", { class: "pl-wk2-title" }, name, el("span", { class: "pl-wk2-range", text: fmtRange(monday, sunday) }));
      sec.append(el("div", { class: "hs-sectionbar pl-wk2-bar" }, title));
      if (band) sec.append(bandBlock(band, "pl-band pl-band-wk"));
      var row = el("div", { class: "pl-tiles" });
      for (var c = 0; c < 7; c++) row.append(dayTile(addDays(monday, c), items, band));
      sec.append(row);
      kids.push(sec);
    }
    box.replaceChildren.apply(box, kids);
  }

  // From the month: bring a day of the two weeks into view and highlight it. False when the day
  // isn't in the two weeks (or the tile isn't on screen), so the caller lists it instead.
  var hitTimer = null;
  function showTile(d) {
    if (!inFortnight(d)) return false;
    var tile = document.querySelector('.pl-tile[data-date="' + d + '"]');
    if (!tile || !tile.getClientRects().length) return false;
    document.querySelectorAll(".pl-tile-hit").forEach(function (t) { t.classList.remove("pl-tile-hit"); });
    tile.classList.add("pl-tile-hit");
    tile.scrollIntoView({ block: "nearest", behavior: "smooth" });
    tile.focus({ preventScroll: true });
    clearTimeout(hitTimer);
    hitTimer = setTimeout(function () { tile.classList.remove("pl-tile-hit"); }, 1800);
    return true;
  }

  // ---------- layer buttons ----------

  function renderLayers() {
    var box = $("plLayers");
    var kids = state.layers.map(function (l) {
      var b = el("button", { type: "button", class: "hs-btn pl-layer pl-l-" + l.id, "aria-pressed": String(isOn(l.id)) });
      b.append(el("span", { class: "pl-mark", "aria-hidden": "true" }), el("span", { text: l.label }));
      b.addEventListener("click", function () {
        if (state.off.has(l.id)) state.off.delete(l.id);
        else state.off.add(l.id);
        writeOff();
        renderLayers();
        renderAll();
      });
      return b;
    });
    box.replaceChildren.apply(box, kids);
  }

  function renderFoot() {
    var on = state.layers.filter(function (l) { return isOn(l.id); }).map(function (l) { return l.label; });
    $("plPrintFoot").textContent =
      "Layers: " + (on.length ? on.join(", ") : "none") + ". Printed " + fmtLong(state.today) + ".";
  }

  function renderAll() {
    if (!state.month) return;
    $("plMonthTitle").textContent = fmtMonth(state.month);
    if (state.monthData) {
      renderGrid();
      renderCompact();
      renderDayList();
    }
    renderWeeks();
    renderFoot();
  }

  // ---------- loading ----------

  function eventsUrl(from, to) {
    return "/api/planner/events?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
  }

  async function loadMonth() {
    var seq = ++state.monthSeq;
    var from = mondayOf(state.month);
    var data = await call("GET", eventsUrl(from, addDays(from, 41)));
    if (seq !== state.monthSeq) return false; // a later move won
    state.gridFrom = from;
    state.monthData = data;
    if (!state.selected || state.selected < from || state.selected > addDays(from, 41)) {
      state.selected = state.today.slice(0, 7) === state.month.slice(0, 7) ? state.today : state.month;
    }
    return true;
  }

  async function loadWeeks() {
    var from = mondayOf(state.today);
    state.weekData = await call("GET", eventsUrl(from, addDays(from, 13)));
  }

  async function reload() {
    try {
      await Promise.all([loadMonth(), loadWeeks()]);
      renderAll();
      return true;
    } catch (e) {
      say(e.message, "err");
      return false;
    }
  }

  async function moveMonth(first) {
    state.month = first;
    $("plMonthTitle").textContent = fmtMonth(first);
    try {
      if (await loadMonth()) renderAll();
    } catch (e) {
      say(e.message, "err");
    }
  }

  // ---------- dialogs ----------

  var current = null; // one dialog at a time

  function openDialogEl(label, extra) {
    if (current) {
      try {
        current.close();
      } catch (e) {
        /* already closed */
      }
    }
    var dlg = el("dialog", { class: "cc-dialog pl-dialog" + (extra ? " " + extra : ""), "aria-label": label });
    dlg.addEventListener("close", function () {
      if (current === dlg) current = null;
      dlg.remove();
    });
    document.body.append(dlg);
    current = dlg;
    return dlg;
  }

  // A question with a few answers. Resolves with the chosen value, or null when cancelled.
  // opts.run(value) may do the work and throw; its message then shows in the dialog.
  function ask(title, note, choices, opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var dlg = openDialogEl(title);
      var settled = false;
      var err = el("p", { class: "cc-dialog-error", role: "alert" });
      var actions = el("div", { class: "cc-dialog-actions" });
      var cancel = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Cancel" });
      cancel.addEventListener("click", function () { dlg.close(); });
      actions.append(cancel);
      choices.forEach(function (c, i) {
        var last = i === choices.length - 1;
        var cls = "hs-btn" + (last ? (o.stop ? " hs-btn-stop" : " hs-btn-primary") : o.stop ? " hs-btn-stop" : "");
        var b = el("button", { type: "button", class: cls, text: c[1] });
        b.addEventListener("click", async function () {
          if (o.run) {
            err.textContent = "";
            actions.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
            try {
              await o.run(c[0]);
            } catch (e) {
              err.textContent = e.message;
              actions.querySelectorAll("button").forEach(function (x) { x.disabled = false; });
              return;
            }
          }
          settled = true;
          resolve(c[0]);
          dlg.close();
        });
        actions.append(b);
      });
      dlg.addEventListener("close", function () {
        if (!settled) resolve(null);
      });
      var box = el("div", { class: "cc-dialog-form" }, el("h2", { class: "cc-dialog-title", text: title }));
      if (note) box.append(el("p", { class: "cc-dialog-note", text: note }));
      box.append(err, actions);
      dlg.append(box);
      dlg.showModal();
    });
  }

  function kv(rows) {
    var box = el("div", { class: "hs-kvt pl-kvt" });
    rows.forEach(function (r) {
      if (!r) return;
      box.append(el("div", { class: "k", text: r[0] }));
      var v = el("div", { class: "v" });
      if (typeof r[1] === "string") v.textContent = r[1];
      else v.append(r[1]);
      box.append(v);
    });
    return box;
  }

  function openDetail(item) {
    var dlg = openDialogEl(item.title, "pl-detail");
    var box = el("div", { class: "cc-dialog-form" });
    var head = el("div", { class: "pl-detail-head" });
    head.append(el("span", { class: "pl-mark pl-l-" + item.layer, "aria-hidden": "true" }));
    head.append(el("h2", { class: "cc-dialog-title", text: item.title }));
    box.append(head);
    // Automatic items are read-only and show their source; a hand-made one (readOnly false) can be
    // changed only when the server says this viewer may (canEdit).
    var auto = !!item.readOnly || item.source !== "event";
    if (auto && item.sourceLabel) box.append(el("p", { class: "pl-src pl-src-detail", text: "Automatic · " + item.sourceLabel }));
    var rows = [["Layer", layerLabel(item.layer)], ["When", whenText(item)]];
    if (item.overdue) rows.push(["Status", el("span", { class: "pl-flag", text: "Overdue" })]);
    if (!auto) {
      if (item.repeat && item.repeat !== "none") rows.push(["Repeats", repeatText(item.repeat, item.repeatUntil, item.repeatEvery, item.repeatUnit)]);
      if (item.reminder) {
        rows.push(["Reminder", (REMINDER_LABELS[item.reminder] || item.reminder) + (item.remindLayer ? ", to everyone on this layer" : "")]);
      }
    }
    if (item.job) {
      rows.push(["Job", item.link && !auto ? el("a", { href: item.link, text: item.job.name }) : item.job.name]);
    }
    if (item.notes) rows.push(["Notes", el("span", { class: "pl-notes", text: item.notes })]);
    if (!auto && item.createdBy) rows.push(["Added by", item.createdBy.name]);
    box.append(kv(rows));
    if (item.changed) box.append(el("p", { class: "cc-dialog-note", text: "This date was changed on its own." }));

    var actions = el("div", { class: "cc-dialog-actions" });
    var close = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Close" });
    close.addEventListener("click", function () { dlg.close(); });
    actions.append(close);
    if (auto) {
      if (item.link) actions.append(el("a", { class: "hs-btn hs-btn-primary", href: item.link, text: "Open" }));
    } else if (!item.readOnly && item.canEdit) {
      var del = el("button", { type: "button", class: "hs-btn hs-btn-stop", text: "Delete" });
      del.addEventListener("click", function () { startDelete(item); });
      var edit = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "Edit" });
      edit.addEventListener("click", function () { startEdit(item); });
      actions.append(del, edit);
    }
    box.append(actions);
    dlg.append(box);
    dlg.showModal();
  }

  // Everything on one day: from the day number or "+N more".
  function openDay(d) {
    var dlg = openDialogEl(fmtDay(d), "pl-daydlg");
    var box = el("div", { class: "cc-dialog-form" }, el("h2", { class: "cc-dialog-title", text: fmtDay(d) }));
    var items = dayOrder(onDay(itemsFor(d), d));
    var list = el("div", { class: "pl-list" });
    items.forEach(function (it) { list.append(chip(it)); });
    if (!items.length) list.append(el("p", { class: "pl-none", text: "Nothing on." }));
    box.append(list);
    var actions = el("div", { class: "cc-dialog-actions" });
    var close = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Close" });
    close.addEventListener("click", function () { dlg.close(); });
    actions.append(close);
    if (canCreate()) {
      var add = el("button", { type: "button", class: "hs-btn hs-btn-primary", text: "New event" });
      add.addEventListener("click", function () { openForm({ date: d }); });
      actions.append(add);
    }
    box.append(actions);
    dlg.append(box);
    dlg.showModal();
  }

  var SCOPE_CHOICES = [["one", "This one"], ["later", "This and all later"]];

  async function startEdit(item) {
    var scope = null;
    if (item.repeat && item.repeat !== "none") {
      scope = await ask("Edit a repeating event", "Change " + fmtDay(item.occurrence) + " only, or this date and every later one?", SCOPE_CHOICES);
      if (!scope) return;
    }
    var series;
    try {
      series = await call("GET", "/api/planner/events/" + encodeURIComponent(item.eventId));
    } catch (e) {
      say(e.status === 404 ? "That event isn't on the planner any more." : e.message, "err");
      reload();
      return;
    }
    openForm({ series: series, item: item, scope: scope });
  }

  function startDelete(item) {
    var repeating = item.repeat && item.repeat !== "none";
    var updatedAt = item.updatedAt;
    function run(choice) {
      var q = "?updatedAt=" + encodeURIComponent(updatedAt);
      if (repeating) q += "&scope=" + encodeURIComponent(choice) + "&occurrence=" + encodeURIComponent(item.occurrence);
      return call("DELETE", "/api/planner/events/" + encodeURIComponent(item.eventId) + q).catch(function (e) {
        if (e.status === 409 && e.body && e.body.event) {
          updatedAt = e.body.event.updatedAt;
          reload();
        }
        throw e;
      });
    }
    var p = repeating
      ? ask("Delete a repeating event", "Delete " + fmtDay(item.occurrence) + " only, or this date and every later one?", SCOPE_CHOICES, { stop: true, run: run })
      : ask("Delete this event?", item.title, [["yes", "Delete"]], { stop: true, run: run });
    p.then(function (choice) {
      if (!choice) return;
      say("Deleted.");
      reload();
    });
  }

  // ---------- the job picker (as taskui.js: /api/job-records?archived=0, "Name (#id)") ----------

  var jobsPromise = null;
  function loadJobs() {
    if (!state.canJobs) return Promise.resolve([]);
    if (!jobsPromise) {
      jobsPromise = call("GET", "/api/job-records?archived=0")
        .then(function (d) {
          var list = Array.isArray(d) ? d : (d && (d.rows || d.jobs)) || [];
          return list.map(function (j) { return { id: j.id, name: j.name }; });
        })
        .catch(function () {
          jobsPromise = null;
          return [];
        });
    }
    return jobsPromise;
  }
  function jobLabel(j) {
    return j.name + " (#" + j.id + ")";
  }

  // ---------- new and edit ----------

  var fieldSeq = 0;
  function field(label, control, cls) {
    var id = "plf" + ++fieldSeq;
    control.id = id;
    return el("div", { class: "cc-field" + (cls ? " " + cls : "") }, el("label", { class: "cc-field-label", for: id, text: label }), control);
  }
  function input(type, props) {
    var p = props || {};
    p.type = type;
    p.class = "hs-input" + (p.class ? " " + p.class : "");
    return el("input", p);
  }
  function select(options, props) {
    var p = props || {};
    p.class = "hs-input";
    var s = el("select", p);
    options.forEach(function (o) { s.append(el("option", { value: o[0], text: o[1] })); });
    return s;
  }

  // The values a form starts from.
  //   new:            {date}
  //   edit, no scope: the series (a non-repeating event)
  //   edit, "later":  the series as it would be from this occurrence on
  //   edit, "one":    this occurrence as it shows, the rest from the series
  function startValues(ctx) {
    if (!ctx.series) {
      var last = readLastLayer();
      var layer = postable().some(function (l) { return l.id === last; }) ? last : state.defaultLayer;
      if (!postable().some(function (l) { return l.id === layer; })) layer = postable()[0] ? postable()[0].id : "";
      return {
        title: "", layer: layer, allDay: true, startDate: ctx.date, endDate: ctx.date,
        startTime: "09:00", endTime: "10:00", repeat: "none", repeatEvery: EVERY_DEFAULT, repeatUnit: UNIT_DEFAULT,
        repeatUntil: "", reminder: "", remindLayer: false, job: null, notes: "",
      };
    }
    var s = ctx.series;
    var v = {
      title: s.title, layer: s.layer, allDay: !!s.allDay, startDate: s.startDate, endDate: s.endDate,
      startTime: s.startTime || "09:00", endTime: s.endTime || "10:00", repeat: s.repeat || "none",
      repeatEvery: s.repeatEvery || EVERY_DEFAULT, repeatUnit: s.repeatUnit || UNIT_DEFAULT,
      repeatUntil: s.repeatUntil || "", reminder: s.reminder || "", remindLayer: !!s.remindLayer,
      job: s.job || null, notes: s.notes || "",
    };
    if (ctx.scope === "later") {
      var span = daysBetween(s.startDate, s.endDate);
      v.startDate = ctx.item.occurrence;
      v.endDate = addDays(ctx.item.occurrence, span);
    } else if (ctx.scope === "one") {
      var it = ctx.item;
      v.title = it.title;
      v.notes = it.notes || "";
      v.startDate = it.start;
      v.endDate = endOf(it);
      if (!v.allDay) {
        v.startTime = it.startTime || v.startTime;
        v.endTime = it.endTime || v.endTime;
      }
    }
    return v;
  }

  // ctx: {date} for a new event; {series, item, scope} to edit (scope null, "one" or "later").
  function openForm(ctx) {
    var create = !ctx.series;
    if (create && !canCreate()) return;
    var scope = create ? null : ctx.scope;
    var series = ctx.series || null;
    var item = ctx.item || null;
    var one = scope === "one";
    var title = create ? "New event" : one ? "Edit " + fmtDay(item.occurrence) + " only" : scope === "later" ? "Edit this and all later" : "Edit event";
    var dlg = openDialogEl(title, "pl-formdlg");
    var jobs = [];
    var endTouched = false;
    var busy = false;
    var init = startValues(ctx);

    // controls
    var fTitle = input("text", { maxlength: "200", autocomplete: "off", required: true });
    var layerChoices = postable().map(function (l) { return [l.id, l.label]; });
    if (init.layer && !layerChoices.some(function (c) { return c[0] === init.layer; })) {
      layerChoices.push([init.layer, layerLabel(init.layer)]);
    }
    var fLayer = select(layerChoices);
    var fAllDay = el("input", { type: "checkbox", class: "pl-check" });
    var fStart = input("date");
    var fEnd = input("date");
    var fStartTime = input("time", { step: "300" });
    var fEndTime = input("time", { step: "300" });
    var fRepeat = select(REPEAT_OPTIONS);
    var fEvery = input("number", { min: "1", max: "99", step: "1", inputmode: "numeric", class: "pl-every-n" });
    var fUnit = select(REPEAT_UNITS.map(function (u) { return [u, u + "s"]; }), { "aria-label": "Unit of time" });
    var fUntil = input("date");
    var fReminder = select([]);
    var fRemindLayer = el("input", { type: "checkbox", class: "pl-check" });
    var fJob = input("text", { list: "plJobList", autocomplete: "off", placeholder: "Type to find a job" });
    var jobList = el("datalist", { id: "plJobList" });
    var fNotes = el("textarea", { class: "hs-input pl-notes-in", rows: "4", maxlength: "4000" });
    var err = el("p", { class: "cc-dialog-error", role: "alert" });
    var warn = el("p", { class: "pl-warn", role: "status" });

    var startLabel = el("span", { text: "Start date" });
    var fStartWrap = field("Start date", fStart);
    fStartWrap.querySelector("label").replaceChildren(startLabel);
    var fEndWrap = field("End date", fEnd);
    var fStartTimeWrap = field("Start time", fStartTime);
    var fEndTimeWrap = field("End time", fEndTime);
    var fUntilWrap = field("Until (optional)", fUntil);
    // Custom repeat: "Every [number] [days|weeks|months|years]", shown only with Repeats = Custom.
    var fEveryWrap = field("Every", fEvery, "pl-wide pl-every");
    fEveryWrap.append(fUnit);
    var remindLayerWrap = el(
      "label",
      { class: "pl-checkrow" },
      fRemindLayer,
      el("span", { text: "Remind everyone on this layer" })
    );
    var jobWrap = field("Job", fJob, "pl-wide");
    jobWrap.append(jobList);

    function fill(v) {
      fTitle.value = v.title;
      fLayer.value = v.layer;
      fAllDay.checked = v.allDay;
      fStart.value = v.startDate;
      fEnd.value = v.endDate;
      fStartTime.value = v.startTime;
      fEndTime.value = v.endTime;
      fRepeat.value = v.repeat;
      fEvery.value = v.repeatEvery;
      fUnit.value = v.repeatUnit;
      fUntil.value = v.repeatUntil;
      fNotes.value = v.notes;
      fJob.value = v.job ? jobLabel(v.job) : "";
      fillReminders(v.reminder);
      fRemindLayer.checked = v.remindLayer;
      endTouched = false;
      sync();
    }
    function fillReminders(chosen) {
      var keys = fAllDay.checked ? REMINDERS_ALL_DAY : REMINDERS_TIMED;
      var opts = [["", "No reminder"]].concat(keys.map(function (k) { return [k, REMINDER_LABELS[k]]; }));
      fReminder.replaceChildren.apply(fReminder, opts.map(function (o) { return el("option", { value: o[0], text: o[1] }); }));
      fReminder.value = keys.indexOf(chosen) >= 0 ? chosen : "";
    }
    // Show what fits: dates or a date and times, Until with a repeat, the layer tick off Personal.
    function sync() {
      var allDay = fAllDay.checked;
      startLabel.textContent = allDay ? "Start date" : "Date";
      fEndWrap.hidden = !allDay;
      fStartTimeWrap.hidden = allDay;
      fEndTimeWrap.hidden = allDay;
      fUntilWrap.hidden = fRepeat.value === "none";
      fEveryWrap.hidden = fRepeat.value !== "custom";
      // "1 day", "3 weeks": the unit reads singular for 1.
      Array.prototype.forEach.call(fUnit.options, function (o) { o.textContent = Number(fEvery.value) === 1 ? o.value : o.value + "s"; });
      fUntil.min = fStart.value || "";
      fEnd.min = fStart.value || "";
      remindLayerWrap.hidden = fLayer.value === "personal";
      fRemindLayer.disabled = one || !fReminder.value;
      if (!fReminder.value) fRemindLayer.checked = false;
      showWarning();
    }
    // The repeat rule differs from the one the form started with (the number and unit count only for Custom).
    function ruleChanged() {
      if (fRepeat.value !== init.repeat) return true;
      return fRepeat.value === "custom" && (Number(fEvery.value) !== init.repeatEvery || fUnit.value !== init.repeatUnit);
    }
    function showWarning() {
      var text = "";
      if (scope === "later" && series && series.repeat !== "none") {
        var exc = series.exceptions || [];
        var d = item.occurrence;
        if (d === series.startDate) {
          if (exc.length && (fStart.value !== init.startDate || ruleChanged() || fAllDay.checked !== init.allDay)) {
            text = WARN_SERIES;
          }
        } else if (exc.some(function (x) { return x.occurrence >= d; })) {
          text = WARN_SPLIT;
        }
      }
      warn.textContent = text;
      warn.hidden = !text;
    }

    fAllDay.addEventListener("change", function () {
      if (!fAllDay.checked) fEnd.value = fStart.value;
      else if (!fEnd.value || fEnd.value < fStart.value) fEnd.value = fStart.value;
      fillReminders(fReminder.value);
      sync();
    });
    fStart.addEventListener("change", function () {
      if (fAllDay.checked && (!fEnd.value || fEnd.value < fStart.value)) fEnd.value = fStart.value;
      sync();
    });
    fStartTime.addEventListener("change", function () {
      if (!endTouched || !fEndTime.value || fEndTime.value <= fStartTime.value) fEndTime.value = addMinutes(fStartTime.value, 60);
    });
    fEndTime.addEventListener("change", function () { endTouched = true; });
    fRepeat.addEventListener("change", function () {
      // Choosing Custom with nothing typed yet starts at "Every 2 weeks".
      if (fRepeat.value === "custom" && !fEvery.value) fEvery.value = EVERY_DEFAULT;
      sync();
    });
    fEvery.addEventListener("input", sync);
    fUnit.addEventListener("change", sync);
    fReminder.addEventListener("change", sync);
    fLayer.addEventListener("change", sync);

    // Read the form into the API's field names.
    function values() {
      var allDay = fAllDay.checked;
      var v = {
        title: fTitle.value.trim(),
        notes: fNotes.value.replace(/\s+$/, ""),
        layer: fLayer.value,
        allDay: allDay,
        startDate: fStart.value,
        endDate: allDay ? fEnd.value : fStart.value,
        startTime: allDay ? null : fStartTime.value,
        endTime: allDay ? null : fEndTime.value || null,
        repeat: fRepeat.value,
        repeatUntil: fRepeat.value === "none" ? null : fUntil.value || null,
        reminder: fReminder.value || null,
        remindLayer: fLayer.value !== "personal" && !!fReminder.value && fRemindLayer.checked,
      };
      if (fRepeat.value === "custom") {
        var n = fEvery.value.trim();
        if (!/^\d{1,2}$/.test(n) || Number(n) < 1) throw new Error("Every must be a whole number from 1 to 99");
        v.repeatEvery = Number(n);
        v.repeatUnit = fUnit.value;
      }
      if (state.canJobs) {
        var text = fJob.value.trim();
        if (!text) v.jobId = null;
        else if (init.job && text === jobLabel(init.job)) v.jobId = init.job.id;
        else {
          var hit = jobs.filter(function (j) { return jobLabel(j) === text; })[0];
          if (!hit) throw new Error("Choose a job from the list, or clear the job box");
          v.jobId = hit.id;
        }
      }
      return v;
    }
    function baseline() {
      return {
        title: init.title, notes: init.notes, layer: init.layer, allDay: init.allDay,
        startDate: init.startDate, endDate: init.allDay ? init.endDate : init.startDate,
        startTime: init.allDay ? null : init.startTime, endTime: init.allDay ? null : init.endTime,
        repeat: init.repeat, repeatUntil: init.repeat === "none" ? null : init.repeatUntil || null,
        repeatEvery: init.repeat === "custom" ? init.repeatEvery : null, repeatUnit: init.repeat === "custom" ? init.repeatUnit : null,
        reminder: init.reminder || null, remindLayer: init.layer !== "personal" && !!init.reminder && init.remindLayer,
        jobId: init.job ? init.job.id : null,
      };
    }
    // The request body: everything for a new event; for an edit only what changed, in groups
    // (the dates and times together, the repeat with its end, the reminder with its tick).
    function requestBody() {
      var v = values();
      if (!v.title) throw new Error("Title is required");
      if (create) return v;
      var b = baseline();
      var out = { updatedAt: series.updatedAt };
      if (scope) {
        out.scope = scope;
        out.occurrence = item.occurrence;
      }
      var changed = false;
      function differs(keys) {
        return keys.some(function (k) { return k in v && v[k] !== b[k]; });
      }
      function take(keys) {
        keys.forEach(function (k) { if (k in v) out[k] = v[k]; });
        changed = true;
      }
      ["title", "notes"].forEach(function (k) { if (differs([k])) take([k]); });
      var when = one
        ? series.allDay ? ["startDate", "endDate"] : ["startDate", "endDate", "startTime", "endTime"]
        : ["allDay", "startDate", "endDate", "startTime", "endTime"];
      if (differs(when)) take(when);
      if (!one) {
        if (differs(["layer"])) take(["layer"]);
        if (differs(["jobId"])) take(["jobId"]);
        if (differs(["repeat", "repeatUntil", "repeatEvery", "repeatUnit"])) take(["repeat", "repeatUntil", "repeatEvery", "repeatUnit"]);
        if (differs(["reminder", "remindLayer"])) take(["reminder", "remindLayer"]);
      }
      return changed ? out : null;
    }

    async function save() {
      if (busy) return;
      err.textContent = "";
      var body;
      try {
        body = requestBody();
      } catch (e) {
        err.textContent = e.message;
        return;
      }
      if (!body) {
        dlg.close();
        say("Nothing changed.");
        return;
      }
      busy = true;
      saveBtn.disabled = true;
      try {
        if (create) {
          await call("POST", "/api/planner/events", body);
          writeLastLayer(body.layer);
        } else {
          await call("PATCH", "/api/planner/events/" + encodeURIComponent(series.id), body);
        }
        dlg.close();
        say("Saved.");
        reload();
      } catch (e) {
        err.textContent = e.message;
        if (e.status === 409 && e.body && e.body.event) {
          // Someone else changed it: start again from their version.
          series = e.body.event;
          ctx.series = series;
          await reload();
          if (one) {
            var fresh = findItem("e:" + series.id + ":" + item.occurrence);
            if (fresh) ctx.item = item = fresh;
          }
          init = startValues(ctx);
          fill(init);
        }
      }
      busy = false;
      saveBtn.disabled = false;
    }

    // layout
    var form = el("form", { class: "cc-dialog-form pl-form", novalidate: true });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      save();
    });
    form.append(el("h2", { class: "cc-dialog-title", text: title }));
    if (!create && series) {
      form.append(el("p", { class: "cc-dialog-note", text: layerLabel(series.layer) + (series.repeat !== "none" ? " · " + repeatText(series.repeat, series.repeatUntil, series.repeatEvery, series.repeatUnit) : "") }));
    }
    var grid = el("div", { class: "pl-fields" });
    grid.append(
      field("Title", fTitle, "pl-wide"),
      field("Layer", fLayer),
      el("label", { class: "pl-checkrow pl-checkrow-field" }, fAllDay, el("span", { text: "All day" })),
      fStartWrap,
      fEndWrap,
      fStartTimeWrap,
      fEndTimeWrap,
      field("Repeats", fRepeat),
      fUntilWrap,
      fEveryWrap,
      field("Reminder", fReminder),
      remindLayerWrap
    );
    if (state.canJobs) grid.append(jobWrap);
    grid.append(field("Notes", fNotes, "pl-wide"));
    form.append(grid);
    if (one) {
      [fLayer, fAllDay, fRepeat, fEvery, fUnit, fUntil, fReminder, fRemindLayer, fJob].forEach(function (c) { c.disabled = true; });
      form.append(el("p", { class: "cc-dialog-note pl-onenote", text: CHANGE_LATER_NOTE }));
    }
    form.append(warn, err);
    var actions = el("div", { class: "cc-dialog-actions" });
    var cancel = el("button", { type: "button", class: "hs-btn hs-btn-quiet", text: "Cancel" });
    cancel.addEventListener("click", function () { dlg.close(); });
    var saveBtn = el("button", { type: "submit", class: "hs-btn hs-btn-primary", text: create ? "Add event" : "Save" });
    actions.append(cancel, saveBtn);
    form.append(actions);
    dlg.append(form);

    fill(init);
    dlg.showModal();
    fTitle.focus();

    loadJobs().then(function (list) {
      jobs = list;
      jobList.replaceChildren.apply(jobList, list.map(function (j) { return el("option", { value: jobLabel(j) }); }));
    });
  }

  // ---------- print ----------

  var PAGE_SIZE = {
    month: "@page { size: A4 landscape; margin: 10mm; }",
    weeks: "@page { size: A4 landscape; margin: 10mm; }",
  };

  function startPrint() {
    ask("Print", "Print the month, or this week and next? Only the layers switched on are printed.", [
      ["month", "Month"],
      ["weeks", "Two weeks"],
    ]).then(function (kind) {
      if (!kind) return;
      document.body.classList.remove("pl-print-month", "pl-print-weeks");
      document.body.classList.add(kind === "month" ? "pl-print-month" : "pl-print-weeks");
      $("plPageSize").textContent = PAGE_SIZE[kind];
      renderFoot();
      // Let the dialog close before the print preview takes its picture of the page.
      setTimeout(function () { window.print(); }, 50);
    });
  }
  window.addEventListener("afterprint", function () {
    document.body.classList.remove("pl-print-month", "pl-print-weeks");
    $("plPageSize").textContent = "";
  });

  // ---------- start ----------

  async function init() {
    try {
      if (window.cc && window.cc.ready && typeof window.cc.ready.then === "function") await window.cc.ready;
    } catch (e) {
      /* the page still works without the shell */
    }
    var cc = window.cc || {};
    state.userId = cc.me && cc.me.id != null ? cc.me.id : 0;
    state.canJobs = typeof cc.can === "function" && cc.can("jobs.view");

    $("plPrev").addEventListener("click", function () { moveMonth(addMonths(state.month, -1)); });
    $("plNext").addEventListener("click", function () { moveMonth(addMonths(state.month, 1)); });
    $("plToday").addEventListener("click", function () { moveMonth(firstOfMonth(state.today)); });
    $("plPrint").addEventListener("click", startPrint);
    $("plNew").addEventListener("click", function () { openForm({ date: state.selected || state.today }); });
    $("plLayersToggle").addEventListener("click", function () {
      var open = this.getAttribute("aria-expanded") !== "true";
      this.setAttribute("aria-expanded", String(open));
      $("plLayers").classList.toggle("pl-layers-open", open);
    });

    var meta;
    try {
      meta = await call("GET", "/api/planner/layers");
    } catch (e) {
      say(e.message, "err");
      $("plMonthTitle").textContent = "Planner";
      $("plWeeks").replaceChildren(el("p", { class: "pl-empty", text: "The planner could not be loaded." }));
      return;
    }
    state.today = meta.today;
    state.layers = (meta.layers || []).slice().sort(function (a, b) {
      return LAYER_ORDER.indexOf(a.id) - LAYER_ORDER.indexOf(b.id);
    });
    state.layers.forEach(function (l) { state.labels[l.id] = l.label; });
    state.defaultLayer = meta.default;
    state.canEdit = !!meta.canEdit;
    state.off = readOff();
    $("plNew").hidden = !canCreate();

    var params = new URLSearchParams(location.search);
    var date = params.get("date");
    var wanted = params.get("event");
    state.month = firstOfMonth(isDate(date) ? date : state.today);
    if (isDate(date)) state.selected = date;
    $("plMonthTitle").textContent = fmtMonth(state.month);
    renderLayers();

    if (!(await reload())) return;
    if (wanted) {
      var hit = findItem(wanted);
      if (hit) openDetail(hit);
      else say("That event isn't on the planner any more.");
    }
  }

  // shell/shell.js loads after this script and defines window.cc, so start once the page has parsed.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
