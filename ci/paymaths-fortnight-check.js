// Pure check of the fortnight minimum for 1.5x (Todd 2026-11-16). No server, no database:
//   node ci/paymaths-fortnight-check.js
// The rule: OT first tops normal time (with P HOL, ARL and SICK) up to 76 h; only OT above that
// stays 1.5x. DT is never touched.
"use strict";
const assert = require("node:assert");
const PM = require("../crosscuts/app/public/paymaths.js");

const rules = { anchor: "2026-10-05", ordinaryMonThuMin: 480, ordinaryFriMin: 360, otBandMin: 120, fortnightMinimum: true };
assert.strictEqual(PM.fortnightMinimumMin(rules), 4560, "76 h at the defaults");
assert.strictEqual(PM.fortnightMinimumMin({ ordinaryMonThuMin: 450, ordinaryFriMin: 300 }), 2 * (4 * 450 + 300));

// One fortnight (ten weekdays) from a spec per day.
function fortnight(specs) {
  return PM.fortnightDates("2035-01-01").map((date, i) => {
    const s = specs[i] || {};
    const typed = { startMin: s.start == null ? null : s.start, finishMin: s.finish == null ? null : s.finish,
      lunchMin: s.lunch == null ? null : s.lunch, pholMin: s.phol || 0, arlMin: s.arl || 0, sickMin: s.sick || 0, onsiteMin: 0 };
    return Object.assign({ date }, typed, PM.split(typed, PM.dayKeyOf(date), rules));
  });
}
const hm = (h) => h * 60;
const day = (workedH) => ({ start: 420, finish: 420 + hm(workedH) + 30, lunch: 30 });
const paid = (t) => t.normalMin + t.otMin + t.dtMin;

// Todd's example: 66 h normal + 12 h OT pays 76 h normal and 2 h at 1.5x.
// Mon-Thu 9.5 h (8 normal + 1.5 OT) x 8 days = 64 h normal + 12 h OT; Fridays 1 h each: 66 h normal.
let days = fortnight([day(9.5), day(9.5), day(9.5), day(9.5), day(1), day(9.5), day(9.5), day(9.5), day(9.5), day(1)]);
let before = PM.totals(days);
assert.strictEqual(before.normalMin, hm(66));
assert.strictEqual(before.otMin, hm(12));
let info = PM.applyFortnightMinimum(days, rules);
let t = PM.totals(days);
assert.strictEqual(t.normalMin, hm(76), "Todd's example: 76 h normal");
assert.strictEqual(t.otMin, hm(2), "Todd's example: 2 h at 1.5x");
assert.strictEqual(info.movedMin, hm(10));
assert.strictEqual(t.otMovedMin, hm(10));
assert.strictEqual(paid(t), paid(before), "total hours paid unchanged");

// Exactly 76 h ordinary (a public holiday counts): all OT kept.
const std = day(8), fri = day(6), long = day(10);
days = fortnight([long, std, std, { phol: 480 }, fri, std, std, std, std, fri]);
info = PM.applyFortnightMinimum(days, rules);
assert.strictEqual(info.completedMin, 4560);
assert.strictEqual(info.movedMin, 0);
assert.strictEqual(PM.totals(days).otMin, 120);

// One minute under: one minute of OT tops normal up, the rest stays 1.5x.
days = fortnight([long, std, std, { phol: 480 }, fri, std, std, std, std, { start: 420, finish: 809, lunch: 30 }]);
info = PM.applyFortnightMinimum(days, rules);
t = PM.totals(days);
assert.strictEqual(info.movedMin, 1);
assert.strictEqual(t.otMin, 119);
assert.strictEqual(t.normalMin, 4080);

// Far under: all OT becomes normal; DT stays (always 2x, never fills the shortfall).
const dt = { start: 360, finish: 1110, lunch: 30 }; // 12 h: 8 + 2 OT + 2 DT
days = fortnight([dt, { arl: 480 }, { sick: 480 }]);
before = PM.totals(days);
info = PM.applyFortnightMinimum(days, rules);
t = PM.totals(days);
assert.strictEqual(info.completedMin, 480 + 480 + 480, "ordinary = normal + ARL + SICK (OT and DT don't count)");
assert.strictEqual(t.otMin, 0);
assert.strictEqual(t.dtMin, 120);
assert.strictEqual(t.normalMin, 600);
assert.strictEqual(paid(t), paid(before));

// OT moves in date order: the earliest days' OT is used first.
days = fortnight([long, long, long]); // 24 normal + 6 OT, far under
PM.applyFortnightMinimum(days, Object.assign({}, rules));
assert.deepStrictEqual(days.slice(0, 3).map((d) => d.otMin), [0, 0, 0]);
days = fortnight([long, long, std, std, fri, std, std, std, std, fri]); // 76 normal? 8*8+12 = 76, 4 h OT: none moves
info = PM.applyFortnightMinimum(days, rules);
assert.strictEqual(info.movedMin, 0);
days = fortnight([long, long, std, std, day(5), std, std, std, std, fri]); // 75 normal: 1 h of Monday's OT moves
PM.applyFortnightMinimum(days, rules);
assert.deepStrictEqual([days[0].otMin, days[1].otMin], [60, 120]);

// Rules without the flag (a run finalised before this rule): nothing moves.
days = fortnight([long]);
info = PM.applyFortnightMinimum(days, Object.assign({}, rules, { fortnightMinimum: undefined }));
assert.strictEqual(info.movedMin, 0);
assert.strictEqual(PM.totals(days).otMin, 120);

console.log("paymaths fortnight minimum: all checks passed");
