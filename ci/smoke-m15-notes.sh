# M15 smoke: department notes (docs/plans/notes-contracts.md), a week wall per department where
# its people stick signed notes on a weekday for each other and give them a thumbs-up.
# Sourced by ci/smoke.sh after the M14 suites, so it shares that script's helpers (step, req, hdr,
# expect_status, expect_jq, expect_eq, jqr, fail, ok, sydney_monday), the cookie jars ($ADMIN
# $SCHED $ACCT $ACCT2 $DPM $SHOW $WSHOP $ORDR $WSMGR), $BASE, $REQ_ORIGIN, $BODY_FILE, $HDR_FILE, $WORK
# and $CONTAINER. No shebang and no `set`: the caller owns both.
# It does not assume a pristine database, and it works on any day of the week (the dates it uses
# are worked out from Sydney's today): its notes carry a run tag in their text, it reads counts as
# the notes carrying that tag, and the old-week rows it seeds sit in weeks the app never writes to.
# Made-up names only (this repo is public). Modelled on smoke-m4-tasks.sh and smoke-m14-*.sh.

# ============================================================================
step "m15-notes. department notes: a week wall per department, with thumbs-up"
# ============================================================================

M15N_TAG="m15n$(date +%s)"
# Every date below comes from Sydney's today, so don't start in the last minutes before its
# midnight: wait until it has passed. The end of the suite checks the day didn't change.
while [ "$(TZ=Australia/Sydney date +%H%M)" -ge 2355 ]; do
  echo "    (waiting for Sydney midnight to pass before the notes suite starts)"
  sleep 15
done
# One reading of the clock gives both the date and the weekday (1 = Monday .. 7 = Sunday).
read -r M15N_TODAY M15N_DOW < <(TZ=Australia/Sydney date '+%F %u')
# m15n_plus DATE +N|-N: the date N days from DATE. m15n_monday_of DATE: that week's Monday.
m15n_plus() { date -u -d "$1 $2 days" +%F; }
m15n_monday_of() { local d; d=$(date -u -d "$1" +%u); date -u -d "$1 -$((d - 1)) days" +%F; }
M15N_THIS=$(m15n_monday_of "$M15N_TODAY")
M15N_LAST=$(m15n_plus "$M15N_THIS" -7)
M15N_NEXT=$(m15n_plus "$M15N_THIS" +7)
# The next weekday after today (Fri -> Monday, Sat -> Monday, Sun -> Monday), and the day a note
# written now sits under when no day is named (today on a weekday, else the next Monday).
case $M15N_DOW in 5) M15N_STEP=3 ;; 6) M15N_STEP=2 ;; *) M15N_STEP=1 ;; esac
M15N_NEXTWD=$(m15n_plus "$M15N_TODAY" "+$M15N_STEP")
if [ "$M15N_DOW" -le 5 ]; then M15N_DAY0=$M15N_TODAY; else M15N_DAY0=$M15N_NEXTWD; fi
M15N_W0=$(m15n_monday_of "$M15N_DAY0")      # the week the default day is in
M15N_WNEXTWD=$(m15n_monday_of "$M15N_NEXTWD")
M15N_PASTFRI=$(m15n_plus "$M15N_THIS" -3)   # last Friday: always a past weekday
M15N_SAT=$(m15n_plus "$M15N_THIS" +5)
M15N_SUN=$(m15n_plus "$M15N_THIS" +6)
M15N_NEXTWED=$(m15n_plus "$M15N_NEXT" +2)   # a Wednesday in next week: always a future weekday
M15N_NEXTFRI=$(m15n_plus "$M15N_NEXT" +4)
M15N_LASTWED=$(m15n_plus "$M15N_LAST" +2)

