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

module.exports = {
  DATE_RE,
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
