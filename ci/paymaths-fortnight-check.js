// Pure check of the fortnight minimum for 1.5x (Todd 2026-11-16). No server, no database:
//   node ci/paymaths-fortnight-check.js
"use strict";
const assert = require("node:assert");
const PM = require("../crosscuts/app/public/paymaths.js");

const rules = { anchor: "2026-10-05", ordinaryMonThuMin: 480, ordinaryFriMin: 360, otBandMin: 120, fortnightMinimum: true };
assert.strictEqual(PM.fortnightMinimumMin(rules), 4560, "76 h at the defaults");
assert.strictEqual(PM.fortnightMinimumMin({ ordinaryMonThuMin: 450, ordinaryFriMin: 300 }), 2 * (4 * 450 + 300));

// days from [startMin, finishMin, lunchMin, extra] per weekday
function fortnight(specs) {
  return PM.fortnightDates("2035-01-01").map((date, i) => {
    const s = specs[i] || {};
    const typed = { startMin: s.start == null ? null : s.start, finishMin: s.finish == null ? null : s.finish,
      lunchMin: s.lunch == null ? null : s.lunch, pholMin: s.phol || 0, arlMin: s.arl || 0, sickMin: s.sick || 0, onsiteMin: 0 };
    return Object.assign({ date }, typed, PM.split(typed, PM.dayKeyOf(date), rules));
  });
}
const std = { start: 420, finish: 930, lunch: 30 }; // 8 h
const long = { start: 420, finish: 1050, lunch: 30 }; // 10 h: 8 normal + 2 OT
const dt = { start: 360, finish: 1110, lunch: 30 }; // 12 h: 8 + 2 OT + 2 DT

// Exactly 76 h counting a public holiday: OT kept.
let days = fortnight([long, std, std, { phol: 480 }, { start: 420, finish: 810, lunch: 30 }, std, std, std, std, { start: 420, finish: 690, lunch: 30 }]);
let info = PM.applyFortnightMinimum(days, rules);
assert.strictEqual(info.completedMin, 4560);
assert.strictEqual(info.movedMin, 0);
assert.strictEqual(PM.totals(days).otMin, 120);

// One minute under: OT becomes normal, total hours unchanged.
days = fortnight([long, std, std, { phol: 480 }, { start: 420, finish: 810, lunch: 30 }, std, std, std, std, { start: 420, finish: 689, lunch: 30 }]);
const before = PM.totals(days);
info = PM.applyFortnightMinimum(days, rules);
let t = PM.totals(days);
assert.strictEqual(info.movedMin, 120);
assert.strictEqual(t.otMin, 0);
assert.strictEqual(t.otMovedMin, 120);
assert.strictEqual(t.normalMin + t.otMin + t.dtMin, before.normalMin + before.otMin + before.dtMin);
assert.strictEqual(t.dtMin, before.dtMin);

// Annual leave and sick hours count too; DT stays as split gave it when under.
days = fortnight([dt, { arl: 480 }, { sick: 480 }]);
info = PM.applyFortnightMinimum(days, rules);
t = PM.totals(days);
assert.strictEqual(info.completedMin, 720 + 480 + 480);
assert.strictEqual(t.otMin, 0);
assert.strictEqual(t.dtMin, 120);
assert.strictEqual(t.normalMin, 600);

// Rules without the flag (a run finalised before this rule): nothing moves.
days = fortnight([long]);
info = PM.applyFortnightMinimum(days, Object.assign({}, rules, { fortnightMinimum: undefined }));
assert.strictEqual(info.movedMin, 0);
assert.strictEqual(PM.totals(days).otMin, 120);

console.log("paymaths fortnight minimum: all checks passed");
