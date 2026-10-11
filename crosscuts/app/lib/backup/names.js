// Archive and upload name rules, and the Sydney stamp (docs/plans/backup-contracts.md section 5.1).
//
//   nightly      crosscuts-db-YYYYMMDD-HHmmss+HHMM.7z          (Sydney wall-clock at the run's start)
//   manual       crosscuts-db-YYYYMMDD-HHmmss+HHMM-manual.7z
//   premigrate   crosscuts-premigrate-NNN-<YYYYMMDDTHHMMSS>.7z  (the migrate.js stamp, UTC, verbatim)
//   unverified   <any of the above>.unverified                  (never parsed as an archive)

const DB_ARCHIVE_RE = /^crosscuts-db-(\d{8})-(\d{6})([+-]\d{4})(-manual)?\.7z$/;
const PREMIGRATE_ARCHIVE_RE = /^crosscuts-premigrate-(\d{3,})-(\d{8}T\d{6})\.7z$/;
const PREMIGRATE_SOURCE_RE = /^photos-pre-(\d{3,})-(\d{8}T\d{6})\.db$/;
const PHOTO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp|gif)$/i; // the same rule as server.js PHOTO_PATH
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // and not ending in .part

const STAMP_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset",
});

// {date: 'YYYYMMDD', time: 'HHmmss', offset: '+1100', iso: '2026-10-12T01:30:04+11:00'}
function sydneyStamp(now = new Date()) {
  const p = {};
  for (const { type, value } of STAMP_FMT.formatToParts(now)) p[type] = value;
  // longOffset is "GMT+11:00" (or "GMT" at a zero offset, which Sydney never has).
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(p.timeZoneName || "");
  const sign = m && m[1] ? m[1] : "+";
  const oh = m && m[2] ? m[2] : "00";
  const om = m && m[3] ? m[3] : "00";
  const hour = p.hour === "24" ? "00" : p.hour;
  return {
    date: `${p.year}${p.month}${p.day}`,
    time: `${hour}${p.minute}${p.second}`,
    offset: `${sign}${oh}${om}`,
    iso: `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}${sign}${oh}:${om}`,
  };
}

function dbArchiveName(now = new Date(), manual = false) {
  const s = sydneyStamp(now);
  return `crosscuts-db-${s.date}-${s.time}${s.offset}${manual ? "-manual" : ""}.7z`;
}

// The wrap's name for a migrate.js file photos-pre-NNN-<stamp>.db, or null if the name breaks the rule.
function premigrateArchiveName(sourceName) {
  const m = typeof sourceName === "string" ? PREMIGRATE_SOURCE_RE.exec(sourceName) : null;
  return m ? `crosscuts-premigrate-${m[1]}-${m[2]}.7z` : null;
}

// A real calendar date and time, or null.
function utcMs(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

function digits(text, from, len) {
  return Number(text.slice(from, from + len));
}

// {name, kind: 'nightly'|'manual'|'premigrate', localDate: 'YYYYMMDD', localMonth: 'YYYYMM', instant: Date}
// or null (a .unverified file, or any name that breaks the rules).
function parseArchiveName(name) {
  if (typeof name !== "string") return null;
  let m = DB_ARCHIVE_RE.exec(name);
  if (m) {
    const [, date, time, offset, manual] = m;
    const ms = utcMs(
      digits(date, 0, 4),
      digits(date, 4, 2),
      digits(date, 6, 2),
      digits(time, 0, 2),
      digits(time, 2, 2),
      digits(time, 4, 2)
    );
    const offH = digits(offset, 1, 2);
    const offM = digits(offset, 3, 2);
    if (ms === null || offH > 14 || offM > 59) return null;
    const offMs = (offset[0] === "-" ? -1 : 1) * (offH * 60 + offM) * 60_000;
    return {
      name,
      kind: manual ? "manual" : "nightly",
      localDate: date,
      localMonth: date.slice(0, 6),
      instant: new Date(ms - offMs),
    };
  }
  m = PREMIGRATE_ARCHIVE_RE.exec(name);
  if (m) {
    const stamp = m[2];
    const ms = utcMs(
      digits(stamp, 0, 4),
      digits(stamp, 4, 2),
      digits(stamp, 6, 2),
      digits(stamp, 9, 2),
      digits(stamp, 11, 2),
      digits(stamp, 13, 2)
    );
    if (ms === null) return null;
    const instant = new Date(ms);
    // The stamp is UTC; the local date is Sydney's date at that instant.
    const local = sydneyStamp(instant).date;
    return { name, kind: "premigrate", localDate: local, localMonth: local.slice(0, 6), instant };
  }
  return null;
}

// By instant, then by name. A name that breaks the rules sorts before every archive.
function compareArchiveNames(a, b) {
  const pa = parseArchiveName(a);
  const pb = parseArchiveName(b);
  if (pa && pb) {
    const d = pa.instant.getTime() - pb.instant.getTime();
    if (d !== 0) return d < 0 ? -1 : 1;
  } else if (pa || pb) {
    return pa ? 1 : -1;
  }
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// 'photo' | 'file': the regex, no leading dot, not *.part.
function isUploadName(name, kind) {
  if (typeof name !== "string" || name.startsWith(".") || /\.part$/i.test(name)) return false;
  if (kind === "photo") return PHOTO_NAME_RE.test(name);
  if (kind === "file") return FILE_NAME_RE.test(name);
  return false;
}

module.exports = {
  DB_ARCHIVE_RE,
  PREMIGRATE_ARCHIVE_RE,
  PREMIGRATE_SOURCE_RE,
  PHOTO_NAME_RE,
  FILE_NAME_RE,
  sydneyStamp,
  dbArchiveName,
  premigrateArchiveName,
  parseArchiveName,
  compareArchiveNames,
  isUploadName,
};
