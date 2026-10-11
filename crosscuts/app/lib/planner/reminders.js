// The planner reminder sweep (docs/plans/m7-contracts.md section 10). Built in M7 · 3.1 Wave 1 A.
//
// Every 60 s the sweep finds the reminders whose fire time falls in (mark, now] (the mark is the
// app setting planner.reminder_swept_to, at most 6 hours back), sends each once to the people who
// may see the event at that moment, and moves the mark to now, all in one transaction. The dedupe
// record is planner_reminders_sent: a restart or an overlapping window never sends twice, and an
// occurrence moved later gets a new fire_at and reminds again.
//
// Events are stored as Sydney wall clock; sydneyInstant turns them into instants here and nowhere
// else. Logs carry counts, window bounds and ids only: never a title, notes or a job name.
// Never requires ../../db: every function takes db first.
const notify = require("../notify");
const settings = require("../settings");
const layers = require("./layers");
const events = require("./events");
const { sydneyInstant, sydneyToday, addDays, parseDateUTC } = require("../time");

const MINUTE_MS = 60 * 1000;
const CHECK_MS = 60 * 1000;
const LOOKBACK_MS = 6 * 60 * MINUTE_MS;
const MARK_KEY = "planner.reminder_swept_to";
const TITLE_CUT = 120;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ALL_DAY_TIME = "07:00"; // matches the task reminder

// The instant a reminder fires for an occurrence ({start, startTime} from events.expand), or null
// when there is no reminder or it doesn't fit. "1 day before" (timed) is the same clock time the
// day before, not 24 hours (they differ by an hour across a change-over).
function fireAt(occ, reminder) {
  if (!occ || !reminder) return null;
  const start = occ.start;
  switch (reminder) {
    case "start":
      return occ.startTime ? sydneyInstant(start, occ.startTime) : null;
    case "min15":
      return occ.startTime ? new Date(sydneyInstant(start, occ.startTime).getTime() - 15 * MINUTE_MS) : null;
    case "hour1":
      return occ.startTime ? new Date(sydneyInstant(start, occ.startTime).getTime() - 60 * MINUTE_MS) : null;
    case "day1":
      return occ.startTime ? sydneyInstant(addDays(start, -1), occ.startTime) : null;
    case "morning":
      return occ.startTime ? null : sydneyInstant(start, ALL_DAY_TIME);
    case "day_before":
      return occ.startTime ? null : sydneyInstant(addDays(start, -1), ALL_DAY_TIME);
    default:
      return null;
  }
}

// When the occurrence is over: the end time (timed) or midnight after its last day (all-day), but
// never before the reminder's own fire time `at`. A start in the spring-forward gap moves an hour
// later (02:30 -> 03:30) while an end after the gap doesn't (03:15), so the end can come before the
// start; such an occurrence counts as over only once a sweep has passed its fire time (M7 · 4.3).
function endsAt(occ, at) {
  const end = occ.startTime && occ.endTime
    ? sydneyInstant(occ.start, occ.endTime)
    : sydneyInstant(addDays(occ.end, 1), "00:00");
  return at && at.getTime() > end.getTime() ? at : end;
}

// A short, safe word for a log line: an error's code or name, never its message (a message may
// carry a row's content).
function safeCode(e) {
  if (e && typeof e.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(e.code)) return e.code;
  if (e && typeof e.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name)) return e.name;
  return "error";
}

// "09:00" -> "9:00".
function clock(t) {
  const [h, m] = t.split(":");
  return `${Number(h)}:${m}`;
}

