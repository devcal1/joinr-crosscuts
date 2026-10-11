// When backups run (docs/plans/backup-contracts.md sections 7.1-7.6 and 11.1). Pure: no database, no
// files, no clock of its own. Every function takes `now` (or a slot) and the runs it reasons about.
//
//   snapshot slot  nightly 01:30 Sydney: the Sydney date D with D 01:30 <= now < D+1 01:30
//   copy slot      Saturday 01:30 Sydney: the latest Saturday whose 01:30 has passed
//
// 01:30 exists on both daylight-saving change days (the gap and the repeat are 02:00-03:00), and
// every step between dates is calendar arithmetic (addDays), never "+ 24 h".
//
// A run here is a backup_runs row of ONE kind in camel case, with `detail` already parsed:
//   {id, kind, trigger, slot, attempt, startedAt, finishedAt, status, reason, exitCode, detail}
const { sydneyParts, addDays } = require("../time");
const {
  SLOT_HOUR,
  SLOT_MINUTE,
  COPY_WEEKDAY,
  CATCH_UP_DELAY_MS,
  RETRY_DELAYS_MIN,
  MAX_ATTEMPTS,
  SNAPSHOT_OVERDUE_HOURS,
  COPY_OVERDUE_HOURS,
  REFUSAL_REASONS,
  NON_RETRYABLE,
} = require("./constants");

const SLOT_MINUTES = SLOT_HOUR * 60 + SLOT_MINUTE;
const HOUR_MS = 3_600_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function ms(v) {
  const d = toDate(v);
  return d === null ? null : d.getTime();
}

function beforeSlotTime(parts) {
  return parts.hour * 60 + parts.minute < SLOT_MINUTES;
}

// ---- slots (section 7.1) ------------------------------------------------------------------------

// The Sydney date 'YYYY-MM-DD' of the snapshot slot `now` falls in.
function snapshotSlot(now) {
  const p = sydneyParts(toDate(now) || new Date());
  return beforeSlotTime(p) ? addDays(p.date, -1) : p.date;
}

// The Sydney date of the latest Saturday whose 01:30 has passed.
function copySlot(now) {
  const p = sydneyParts(toDate(now) || new Date());
  let back = (p.weekday - COPY_WEEKDAY + 7) % 7;
  if (back === 0 && beforeSlotTime(p)) back = 7;
  return addDays(p.date, -back);
}

function slotFor(kind, now) {
  return kind === "copy" ? copySlot(now) : snapshotSlot(now);
}

// The slot a run counts for by its start (a manual run has no stored slot).
function slotOf(kind, startedAt) {
  const d = toDate(startedAt);
  return d === null ? null : slotFor(kind, d);
}