# m15n_seed DEPT DATE BODY AUTHOR_ID [REMOVED]: inserts a row straight into dept_notes (the app lets
# a note go on today or later only, so past days are seeded); sets M15N_SEEDED to its id.
m15n_seed() {
  M15N_SEEDED=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
const [dept, date, body, author, removed] = process.argv.slice(1);
const dt = new Date(date + "T00:00:00Z");
const dow = dt.getUTCDay();
dt.setUTCDate(dt.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
const week = dt.toISOString().slice(0, 10);
const at = date + "T01:00:00.000Z";
const info = d.prepare(
  "INSERT INTO dept_notes (dept, note_date, week_start, body, author_id, created_at, updated_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
).run(dept, date, week, body, Number(author), at, at, removed ? at : null);
console.log(String(info.lastInsertRowid));
d.close();' "$1" "$2" "$3" "$4" "${5:-}" | tr -d '\r') || fail "seeding a dept_notes row failed"
  [ -n "$M15N_SEEDED" ] || fail "seeding a dept_notes row gave no id"
}

# m15n_get JAR DEPT [EXTRA QUERY, starting with &]: GET /api/notes for a department.
m15n_get() {
  req GET "/api/notes?dept=$2${3:-}" "$1"
}
# m15n_week JAR DEPT MONDAY: the same, for one week.
m15n_week() {
  req GET "/api/notes?dept=$2&week=$3" "$1"
}
# m15n_note ID: a jq expression for that note in the last answer.
m15n_note() {
  printf '([.days[].notes[] | select(.id == %s)][0])' "$1"
}

req GET /api/auth/me "$ADMIN"
M15N_ADMIN_ID=$(jqr '.user.id')
M15N_ADMIN_NAME=$(jqr '.user.displayName')
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
for M15N_PAIR in scheduling:notes.scheduling design:notes.design ordering:notes.ordering accounts:notes.accounts admin:notes.admin; do
  M15N_D=${M15N_PAIR%%:*}
  M15N_K=${M15N_PAIR#*:}
  printf '%s\n' "$M15N_SHELL" | grep -qF "home: { href: \"/notes.html?dept=$M15N_D\", key: \"$M15N_K\" }" \
    || fail "the $M15N_D department name doesn't open Notes with key $M15N_K"
  ok
done
req GET "/notes.html?dept=accounts"
expect_status 302 "logged out GET /notes.html"
for M15N_J in "$ACCT" "$SCHED" "$DPM" "$ADMIN" "$WSMGR" "$ORDR"; do
  req GET "/notes.html?dept=accounts&week=$M15N_LAST" "$M15N_J"
  expect_status 200 "a department login GET /notes.html (with a week in the address)"
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
req PUT /api/notes/1/ack ""
expect_status 401 "logged out PUT /api/notes/1/ack"
# Each department has its own key: acct holds notes.accounts only, sched notes.scheduling, dpm
# notes.design, ordr and wsmgr notes.ordering, admin all five, show and wshop none.
m15n_get "$ACCT" accounts;   expect_status 200 "acct GET accounts notes"
expect_jq '.dept == "accounts" and .deptLabel == "Accounts" and (.days | length) == 5 and .current == true and .past == false' "the answer's shape: this week as five days"
for M15N_D in scheduling design ordering admin; do
  m15n_get "$ACCT" "$M15N_D"; expect_status 403 "acct GET $M15N_D notes (no orders.view or other key opens it)"
done
m15n_get "$SCHED" scheduling; expect_status 200 "sched GET scheduling notes"
for M15N_D in design ordering accounts admin; do
  m15n_get "$SCHED" "$M15N_D"; expect_status 403 "sched GET $M15N_D notes"
done
m15n_get "$DPM" design;     expect_status 200 "dpm GET design notes"
m15n_get "$DPM" scheduling; expect_status 403 "dpm holds scheduling.view but not notes.scheduling"
m15n_get "$DPM" ordering;   expect_status 403 "dpm holds orders.view but not notes.ordering"
m15n_get "$ORDR" ordering;  expect_status 200 "ordr GET ordering notes"
m15n_get "$ORDR" design;    expect_status 403 "ordr holds design.view but not notes.design"
m15n_get "$WSMGR" ordering; expect_status 200 "wsmgr GET ordering notes"
m15n_get "$WSMGR" accounts; expect_status 403 "wsmgr GET accounts notes"
for M15N_D in scheduling design ordering accounts admin; do
  m15n_get "$SHOW" "$M15N_D"
  expect_status 403 "show GET $M15N_D notes"
  m15n_get "$WSHOP" "$M15N_D"
  expect_status 403 "wshop GET $M15N_D notes"
  m15n_get "$ADMIN" "$M15N_D"
  expect_status 200 "admin GET $M15N_D notes"
done
echo "--- per-person grant and revoke ---"
req PUT "/api/users/$ACCT2_ID/overrides/notes.ordering" "$ADMIN" '{"effect":"grant"}'
expect_status 200 "grant notes.ordering to acct2"
m15n_get "$ACCT2" ordering; expect_status 200 "acct2 reads ordering notes with the grant"
req POST /api/notes "$ACCT2" "$(jq -nc --arg b "grant check ${M15N_TAG#m15n}" '{dept:"ordering",body:$b}')"
expect_status 201 "acct2 leaves an ordering note with the grant"
M15N_NG=$(jqr '.id')
req GET "/notes.html?dept=ordering" "$ACCT2"
expect_status 200 "acct2 opens the page"
req DELETE "/api/users/$ACCT2_ID/overrides/notes.ordering" "$ADMIN"
expect_status 200 "remove the grant"
m15n_get "$ACCT2" ordering; expect_status 403 "acct2 loses ordering notes without the grant"
req PATCH "/api/notes/$M15N_NG" "$ACCT2" '{"body":"x"}'
expect_status 403 "acct2 can't edit its ordering note any more"
req PUT "/api/notes/$M15N_NG/ack" "$ACCT"
expect_status 403 "acct (no ordering key) can't thumbs-up an ordering note"
req PUT "/api/users/$ACCT2_ID/overrides/notes.accounts" "$ADMIN" '{"effect":"revoke"}'
expect_status 200 "revoke notes.accounts from acct2"
m15n_get "$ACCT2" accounts; expect_status 403 "acct2 loses accounts notes with the revoke"
req DELETE "/api/users/$ACCT2_ID/overrides/notes.accounts" "$ADMIN"
expect_status 200 "remove the revoke"
m15n_get "$ACCT2" accounts; expect_status 200 "acct2 has accounts notes again"
req GET /api/users/meta "$ADMIN"
expect_jq '.keys | (index("notes.scheduling") != null and index("notes.design") != null and index("notes.ordering") != null and index("notes.accounts") != null and index("notes.admin") != null)' "the five notes keys are in the key list"
expect_jq '.presets.accounts | index("notes.accounts") != null' "the accounts preset has notes.accounts"
expect_jq '[.presets.accounts, .presets.design_pm, .presets.scheduling, .presets.ordering, .presets.workshop_manager] | map(map(select(startswith("notes.")))) == [["notes.accounts"],["notes.design"],["notes.scheduling"],["notes.ordering"],["notes.ordering"]]' "each role has just its own department's notes key"
expect_jq '[.presets.showroom, .presets.workshop] | map(map(select(startswith("notes.")))) == [[],[]]' "showroom and workshop have none"
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

echo "--- the week wall ---"
m15n_get "$ACCT" accounts
expect_jq ".thisWeek == \"$M15N_THIS\" and .weekStart == \"$M15N_THIS\" and .today == \"$M15N_TODAY\" and .prev == \"$M15N_LAST\" and .next == \"$M15N_NEXT\"" "this week is the Sydney Monday, with the Mondays either side"
expect_jq ".heading | startswith(\"Week of Mon \")" "the heading names the Monday"
expect_jq "[.days[].name] == [\"Mon\",\"Tue\",\"Wed\",\"Thu\",\"Fri\"] and .days[0].date == \"$M15N_THIS\" and .days[4].date == \"$(m15n_plus "$M15N_THIS" +4)\"" "five days, Monday to Friday"
expect_jq '[.days[].label] | all(test("^(Mon|Tue|Wed|Thu|Fri) [0-9]{1,2} [A-Z][a-z]{2}$"))' "each day is headed like Tue 13 Oct"
if [ "$M15N_DOW" -le 5 ]; then
  expect_jq "[.days[] | select(.today)] | length == 1 and .[0].date == \"$M15N_TODAY\"" "today's column is marked"
else
  expect_jq '[.days[] | select(.today)] | length == 0' "no column is today on a weekend"
fi
expect_jq "[.days[] | select(.canAdd == (.date >= \"$M15N_TODAY\"))] | length == 5" "a day takes a new note when it is today or later"
expect_jq ".canAdd == true and (.formDays | length) >= 1 and .defaultDate == \"$M15N_DAY0\"" "the add form offers days and defaults to today (or the next Monday on a weekend)"
expect_jq "[.formDays[].date] | all(. >= \"$M15N_TODAY\")" "the form offers no past day"

echo "--- writing and reading ---"
M15N_B1="$M15N_TAG first note, with <b>tags</b> & a <script>x</script>
second line"
req POST /api/notes "$ACCT" "$(jq -nc --arg b "  $M15N_B1  " '{dept:"accounts",body:$b}')"
expect_status 201 "acct leaves a note, naming no day"
M15N_N1=$(jqr '.id')
expect_jq ".dept == \"accounts\" and .date == \"$M15N_DAY0\" and .weekStart == \"$M15N_W0\" and .author.id == $M15N_ACCT_ID and .author.name == \"$M15N_ACCT_NAME\" and .canEdit == true and .canAck == false and .edited == false and (.createdAt | type == \"string\") and (.body | endswith(\"second line\"))" \
  "the note is signed by acct, sits under today (or the next Monday), and is trimmed"
expect_jq '.acks.count == 0 and .acks.names == [] and .acks.mine == false' "a new note has no thumbs-up"
printf '%s' "$BODY" | jq -e --arg b "$M15N_B1" '.body == $b' >/dev/null \
  || fail "the stored text differs from what was sent (line break kept, markup not touched): ${BODY:0:300}"
ok
req POST /api/notes "$ACCT2" "$(jq -nc --arg b "$M15N_TAG second note" --arg d "$M15N_DAY0" '{dept:"accounts",date:$d,body:$b}')"
expect_status 201 "acct2 leaves a note on the same day"
M15N_N2=$(jqr '.id')
expect_jq ".author.id == $M15N_ACCT2_ID and .author.name == \"$M15N_ACCT2_NAME\" and .date == \"$M15N_DAY0\"" "the second note is signed by acct2"
req POST /api/notes "$ACCT2" "$(jq -nc --arg b "$M15N_TAG a later day" --arg d "$M15N_NEXTWD" '{dept:"accounts",date:$d,body:$b}')"
expect_status 201 "acct2 leaves a note on a later day"
M15N_NF=$(jqr '.id')
expect_jq ".date == \"$M15N_NEXTWD\" and .weekStart == \"$M15N_WNEXTWD\"" "it is filed under that day's week"
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG next week" --arg d "$M15N_NEXTWED" '{dept:"accounts",date:$d,body:$b}')"
expect_status 201 "acct leaves a note on a day of next week"
M15N_NFW=$(jqr '.id')
expect_jq ".date == \"$M15N_NEXTWED\" and .weekStart == \"$M15N_NEXT\"" "it is filed under next week"
req POST /api/notes "$SCHED" "$(jq -nc --arg b "$M15N_TAG scheduling note" '{dept:"scheduling",body:$b}')"
expect_status 201 "sched leaves a scheduling note"
M15N_NS=$(jqr '.id')
req POST /api/notes "$ADMIN" "$(jq -nc --arg b "$M15N_TAG admin note" '{dept:"admin",body:$b}')"
expect_status 201 "admin leaves an admin note"
M15N_NA=$(jqr '.id')
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG admin note" '{dept:"admin",body:$b}')"
expect_status 403 "acct can't write on the admin sheet"

m15n_week "$ACCT" accounts "$M15N_W0"
expect_status 200 "acct reads the accounts wall"
expect_jq "[.days[] | select(.date == \"$M15N_DAY0\") | .notes[] | select(.id == $M15N_N1 or .id == $M15N_N2) | .id] == [$M15N_N1, $M15N_N2]" "a day's notes stack in the order posted"
expect_jq "$(m15n_note "$M15N_N1").canEdit == true and $(m15n_note "$M15N_N2").canEdit == false" "acct may edit only the note acct wrote"
expect_jq "$(m15n_note "$M15N_N1").canAck == false and $(m15n_note "$M15N_N2").canAck == true" "acct may thumbs-up only the note acct2 wrote"
m15n_week "$ACCT2" accounts "$M15N_W0"
expect_jq "$(m15n_note "$M15N_N2").canEdit == true and $(m15n_note "$M15N_N1").canEdit == false" "acct2 may edit only the note acct2 wrote"
m15n_week "$ADMIN" accounts "$M15N_W0"
expect_jq "[.days[].notes[] | select(.body | contains(\"$M15N_TAG\")) | .canEdit] | length >= 2 and all(. == false)" "admin may edit neither"
expect_jq "[.days[].notes[] | select(.body | contains(\"$M15N_TAG\")) | .canAck] | length >= 2 and all(. == true)" "admin may thumbs-up both"
m15n_week "$ACCT" accounts "$M15N_WNEXTWD"
expect_jq "[.days[].notes[] | select(.id == $M15N_NF)] | length == 1" "the later-day note is on its own week's wall"
m15n_week "$ACCT" accounts "$M15N_NEXT"
expect_jq "[.days[] | select(.date == \"$M15N_NEXTWED\") | .notes[] | select(.id == $M15N_NFW)] | length == 1" "the next-week note sits under its Wednesday"
m15n_week "$ADMIN" scheduling "$M15N_W0"
expect_jq "[.days[].notes[] | select(.body | contains(\"$M15N_TAG\"))] | length == 1" "the sheets don't mix: scheduling holds only its own note"
m15n_week "$ADMIN" ordering "$M15N_W0"
expect_jq "[.days[].notes[] | select(.body | contains(\"$M15N_TAG\"))] | length == 0" "ordering holds none of them"
m15n_week "$SCHED" scheduling "$M15N_W0"
expect_jq "$(m15n_note "$M15N_NS").author.name == \"CI Scheduling\"" "the scheduling note is signed CI Scheduling"

echo "--- which days a note may go on ---"
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG past" --arg d "$M15N_PASTFRI" '{dept:"accounts",date:$d,body:$b}')"
expect_status 400 "a note on a past day"
expect_jq '.error == "Notes can only go on today or a later day"' "the past-day sentence"
for M15N_WE in "$M15N_SAT" "$M15N_SUN" "$(m15n_plus "$M15N_NEXT" +5)"; do
  req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG weekend" --arg d "$M15N_WE" '{dept:"accounts",date:$d,body:$b}')"
  expect_status 400 "a note on the weekend date $M15N_WE"
  expect_jq '.error == "Notes go on a weekday, Monday to Friday"' "the weekend sentence"
done
for M15N_BADDATE in '"yesterday"' '"2030-02-30"' '"2030-1-5"' '12' 'true'; do
  req POST /api/notes "$ACCT" "{\"dept\":\"accounts\",\"date\":$M15N_BADDATE,\"body\":\"$M15N_TAG bad date\"}"
  expect_status 400 "a note with the date $M15N_BADDATE"
  expect_jq '.error == "Choose a day for the note"' "the bad-date sentence"
done
if [ "$M15N_DOW" -le 5 ]; then
  req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG today" --arg d "$M15N_TODAY" '{dept:"accounts",date:$d,body:$b}')"
  expect_status 201 "a note on today"
  M15N_NT=$(jqr '.id')
else
  req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG today" --arg d "$M15N_TODAY" '{dept:"accounts",date:$d,body:$b}')"
  expect_status 400 "a note on today when today is a weekend day"
  req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG weekend default" '{dept:"accounts",body:$b}')"
  expect_status 201 "a note naming no day on a weekend"
  M15N_NT=$(jqr '.id')
  expect_jq ".date == \"$M15N_NEXTWD\"" "it goes under the next Monday"
fi
if [ "$M15N_DOW" -ge 2 ]; then
  m15n_week "$ACCT" accounts "$M15N_THIS"
  expect_jq "[.days[] | select(.date == \"$M15N_THIS\") | .canAdd] == [false]" "an earlier day of this week takes no new note"
  req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG earlier this week" --arg d "$M15N_THIS" '{dept:"accounts",date:$d,body:$b}')"
  expect_status 400 "a note on an earlier day of this week"
fi
M15N_UNIT=$(docker exec "$CONTAINER" node -e '
const n = require("/app/lib/notes.js");
console.log(["2030-01-04", "2030-01-05", "2030-01-06", "2030-01-07", "2030-01-08"].map(n.defaultDate).join(" "));' | tr -d '\r') || fail "the default-day check failed to run"
expect_eq "$M15N_UNIT" "2030-01-04 2030-01-07 2030-01-07 2030-01-07 2030-01-08" "a weekend note defaults to the next Monday (Fri, Sat, Sun, Mon, Tue)"

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

echo "--- editing, moving and removing ---"
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg b "$M15N_TAG first note, edited" '{body:$b}')"
expect_status 200 "the author edits the note"
expect_jq ".id == $M15N_N1 and .body == \"$M15N_TAG first note, edited\" and .edited == true and .canEdit == true and .author.id == $M15N_ACCT_ID and .date == \"$M15N_DAY0\"" "the edited note keeps its author and day and says it was edited"
M15N_U1=$(jqr '.updatedAt')
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg b "$M15N_TAG stale" --arg u "2020-01-01T00:00:00.000Z" '{body:$b,updatedAt:$u}')"
expect_status 409 "an edit from a stale copy"
expect_jq '.error == "This note was changed somewhere else; reload it"' "the stale sentence"
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg b "$M15N_TAG with the current copy" --arg u "$M15N_U1" '{body:$b,updatedAt:$u}')"
expect_status 200 "an edit from the current copy"
M15N_U1=$(jqr '.updatedAt')
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg b "$M15N_TAG with the current copy" '{body:$b}')"
expect_status 200 "an edit that changes nothing"
expect_jq ".updatedAt == \"$M15N_U1\"" "changes nothing, moves nothing"
req PATCH "/api/notes/$M15N_N1" "$ACCT" '{"body":"   "}'
expect_status 400 "an edit to nothing"
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg b "$M15N_2001" '{body:$b}')"
expect_status 400 "an edit past 2000 characters"
req PATCH "/api/notes/$M15N_N1" "$ACCT" '{"body":"x","updatedAt":5}'
expect_status 400 "a non-text updatedAt"
req PATCH "/api/notes/$M15N_N1" "$ACCT" '{}'
expect_status 400 "an edit that names nothing to change"
expect_jq '.error == "Nothing to change"' "the nothing-to-change sentence"
# moving to another day
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg d "$M15N_NEXTWED" '{date:$d}')"
expect_status 200 "the author moves the note to a day of next week"
expect_jq ".date == \"$M15N_NEXTWED\" and .weekStart == \"$M15N_NEXT\" and .edited == true and .canEdit == true and (.body | contains(\"current copy\"))" "it moved, kept its text, and a note in a future week stays editable"
m15n_week "$ACCT" accounts "$M15N_NEXT"
expect_jq "[.days[] | select(.date == \"$M15N_NEXTWED\") | .notes[] | select(.id == $M15N_N1)] | length == 1" "the wall shows it under the new day"
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg d "$M15N_NEXTFRI" '{date:$d}')"
expect_status 200 "the author moves it again, to the Friday"
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg d "$M15N_DAY0" --arg b "$M15N_TAG moved back" '{date:$d,body:$b}')"
expect_status 200 "the author moves it back and edits the text in one go"
expect_jq ".date == \"$M15N_DAY0\" and .body == \"$M15N_TAG moved back\"" "both took"
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg d "$M15N_PASTFRI" '{date:$d}')"
expect_status 400 "a move to a past day"
expect_jq '.error == "Notes can only go on today or a later day"' "the past-day sentence for a move"
req PATCH "/api/notes/$M15N_N1" "$ACCT" "$(jq -nc --arg d "$M15N_SAT" '{date:$d}')"
expect_status 400 "a move to a Saturday"
req PATCH "/api/notes/$M15N_N1" "$ACCT" '{"date":"someday"}'
expect_status 400 "a move to nothing like a date"
req PATCH "/api/notes/$M15N_N1" "$ACCT" '{"date":5}'
expect_status 400 "a move to a number"
m15n_week "$ACCT" accounts "$M15N_W0"
expect_jq "$(m15n_note "$M15N_N1").date == \"$M15N_DAY0\" and $(m15n_note "$M15N_N1").body == \"$M15N_TAG moved back\"" "the refused moves changed nothing"
# a note on an earlier day of the current week: its text may change, it may move on, never back
m15n_seed accounts "$M15N_THIS" "$M15N_TAG on Monday" "$M15N_ACCT_ID"
M15N_NMON=$M15N_SEEDED
req PATCH "/api/notes/$M15N_NMON" "$ACCT" "$(jq -nc --arg b "$M15N_TAG on Monday, edited" '{body:$b}')"
expect_status 200 "the author edits a note that sits on an earlier day of this week"
req PATCH "/api/notes/$M15N_NMON" "$ACCT" "$(jq -nc --arg b "$M15N_TAG on Monday, edited again" --arg d "$M15N_THIS" '{body:$b,date:$d}')"
expect_status 200 "an edit that names the day it is already on"
req PATCH "/api/notes/$M15N_NMON" "$ACCT" "$(jq -nc --arg d "$M15N_NEXTWD" '{date:$d}')"
expect_status 200 "the author moves it forward"
if [ "$M15N_DOW" -ge 2 ]; then
  req PATCH "/api/notes/$M15N_NMON" "$ACCT" "$(jq -nc --arg d "$M15N_THIS" '{date:$d}')"
  expect_status 400 "the author can't move it back onto a past day"
