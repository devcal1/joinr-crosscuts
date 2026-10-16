# M15 smoke: department notes (docs/plans/notes-contracts.md), a weekly sheet per department
# where its people leave signed notes for each other.
# Sourced by ci/smoke.sh after the M14 suites, so it shares that script's helpers (step, req, hdr,
# expect_status, expect_jq, expect_eq, jqr, fail, ok, sydney_monday), the cookie jars ($ADMIN
# $SCHED $ACCT $ACCT2 $DPM $SHOW $WSHOP $WSMGR), $BASE, $REQ_ORIGIN, $BODY_FILE, $HDR_FILE, $WORK
# and $CONTAINER. No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: its notes carry a run tag in their text, it reads counts
# as the notes carrying that tag, and the old-week rows it seeds sit in weeks the app never writes
# to. Made-up names only (this repo is public). Modelled on smoke-m4-tasks.sh and smoke-m14-*.sh.

# ============================================================================
step "m15-notes. department notes: one weekly sheet per department"
# ============================================================================

M15N_TAG="m15n$(date +%s)"
M15N_THIS=$(sydney_monday)
m15n_back() { date -u -d "$M15N_THIS - $(($1 * 7)) days" +%F; }
M15N_LAST=$(m15n_back 1)

# m15n_seed DEPT WEEK BODY AUTHOR_ID [REMOVED]: inserts a row straight into dept_notes (the app only
# writes the current week, so older weeks are seeded); prints nothing, sets M15N_SEEDED to its id.
m15n_seed() {
  M15N_SEEDED=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
const [dept, week, body, author, removed] = process.argv.slice(1);
const at = week + "T01:00:00.000Z";
const info = d.prepare(
  "INSERT INTO dept_notes (dept, week_start, body, author_id, created_at, updated_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
).run(dept, week, body, Number(author), at, at, removed ? at : null);
console.log(String(info.lastInsertRowid));
d.close();' "$1" "$2" "$3" "$4" "${5:-}" | tr -d '\r') || fail "seeding a dept_notes row failed"
  [ -n "$M15N_SEEDED" ] || fail "seeding a dept_notes row gave no id"
}

# m15n_get JAR DEPT [EXTRA QUERY, starting with &]: GET /api/notes for a department.
m15n_get() {
  req GET "/api/notes?dept=$2${3:-}" "$1"
}

req GET /api/auth/me "$ADMIN"
M15N_ADMIN_ID=$(jqr '.user.id')
req GET /api/auth/me "$ACCT"
M15N_ACCT_ID=$(jqr '.user.id')
M15N_ACCT_NAME=$(jqr '.user.displayName')
req GET /api/auth/me "$ACCT2"
M15N_ACCT2_ID=$(jqr '.user.id')
M15N_ACCT2_NAME=$(jqr '.user.displayName')
req GET /api/auth/me "$SCHED"
M15N_SCHED_ID=$(jqr '.user.id')

