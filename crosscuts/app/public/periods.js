// Months and financial years (docs/plans/m9-contracts.md section 4): the one home of month and
// financial-year arithmetic for BAS sales and supplier accounts, and of dollars shown and typed.
// Shared by the server (lib/bas.js and lib/suppliers.js require it) and the pages
// (<script src="/periods.js"> sets window.Periods). No dependencies, no DOM, and no clock: callers
// pass today in.
//
// A period is 'YYYY-MM' (a Sydney calendar month). A financial year is a number, the calendar year
// it ends in: FY 2027 = Jul 2026 - Jun 2027. Quarters are the FY's: Q1 Jul-Sep, Q2 Oct-Dec,
// Q3 Jan-Mar, Q4 Apr-Jun. Money is integer cents.
(function (root) {
  "use strict";

  var PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  var HISTORY_START = "2023-06";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var LONG_MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function parts(period) {
    return { y: Number(period.slice(0, 4)), m: Number(period.slice(5, 7)) };
  }

  function make(y, m) {
    return y + "-" + pad2(m);
  }

  function validPeriod(p) {
    if (typeof p !== "string" || !PERIOD_RE.test(p)) return false;
    var y = parts(p).y;
    return y >= 2000 && y <= 2099;
  }

  function periodOf(date) {
    return String(date).slice(0, 7);
  }

  function addMonths(period, n) {
    var q = parts(period);
    var i = q.y * 12 + (q.m - 1) + n;
    return make(Math.floor(i / 12), (((i % 12) + 12) % 12) + 1);
  }

  function compare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function firstDay(period) {
    return period + "-01";
  }

  function lastDay(period) {
    var q = parts(period);
    var d = new Date(Date.UTC(q.y, q.m, 0)); // day 0 of the next month
    return period + "-" + pad2(d.getUTCDate());
  }

  function label(period) {
    var q = parts(period);
    return MONTHS[q.m - 1] + " " + q.y;
  }

  function longLabel(period) {
    var q = parts(period);
    return LONG_MONTHS[q.m - 1] + " " + q.y;
  }

  function fyOf(period) {
    var q = parts(period);
    return q.m >= 7 ? q.y + 1 : q.y;
  }

  function fyMonths(fy) {
    var out = [];
    for (var i = 0; i < 12; i++) out.push(addMonths(make(fy - 1, 7), i));
    return out;
  }

  function fyLabel(fy) {
    return "FY " + fy;
  }

  function fyRangeLabel(fy) {
    return "Jul " + (fy - 1) + " – Jun " + fy;
  }

  function quarterOf(period) {
    var m = parts(period).m;
    return m >= 7 ? Math.floor((m - 7) / 3) + 1 : Math.floor((m - 1) / 3) + 3;
  }

  function quarterLabel(fy, q) {
    var names = { 1: "Jul–Sep", 2: "Oct–Dec", 3: "Jan–Mar", 4: "Apr–Jun" };
    var year = q <= 2 ? fy - 1 : fy;
    return "Q" + q + " " + names[q] + " " + year;
  }

  function currentPeriod(today) {
    return periodOf(today);
  }

  function ended(period, today) {
    return period < currentPeriod(today);
  }

  // 1234567 -> '$12,345.67'; -1200 -> '-$12.00'; null -> ''.
  function dollars(cents) {
    if (cents === null || cents === undefined) return "";
    var neg = cents < 0;
    var abs = Math.abs(cents);
    var whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + "$" + whole + "." + pad2(abs % 100);
  }

  // What Accounts types: '12,345.67', '$12345.6', '12345', '-50', '5.' -> cents; '' -> null;
  // anything else NaN. At most two decimals (a trailing dot is allowed); commas only as
  // thousands separators.
  function parseDollars(text) {
    var s = String(text === null || text === undefined ? "" : text).trim();
    if (s === "") return null;
    var m = /^(-)?\$?(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{0,2}))?$/.exec(s);
    if (!m || (m[2] === undefined && !m[3])) return NaN;
    var whole = m[2] === undefined ? 0 : Number(m[2].replace(/,/g, ""));
    var frac = !m[3] ? 0 : Number(m[3].length === 1 ? m[3] + "0" : m[3]);
    var cents = whole * 100 + frac;
    if (!Number.isSafeInteger(cents)) return NaN;
    return m[1] ? -cents : cents;
  }

  // ---- stock periods (0.2.6, docs/plans/m27-contracts.md section 2) ----
  // The stock order is counted per month ('YYYY-MM') or per fortnight ('YYYY-MM-DD', its Monday).
  // Both keys live in the same stock_orders.period column; month keys already stored stay readable.
  var DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  var DAY_MS = 86400000;

  function dayMs(s) {
    return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  }

  function msDay(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }

  function addDays(s, n) {
    return msDay(dayMs(s) + n * DAY_MS);
  }

  function validDay(s) {
    if (typeof s !== "string" || !DAY_RE.test(s)) return false;
    var y = Number(s.slice(0, 4));
    return y >= 2000 && y <= 2099 && msDay(dayMs(s)) === s;
  }

  function isMonday(s) {
    return validDay(s) && new Date(dayMs(s)).getUTCDay() === 1;
  }

  // A fortnight key: a real Monday.
  function validFortnight(p) {
    return isMonday(p);
  }

  function isFortnight(p) {
    return typeof p === "string" && p.length === 10;
  }

  function validStockPeriod(p) {
    return validPeriod(p) || validFortnight(p);
  }

  // The Monday starting the fortnight (counted from cycleStart, a Monday) that holds date.
  function fortnightOf(date, cycleStart) {
    var diff = Math.round((dayMs(date) - dayMs(cycleStart)) / DAY_MS);
    return addDays(cycleStart, Math.floor(diff / 14) * 14);
  }

  // cycle 'monthly' | 'fortnightly'.
  function currentStockPeriod(today, cycle, cycleStart) {
    return cycle === "monthly" ? currentPeriod(today) : fortnightOf(today, cycleStart);
  }

  function addStockPeriods(p, n) {
    return isFortnight(p) ? addDays(p, 14 * n) : addMonths(p, n);
  }

  function stockPeriodEnd(p) {
    return isFortnight(p) ? addDays(p, 13) : lastDay(p);
  }

  // Started by today: a month no later than this one; a fortnight whose Monday has come.
  function stockPeriodStarted(p, today) {
    return isFortnight(p) ? p <= today : p <= currentPeriod(today);
  }

  function shortDay(s) {
    return Number(s.slice(8, 10)) + " " + MONTHS[Number(s.slice(5, 7)) - 1];
  }

  // 'October 2026', or '26 Oct – 8 Nov 2026' (both years when it spans two).
  function stockLabel(p) {
    if (!isFortnight(p)) return longLabel(p);
    var end = addDays(p, 13);
    if (p.slice(0, 4) !== end.slice(0, 4)) return shortDay(p) + " " + p.slice(0, 4) + " – " + shortDay(end) + " " + end.slice(0, 4);
    return shortDay(p) + " – " + shortDay(end) + " " + end.slice(0, 4);
  }

  var Periods = {
    PERIOD_RE: PERIOD_RE,
    validFortnight: validFortnight,
    isFortnight: isFortnight,
    isMonday: isMonday,
    validStockPeriod: validStockPeriod,
    fortnightOf: fortnightOf,
    currentStockPeriod: currentStockPeriod,
    addStockPeriods: addStockPeriods,
    stockPeriodEnd: stockPeriodEnd,
    stockPeriodStarted: stockPeriodStarted,
    stockLabel: stockLabel,
    addDays: addDays,
    HISTORY_START: HISTORY_START,
    validPeriod: validPeriod,
    periodOf: periodOf,
    addMonths: addMonths,
    compare: compare,
    firstDay: firstDay,
    lastDay: lastDay,
    label: label,
    longLabel: longLabel,
    fyOf: fyOf,
    fyMonths: fyMonths,
    fyLabel: fyLabel,
    fyRangeLabel: fyRangeLabel,
    quarterOf: quarterOf,
    quarterLabel: quarterLabel,
    currentPeriod: currentPeriod,
    ended: ended,
    dollars: dollars,
    parseDollars: parseDollars,
  };

  if (typeof module === "object" && module.exports) module.exports = Periods;
  else root.Periods = Periods;
})(typeof window !== "undefined" ? window : this);