fi
req DELETE "/api/notes/$M15N_NMON" "$ACCT"
expect_status 204 "the author removes it"
# other people
req PATCH "/api/notes/$M15N_N2" "$ACCT" "$(jq -nc --arg b "$M15N_TAG hijack" '{body:$b}')"
expect_status 403 "acct edits acct2's note"
req PATCH "/api/notes/$M15N_N2" "$ACCT" "$(jq -nc --arg d "$M15N_NEXTWD" '{date:$d}')"
expect_status 403 "acct moves acct2's note"
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
m15n_week "$ACCT2" accounts "$M15N_W0"
expect_jq "$(m15n_note "$M15N_N2").body == \"$M15N_TAG second note\" and $(m15n_note "$M15N_N2").date == \"$M15N_DAY0\"" "acct2's note is unchanged"
req PATCH /api/notes/999999999 "$ACCT" '{"body":"x"}'
expect_status 404 "PATCH an unknown note"
req DELETE /api/notes/abc "$ACCT"
expect_status 404 "DELETE a non-numeric id"
req DELETE /api/notes/999999999 "$ACCT"
expect_status 404 "DELETE an unknown note"
# removing
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG to be removed" '{dept:"accounts",body:$b}')"
expect_status 201 "acct leaves a note to remove"
M15N_NR=$(jqr '.id')
req DELETE "/api/notes/$M15N_NR" "$ACCT"
expect_status 204 "the author removes it"
m15n_week "$ACCT" accounts "$M15N_W0"
expect_jq "[.days[].notes[] | select(.id == $M15N_NR)] | length == 0" "a removed note is never shown"
req DELETE "/api/notes/$M15N_NR" "$ACCT"
expect_status 404 "removing it again"
req PATCH "/api/notes/$M15N_NR" "$ACCT" '{"body":"back again"}'
expect_status 404 "editing a removed note"
req PUT "/api/notes/$M15N_NR/ack" "$ACCT2"
expect_status 404 "a thumbs-up on a removed note"
# a future-week note can be removed
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG future remove" --arg d "$M15N_NEXTWED" '{dept:"accounts",date:$d,body:$b}')"
expect_status 201 "acct leaves a note for next week"
M15N_NFR=$(jqr '.id')
req DELETE "/api/notes/$M15N_NFR" "$ACCT"
expect_status 204 "the author removes a note of a future week"

