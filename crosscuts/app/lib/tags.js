// Photo tag rule (Todd, 2026-10-11; docs/plans/m3-contracts.md section 2).
// Split on commas, trim, lowercase, drop empties, drop duplicates (first
// occurrence kept, order otherwise unchanged). normaliseTags must give the
// same result as tidy() in db/migrations/011_tidy_photo_tags.js for every
// string: change the rule only together with a matching new migration.

// A comma-separated string, or an array of strings (each item is itself split
// on commas) -> the tidy array. null/undefined -> [].
function splitTags(input) {
  if (input == null) return [];
  const parts = Array.isArray(input) ? input : [input];
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (part == null) continue;
    for (const raw of String(part).split(",")) {
      const t = raw.trim().toLowerCase();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// The stored form: "a, b, c".
function normaliseTags(input) {
  return splitTags(input).join(", ");
}

// rows = [{tags}] -> [{tag, count}], each tag counted once per photo, sorted
// by count descending, then tag ascending.
function countTags(rows) {
  const counts = new Map();
  for (const row of rows || []) {
    for (const tag of splitTags(row && row.tags)) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

module.exports = { splitTags, normaliseTags, countTags };