echo "--- the menu and the pages ---"
M15N_SHELL=$(curl -s "$BASE/shell/shell.js")
for M15N_PAIR in scheduling:scheduling.view design:design.view ordering:orders.view accounts:accounts.view admin:users.admin; do
  M15N_D=${M15N_PAIR%%:*}
  M15N_K=${M15N_PAIR#*:}
  printf '%s\n' "$M15N_SHELL" | grep -A1 'items: \[' | grep -q "{ label: \"Notes\", href: \"/notes.html?dept=$M15N_D\", key: \"$M15N_K\" }" \
    || fail "the $M15N_D menu has no Notes first item with key $M15N_K"
  ok
done
req GET "/notes.html?dept=accounts"
expect_status 302 "logged out GET /notes.html"
for M15N_J in "$ACCT" "$SCHED" "$DPM" "$ADMIN" "$WSMGR"; do
  req GET "/notes.html?dept=accounts" "$M15N_J"
  expect_status 200 "a department login GET /notes.html"
done
printf '%s' "$BODY" | grep -q 'id="cc-shell"' || fail "notes.html carries no #cc-shell"
ok
for M15N_J in "$SHOW" "$WSHOP"; do
  req GET "/notes.html?dept=accounts" "$M15N_J"
  expect_status 403 "a login without any department key GET /notes.html"
done
req GET /notes.js "$SHOW"
expect_status 200 "notes.js is a plain static file"

echo "--- access per department ---"
req GET /api/notes?dept=accounts
expect_status 401 "logged out GET /api/notes"
req POST /api/notes "" '{"dept":"accounts","body":"x"}'
expect_status 401 "logged out POST /api/notes"
# acct holds accounts.view and orders.view (not scheduling.view, design.view or users.admin).
m15n_get "$ACCT" accounts;   expect_status 200 "acct GET accounts notes"
expect_jq '.dept == "accounts" and .deptLabel == "Accounts" and (.weeks | length) == 2 and (.weeks[0].current == true) and (.weeks[1].current == false)' "the answer's shape: this week then last week"
m15n_get "$ACCT" ordering;   expect_status 200 "acct GET ordering notes (orders.view)"
m15n_get "$ACCT" scheduling; expect_status 403 "acct GET scheduling notes"
m15n_get "$ACCT" design;     expect_status 403 "acct GET design notes"
m15n_get "$ACCT" admin;      expect_status 403 "acct GET admin notes"
# sched holds scheduling.view and orders.view.
m15n_get "$SCHED" scheduling; expect_status 200 "sched GET scheduling notes"
m15n_get "$SCHED" accounts;   expect_status 403 "sched GET accounts notes"
m15n_get "$SCHED" admin;      expect_status 403 "sched GET admin notes"
# wsmgr holds orders.view only; show holds none.
m15n_get "$WSMGR" ordering; expect_status 200 "wsmgr GET ordering notes"
m15n_get "$WSMGR" accounts; expect_status 403 "wsmgr GET accounts notes"
for M15N_D in scheduling design ordering accounts admin; do
  m15n_get "$SHOW" "$M15N_D"
  expect_status 403 "show GET $M15N_D notes"
  m15n_get "$ADMIN" "$M15N_D"
  expect_status 200 "admin GET $M15N_D notes"
done
m15n_get "$ACCT" nowhere; expect_status 400 "an unknown department"
expect_jq '.error == "Unknown department"' "the unknown-department sentence"
req GET /api/notes "$ACCT"
expect_status 400 "no department"
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG no key" '{dept:"scheduling",body:$b}')"
expect_status 403 "acct POST a scheduling note"
req POST /api/notes "$SHOW" "$(jq -nc --arg b "$M15N_TAG no key" '{dept:"accounts",body:$b}')"
expect_status 403 "show POST an accounts note"
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG nowhere" '{dept:"nowhere",body:$b}')"
expect_status 400 "POST a note for an unknown department"
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG no dept" '{body:$b}')"
expect_status 400 "POST a note with no department"

echo "--- writing and reading ---"
M15N_B1="$M15N_TAG first note, with <b>tags</b> & a <script>x</script>
second line"
req POST /api/notes "$ACCT" "$(jq -nc --arg b "  $M15N_B1  " '{dept:"accounts",body:$b}')"
expect_status 201 "acct leaves a note"
M15N_N1=$(jqr '.id')
expect_jq ".dept == \"accounts\" and .weekStart == \"$M15N_THIS\" and .author.id == $M15N_ACCT_ID and .author.name == \"$M15N_ACCT_NAME\" and .canEdit == true and .edited == false and (.createdAt | type == \"string\") and (.body | endswith(\"second line\"))" \
  "the note is signed by acct, filed under this week, and trimmed"
printf '%s' "$BODY" | jq -e --arg b "$M15N_B1" '.body == $b' >/dev/null \
  || fail "the stored text differs from what was sent (line break kept, markup not touched): ${BODY:0:300}"
ok
req POST /api/notes "$ACCT2" "$(jq -nc --arg b "$M15N_TAG second note" '{dept:"accounts",body:$b}')"
expect_status 201 "acct2 leaves a note"
M15N_N2=$(jqr '.id')
expect_jq ".author.id == $M15N_ACCT2_ID and .author.name == \"$M15N_ACCT2_NAME\"" "the second note is signed by acct2"
req POST /api/notes "$SCHED" "$(jq -nc --arg b "$M15N_TAG scheduling note" '{dept:"scheduling",body:$b}')"
expect_status 201 "sched leaves a scheduling note"
M15N_NS=$(jqr '.id')
req POST /api/notes "$ADMIN" "$(jq -nc --arg b "$M15N_TAG admin note" '{dept:"admin",body:$b}')"
expect_status 201 "admin leaves an admin note"
M15N_NA=$(jqr '.id')
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG admin note" '{dept:"admin",body:$b}')"
expect_status 403 "acct can't write on the admin sheet"

m15n_get "$ACCT" accounts
expect_status 200 "acct reads the accounts sheet"
expect_jq "[.weeks[0].notes[] | select(.body | contains(\"$M15N_TAG\"))] | length == 2" "this week holds both accounts notes"
expect_jq "[.weeks[0].notes[] | select(.body | contains(\"$M15N_TAG\")) | .id] == [$M15N_N2, $M15N_N1]" "newest first"
expect_jq ".weeks[0].weekStart == \"$M15N_THIS\" and .weeks[1].weekStart == \"$M15N_LAST\" and .thisWeek == \"$M15N_THIS\"" "this week and last week are the Sydney Mondays"
expect_jq "(.weeks[0].notes[] | select(.id == $M15N_N1) | .canEdit) == true and (.weeks[0].notes[] | select(.id == $M15N_N2) | .canEdit) == false" "acct may edit only the note acct wrote"
m15n_get "$ACCT2" accounts
expect_jq "(.weeks[0].notes[] | select(.id == $M15N_N2) | .canEdit) == true and (.weeks[0].notes[] | select(.id == $M15N_N1) | .canEdit) == false" "acct2 may edit only the note acct2 wrote"
m15n_get "$ADMIN" accounts
expect_jq "[.weeks[0].notes[] | select(.body | contains(\"$M15N_TAG\")) | .canEdit] | all(. == false)" "admin may edit neither"
m15n_get "$ADMIN" scheduling
expect_jq "[.weeks[0].notes[] | select(.body | contains(\"$M15N_TAG\"))] | length == 1" "the sheets don't mix: scheduling holds only its own note"
m15n_get "$ADMIN" ordering
expect_jq "[.weeks[] | .notes[] | select(.body | contains(\"$M15N_TAG\"))] | length == 0" "ordering holds none of them"
m15n_get "$SCHED" scheduling
expect_jq "(.weeks[0].notes[] | select(.id == $M15N_NS) | .author.name) == \"CI Scheduling\"" "the scheduling note is signed CI Scheduling"
m15n_get "$SCHED" scheduling
expect_jq '.more == false' "no older notes in scheduling, so no Older weeks"

echo "--- limits ---"
for M15N_BAD in '{"dept":"accounts"}' '{"dept":"accounts","body":""}' '{"dept":"accounts","body":"  \n  "}' '{"dept":"accounts","body":12}' '{"dept":"accounts","body":null}'; do
  req POST /api/notes "$ACCT" "$M15N_BAD"
  expect_status 400 "POST $M15N_BAD"
done
req POST /api/notes "$ACCT" '[1]'
expect_status 400 "POST a JSON array"
M15N_2000=$(printf 'a%.0s' $(seq 1 2000))
M15N_2001="${M15N_2000}a"
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_2001" '{dept:"accounts",body:$b}')"
expect_status 400 "2001 characters"
expect_jq '.error == "Notes are 2,000 characters at most"' "the length sentence"
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_2000" '{dept:"accounts",body:$b}')"
expect_status 201 "exactly 2000 characters"
M15N_N3=$(jqr '.id')
req DELETE "/api/notes/$M15N_N3" "$ACCT"
expect_status 204 "acct removes the long note"
req POST /api/notes "$ACCT" "$(jq -nc --arg b "  x  " '{dept:"accounts",body:$b}')"
expect_status 201 "a one-character note"
expect_jq '.body == "x"' "surrounding spaces are trimmed"
M15N_N4=$(jqr '.id')
req DELETE "/api/notes/$M15N_N4" "$ACCT"
expect_status 204 "acct removes the one-character note"

echo "--- editing and removing, in the week ---"
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg b "$M15N_TAG first note, edited" '{body:$b}')"
expect_status 200 "the author edits the note this week"
expect_jq ".id == $M15N_N1 and .body == \"$M15N_TAG first note, edited\" and .edited == true and .canEdit == true and .author.id == $M15N_ACCT_ID and .weekStart == \"$M15N_THIS\"" "the edited note keeps its author and week and says it was edited"
M15N_U1=$(jqr '.updatedAt')
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg b "$M15N_TAG stale" --arg u "2020-01-01T00:00:00.000Z" '{body:$b,updatedAt:$u}')"
expect_status 409 "an edit from a stale copy"
expect_jq '.error == "This note was changed somewhere else; reload it"' "the stale sentence"
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg b "$M15N_TAG with the current copy" --arg u "$M15N_U1" '{body:$b,updatedAt:$u}')"
expect_status 200 "an edit from the current copy"
req PATCH "/api/notes/$M15N_N1" "$ACCT" '{"body":"   "}'
expect_status 400 "an edit to nothing"
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg b "$M15N_2001" '{body:$b}')"
expect_status 400 "an edit past 2000 characters"
req PATCH "/api/notes/$M15N_N1" "$ACCT" '{"body":"x","updatedAt":5}'
expect_status 400 "a non-text updatedAt"
req PATCH "/api/notes/$M15N_N2" "$ACCT" "$(jq -nc --arg b "$M15N_TAG hijack" '{body:$b}')"
expect_status 403 "acct edits acct2's note"
req PATCH "/api/notes/$M15N_N2" "$ADMIN" "$(jq -nc --arg b "$M15N_TAG hijack" '{body:$b}')"
expect_status 403 "an admin edits acct2's note"
req DELETE "/api/notes/$M15N_N2" "$ACCT"
expect_status 403 "acct removes acct2's note"
req DELETE "/api/notes/$M15N_N2" "$ADMIN"
expect_status 403 "an admin removes acct2's note"
req PATCH "/api/notes/$M15N_NS" "$ACCT" "$(jq -nc --arg b "$M15N_TAG hijack" '{body:$b}')"
expect_status 403 "acct edits a scheduling note (no scheduling key)"
req DELETE "/api/notes/$M15N_NS" "$ACCT"
expect_status 403 "acct removes a scheduling note (no scheduling key)"
req PATCH "/api/notes/$M15N_N2" "$SHOW" '{"body":"x"}'
expect_status 403 "show edits a note"
req PATCH "/api/notes/$M15N_N2" "" '{"body":"x"}'
expect_status 401 "logged out PATCH"
m15n_get "$ACCT2" accounts
expect_jq "(.weeks[0].notes[] | select(.id == $M15N_N2) | .body) == \"$M15N_TAG second note\"" "acct2's note is unchanged"
req PATCH /api/notes/999999999 "$ACCT" '{"body":"x"}'
expect_status 404 "PATCH an unknown note"
req DELETE /api/notes/abc "$ACCT"
expect_status 404 "DELETE a non-numeric id"
req DELETE /api/notes/999999999 "$ACCT"
expect_status 404 "DELETE an unknown note"