echo "--- past weeks are read-only ---"
# A note written now, then its week ends: file it under last Wednesday as the clock would have.
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG written before the rollover" '{dept:"accounts",body:$b}')"
expect_status 201 "acct writes a note that will be rolled over"
M15N_NROLL=$(jqr '.id')
docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.prepare("UPDATE dept_notes SET note_date = ?, week_start = ? WHERE id = ?").run(process.argv[1], process.argv[2], Number(process.argv[3]));
d.close();' "$M15N_LASTWED" "$M15N_LAST" "$M15N_NROLL" || fail "moving the note to last week failed"
m15n_week "$ACCT" accounts "$M15N_LAST"
expect_jq "$(m15n_note "$M15N_NROLL").canEdit == false and $(m15n_note "$M15N_NROLL").weekStart == \"$M15N_LAST\" and $(m15n_note "$M15N_NROLL").date == \"$M15N_LASTWED\"" "it sits under last Wednesday and is locked"
expect_jq '.past == true and .current == false and .canAdd == false and .formDays == [] and ([.days[].canAdd] | all(. == false))' "last week offers no way to add a note"
m15n_get "$ACCT" accounts
expect_jq "[.days[].notes[] | select(.id == $M15N_NROLL)] | length == 0" "the note has left this week's wall"
req PATCH "/api/notes/$M15N_NROLL" "$ACCT" "$(jq -nc --arg b "$M15N_TAG too late" '{body:$b}')"
expect_status 409 "the author edits it after the week ended"
expect_jq '.error == "That week is over, so the note can no longer be changed or removed"' "the locked sentence"
req PATCH "/api/notes/$M15N_NROLL" "$ACCT" "$(jq -nc --arg d "$M15N_NEXTWD" '{date:$d}')"
expect_status 409 "the author moves it after the week ended"
req DELETE "/api/notes/$M15N_NROLL" "$ACCT"
expect_status 409 "the author removes it after the week ended"
req PATCH "/api/notes/$M15N_NROLL" "$ADMIN" '{"body":"x"}'
expect_status 403 "an admin can't change it either"
m15n_week "$ACCT" accounts "$M15N_LAST"
expect_jq "$(m15n_note "$M15N_NROLL").body == \"$M15N_TAG written before the rollover\"" "the locked note is untouched"
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG into the past" --arg d "$M15N_LASTWED" '{dept:"accounts",date:$d,body:$b}')"
expect_status 400 "no new note goes on a day of last week"
# And a row seeded long ago, by acct2, in the same department.
m15n_seed accounts "$(m15n_plus "$M15N_LASTWED" -7)" "$M15N_TAG two weeks back" "$M15N_ACCT2_ID"
M15N_NOLD=$M15N_SEEDED
req PATCH "/api/notes/$M15N_NOLD" "$ACCT2" "$(jq -nc --arg b "$M15N_TAG too late" '{body:$b}')"
expect_status 409 "acct2 edits a note from two weeks back"
req DELETE "/api/notes/$M15N_NOLD" "$ACCT2"
expect_status 409 "acct2 removes a note from two weeks back"

