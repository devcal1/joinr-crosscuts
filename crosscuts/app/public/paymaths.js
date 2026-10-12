// Pay-run hour maths (docs/plans/m8-contracts.md section 3): the one home of the daily split into
// normal, OT and DT, the totals, the display of hours and times, and the parsing of what Accounts
// types. Shared by the server (lib/payroll.js requires it) and the pages (<script src="/paymaths.js">
// sets window.PayMaths). No dependencies, no DOM, and no dates from the clock: callers pass them in.
//
// All hours are integer minutes; start and finish are minutes after midnight. Dates are YYYY-MM-DD
// strings and the calendar helpers are pure UTC arithmetic on them.
(function (root) {
  "use strict";

  var DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"];
  var DAY_LABELS = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri" };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var DAY_MS = 24 * 60 * 60 * 1000;

  // ------------------------------------------------------------ calendar ---

  function parse(date) {
    if (typeof date !== "string" || !DATE_RE.test(date)) return null;
    var p = date.split("-").map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.toISOString().slice(0, 10) === date ? d : null;
  }

  function fmt(d) {
    return d.toISOString().slice(0, 10);
  }

  function addDays(date, n) {
    var d = parse(date);
    d.setUTCDate(d.getUTCDate() + n);
    return fmt(d);
  }

  function daysBetween(from, to) {
    return Math.round((parse(to).getTime() - parse(from).getTime()) / DAY_MS);
  }

  // True when date is anchor + 14k days, k >= 0.
  function onGrid(date, anchor) {
    if (!parse(date) || !parse(anchor)) return false;
    var diff = daysBetween(anchor, date);
    return diff >= 0 && diff % 14 === 0;
  }

  // The grid Monday whose fortnight holds date. A weekend falls inside the 14 days that start on
  // the Monday before it, so it belongs to the fortnight before it. Anchor when date < anchor.
  function fortnightStartFor(date, anchor) {
    var diff = daysBetween(anchor, date);
    if (diff < 0) return anchor;
    return addDays(anchor, Math.floor(diff / 14) * 14);
  }

  // The ten weekday dates: start+0..4, start+7..11.
  function fortnightDates(start) {
    var out = [];
    for (var i = 0; i < 12; i++) {
      if (i === 5 || i === 6) continue;
      out.push(addDays(start, i));
    }
    return out;
  }

  function endOf(start) {
    return addDays(start, 11);
  }

  // 'mon'..'fri', or null for a weekend.
  function dayKeyOf(date) {
    var d = parse(date);
    if (!d) return null;
    var wd = d.getUTCDay(); // 0 = Sunday
    return wd >= 1 && wd <= 5 ? DAY_KEYS[wd - 1] : null;
  }

  // '5 Oct'
  function shortDate(date) {
    var d = parse(date);
    return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()];
  }

  // '5–16 Oct 2026', '26 Oct – 6 Nov 2026', '28 Dec 2026 – 8 Jan 2027'
  function fortnightLabel(start) {
    var a = parse(start);
    var b = parse(endOf(start));
    var ya = a.getUTCFullYear();
    var yb = b.getUTCFullYear();
    if (ya !== yb) return shortDate(start) + " " + ya + " – " + shortDate(endOf(start)) + " " + yb;
    if (a.getUTCMonth() !== b.getUTCMonth()) {
      return shortDate(start) + " – " + shortDate(endOf(start)) + " " + yb;
    }
    return a.getUTCDate() + "–" + b.getUTCDate() + " " + MONTHS[b.getUTCMonth()] + " " + yb;
  }

  // ------------------------------------------------------- the daily split ---

  function ordinaryFor(dayKey, rules) {
    return dayKey === "fri" ? rules.ordinaryFriMin : rules.ordinaryMonThuMin;
  }

  // worked = finish - start - lunch (0 when start or finish is blank); normal up to the day's
  // ordinary minutes, then up to otBandMin of OT, then DT. Leave and holiday hours never change the
  // split (contracts section 11 point 1).
  function split(day, dayKey, rules) {
    var worked = 0;
    if (day && day.startMin != null && day.finishMin != null) {
      worked = Math.max(0, day.finishMin - day.startMin - (day.lunchMin || 0));
    }
    var normal = Math.min(worked, ordinaryFor(dayKey, rules));
    var ot = Math.min(worked - normal, rules.otBandMin);
    return { workedMin: worked, normalMin: normal, otMin: ot, dtMin: worked - normal - ot };
  }

  // Sums over days that already carry split() fields and the typed leave fields.
  function totals(days) {
    var t = { workedMin: 0, normalMin: 0, otMin: 0, dtMin: 0, pholMin: 0, sickMin: 0, arlMin: 0, onsiteMin: 0 };
    (days || []).forEach(function (d) {
      for (var k in t) t[k] += (d && d[k]) || 0;
    });
    return t;
  }

  // ------------------------------------------------------------- display ---

  // null/undefined → ''; else hours to two places: 450 → '7.50', 0 → '0.00'.
  function hours(min) {
    if (min == null) return "";
    return (min / 60).toFixed(2);
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  // null → ''; 450 → '07:30'; 1440 → '24:00'.
  function clock(min) {
    if (min == null) return "";
    return pad2(Math.floor(min / 60)) + ":" + pad2(min % 60);
  }

  // ------------------------------------------------------------- parsing ---
  // Each returns minutes, null for blank, or NaN when unreadable.

  function blank(text) {
    return text == null || String(text).trim() === "";
  }

  function hm(h, m) {
    if (h > 24 || m > 59 || (h === 24 && m !== 0)) return NaN;
    return h * 60 + m;
  }

  // '7:30', '07:30', '7.30', '730', '0730' → 450; '7' → 420. Hours 0–24, minutes 0–59, '24:00' the
  // only 24.
  function parseClock(text) {
    if (blank(text)) return null;
    var s = String(text).trim();
    var m = /^(\d{1,2})[:.](\d{2})$/.exec(s);
    if (m) return hm(Number(m[1]), Number(m[2]));
    if (/^\d{1,2}$/.test(s)) return hm(Number(s), 0);
    if (/^\d{3,4}$/.test(s)) return hm(Number(s.slice(0, s.length - 2)), Number(s.slice(-2)));
    return NaN;
  }

  // '7.5' → 450, '7.25' → 435, '7:30' → 450, '8' → 480; at most 24 h.
  function parseHours(text) {
    if (blank(text)) return null;
    var s = String(text).trim();
    var m = /^(\d{1,2}):(\d{2})$/.exec(s);
    var min;
    if (m) min = hm(Number(m[1]), Number(m[2]));
    else if (/^(\d+(\.\d*)?|\.\d+)$/.test(s)) min = Math.round(Number(s) * 60);
    else return NaN;
    return min >= 0 && min <= 1440 ? min : NaN;
  }

  // A bare whole number is minutes: '30' → 30; 'h:mm': '0:45' → 45, '1:00' → 60; else NaN.
  function parseLunch(text) {
    if (blank(text)) return null;
    var s = String(text).trim();
    var min;
    var m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (m) min = hm(Number(m[1]), Number(m[2]));
    else if (/^\d{1,4}$/.test(s)) min = Number(s);
    else return NaN;
    return min >= 0 && min <= 1440 ? min : NaN;
  }

  // ---------------------------------------------------------- validation ---

  // The first problem with one day (the server's 400 sentences without the date prefix), or null.
  function dayProblem(day) {
    var hasStart = day.startMin != null;
    var hasFinish = day.finishMin != null;
    if (hasStart !== hasFinish) return "Give both a start and a finish";
    if (hasStart && day.finishMin <= day.startMin) return "Finish must be after start";
    if (day.lunchMin != null && !hasStart) return "Lunch needs a start and a finish";
    if (hasStart && (day.lunchMin || 0) > day.finishMin - day.startMin) return "Lunch is longer than the day";
    var worked = hasStart ? day.finishMin - day.startMin - (day.lunchMin || 0) : 0;
    if (worked + (day.pholMin || 0) + (day.sickMin || 0) + (day.arlMin || 0) > 1440) {
      return "More than 24 hours in one day";
    }
    if ((day.onsiteMin || 0) > worked) return "On-site hours are more than the hours worked";
    return null;
  }

  var PayMaths = {
    DAY_KEYS: DAY_KEYS,
    DAY_LABELS: DAY_LABELS,
    addDays: addDays,
    onGrid: onGrid,
    fortnightStartFor: fortnightStartFor,
    fortnightDates: fortnightDates,
    endOf: endOf,
    dayKeyOf: dayKeyOf,
    fortnightLabel: fortnightLabel,
    shortDate: shortDate,
    ordinaryFor: ordinaryFor,
    split: split,
    totals: totals,
    hours: hours,
    clock: clock,
    parseClock: parseClock,
    parseHours: parseHours,
    parseLunch: parseLunch,
    dayProblem: dayProblem,
  };

  if (typeof module === "object" && module.exports) module.exports = PayMaths;
  else root.PayMaths = PayMaths;
})(typeof window !== "undefined" ? window : this);
