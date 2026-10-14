// Batten maths (docs/plans/m12-contracts.md section 6): the one home of the batten calculator's
// sums, shared by the page (<script src="/battens.js"> sets window.Battens) and the smoke (Node's
// require gets the same object). No dependencies, no DOM, nothing saved.
//
// A run of battens fills a space: either starting and ending on a batten (ends "batten", as the
// workbook's Calc-Batons strip) or with a gap at each end (ends "gap"). Give the number of battens
// and it works out the gap, or give the gap you'd like and it works out the number of battens.
// The gap is rounded down to the 0.5 mm, so the run never comes out longer than the space; what's
// left over sits at the far end.
//
// Inputs come in 0.5 mm steps, so the sums run in half-millimetres (whole numbers) and the
// rounding and the set-out are exact.
(function (root) {
  "use strict";

  var LIMITS = {
    spaceMin: 1, spaceMax: 20000,
    widthMin: 1, widthMax: 1000,
    countMax: 1000,
    gapMin: 0.5, gapMax: 10000,
  };
  var DEFAULT_WIDTH = 25;
  var ENDS = ["batten", "gap"];

  function given(v) {
    return v !== undefined && v !== null && v !== "";
  }

  // A number, or a plain decimal string ("58", "58.5"); anything else is NaN.
  function num(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v);
    return NaN;
  }

  // v in half-millimetres (a whole number) when it is in 0.5 mm steps from min to max, else null.
  function halves(v, min, max) {
    var n = num(v);
    if (!isFinite(n)) return null;
    var h = Math.round(n * 2);
    if (Math.abs(n * 2 - h) > 1e-9) return null;
    if (h < min * 2 || h > max * 2) return null;
    return h;
  }

  // Half-millimetres back to millimetres (exact: 117 -> 58.5).
  function mm(h) {
    return h / 2;
  }

  function minCount(ends) {
    return ends === "batten" ? 2 : 1;
  }
  function gapsFor(count, ends) {
    return ends === "batten" ? count - 1 : count + 1;
  }

  function refuse(error) {
    return { ok: false, error: error };
  }

  // The run for a known count, all in half-millimetres. gap2 is the exact gap rounded down to
  // the 0.5 mm; null when the battens leave no gap of at least 0.5 mm.
  function run(S2, W2, ends, count) {
    var gaps = gapsFor(count, ends);
    var free = S2 - count * W2; // half-mm left for the gaps
    if (gaps < 1 || free < gaps) return null; // the exact gap is under 0.5 mm
    var gap2 = Math.floor(free / gaps);
    var lead = ends === "gap" ? gap2 : 0;
    var setOut = [];
    for (var n = 1; n <= count; n++) {
      var start = lead + (n - 1) * (W2 + gap2);
      setOut.push({ n: n, start: mm(start), end: mm(start + W2) });
    }
    var total2 = count * W2 + gaps * gap2;
    return {
      ok: true,
      space: mm(S2),
      width: mm(W2),
      ends: ends,
      count: count,
      gaps: gaps,
      exactGap: Math.round((free * 100) / (2 * gaps)) / 100,
      gap: mm(gap2),
      total: mm(total2),
      leftOver: mm(S2 - total2),
      setOut: setOut,
    };
  }

  // Battens.solve({ space, width = 25, ends = "batten", count, gap })
  //   -> { ok: true, space, width, ends, count, gaps, exactGap, gap, total, leftOver, setOut }
  //    | { ok: false, error: "<sentence>" }
  function solve(input) {
    var o = input || {};
    var S2 = halves(o.space, LIMITS.spaceMin, LIMITS.spaceMax);
    if (S2 === null) return refuse("The space to fill must be from 1 to 20000 mm, in 0.5 mm steps");
    var W2 = halves(given(o.width) ? o.width : DEFAULT_WIDTH, LIMITS.widthMin, LIMITS.widthMax);
    if (W2 === null) return refuse("The batten width must be from 1 to 1000 mm, in 0.5 mm steps");
    var ends = given(o.ends) ? o.ends : "batten";
    if (ENDS.indexOf(ends) < 0) return refuse("The ends must be a batten at each end or a gap at each end");

    var hasCount = given(o.count);
    var hasGap = given(o.gap);
    if (hasCount === hasGap) return refuse("Give the number of battens or the gap you'd like");

    var S = mm(S2);
    var W = mm(W2);
    var low = minCount(ends);

    if (hasCount) {
      var c = num(o.count);
      if (Number.isInteger(c) && c < 2 && ends === "batten") {
        return refuse("Starting and ending on a batten needs at least 2 battens");
      }
      if (!Number.isInteger(c) || c < low || c > LIMITS.countMax) {
        return refuse("The number of battens must be a whole number from " + low + " to " + LIMITS.countMax);
      }
      var r = run(S2, W2, ends, c);
      if (!r) {
        return refuse(c === 1
          ? "1 batten of " + W + " mm doesn't leave a gap in " + S + " mm"
          : c + " battens of " + W + " mm don't leave a gap in " + S + " mm");
      }
      return r;
    }

    var g2 = halves(o.gap, LIMITS.gapMin, LIMITS.gapMax);
    if (g2 === null) return refuse("The gap must be from 0.5 to 10000 mm, in 0.5 mm steps");
    var G = mm(g2);

    // The exact (fractional) count for this gap: space = count x width + gaps x gap.
    //   batten ends: count = (space + gap) / (width + gap); gap ends: (space - gap) / (width + gap)
    var top = ends === "batten" ? S2 + g2 : S2 - g2;
    var under = Math.floor(top / (W2 + g2));
    if (under > LIMITS.countMax) {
      return refuse("Battens of " + W + " mm with a " + G + " mm gap would take more than " +
        LIMITS.countMax + " battens in " + S + " mm");
    }

    // Of the whole numbers either side, within the limits and leaving a gap, the one whose exact
    // gap is closest to the gap asked for; a tie takes more battens. Compared as fractions
    // (|free - gap x gaps| / gaps) so a tie is exact.
    var best = null;
    var bestDiff = 0;
    var bestGaps = 1;
    [under, under + 1].forEach(function (cand) {
      if (cand < low || cand > LIMITS.countMax) return;
      var gaps = gapsFor(cand, ends);
      var free = S2 - cand * W2;
      if (free < gaps) return; // leaves no gap of 0.5 mm
      var diff = Math.abs(free - g2 * gaps);
      if (best === null || diff * bestGaps < bestDiff * gaps || (diff * bestGaps === bestDiff * gaps && cand > best)) {
        best = cand;
        bestDiff = diff;
        bestGaps = gaps;
      }
    });
    if (best === null) return refuse("Battens of " + W + " mm with a " + G + " mm gap don't fit in " + S + " mm");
    return run(S2, W2, ends, best);
  }

  var Battens = {
    LIMITS: LIMITS,
    DEFAULT_WIDTH: DEFAULT_WIDTH,
    solve: solve,
  };

  if (typeof module === "object" && module.exports) module.exports = Battens;
  else root.Battens = Battens;
})(typeof window !== "undefined" ? window : this);