echo "--- walking through the weeks ---"
# Weeks back 3, 4, 5 hold one seeded note each; week 6 holds only a removed one.
for M15N_W in 3 4 5; do
  m15n_seed accounts "$(m15n_plus "$M15N_THIS" "-$((M15N_W * 7 - 4))")" "$M15N_TAG week -$M15N_W" "$M15N_ACCT_ID"
done
m15n_seed accounts "$(m15n_plus "$M15N_THIS" -38)" "$M15N_TAG removed week -6" "$M15N_ACCT_ID" removed
M15N_M3=$(m15n_plus "$M15N_THIS" -21)
m15n_week "$ACCT" accounts "$M15N_M3"
expect_status 200 "three weeks back"
expect_jq ".weekStart == \"$M15N_M3\" and .past == true and .current == false and .prev == \"$(m15n_plus "$M15N_M3" -7)\" and .next == \"$(m15n_plus "$M15N_M3" +7)\"" "the week and its neighbours"
expect_jq "[.days[].notes[] | select(.body | contains(\"$M15N_TAG week -3\"))] | length == 1 and .[0].canEdit == false and .[0].date == \"$(m15n_plus "$M15N_M3" +4)\"" "its note sits under Friday and is locked"
m15n_week "$ACCT" accounts "$(m15n_plus "$M15N_THIS" -42)"
expect_jq "[.days[].notes[] | select(.body | contains(\"removed\"))] | length == 0" "a removed note is hidden in the past weeks too"
m15n_week "$ACCT" accounts "$(m15n_plus "$M15N_THIS" -$((52 * 7)))"
expect_status 200 "a year back"
expect_jq '([.days[].notes[]] | length) == 0 and (.days | length) == 5' "an empty week is five empty days"
m15n_week "$ACCT" accounts "$(m15n_plus "$M15N_THIS" +$((104 * 7)))"
expect_status 200 "two years ahead"
expect_jq '.past == false and .current == false and .canAdd == true and ([.days[].canAdd] | all(. == true))' "any future day takes a note"
m15n_week "$ACCT" accounts "$M15N_NEXT"
expect_jq '.past == false and .current == false and .canAdd == true and ([.days[].today] | all(. == false))' "next week"
m15n_week "$ACCT" accounts "$M15N_THIS"
expect_jq '.current == true and .past == false and .canAdd == true' "this week"
m15n_week "$ACCT" accounts "$(m15n_plus "$M15N_THIS" +1)"
expect_status 400 "a week that isn't a Monday"
expect_jq '.error == "week must be a Monday"' "the not-a-Monday sentence"
m15n_week "$ACCT" accounts yesterday
expect_status 400 "a week that isn't a date"
m15n_week "$ACCT" accounts 2030-02-30
expect_status 400 "a week that isn't a real date"
m15n_week "$ACCT" scheduling "$M15N_LAST"
expect_status 403 "a past week of a department without the key"
m15n_week "$ADMIN" ordering "$M15N_LAST"
expect_jq "[.days[].notes[] | select(.body | contains(\"$M15N_TAG\"))] | length == 0" "a past week of another department holds none of these"

