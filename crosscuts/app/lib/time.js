// Dates. Business dates are Australia/Sydney local YYYY-MM-DD strings; the
// helpers below that take a date string do pure calendar arithmetic (via UTC)
// and never depend on the server's own timezone.
const SYDNEY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Today's date in Sydney, YYYY-MM-DD. `now` is injectable for tests.
function sydneyToday(now = new Date()) {
  const p = {};
  for (const { type, value } of SYDNEY_FMT.formatToParts(now)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}

function parseDateUTC(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function formatDateUTC(date) {
  return date.toISOString().slice(0, 10);
}
function addDays(s, n) {
  const d = parseDateUTC(s);
  d.setUTCDate(d.getUTCDate() + n);
  return formatDateUTC(d);
}
// Monday of the week containing s (a Sunday belongs to the week before it).
function mondayOf(s) {
  const d = parseDateUTC(s);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return formatDateUTC(d);
}
// Monday of the week containing dateStr, or of the current Sydney week.
function sydneyMonday(dateStr) {
  return mondayOf(dateStr || sydneyToday());
}
function weekLabel(startStr) {
  const start = parseDateUTC(startStr);
  const end = parseDateUTC(addDays(startStr, 4));
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const startPart = `${start.getUTCDate()}${sameMonth ? "" : ` ${MONTHS[start.getUTCMonth()]}`}`;
  const endPart = `${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
  return `${startPart}–${endPart}`;
}

const SYDNEY_CLOCK_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// Sydney wall-clock parts for `now`: {date, weekday (Mon=1..Sun=7), hour, minute}.
function sydneyParts(now = new Date()) {
  const p = {};
  for (const { type, value } of SYDNEY_CLOCK_FMT.formatToParts(now)) p[type] = value;
  const date = `${p.year}-${p.month}-${p.day}`;
  const dow = parseDateUTC(date).getUTCDay(); // 0 = Sunday
  return { date, weekday: dow === 0 ? 7 : dow, hour: Number(p.hour), minute: Number(p.minute) };
}

// The most recent Friday whose 12:00 Sydney is at or before `now`, YYYY-MM-DD.
function latestFridayNoon(now = new Date()) {
  const { date, weekday, hour } = sydneyParts(now);
  let back = (weekday - 5 + 7) % 7; // days since the last Friday (0 on a Friday)
  if (back === 0 && hour < 12) back = 7;
  return addDays(date, -back);
}

// ---------------------------------------------------------------- Sydney wall clock to instant
// (docs/plans/m7-contracts.md section 6). Planner events are stored as Sydney wall clock; only the
// reminder bell needs instants, through sydneyInstant.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// The Sydney wall clock of the instant ms, as UTC ms (minutes precision).
function sydneyWallMs(ms) {
  const p = {};
  for (const { type, value } of SYDNEY_CLOCK_FMT.formatToParts(new Date(ms))) p[type] = value;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
}

// Sydney's offset from UTC at the instant ms, in ms.
function offsetAt(ms) {
  return sydneyWallMs(ms) - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

// The UTC instant of Sydney wall-clock `time` ("HH:MM") on `date` ("YYYY-MM-DD").
// A time that doesn't exist (the spring-forward hour, e.g. 02:30 on the first Sunday in October)
// moves an hour later (03:30 AEDT). A time that happens twice (the fall-back hour, 02:00-02:59 on
// the first Sunday in April) uses the first (still AEDT). Throws TypeError on a bad date or time.
function sydneyInstant(date, time) {
  if (typeof date !== "string" || !DATE_RE.test(date) || formatDateUTC(parseDateUTC(date)) !== date) {
    throw new TypeError(`sydneyInstant: bad date ${JSON.stringify(date)}`);
  }
  if (typeof time !== "string" || !TIME_RE.test(time)) {
    throw new TypeError(`sydneyInstant: bad time ${JSON.stringify(time)}`);
  }
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const offsets = [...new Set([offsetAt(wall - DAY_MS), offsetAt(wall + DAY_MS)])];
  const matches = offsets.map((off) => wall - off).filter((t) => sydneyWallMs(t) === wall);
  if (matches.length) return new Date(Math.min(...matches));
  // A gap: the wall clock one hour later.
  const later = new Date(wall + 60 * MINUTE_MS).toISOString();
  return sydneyInstant(later.slice(0, 10), later.slice(11, 16));
}

module.exports = {
  DATE_RE,
  sydneyInstant,
  sydneyParts,
  latestFridayNoon,
  sydneyToday,
  sydneyMonday,
  parseDateUTC,
  formatDateUTC,
  addDays,
  mondayOf,
  weekLabel,
};
