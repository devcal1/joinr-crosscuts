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

module.exports = {
  DATE_RE,
  sydneyToday,
  sydneyMonday,
  parseDateUTC,
  formatDateUTC,
  addDays,
  mondayOf,
  weekLabel,
};