// The UTC instant of Sydney wall-clock `date` hour:minute. Sydney is UTC+10 or UTC+11; the
// candidate whose Sydney reading matches is the answer. A time in the spring-forward gap (never
// 01:30) has no match and falls back to the +10 reading.
function sydneyInstant(date, hour, minute) {
  if (typeof date !== "string" || !DATE_RE.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  for (const offsetHours of [11, 10]) {
    const at = new Date(wall - offsetHours * HOUR_MS);
    const p = sydneyParts(at);
    if (p.date === date && p.hour === hour && p.minute === minute) return at;
  }
  return new Date(wall - 10 * HOUR_MS);
}

function slotInstant(slot) {
  return sydneyInstant(slot, SLOT_HOUR, SLOT_MINUTE);
}

// The next 01:30 Sydney after `now`.
function nextSnapshotAt(now) {
  return slotInstant(addDays(snapshotSlot(now), 1));
}

// The next Saturday 01:30 Sydney after `now`.
function nextCopyAt(now) {
  return slotInstant(addDays(copySlot(now), 7));
}

function nextSlotAt(kind, now) {
  return kind === "copy" ? nextCopyAt(now) : nextSnapshotAt(now);
}

// ---- settled, attempts and retries (section 7.2) ------------------------------------------------

function list(runs) {
  return Array.isArray(runs) ? runs.filter((r) => r && typeof r === "object") : [];
}

// Failed runs stored for `slot`, other than `interrupted` (a stop mid-run is not an attempt).
function realAttemptRuns(runs, slot) {
  return list(runs).filter((r) => r.slot === slot && r.status === "failed" && r.reason !== "interrupted");
}

function realAttempts(runs, slot) {
  return realAttemptRuns(runs, slot).length;
}

function isSettled(kind, slot, runs, seedSlot) {
  if (typeof slot !== "string") return false;
  // (a) at or before the slot seeded at first start
  if (typeof seedSlot === "string" && DATE_RE.test(seedSlot) && slot <= seedSlot) return true;
  const rs = list(runs);
  // (b) a succeeded run of this kind, any trigger, started within the slot
  if (rs.some((r) => r.status === "succeeded" && slotOf(kind, r.startedAt) === slot)) return true;
  // (c) a failed run for the slot that no retry can fix
  if (rs.some((r) => r.slot === slot && r.status === "failed" && NON_RETRYABLE.includes(r.reason))) return true;
  // (d) the attempts are used up
  return realAttempts(rs, slot) >= MAX_ATTEMPTS;
}

function newestFirst(a, b) {
  const fa = ms(a.finishedAt) ?? ms(a.startedAt) ?? 0;
  const fb = ms(b.finishedAt) ?? ms(b.startedAt) ?? 0;
  if (fa !== fb) return fb - fa;
  return (Number(b.id) || 0) - (Number(a.id) || 0);
}

// The earliest the next attempt for `slot` may start, or null (no attempt yet, the attempts are used
// up, or the last attempt was a refusal: the refusal lock is then the only gate).
function retryAt(runs, slot) {
  const attempts = realAttemptRuns(runs, slot).sort(newestFirst);
  const n = attempts.length;
  if (n === 0 || n >= MAX_ATTEMPTS) return null;
  const last = attempts[0];
  if (REFUSAL_REASONS.includes(last.reason)) return null;
  const finished = ms(last.finishedAt) ?? ms(last.startedAt);
  if (finished === null) return null;
  const delay = RETRY_DELAYS_MIN[Math.min(n, RETRY_DELAYS_MIN.length) - 1];
  return new Date(finished + delay * 60_000);
}

// ---- the refusal lock (section 7.6) -------------------------------------------------------------

function attempted(run) {
  return !!(run && run.detail && run.detail.attempted === true);
}

// Locked when the newest copy that reached the NAS (not running) was refused, and neither NAS file
// has been placed again since it started. `mtimes` is {url, password} in ms (null when missing).
function isLocked(copyRuns, mtimes) {
  const tried = list(copyRuns)
    .filter((r) => r.status !== "running" && attempted(r))
    .sort((a, b) => {
      const sa = ms(a.startedAt) ?? 0;
      const sb = ms(b.startedAt) ?? 0;
      if (sa !== sb) return sb - sa;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
  const newest = tried[0];
  if (!newest || newest.status !== "failed" || !REFUSAL_REASONS.includes(newest.reason)) return false;
  const started = ms(newest.startedAt);
  if (started === null) return false;
  const m = mtimes && typeof mtimes === "object" ? mtimes : {};
  const placedSince = (t) => typeof t === "number" && Number.isFinite(t) && t > started;
  return !(placedSince(m.url) || placedSince(m.password));
}

// ---- overdue (section 11.1) ---------------------------------------------------------------------

// snapshot: state != 'off' and more than 48 h since the newest succeeded snapshot finished (none
// yet: since seededAt). copy: state != 'off' and more than 192 h since the newest succeeded copy
// (none yet: since the oldest copy that reached the NAS; none: never).
function isOverdue(kind, { runs, now, state, seededAt } = {}) {
  if (state === "off" || state === undefined || state === null) return false;
  const at = ms(now);
  if (at === null) return false;
  const rs = list(runs);
  const succeeded = rs
    .filter((r) => r.status === "succeeded")
    .map((r) => ms(r.finishedAt) ?? ms(r.startedAt))
    .filter((t) => t !== null);
  let since;
  if (succeeded.length > 0) {
    since = Math.max(...succeeded);
  } else if (kind === "copy") {
    const tried = rs
      .filter(attempted)
      .map((r) => ms(r.startedAt))
      .filter((t) => t !== null);
    if (tried.length === 0) return false;
    since = Math.min(...tried);
  } else {
    since = ms(seededAt);
    if (since === null) return false;
  }
  const hours = kind === "copy" ? COPY_OVERDUE_HOURS : SNAPSHOT_OVERDUE_HOURS;
  return at - since > hours * HOUR_MS;
}

// ---- the trigger and the whole decision (section 7.3) -------------------------------------------

// 'startup' when the slot's 01:30 was before the process started (a catch-up), else 'schedule'.
function triggerFor(slot, processStartedAt) {
  const at = slotInstant(slot);
  const started = ms(processStartedAt);
  return at !== null && started !== null && at.getTime() < started ? "startup" : "schedule";
}

// Everything the timer needs for one kind, apart from whether its job can run at all (tools, files,
// the lock), which the service checks. `due` means: the slot is not settled, and the retry and
// catch-up gates have passed. `gateAt` is when an unsettled slot may next start (now when due).
function evaluate(kind, { now, runs, seedSlot, processStartedAt } = {}) {
  const at = toDate(now) || new Date();
  const slot = slotFor(kind, at);
  const settled = isSettled(kind, slot, runs, seedSlot);
  const retry = settled ? null : retryAt(runs, slot);
  const started = ms(processStartedAt);
  const catchUp = started === null ? at.getTime() : started + CATCH_UP_DELAY_MS;
  const gate = settled ? null : Math.max(at.getTime(), catchUp, retry ? retry.getTime() : 0);
  const due = !settled && gate === at.getTime();
  return {
    kind,
    slot,
    settled,
    attempts: realAttempts(runs, slot),
    retryAt: retry && retry.getTime() > at.getTime() ? retry : null,
    due,
    gateAt: gate === null ? null : new Date(gate),
    nextAt: settled ? nextSlotAt(kind, at) : new Date(gate),
    trigger: triggerFor(slot, processStartedAt),
  };
}

module.exports = {
  snapshotSlot,
  copySlot,
  slotOf,
  sydneyInstant,
  nextSnapshotAt,
  nextCopyAt,
  isSettled,
  realAttempts,
  retryAt,
  isLocked,
  isOverdue,
  triggerFor,
  evaluate,
};
