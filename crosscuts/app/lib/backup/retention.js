// Local retention of the archives on the Umbrel (docs/plans/backup-contracts.md section 5.6;
// Finance's retention.ts, ported). Pure: names in, a decision out. The snapshot does the unlinking,
// after a successful snapshot only. Nothing on the NAS is ever pruned (decision 8).
//
//   nightly      the newest archive of each Sydney date in the name; the archives of the 14 newest
//                dates that have one (not the last 14 calendar days, so an outage never eats them);
//                plus, for each calendar month from now's Sydney month back 11 months, the newest
//                nightly dated in that month
//   manual       the newest 10
//   premigrate   all kept
//   future       a name dated more than 24 h after now is never removed and never counts towards
//                the rules above (a clock that once ran fast can't push real archives out)
//   anything else (a name that breaks the rules, a .unverified file) is not an input to retain()
//                and is never removed by it; pruneUnverified() handles the .unverified files.
const { RETAIN } = require("./constants");
const { parseArchiveName, compareArchiveNames, sydneyStamp } = require("./names");

const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
const UNVERIFIED_SUFFIX = ".unverified";

function newestFirst(a, b) {
  return compareArchiveNames(b.name, a.name);
}

// 'YYYYMM' months from `month` back `count - 1` months, newest first.
function monthsBack(month, count) {
  let y = Number(month.slice(0, 4));
  let m = Number(month.slice(4, 6));
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

// names: every file name in ARCHIVES_DIR.
// {keep: Map<name, 'daily'|'monthly'|'manual'|'premigrate'>, remove: [names, oldest first],
//  future: [names dated more than 24 h after now: never removed]}
function retain(names, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const seen = new Set();
  const current = [];
  const future = [];
  for (const name of Array.isArray(names) ? names : []) {
    if (seen.has(name)) continue;
    seen.add(name);
    const p = parseArchiveName(name);
    if (!p) continue;
    if (p.instant.getTime() > nowMs + FUTURE_SLACK_MS) future.push(p);
    else current.push(p);
  }

  const keep = new Map();
  const nightly = current.filter((p) => p.kind === "nightly").sort(newestFirst);
  const manual = current.filter((p) => p.kind === "manual").sort(newestFirst);

  // Nightly: the newest of each date, for the 14 newest dates that have one.
  const newestOfDate = new Map();
  for (const p of nightly) if (!newestOfDate.has(p.localDate)) newestOfDate.set(p.localDate, p);
  const dates = [...newestOfDate.keys()].sort().reverse().slice(0, RETAIN.dailyDates);
  for (const d of dates) keep.set(newestOfDate.get(d).name, "daily");

  // Nightly: the newest of each of the 12 calendar months ending with now's Sydney month.
  const months = monthsBack(sydneyStamp(new Date(nowMs)).date.slice(0, 6), RETAIN.monthlyMonths);
  for (const month of months) {
    const p = nightly.find((n) => n.localMonth === month);
    if (p && !keep.has(p.name)) keep.set(p.name, "monthly");
  }

  // Manual: the newest 10.
  for (const p of manual.slice(0, RETAIN.manual)) keep.set(p.name, "manual");

  // Pre-migration wraps: all kept.
  for (const p of current) if (p.kind === "premigrate") keep.set(p.name, "premigrate");

  const remove = current
    .filter((p) => !keep.has(p.name))
    .map((p) => p.name)
    .sort(compareArchiveNames);
  return { keep, remove, future: future.map((p) => p.name).sort(compareArchiveNames) };
}

// The .unverified names to remove: all but the newest RETAIN.unverified, ordered as the archives
// they would have been (by instant, then name), oldest first. Only names whose archive part passes
// the rules count; any other name is never removed.
function pruneUnverified(names) {
  const list = [];
  const seen = new Set();
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== "string" || !name.endsWith(UNVERIFIED_SUFFIX) || seen.has(name)) continue;
    const base = name.slice(0, -UNVERIFIED_SUFFIX.length);
    if (!parseArchiveName(base)) continue;
    seen.add(name);
    list.push({ name, base });
  }
  list.sort((a, b) => compareArchiveNames(b.base, a.base));
  return list
    .slice(RETAIN.unverified)
    .sort((a, b) => compareArchiveNames(a.base, b.base))
    .map((x) => x.name);
}

module.exports = { retain, pruneUnverified, UNVERIFIED_SUFFIX };
