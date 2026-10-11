// Reading an rsync listing back (docs/plans/backup-contracts.md section 6.4). Pure; Finance's
// listing.ts ported.
//
// Only regular files are read (a mode starting "-"): directories (the folder itself lists as "."),
// symlinks, devices, a daemon's message of the day and anything else are skipped. The name is the
// WHOLE remainder after the time and one space (never "the last field": "copy of x.jpg" is not
// "x.jpg"), and it is kept only when the folder's own rule accepts it, so a file somebody else put
// on the NAS is never counted, compared or touched. A name listed twice gets size NaN: unreadable,
// so it is sent again and proved, the safe direction.
//
// The caller treats a truncated listing (outTruncated) as a failure before it ever gets here:
// a cut-off listing must never read as "the NAS lacks these".

// The anchored regular-file line (Finance, frozen):
//   -rw-r--r--      1,031,616 2026/09/17 10:10:09 crosscuts-db-20260917-013004+1000.7z
const LISTING_LINE_RE = /^(-[rwxsStT-]{9})[.+@]?\s+([\d,]+)\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})\s(.+)$/;

// [{name, bytes}], each name once. `nameOk(name)` is the folder's rule; without one nothing is kept
// (which reads as an empty NAS: everything is sent again and proved, never skipped).
function parseListing(text, nameOk) {
  if (typeof text !== "string" || typeof nameOk !== "function") return [];
  const byName = new Map();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const m = LISTING_LINE_RE.exec(line);
    if (m === null) continue;
    const name = m[5];
    let ok = false;
    try {
      ok = nameOk(name) === true;
    } catch {
      ok = false;
    }
    if (!ok) continue;
    const digits = m[2].replace(/,/g, "");
    const bytes = digits === "" ? NaN : Number(digits);
    byName.set(name, byName.has(name) ? NaN : bytes);
  }
  return [...byName].map(([name, bytes]) => ({ name, bytes }));
}

module.exports = { LISTING_LINE_RE, parseListing };