echo "--- the thumbs-up ---"
req POST /api/notes "$ACCT" "$(jq -nc --arg b "$M15N_TAG to acknowledge" '{dept:"accounts",body:$b}')"
expect_status 201 "acct leaves a note to be acknowledged"
M15N_NK=$(jqr '.id')
req PUT "/api/notes/$M15N_NK/ack" "$ACCT2"
expect_status 200 "acct2 gives it a thumbs-up"
expect_jq ".id == $M15N_NK and .acks.count == 1 and .acks.names == [\"$M15N_ACCT2_NAME\"] and .acks.mine == true and .canAck == true" "one thumbs-up, from acct2, shown as mine"
req PUT "/api/notes/$M15N_NK/ack" "$ACCT2"
expect_status 200 "a second press of the same thumbs-up"
expect_jq '.acks.count == 1' "still one"
m15n_week "$ACCT" accounts "$M15N_W0"
expect_jq "$(m15n_note "$M15N_NK").acks.count == 1 and $(m15n_note "$M15N_NK").acks.names == [\"$M15N_ACCT2_NAME\"] and $(m15n_note "$M15N_NK").acks.mine == false and $(m15n_note "$M15N_NK").canAck == false" "the author sees who acknowledged, and can't acknowledge"
req PUT "/api/notes/$M15N_NK/ack" "$ADMIN"
expect_status 200 "an admin gives it a thumbs-up too"
expect_jq ".acks.count == 2 and .acks.names == [\"$M15N_ACCT2_NAME\", \"$M15N_ADMIN_NAME\"]" "names in the order they were given"
req PUT "/api/notes/$M15N_NK/ack" "$ACCT"
expect_status 403 "the author thumbs-up their own note"
expect_jq '.error == "You can'"'"'t acknowledge your own note"' "the own-note sentence"
req DELETE "/api/notes/$M15N_NK/ack" "$ACCT"
expect_status 403 "the author takes back a thumbs-up on their own note"
req PUT "/api/notes/$M15N_NS/ack" "$ACCT"
expect_status 403 "acct thumbs-up a scheduling note (no scheduling key)"
req PUT "/api/notes/$M15N_NK/ack" "$SHOW"
expect_status 403 "show thumbs-up a note"
req PUT "/api/notes/$M15N_NK/ack" "$SCHED"
expect_status 403 "sched thumbs-up an accounts note"
req DELETE "/api/notes/$M15N_NK/ack" "$ACCT2"
expect_status 200 "acct2 takes the thumbs-up back"
expect_jq ".acks.count == 1 and .acks.names == [\"$M15N_ADMIN_NAME\"] and .acks.mine == false" "only the admin's is left"
req DELETE "/api/notes/$M15N_NK/ack" "$ACCT2"
expect_status 200 "taking it back again"
expect_jq '.acks.count == 1' "nothing changes"
# a thumbs-up doesn't count as an edit
req GET "/api/notes?dept=accounts&week=$M15N_W0" "$ACCT"
M15N_UK=$(jqr "$(m15n_note "$M15N_NK").updatedAt")
req PATCH "/api/notes/$M15N_NK" "$ACCT" "$(jq -nc --arg b "$M15N_TAG to acknowledge, edited" --arg u "$M15N_UK" '{body:$b,updatedAt:$u}')"
expect_status 200 "an edit from a copy that predates the thumbs-ups"
expect_jq '.acks.count == 1' "the thumbs-up stays through an edit"
# any week, past included, and future weeks
req PUT "/api/notes/$M15N_NROLL/ack" "$ACCT2"
expect_status 200 "acct2 thumbs-up a note of a past week"
m15n_week "$ACCT" accounts "$M15N_LAST"
expect_jq "$(m15n_note "$M15N_NROLL").acks.count == 1 and $(m15n_note "$M15N_NROLL").canEdit == false" "it shows on the past week, which is otherwise read-only"
req DELETE "/api/notes/$M15N_NROLL/ack" "$ACCT2"
expect_status 200 "acct2 takes it back"
req PUT "/api/notes/$M15N_NOLD/ack" "$ACCT"
expect_status 200 "acct thumbs-up a note from two weeks back"
req PUT "/api/notes/$M15N_NFW/ack" "$ACCT2"
expect_status 200 "acct2 thumbs-up a note of next week"
req PUT "/api/notes/$M15N_NA/ack" "$ACCT"
expect_status 403 "acct thumbs-up an admin-sheet note"
req PUT /api/notes/999999999/ack "$ACCT2"
expect_status 404 "a thumbs-up on an unknown note"
req PUT /api/notes/abc/ack "$ACCT2"
expect_status 404 "a thumbs-up on a non-numeric id"
req DELETE /api/notes/999999999/ack "$ACCT2"
expect_status 404 "taking back a thumbs-up on an unknown note"