# A third note by acct, removed in the week: gone from the sheet.
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG to be removed" '{dept:"accounts",body:$b}')"
expect_status 201 "acct leaves a note to remove"
M15N_NR=$(jqr '.id')
req DELETE "/api/notes/$M15N_NR" "$ACCT"
expect_status 204 "the author removes it this week"
m15n_get "$ACCT" accounts
expect_jq "[.weeks[].notes[] | select(.id == $M15N_NR)] | length == 0" "a removed note is never shown"
req DELETE "/api/notes/$M15N_NR" "$ACCT"
expect_status 404 "removing it again"
req PATCH "/api/notes/$M15N_NR" "$ACCT" '{"body":"back again"}'
expect_status 404 "editing a removed note"

echo "--- the week rolls over ---"
# A note written this week, then the week ends: file it under last week as the clock would have.
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG written before the rollover" '{dept:"accounts",body:$b}')"
expect_status 201 "acct writes a note that will be rolled over"
M15N_NROLL=$(jqr '.id')
docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.prepare("UPDATE dept_notes SET week_start = ? WHERE id = ?").run(process.argv[1], Number(process.argv[2]));
d.close();' "$M15N_LAST" "$M15N_NROLL" || fail "moving the note to last week failed"
m15n_get "$ACCT" accounts
expect_jq "[.weeks[0].notes[] | select(.id == $M15N_NROLL)] | length == 0" "the note has left this week's sheet"
expect_jq "(.weeks[1].notes[] | select(.id == $M15N_NROLL)) | .canEdit == false and .weekStart == \"$M15N_LAST\"" "it sits under last week and is locked"
req PATCH "/api/notes/$M15N_NROLL" "$ACCT" "$(jq -nc --arg b "$M15N_TAG too late" '{body:$b}')"
expect_status 409 "the author edits it after the week ended"
expect_jq '.error == "That week is over, so the note can no longer be changed or removed"' "the locked sentence"
req DELETE "/api/notes/$M15N_NROLL" "$ACCT"
expect_status 409 "the author removes it after the week ended"
req PATCH "/api/notes/$M15N_NROLL" "$ADMIN" '{"body":"x"}'
expect_status 403 "an admin can't change it either"
m15n_get "$ACCT" accounts
expect_jq "(.weeks[1].notes[] | select(.id == $M15N_NROLL) | .body) == \"$M15N_TAG written before the rollover\"" "the locked note is untouched"
# And a row seeded long ago, by acct2, in the same department.
m15n_seed accounts "$(m15n_back 2)" "$M15N_TAG two weeks back" "$M15N_ACCT2_ID"
M15N_NOLD=$M15N_SEEDED
req PATCH "/api/notes/$M15N_NOLD" "$ACCT2" "$(jq -nc --arg b "$M15N_TAG too late" '{body:$b}')"
expect_status 409 "acct2 edits a note from two weeks back"
req DELETE "/api/notes/$M15N_NOLD" "$ACCT2"
expect_status 409 "acct2 removes a note from two weeks back"

