// What a copy sends to one NAS folder (docs/plans/backup-contracts.md section 6.5). Pure.
//
// A local file is already there when the NAS lists its name at the size it should have
// (`expectedSize(file)`: the local size; for files/ the ledger's blob_bytes, or unknown with no
// ledger row). Anything else is sent: absent, another size, an unreadable size (NaN) or an unknown
// expected size. `!==` and never a tolerance: two sizes of the same file are equal or the file is
// not the same file. The send list is newest first, so a copy cut short has the recent ones.
const { compareArchiveNames } = require("./names");

function knownSize(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

// local:  [{name, source, bytes, mtimeMs, ...}]  (name is the name the file has on the NAS)
// remote: [{name, bytes}]                         (parseListing)
// expectedSize(file) -> number | null             (null or undefined: unknown, so it is sent)
// options.order: 'archive' (db/: by compareArchiveNames, reversed) | 'mtime' (the others; default)
// -> {alreadyThere: n, present: [file], toSend: [file]}   each file is the local entry as given
function planFolder(local, remote, expectedSize, { order = "mtime" } = {}) {
  const there = new Map();
  for (const r of Array.isArray(remote) ? remote : []) {
    if (r && typeof r.name === "string") there.set(r.name, r.bytes);
  }
  const present = [];
  const toSend = [];
  for (const f of Array.isArray(local) ? local : []) {
    if (!f || typeof f.name !== "string") continue;
    let want = null;
    try {
      want = typeof expectedSize === "function" ? expectedSize(f) : f.bytes;
    } catch {
      want = null;
    }
    const theirs = there.get(f.name);
    if (knownSize(want) && theirs === want) present.push(f);
    else toSend.push(f);
  }
  if (order === "archive") {
    toSend.sort((a, b) => compareArchiveNames(b.name, a.name));
  } else {
    toSend.sort((a, b) => {
      const ma = Number.isFinite(a.mtimeMs) ? a.mtimeMs : 0;
      const mb = Number.isFinite(b.mtimeMs) ? b.mtimeMs : 0;
      if (ma !== mb) return mb - ma;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  }
  return { alreadyThere: present.length, present, toSend };
}

// Splits `items` (in order) into batches of at most `maxCount` items and `maxBytes` of `bytes`.
// One item larger than `maxBytes` goes alone in its own batch.
function batches(items, maxCount, maxBytes = Infinity) {
  const out = [];
  let cur = [];
  let curBytes = 0;
  const count = Number.isInteger(maxCount) && maxCount > 0 ? maxCount : 1;
  for (const it of Array.isArray(items) ? items : []) {
    const b = knownSize(it && it.bytes) ? it.bytes : 0;
    if (cur.length > 0 && (cur.length >= count || curBytes + b > maxBytes)) {
      out.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(it);
    curBytes += b;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

module.exports = { planFolder, batches };