echo "--- the audit trail ---"
req GET "/api/audit?action=note.&entityType=dept_note&limit=500" "$ADMIN"
expect_status 200 "admin reads the note audit rows"
expect_jq "[.rows[] | select(.action == \"note.create\" and .entityId == \"$M15N_N1\" and .after.dept == \"accounts\" and .after.date == \"$M15N_DAY0\" and .after.weekStart == \"$M15N_W0\" and (.after.body | startswith(\"$M15N_TAG first note\")))] | length == 1" "a note.create row with the day and the text"
expect_jq "[.rows[] | select(.action == \"note.update\" and .entityId == \"$M15N_N1\" and .before.date == \"$M15N_DAY0\" and .after.date == \"$M15N_NEXTWED\" and .after.weekStart == \"$M15N_NEXT\")] | length == 1" "a note.update row for the move, with both days"
expect_jq "[.rows[] | select(.action == \"note.update\" and .entityId == \"$M15N_N1\" and (.before.body | contains(\"edited\")) and (.after.body | contains(\"current copy\")))] | length == 1" "a note.update row for the edit, with before and after"
expect_jq "[.rows[] | select(.action == \"note.update\" and .entityId == \"$M15N_N1\")] | length == 5" "one row per change that did something (none for the refused ones or the no-op)"
expect_jq "[.rows[] | select(.action == \"note.remove\" and .entityId == \"$M15N_NR\" and (.before.body | contains(\"to be removed\")))] | length == 1" "a note.remove row with the text"
expect_jq "[.rows[] | select(.action == \"note.remove\" and .entityId == \"$M15N_NFR\")] | length == 1" "a note.remove row for the future-week note"
expect_jq "[.rows[] | select(.entityId == \"$M15N_NROLL\" and (.action == \"note.update\" or .action == \"note.remove\"))] | length == 0" "no edit or remove rows for the refused locked-week requests"
expect_jq "[.rows[] | select(.action == \"note.update\" and .entityId == \"$M15N_N2\")] | length == 0" "no rows for the refused edits of acct2's note"
expect_jq "[.rows[] | select(.action == \"note.create\" and .entityId == \"$M15N_NA\")] | length == 1" "the admin sheet's note is audited too"
expect_jq "[.rows[] | select(.action == \"note.ack\" and .entityId == \"$M15N_NK\" and .actorUserId == $M15N_ACCT2_ID)] | length == 1" "a note.ack row for acct2 (the repeat wrote none)"
expect_jq "[.rows[] | select(.action == \"note.ack\" and .entityId == \"$M15N_NK\" and .actorUserId == $M15N_ADMIN_ID)] | length == 1" "a note.ack row for the admin"
expect_jq "[.rows[] | select(.action == \"note.unack\" and .entityId == \"$M15N_NK\")] | length == 1" "one note.unack row (taking it back twice wrote one)"
expect_jq "[.rows[] | select(.action == \"note.ack\" and .entityId == \"$M15N_NK\" and .actorUserId == $M15N_ACCT_ID)] | length == 0" "nothing for the refused own-note thumbs-up"
expect_jq "[.rows[] | select(.action == \"note.ack\" and .entityId == \"$M15N_NROLL\")] | length == 1" "a thumbs-up on a past week is recorded"
expect_jq "[.rows[] | select(.entityId == \"$M15N_N1\")] | all(.entityType == \"dept_note\")" "the entity type is dept_note"
M15N_AUD_TOTAL=$(jqr '.total')
M15N_AUD_ADMINROWS=$(printf '%s' "$BODY" | jq '[.rows[] | select((.after.dept // .before.dept) == "admin")] | length')
[ "$M15N_AUD_ADMINROWS" -ge 1 ] || fail "expected the owner to see Admin-notes audit rows (saw $M15N_AUD_ADMINROWS)"

