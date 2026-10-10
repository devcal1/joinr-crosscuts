// 011_tidy_photo_tags: one-off tidy of photos.tags (Todd, 2026-10-11; m3-plan §3, Q4).
// Rewrites photos.tags only. Split on commas, trim, lowercase, drop empties, drop
// duplicates (first occurrence kept, order otherwise unchanged), join with ", ".
// Rows already tidy are not written. No row is deleted; no other column changes.
// The rule is inlined on purpose (see m3-contracts.md section 1): never require app code here.
function tidy(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of String(tags == null ? "" : tags).split(",")) {
    const t = raw.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join(", ");
}

function up(db) {
  const rows = db.prepare("SELECT id, tags FROM photos ORDER BY id").all();
  const update = db.prepare("UPDATE photos SET tags = ? WHERE id = ?");
  let changed = 0;
  for (const row of rows) {
    const next = tidy(row.tags);
    if (next !== row.tags) {
      update.run(next, row.id);
      changed++;
    }
  }
  console.log(`[migrate] 011 tag tidy: ${changed} of ${rows.length} photo(s) rewritten`);
}

module.exports = { up };