echo "--- older weeks ---"
# Weeks back 3, 4, 5, 6, 7 hold one note each, week 9 holds one, week 8 holds only a removed one.
for M15N_W in 3 4 5 6 7 9; do
  m15n_seed accounts "$(m15n_back $M15N_W)" "$M15N_TAG week -$M15N_W" "$M15N_ACCT_ID"
done
m15n_seed accounts "$(m15n_back 8)" "$M15N_TAG removed week -8" "$M15N_ACCT_ID" removed
m15n_get "$ACCT" accounts
expect_jq '.more == true' "older notes exist, so Older weeks shows"
expect_jq ".next == \"$M15N_LAST\"" "the cursor is last week's Monday"
m15n_get "$ACCT" accounts "&before=$M15N_LAST"
expect_status 200 "the first Older weeks press"
expect_jq ".weeks | length == 4" "four weeks at a time"
expect_jq "[.weeks[].weekStart] == [\"$(m15n_back 2)\", \"$(m15n_back 3)\", \"$(m15n_back 4)\", \"$(m15n_back 5)\"]" "newest first, starting just before last week"
expect_jq '.more == true' "more remain"
M15N_NEXT=$(jqr '.next')
expect_eq "$M15N_NEXT" "$(m15n_back 5)" "the cursor is the oldest week returned"
expect_jq '[.weeks[].notes[] | .canEdit] | all(. == false)' "older weeks are locked"
m15n_get "$ACCT" accounts "&before=$M15N_NEXT"
expect_jq "[.weeks[].weekStart] == [\"$(m15n_back 6)\", \"$(m15n_back 7)\", \"$(m15n_back 9)\"]" "the next press: the rest, skipping the week with only a removed note"
expect_jq '.more == false' "nothing older is left"
expect_jq "[.weeks[].notes[] | select(.body | contains(\"removed\"))] | length == 0" "a removed note is hidden in the older weeks too"
m15n_get "$ACCT" accounts "&before=$M15N_LAST&limit=2"
expect_jq '(.weeks | length) == 2 and .more == true' "limit=2 gives two weeks and more"
m15n_get "$ACCT" accounts "&before=$(m15n_back 9)"
expect_jq '.weeks == [] and .more == false' "before the oldest week: nothing"
m15n_get "$ACCT" accounts "&before=yesterday"
expect_status 400 "a before that isn't a date"
m15n_get "$ACCT" accounts "&before=$M15N_LAST&limit=0"
expect_status 400 "limit=0"
m15n_get "$ACCT" scheduling "&before=$M15N_LAST"
expect_status 403 "older weeks of a department without the key"
m15n_get "$ADMIN" ordering "&before=$M15N_LAST"
expect_jq '.weeks == []' "older weeks of another department hold none of these"