// "2035-10-08" -> "Thu 8 Oct".
function dayLabel(date) {
  const d = parseDateUTC(date);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function cut(title) {
  const t = String(title || "");
  return t.length > TITLE_CUT ? `${t.slice(0, TITLE_CUT - 1)}…` : t;
}

// The bell row for one occurrence (section 11.1). Notes never go in the bell.
function payload(event, occ) {
  const title = cut(occ.title);
  let heading;
  if (occ.startTime) {
    const lead = { start: "Starting now", min15: "In 15 minutes", hour1: "In 1 hour", day1: "Tomorrow" }[event.reminder];
    heading = `${lead}: ${title}, ${clock(occ.startTime)}`;
  } else {
    heading = `${event.reminder === "day_before" ? "Tomorrow" : "Today"}: ${title}`;
  }
  let when;
  if (occ.startTime) when = `${dayLabel(occ.start)}, ${clock(occ.startTime)}–${clock(occ.endTime)}`;
  else if (occ.end !== occ.start) when = `${dayLabel(occ.start)} – ${dayLabel(occ.end)}`;
  else when = dayLabel(occ.start);
  const key = `${event.id}:${occ.occurrence}`;
  return {
    kind: "planner.reminder",
    title: heading,
    body: `${layers.LABELS[event.layer] || event.layer} · ${when}`,
    link: `/planner.html?date=${occ.start}&event=e:${key}`,
    entityType: "planner_event",
    entityId: key,
  };
}

// The people to remind, checked now: the owner if they still see the event, plus everyone who sees
// the layer when remind_layer is set (never on Personal). Ids ascending, no duplicates.
function recipients(db, event, audienceCache) {
  const ids = new Set();
  const owner = layers.userById(db, event.owner_id);
  if (owner && layers.canSee(owner, event)) ids.add(owner.id);
  if (event.remind_layer && event.layer !== "personal") {
    if (!audienceCache.has(event.layer)) audienceCache.set(event.layer, layers.usersWhoSee(db, event.layer));
    for (const id of audienceCache.get(event.layer)) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

// The sends for (from, to]; the caller owns the transaction. Returns how many bell rows were written.
function sweep(db, from, to) {
  const fromMs = from.getTime(), toMs = to.getTime();
  if (!(toMs > fromMs)) return 0;
  const items = events.occurrencesForSweep(db, {
    from: addDays(sydneyToday(from), -1),
    to: addDays(sydneyToday(to), 2),
  });
  const record = db.prepare(
    `INSERT OR IGNORE INTO planner_reminders_sent (event_id, occurrence_date, user_id, fire_at)
     VALUES (?, ?, ?, ?)`
  );
  const audience = new Map();
  let sent = 0;
  for (const { event, occ } of items) {
    // One bad row must not stop every reminder: each occurrence runs in its own savepoint, and a
    // failure is logged with the event id and a safe code only, then the sweep goes on (M7 · 4.3).
    try {
      sent += db.transaction(() => sendOne(db, event, occ, fromMs, toMs, record, audience))();
    } catch (e) {
      console.error(`[planner] reminder skipped for event ${Number(event && event.id)}: ${safeCode(e)}`);
    }
  }
  return sent;
}

// The sends for one occurrence whose reminder fires in (fromMs, toMs]. Returns how many were sent.
function sendOne(db, event, occ, fromMs, toMs, record, audience) {
  const at = fireAt(occ, event.reminder);
  if (!at) return 0;
  const ms = at.getTime();
  if (!(ms > fromMs && ms <= toMs)) return 0;
  // Already over: it ended after its reminder fired and before now. An end at the fire time (only
  // the spring-forward gap, through endsAt's max) is never over yet.
  const ends = endsAt(occ, at).getTime();
  if (ends > ms && ends <= toMs) return 0;
  const fire = at.toISOString();
  let body = null;
  let sent = 0;
  for (const userId of recipients(db, event, audience)) {
    const info = record.run(event.id, occ.occurrence, userId, fire);
    if (Number(info.changes) !== 1) continue;
    if (!body) body = payload(event, occ);
    notify.toUser(db, userId, body);
    sent++;
  }
  return sent;
}

// The sweep for (from, to] in one transaction. from/to are Dates.
function runSweep(db, { from, to } = {}) {
  return { sent: db.transaction(() => sweep(db, from, to))() };
}

// The admin route: the sweep for (at - windowMinutes, at], the stored mark untouched.
function runNow(db, { at, windowMinutes } = {}) {
  const to = at instanceof Date ? at : new Date();
  const from = new Date(to.getTime() - (windowMinutes || 360) * MINUTE_MS);
  const { sent } = runSweep(db, { from, to });
  return { sent, from: from.toISOString(), to: to.toISOString() };
}

// One tick: (max(mark, now - 6 h), now], then the mark = now; the sends and the mark commit together.
function tick(db, now) {
  return db.transaction(() => {
    const mark = Date.parse(settings.get(db, MARK_KEY) || "");
    const fromMs = Number.isFinite(mark) ? Math.max(mark, now.getTime() - LOOKBACK_MS) : now.getTime();
    const from = new Date(fromMs);
    const sent = sweep(db, from, now);
    settings.set(db, MARK_KEY, now.toISOString(), null, { audit: false });
    return { sent, from };
  })();
}

let started = false;

// Started once by server.js after listen. Off with PLANNER_REMINDER_DISABLED=1. Never throws.
function startReminders(db) {
  try {
    if (process.env.PLANNER_REMINDER_DISABLED === "1") return;
    if (started) return;
    started = true;
    try {
      const mark = settings.get(db, MARK_KEY);
      if (mark == null || !Number.isFinite(Date.parse(mark))) {
        const now = new Date().toISOString();
        settings.set(db, MARK_KEY, now, null, { audit: false });
        console.log(`[planner] first start: reminder mark seeded to ${now}, nothing sent`);
      }
    } catch (e) {
      console.error(`[planner] seeding the reminder mark failed: ${e && e.message ? e.message : e}`);
    }
    const timer = setInterval(() => {
      try {
        const now = new Date();
        const { sent, from } = tick(db, now);
        if (sent > 0) console.log(`[planner] reminders: ${sent} sent (${from.toISOString()} to ${now.toISOString()})`);
      } catch (e) {
        console.error(`[planner] reminder sweep failed: ${e && e.message ? e.message : e}`);
      }
    }, CHECK_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
  } catch (e) {
    console.error(`[planner] reminder sweep failed to start: ${e && e.message ? e.message : e}`);
  }
}

module.exports = { fireAt, runSweep, runNow, startReminders };