echo "--- the audit trail: a note's rows show only to readers of its department (Todd, 2026-10-17) ---"
M15N_AU_USER="m15adm$M15N_TAG"
M15N_AU_PW="M15-Adm-Passw0rd-$M15N_TAG"
create_user "$M15N_AU_USER" "M15 Second Admin $M15N_TAG" "Tmp-$M15N_AU_PW" admin
M15N_AU_ID=$CREATED_ID
M15N_AU="$WORK/jar-m15-adm"
new_jar "$M15N_AU"
login "$M15N_AU" "$M15N_AU_USER" "Tmp-$M15N_AU_PW"
expect_status 200 "login the second admin"
own_password "$M15N_AU" "Tmp-$M15N_AU_PW" "$M15N_AU_PW"
req GET "/api/audit?action=note.&entityType=dept_note&limit=500" "$M15N_AU"
expect_status 200 "the second admin reads the note audit rows"
expect_jq "$M15N_AUD_TOTAL == .total" "with every notes key the second admin sees as many note rows as the owner"
req PUT "/api/users/$M15N_AU_ID/overrides/notes.admin" "$ADMIN" '{"effect":"revoke"}'
expect_status 200 "revoke notes.admin from the second admin"
req GET /api/auth/me "$M15N_AU"
expect_jq '(.user.perms | index("audit.view")) != null and (.user.perms | index("notes.admin")) == null and (.user.perms | index("notes.accounts")) != null' "the second admin still has audit.view and the other notes keys, but not notes.admin"
req GET "/api/audit?action=note.&entityType=dept_note&limit=500" "$M15N_AU"
expect_status 200 "the second admin (no notes.admin) reads the note audit rows"
expect_jq "[.rows[] | select((.after.dept // .before.dept) == \"admin\")] | length == 0" "no Admin-notes audit row reaches a reader without notes.admin"
expect_jq "[.rows[] | select(.entityId == \"$M15N_NA\")] | length == 0" "the admin sheet's note.create row is hidden from them"
expect_jq "[.rows[] | select(.action == \"note.create\" and .entityId == \"$M15N_N1\")] | length == 1" "an Accounts-notes row is still shown"
expect_jq "[.rows[] | select(.action == \"note.create\" and .entityId == \"$M15N_NS\")] | length == 1" "a Scheduling-notes row is still shown"
expect_jq ".total == $M15N_AUD_TOTAL - $M15N_AUD_ADMINROWS" "the total leaves the hidden rows out too"
req GET "/api/audit?entityType=dept_note&entityId=$M15N_NA" "$M15N_AU"
expect_status 200 "asking for the hidden note by id"
expect_jq '.rows == [] and .total == 0' "gives nothing, not even a count"
req GET "/api/audit?limit=500&offset=0" "$M15N_AU"
expect_status 200 "the unfiltered log for the second admin"
expect_jq "[.rows[] | select(.entityType == \"dept_note\" and (.after.dept // .before.dept) == \"admin\")] | length == 0" "the unfiltered log hides them as well"
req GET "/api/audit?action=note.create&limit=1" "$ADMIN"
expect_jq '.total >= 1' "the owner's count still includes every department"
req GET "/api/audit/actions" "$M15N_AU"
expect_status 200 "the action list for the second admin"
expect_jq 'index("note.create") != null' "the note actions are still listed (they hold other departments)"
req DELETE "/api/users/$M15N_AU_ID/overrides/notes.admin" "$ADMIN"
expect_status 200 "give notes.admin back"
req GET "/api/audit?action=note.&entityType=dept_note&limit=500" "$M15N_AU"
expect_jq ".total == $M15N_AUD_TOTAL and ([.rows[] | select(.entityId == \"$M15N_NA\")] | length) == 1" "with notes.admin back the Admin-notes rows show again"

echo "--- the tables' own checks ---"
M15N_DB=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.pragma("foreign_keys = ON");
// "refused" only for a constraint error (CHECK, UNIQUE/PRIMARY KEY, FOREIGN KEY): a locked
// database or a typo must not pass as a refusal by the table.
// better-sqlite3 names it in code; node:sqlite (the local shim) gives the result code in errcode (19 = constraint).
const isConstraint = (e) => !!e && (/^SQLITE_CONSTRAINT/.test(String(e.code)) || (Number.isInteger(e.errcode) && (e.errcode & 255) === 19));
const refusal = (e) => (isConstraint(e) ? "refused" : "ERROR(" + (e && (e.code || e.message)) + ")");
const ins = d.prepare("INSERT INTO dept_notes (dept, note_date, week_start, body, author_id) VALUES (?, ?, ?, ?, 1)");
const tries = [
  ["bogus dept", ["bogus", "2024-01-03", "2024-01-01", "x"]],
  ["empty body", ["accounts", "2024-01-03", "2024-01-01", ""]],
  ["blank body", ["accounts", "2024-01-03", "2024-01-01", "   "]],
  ["2001 chars", ["accounts", "2024-01-03", "2024-01-01", "a".repeat(2001)]],
  ["bad date", ["accounts", "next monday", "2024-01-01", "x"]],
  ["not a date", ["accounts", "2024-02-30", "2024-01-01", "x"]],
  ["saturday", ["accounts", "2024-01-06", "2024-01-01", "x"]],
  ["sunday", ["accounts", "2024-01-07", "2024-01-01", "x"]],
  ["wrong week", ["accounts", "2024-01-03", "2024-01-08", "x"]],
  ["bad week", ["accounts", "2024-01-03", "last week", "x"]],
  ["monday", ["accounts", "2024-01-01", "2024-01-01", "x"], true],
  ["friday", ["accounts", "2024-01-05", "2024-01-01", "x"], true],
];
const out = [];
let okId = 0;
for (const [name, args, shouldPass] of tries) {
  try {
    const id = Number(ins.run(...args).lastInsertRowid);
    if (shouldPass) { out.push(name + ":accepted"); d.prepare("DELETE FROM dept_notes WHERE id = ?").run(id); }
    else out.push(name + ":ACCEPTED");
  } catch (e) {
    out.push(name + ":" + refusal(e));
  }
}
const note = Number(ins.run("accounts", "2024-01-03", "2024-01-01", "ack target").lastInsertRowid);
const ack = d.prepare("INSERT INTO dept_note_acks (note_id, user_id, created_at) VALUES (?, ?, ?)");
ack.run(note, 1, "2024-01-03T00:00:00.000Z");
for (const [name, args] of [["duplicate ack", [note, 1, "x"]], ["ack of no note", [999999999, 1, "x"]], ["ack by no user", [note, 999999999, "x"]]]) {
  try { ack.run(...args); out.push(name + ":ACCEPTED"); } catch (e) { out.push(name + ":" + refusal(e)); }
}
d.prepare("DELETE FROM dept_note_acks WHERE note_id = ?").run(note);
d.prepare("DELETE FROM dept_notes WHERE id = ?").run(note);
const idx = d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name = ?").get("index", "idx_dept_notes_dept_week").n;
out.push("index:" + idx);
console.log(out.join(" "));
d.close();' | tr -d '\r') || fail "the table checks failed to run"
expect_eq "$M15N_DB" "bogus dept:refused empty body:refused blank body:refused 2001 chars:refused bad date:refused not a date:refused saturday:refused sunday:refused wrong week:refused bad week:refused monday:accepted friday:accepted duplicate ack:refused ack of no note:refused ack by no user:refused index:1" "dept_notes refuses a bad department, body, weekend or mismatched week; dept_note_acks refuses a duplicate or a stranger; the index exists"

# Nothing above may have crossed Sydney midnight: every date in this suite came from the first one.
[ "$(TZ=Australia/Sydney date +%F)" = "$M15N_TODAY" ] || fail "m15-notes: date rolled mid-run (started on $M15N_TODAY, now $(TZ=Australia/Sydney date +%F)); rerun"
ok