echo "--- the audit trail ---"
req GET "/api/audit?action=note.&entityType=dept_note&limit=500" "$ADMIN"
expect_status 200 "admin reads the note audit rows"
expect_jq "[.rows[] | select(.action == \"note.create\" and .entityId == \"$M15N_N1\" and .after.dept == \"accounts\" and .after.weekStart == \"$M15N_THIS\" and (.after.body | startswith(\"$M15N_TAG first note\")))] | length == 1" "a note.create row with the text"
expect_jq "[.rows[] | select(.action == \"note.update\" and .entityId == \"$M15N_N1\" and (.before.body | contains(\"edited\")) and (.after.body | contains(\"current copy\")))] | length == 1" "a note.update row with before and after"
expect_jq "[.rows[] | select(.action == \"note.update\" and .entityId == \"$M15N_N1\")] | length == 2" "one row per successful edit (none for the refused ones)"
expect_jq "[.rows[] | select(.action == \"note.remove\" and .entityId == \"$M15N_NR\" and (.before.body | contains(\"to be removed\")))] | length == 1" "a note.remove row with the text"
expect_jq "[.rows[] | select(.entityId == \"$M15N_NROLL\" and .action != \"note.create\")] | length == 0" "no audit rows for the refused rollover edits"
expect_jq "[.rows[] | select(.action == \"note.update\" and .entityId == \"$M15N_N2\")] | length == 0" "no rows for the refused edits of acct2's note"
expect_jq "[.rows[] | select(.action == \"note.create\" and .entityId == \"$M15N_NA\")] | length == 1" "the admin sheet's note is audited too"
expect_jq "[.rows[] | select(.entityId == \"$M15N_N1\")] | all(.entityType == \"dept_note\")" "the entity type is dept_note"

echo "--- the table's own checks ---"
M15N_DB=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
const tries = [
  ["bogus dept", ["bogus", "2024-01-01", "x"]],
  ["empty body", ["accounts", "2024-01-01", ""]],
  ["blank body", ["accounts", "2024-01-01", "   "]],
  ["2001 chars", ["accounts", "2024-01-01", "a".repeat(2001)]],
  ["bad week", ["accounts", "next monday", "x"]],
];
const out = [];
for (const [name, [dept, week, body]] of tries) {
  try {
    d.prepare("INSERT INTO dept_notes (dept, week_start, body, author_id) VALUES (?, ?, ?, 1)").run(dept, week, body);
    out.push(name + ":accepted");
  } catch (e) {
    out.push(name + ":refused");
  }
}
const idx = d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name = ?").get("index", "idx_dept_notes_dept_week").n;
out.push("index:" + idx);
console.log(out.join(" "));
d.close();' | tr -d '\r') || fail "the table checks failed to run"
expect_eq "$M15N_DB" "bogus dept:refused empty body:refused blank body:refused 2001 chars:refused bad week:refused index:1" "dept_notes refuses a bad department, body or week; the index exists"
