# M13 smoke, Wave 1 B: job bonuses.
# Sourced by ci/smoke.sh after the M12 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, hdr, fail, ok) and the cookie jars ($ADMIN is the owner
# and holds bonuses.manage; $ACCT, $DPM and $SCHED don't: $SCHED is granted it for one check and the
# grant is removed). No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: it reads the bonus settings first and puts them back at
# the end, its jobs and people carry a run tag, its two pay runs sit on free fortnights far ahead
# and are deleted at the end, and it checks only its own rows. Made-up names and figures only (this
# repo is public).
# Contract: docs/plans/m13-contracts.md sections 4, 7.1 and 11.3.

# ============================================================================
step "m13. bonuses"
# ============================================================================

M13_B_TAG=$(date +%s)
M13_B_JOB_NAME="M13 Test Job $M13_B_TAG"

# Today is the server's (Sydney) date. m13_b_day N: today plus N days, as YYYY-MM-DD.
req GET /api/orders/deliveries "$ADMIN"
expect_status 200 "admin reads the server's today"
M13_B_TODAY=$(jqr '.date')
m13_b_day() {
  date -u -d "$M13_B_TODAY $1 day" +%F
}
# Today as the refusals write a date ("16 Oct 2026").
M13_B_TODAY_LABEL=$(LC_ALL=C date -u -d "$M13_B_TODAY" '+%-d %b %Y')

echo "--- access ---"
for M13_B_PAGE in /bonuses.html /bonusprint.html; do
  req GET "$M13_B_PAGE" "$ADMIN"
  expect_status 200 "admin GET $M13_B_PAGE"
  req GET "$M13_B_PAGE" "$ACCT"
  expect_status 403 "acct GET $M13_B_PAGE"
  req GET "$M13_B_PAGE" "$DPM"
  expect_status 403 "dpm GET $M13_B_PAGE"
done
req GET /api/bonuses "$ADMIN"
expect_status 200 "admin GET /api/bonuses"
expect_jq '(.bonuses | type) == "array"' "the list is an array"
for M13_B_GET in /api/bonuses /api/bonuses/settings /api/bonuses/people /api/bonuses/jobs /api/bonuses/summary /api/bonuses/999999999; do
  req GET "$M13_B_GET" "$ADMIN"
  expect_eq "$(hdr Cache-Control)" "no-store" "GET $M13_B_GET is Cache-Control: no-store"
done
req GET /api/bonuses "$ACCT"
expect_status 403 "acct GET /api/bonuses"
req GET /api/bonuses/summary "$DPM"
expect_status 403 "dpm GET /api/bonuses/summary"

echo "--- the settings as they were (put back at the end) ---"
req GET /api/bonuses/settings "$ADMIN"
expect_status 200 "admin GET /api/bonuses/settings"
expect_jq '(.rateBp | type) == "number" and (.holders | type) == "array" and .totalPoints == ([.holders[].points] | add // 0)' \
  "the settings, with the share total added up"
M13_B_SAVED=$(jqr '{rateBp: .rateBp, holders: [.holders[] | {personId: .personId, points: .points}]} | tojson')

echo "--- people ---"
for M13_B_X in A B C; do
  req POST /api/payruns/people "$ACCT" "$(jq -nc --arg n "M13 Person $M13_B_X $M13_B_TAG" '{name:$n}')"
  expect_status 201 "acct adds M13 Person $M13_B_X"
  printf -v "M13_B_P$M13_B_X" '%s' "$(jqr '.id')"
done
req GET /api/bonuses/people "$ADMIN"
expect_status 200 "admin GET /api/bonuses/people"
expect_jq "[.people[] | select(.id == $M13_B_PA or .id == $M13_B_PB or .id == $M13_B_PC)] | length == 3" "the three people are on the pay list"

echo "--- settings ---"
req PUT /api/bonuses/settings "$ADMIN" "{\"rateBp\":10001,\"holders\":[]}"
expect_status 400 "a rate of 10001"
expect_jq '.error == "The bonus rate must be from 0 to 10000 basis points (0% to 100%)"' "the rate sentence"
req PUT /api/bonuses/settings "$ADMIN" "{\"rateBp\":150,\"holders\":[{\"personId\":$M13_B_PA,\"points\":1.5}]}"
expect_status 400 "points 1.5"
expect_jq '.error == "Share points must be whole numbers from 0 to 1000"' "the points sentence"
req PUT /api/bonuses/settings "$ADMIN" "{\"rateBp\":150,\"holders\":[{\"personId\":$M13_B_PA,\"points\":2},{\"personId\":$M13_B_PA,\"points\":1}]}"
expect_status 400 "a person twice"
expect_jq ".error == \"M13 Person A $M13_B_TAG is listed twice\"" "the twice sentence names the person"
req PUT /api/bonuses/settings "$ADMIN" "{\"rateBp\":150,\"holders\":[{\"personId\":999999999,\"points\":1}]}"
expect_status 400 "a person not on the pay list"
expect_jq '.error == "Share holder must be a person from the pay list"' "the person sentence"
req PUT /api/bonuses/settings "$ACCT" "{\"rateBp\":150,\"holders\":[]}"
expect_status 403 "acct PUT the settings"
M13_B_HOLDERS="[{\"personId\":$M13_B_PA,\"points\":2},{\"personId\":$M13_B_PB,\"points\":1},{\"personId\":$M13_B_PC,\"points\":1}]"
req PUT /api/bonuses/settings "$ADMIN" "{\"rateBp\":150,\"holders\":$M13_B_HOLDERS}"
expect_status 200 "rate 1.50% and points A 2, B 1, C 1"
expect_jq ".rateBp == 150 and .totalPoints == 4 and ([.holders[].personId] == [$M13_B_PA, $M13_B_PB, $M13_B_PC]) and ([.holders[].points] == [2, 1, 1]) and .holders[0].name == \"M13 Person A $M13_B_TAG\" and .holders[0].archived == false" \
  "the settings as saved, in order"

echo "--- a job and its Joinr hours ---"
req POST /api/job-records "$ADMIN" "$(jq -nc --arg n "$M13_B_JOB_NAME" '{name:$n,valueCents:3000000}')"
expect_status 201 "admin makes the job with a value of \$30,000.00"
M13_B_JOB=$(jqr '.id')
M13_B_ROOT="m13-bonus-$M13_B_TAG"
M13_B_PAYLOAD=$(jq -nc --arg r "$M13_B_ROOT" \
  '{rootQuoteId:$r, quoteId:$r, clientName:"M13 Test Client", estimatedHours:{office:1, factory:10.5, site:4, travel:0}}')
M13_B_INTAKE=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
const [root, job, payload] = process.argv.slice(1);
const info = d.prepare(
  "INSERT INTO joinr_intake (root_quote_id, quote_id, joinr_status, last_event, payload, state, job_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
).run(root, root, "won", "won", payload, "accepted", Number(job));
console.log(String(info.lastInsertRowid));
d.close();' "$M13_B_ROOT" "$M13_B_JOB" "$M13_B_PAYLOAD" | tr -d '\r') \
  || fail "inserting the joinr_intake row failed: ${M13_B_INTAKE:-}"
[ -n "$M13_B_INTAKE" ] || fail "inserting the joinr_intake row gave no id"
ok

echo "--- create ---"
# The newest audit row before this run's bonus, so the audit checks read only its own rows.
req GET "/api/audit?limit=1" "$ADMIN"
expect_status 200 "the newest audit row"
M13_B_AUDIT0=$(jqr '.rows[0].id // 0')
req POST /api/bonuses "$ADMIN" "{\"jobId\":$M13_B_JOB}"
expect_status 201 "admin creates the job's bonus"
M13_B_ID=$(jqr '.id')
expect_jq ".job.id == $M13_B_JOB and .job.name == \"$M13_B_JOB_NAME\" and .status == \"draft\" and .priceCents == 3000000" \
  "a draft, the price prefilled from the job's value"
expect_jq '.hours.quotedFactoryMin == 1260 and .hours.quotedInstallMin == 480 and .hours.quotedFromJoinr == true and .hours.actualFactoryMin == null and .hours.actualInstallMin == null' \
  "quoted hours from Joinr, factory and site doubled back (10.5 h and 4 h)"
expect_jq '.ticked == 0 and .rateBp == 150 and .possibleCents == 45000 and .earnedCents == 0 and .lostCents == 45000 and .totalPoints == 4 and .shares == [] and .owedCents == 0 and .confirmed == null and .confirmedDate == null' \
  "nothing ticked: possible 45000, earned 0"
req POST /api/bonuses "$ADMIN" "{\"jobId\":$M13_B_JOB}"
expect_status 409 "a second bonus for the job"
expect_jq '.error == "This job already has a bonus"' "the one-per-job sentence"
req POST /api/bonuses "$ADMIN" '{"jobId":999999999}'
expect_status 404 "a bonus for no such job"
req GET "/api/bonuses/jobs?q=$M13_B_TAG" "$ADMIN"
expect_status 200 "admin searches the jobs"
expect_jq "[.jobs[] | select(.id == $M13_B_JOB)][0] | .hasBonus == true and .archived == false and .name == \"$M13_B_JOB_NAME\"" \
  "the job is found and has a bonus"

echo "--- the price is prefilled only for a jobs.value holder ---"
req GET /api/auth/me "$SCHED"
expect_status 200 "sched GET /api/auth/me"
M13_B_SCHED_ID=$(jqr '.user.id')
expect_jq '(.user.perms | index("jobs.value")) == null and (.user.perms | index("bonuses.manage")) == null' \
  "sched holds neither jobs.value nor bonuses.manage"
req POST /api/job-records "$ADMIN" "$(jq -nc --arg n "M13 Test Job V $M13_B_TAG" '{name:$n,valueCents:1000000}')"
expect_status 201 "admin makes a second job with a value"
M13_B_JOB2=$(jqr '.id')
req PUT "/api/users/$M13_B_SCHED_ID/overrides/bonuses.manage" "$ADMIN" '{"effect":"grant"}'
expect_status 200 "the owner grants sched bonuses.manage"
req POST /api/bonuses "$SCHED" "{\"jobId\":$M13_B_JOB2}"
expect_status 201 "sched creates the second job's bonus"
M13_B_ID2=$(jqr '.id')
expect_jq '.priceCents == null and .possibleCents == null and .earnedCents == null and .shares == []' \
  "no price prefilled for someone without jobs.value"
req DELETE "/api/bonuses/$M13_B_ID2" "$SCHED"
expect_status 200 "sched deletes that draft"
req DELETE "/api/users/$M13_B_SCHED_ID/overrides/bonuses.manage" "$ADMIN"
expect_status 200 "the owner removes sched's bonuses.manage"
req GET /api/bonuses "$SCHED"
expect_status 403 "sched GET /api/bonuses without the grant"

echo "--- the maths ---"
req PATCH "/api/bonuses/$M13_B_ID" "$ADMIN" \
  '{"checks":{"drawn":true,"ordered":true,"assembled":true,"installed":true,"noFuss":true},"actualFactoryMin":1200,"actualInstallMin":500}'
expect_status 200 "tick five and type the actual hours"
expect_jq '.hoursCheck.suggested == true and .hoursCheck.setByHand == false and .checks.hours == true and .checks.onTime == false' \
  "1700 actual minutes against 1740 quoted: Hours suggested and ticked"
expect_jq '.ticked == 6 and .possibleCents == 45000 and .earnedCents == 38571 and .lostCents == 6429' \
  "six of seven: earned 38571, lost 6429"
req PATCH "/api/bonuses/$M13_B_ID" "$ADMIN" '{"checks":{"hours":false}}'
expect_status 200 "Hours set by hand to no"
expect_jq '.checks.hours == false and .hoursCheck.setByHand == true and .hoursCheck.suggested == true and .ticked == 5 and .earnedCents == 32143 and .lostCents == 12857' \
  "five of seven: earned 32143, lost 12857"
expect_jq "([.shares[] | [.personId, .points, .shareCents]] == [[$M13_B_PA, 2, 16071], [$M13_B_PB, 1, 8036], [$M13_B_PC, 1, 8036]]) and ([.shares[].shareCents] | add) == 32143 and ([.shares[].paid] | all(. == null))" \
  "the preview: A 16071, B 8036, C 8036 (the 1-point holders take the leftover cents)"
req PATCH "/api/bonuses/$M13_B_ID" "$ADMIN" '{"checks":{"hours":null}}'
expect_status 200 "Hours back to the suggestion"
expect_jq '.checks.hours == true and .hoursCheck.setByHand == false and .ticked == 6 and .earnedCents == 38571' "back to six of seven"
req PATCH "/api/bonuses/$M13_B_ID" "$ADMIN" '{"quotedFactoryMin":1300}'
expect_status 200 "type the quoted factory hours"
expect_jq '.hours.quotedFactoryMin == 1300 and .hours.quotedFromJoinr == false' "a typed quoted value isn't from Joinr"
req POST "/api/bonuses/$M13_B_ID/joinr-hours" "$ADMIN" '{}'
expect_status 200 "fill the quoted hours from Joinr again"
expect_jq '.hours.quotedFactoryMin == 1260 and .hours.quotedInstallMin == 480 and .hours.quotedFromJoinr == true' "the Joinr hours are back"

echo "--- rules ---"
req PATCH "/api/bonuses/$M13_B_ID" "$ADMIN" '{"bogus":1}'
expect_status 400 "an unknown field"
expect_jq '.error == "Unknown field: bogus"' "the unknown field is named"
req PATCH "/api/bonuses/$M13_B_ID" "$ADMIN" '{"priceCents":1.5}'
expect_status 400 "a bad price"
expect_jq '.error == "The price must be whole cents from $0 to $100,000,000"' "the price sentence"
req PATCH "/api/bonuses/$M13_B_ID" "$ADMIN" '{"actualFactoryMin":-1}'
expect_status 400 "actual hours -1"
expect_jq '.error == "Actual factory hours must be minutes from 0 to 600000"' "the hours sentence"
req PATCH "/api/bonuses/$M13_B_ID" "$ADMIN" '{"checks":{"drawn":"yes"}}'
expect_status 400 "a check that isn't true or false"
expect_jq '.error == "Drawn (Mozaik) must be true or false"' "the check sentence"
req PATCH "/api/bonuses/$M13_B_ID" "$ADMIN" '{"ranBy":{"personId":999999999}}'
expect_status 400 "ran by someone not on the pay list"
expect_jq '.error == "Ran by must be a person from the pay list"' "the person sentence"
req PATCH "/api/bonuses/$M13_B_ID" "$ADMIN" "{\"ranBy\":{\"personId\":$M13_B_PA},\"checkedBy\":{\"personId\":$M13_B_PB},\"note\":\"M13 made-up note\"}"
expect_status 200 "ran by A, checked by B, a note"
expect_jq ".ranBy.personId == $M13_B_PA and .ranBy.name == \"M13 Person A $M13_B_TAG\" and .ranBy.archived == false and .checkedBy.personId == $M13_B_PB and .note == \"M13 made-up note\"" \
  "the people and the note"
req PATCH "/api/bonuses/$M13_B_ID" "$ADMIN" '{"note":"M13 made-up note"}'
expect_status 200 "the same note again (nothing changed)"
req GET "/api/bonuses?status=bogus" "$ADMIN"
expect_status 400 "an unknown list status"
expect_jq '.error == "Unknown status: bogus"' "the status sentence"
req GET "/api/bonuses?status=draft" "$ADMIN"
expect_status 200 "the draft list"
expect_jq "[.bonuses[] | select(.id == $M13_B_ID)] | length == 1" "the draft is listed"

echo "--- confirm ---"
req PATCH "/api/bonuses/$M13_B_ID" "$ADMIN" '{"checks":{"hours":false}}'
expect_status 200 "Hours set by hand to no again"
req POST "/api/bonuses/$M13_B_ID/confirm" "$ADMIN" "{\"confirmedDate\":\"$(m13_b_day +1)\"}"
expect_status 400 "confirm with tomorrow's date"
expect_jq ".error == \"The confirmed date can't be in the future\"" "the future sentence"
req POST "/api/bonuses/$M13_B_ID/confirm" "$ADMIN" '{"confirmedDate":"2026-02-31"}'
expect_status 400 "confirm with a date that doesn't exist"
expect_jq '.error == "The confirmed date must be a date"' "the date sentence"
req POST "/api/bonuses/$M13_B_ID/confirm" "$ADMIN" '{}'
expect_status 200 "confirm today"
expect_jq ".status == \"confirmed\" and .confirmedDate == \"$M13_B_TODAY\" and .rateBp == 150 and .priceCents == 3000000 and .ticked == 5 and .possibleCents == 45000 and .earnedCents == 32143 and .lostCents == 12857 and .totalPoints == 4 and .checks.hours == false and .owedCents == 32143 and (.confirmed.at | type) == \"string\"" \
  "confirmed: the figures frozen"
expect_jq "(.shares | length) == 3 and ([.shares[] | [.personId, .shareCents]] == [[$M13_B_PA, 16071], [$M13_B_PB, 8036], [$M13_B_PC, 8036]]) and ([.shares[].paid] | all(. == null))" \
  "three shares, none paid"
req PATCH "/api/bonuses/$M13_B_ID" "$ADMIN" '{"note":"M13 changed"}'
expect_status 409 "PATCH a confirmed bonus"
expect_jq '.error == "This bonus is confirmed; reopen it to change it"' "the confirmed sentence"
req POST "/api/bonuses/$M13_B_ID/confirm" "$ADMIN" '{}'
expect_status 409 "confirm it again"
expect_jq '.error == "This bonus is already confirmed"' "the already-confirmed sentence"
req DELETE "/api/bonuses/$M13_B_ID" "$ADMIN"
expect_status 409 "delete a confirmed bonus"
expect_jq '.error == "Only a draft bonus can be deleted"' "the draft-only sentence"
req PUT /api/bonuses/settings "$ADMIN" "{\"rateBp\":200,\"holders\":$M13_B_HOLDERS}"
expect_status 200 "the rate changes to 2.00%"
req GET "/api/bonuses/$M13_B_ID" "$ADMIN"
expect_status 200 "GET the confirmed bonus"
expect_jq '.rateBp == 150 and .earnedCents == 32143' "the confirmed bonus keeps 1.50% and 32143"

echo "--- pay runs of its own: one left open, one finalised ---"
# Far ahead on the pay fortnight grid, on fortnights with no run yet; both are removed at the end.
req GET /api/payruns "$ACCT"
expect_status 200 "acct reads the pay runs"
M13_B_GRID=$(jqr '.current.startDate')
M13_B_GRID_K=400
# m13_b_new_run: acct makes a pay run on the next free fortnight; sets M13_B_NEWRUN and its start.
m13_b_new_run() {
  local start
  while [ "$M13_B_GRID_K" -lt 520 ]; do
    start=$(date -u -d "$M13_B_GRID $((M13_B_GRID_K * 14)) day" +%F)
    M13_B_GRID_K=$((M13_B_GRID_K + 1))
    req POST /api/payruns "$ACCT" "{\"startDate\":\"$start\"}"
    if [ "$STATUS" = 201 ]; then
      M13_B_NEWRUN=$(jqr '.id')
      M13_B_NEWRUN_START=$(jqr '.startDate')
      ok
      return 0
    fi
    [ "$STATUS" = 409 ] || fail "acct POST /api/payruns $start: expected 201 or 409, got $STATUS: ${BODY:0:300}"
  done
  fail "no free pay fortnight for a test pay run"
}
m13_b_new_run
M13_B_RUN_OPEN=$M13_B_NEWRUN
m13_b_new_run
M13_B_RUN_FIN=$M13_B_NEWRUN
M13_B_RUN_FIN_START=$M13_B_NEWRUN_START
req POST "/api/payruns/$M13_B_RUN_FIN/finalise" "$ACCT"
expect_status 200 "acct finalises the second test pay run"

echo "--- paying ---"
req POST "/api/bonuses/$M13_B_ID/shares/$M13_B_PB/paid" "$ADMIN" '{"payRunId":999999999}'
expect_status 400 "mark B paid in no such pay run"
expect_jq '.error == "No such pay run"' "the pay run sentence"
req POST "/api/bonuses/$M13_B_ID/shares/$M13_B_PB/paid" "$ADMIN" "{\"payRunId\":$M13_B_RUN_OPEN}"
expect_status 400 "mark B paid in an open pay run"
expect_jq '.error == "Choose a finalised pay run"' "the finalised-only sentence"
req POST "/api/bonuses/people/$M13_B_PA/paid" "$ADMIN" "{\"bonusIds\":[$M13_B_ID],\"payRunId\":$M13_B_RUN_OPEN}"
expect_status 400 "mark all A's shares paid in an open pay run"
expect_jq '.error == "Choose a finalised pay run"' "the finalised-only sentence (mark all paid)"
req GET /api/bonuses/summary "$ADMIN"
expect_status 200 "the summary's pay runs"
expect_jq "(.payRuns | all(.status == \"finalised\")) and ([.payRuns[] | select(.id == $M13_B_RUN_OPEN)] | length == 0) and ([.payRuns[] | select(.id == $M13_B_RUN_FIN)] | length == 1)" \
  "the pickers list finalised pay runs only"
# The review's repro (A-M2): the open pay run was never taken, so Accounts can still delete it.
req DELETE "/api/payruns/$M13_B_RUN_OPEN" "$ACCT"
expect_status 204 "acct deletes the open test pay run"
req POST "/api/bonuses/$M13_B_ID/shares/$M13_B_PC/paid" "$ADMIN" "{\"payRunId\":$M13_B_RUN_FIN}"
expect_status 200 "mark C paid in the finalised pay run"
expect_jq "[.shares[] | select(.personId == $M13_B_PC)][0].paid | .date == \"$M13_B_TODAY\" and .payRun.id == $M13_B_RUN_FIN and .payRun.startDate == \"$M13_B_RUN_FIN_START\"" \
  "C's share names the finalised pay run"
req POST "/api/bonuses/$M13_B_ID/shares/$M13_B_PC/paid" "$ADMIN" '{"undo":true}'
expect_status 200 "undo C's payment"
req POST "/api/bonuses/$M13_B_ID/shares/$M13_B_PB/paid" "$ADMIN" "{\"paidDate\":\"$(m13_b_day -1)\"}"
expect_status 400 "mark B paid before the confirmed date"
expect_jq ".error == \"The paid date can't be before the bonus was confirmed ($M13_B_TODAY_LABEL)\"" "the before-confirmed sentence"
req POST "/api/bonuses/$M13_B_ID/shares/$M13_B_PB/paid" "$ADMIN" "{\"paidDate\":\"$(m13_b_day +1)\"}"
expect_status 400 "mark B paid tomorrow"
expect_jq ".error == \"The paid date can't be in the future\"" "the future sentence"
req POST "/api/bonuses/$M13_B_ID/shares/999999999/paid" "$ADMIN" '{}'
expect_status 404 "mark paid someone with no share"
req POST "/api/bonuses/$M13_B_ID/shares/$M13_B_PB/paid" "$ADMIN" '{}'
expect_status 200 "mark B paid today"
expect_jq "([.shares[] | select(.personId == $M13_B_PB)][0].paid | .date == \"$M13_B_TODAY\" and .payRun == null and (.by.id | type) == \"number\") and .owedCents == 24107" \
  "B paid today; 24107 still owed"
req POST "/api/bonuses/$M13_B_ID/shares/$M13_B_PB/paid" "$ADMIN" '{}'
expect_status 409 "mark B paid again"
expect_jq '.error == "This share is already marked paid"' "the already-paid sentence"
req POST "/api/bonuses/$M13_B_ID/reopen" "$ADMIN" '{}'
expect_status 409 "reopen with a share paid"
expect_jq '.error == "A share of this bonus has been paid; undo that first"' "the paid-share sentence"
req GET "/api/bonuses?status=owed" "$ADMIN"
expect_status 200 "the owed list"
expect_jq "[.bonuses[] | select(.id == $M13_B_ID)] | length == 1" "the bonus is owed"
req GET /api/bonuses/summary "$ADMIN"
expect_status 200 "the summary"
expect_jq "([.people[] | select(.personId == $M13_B_PA)][0] | .earnedCents == 16071 and .paidCents == 0 and .owedCents == 16071 and (.owed | length) == 1 and .owed[0].bonusId == $M13_B_ID and .owed[0].jobName == \"$M13_B_JOB_NAME\" and .owed[0].shareCents == 16071 and .owed[0].confirmedDate == \"$M13_B_TODAY\")" \
  "A is owed 16071"
expect_jq "([.people[] | select(.personId == $M13_B_PB)][0] | .earnedCents == 8036 and .paidCents == 8036 and .owedCents == 0 and .owed == [])" \
  "B was paid 8036"
expect_jq '(.totals.earnedCents == .totals.paidCents + .totals.owedCents) and (.payRuns | type) == "array" and (.payRuns | length) <= 26' \
  "the totals add up; at most 26 pay runs"
req POST "/api/bonuses/people/$M13_B_PA/paid" "$ADMIN" "{\"bonusIds\":[$((M13_B_ID + 1000000))]}"
expect_status 409 "mark A paid with the wrong owed list"
expect_jq '.error == "The owed list changed while you were looking; reload it"' "the owed-list sentence"
req POST "/api/bonuses/people/$M13_B_PA/paid" "$ADMIN" '{"bonusIds":[]}'
expect_status 400 "mark A paid with nothing listed"
expect_jq '.error == "Nothing owed to mark paid"' "the nothing-owed sentence"
req POST "/api/bonuses/people/$M13_B_PA/paid" "$ADMIN" "{\"bonusIds\":[$M13_B_ID]}"
expect_status 200 "mark all A's shares paid"
expect_jq "[.people[] | select(.personId == $M13_B_PA)][0] | .owedCents == 0 and .paidCents == 16071 and .owed == []" \
  "A owes nothing now"
req POST "/api/bonuses/$M13_B_ID/shares/$M13_B_PB/paid" "$ADMIN" '{"undo":true}'
expect_status 200 "undo B's payment"
expect_jq "[.shares[] | select(.personId == $M13_B_PB)][0].paid == null" "B's share is unpaid again"
req POST "/api/bonuses/$M13_B_ID/shares/$M13_B_PB/paid" "$ADMIN" '{"undo":true}'
expect_status 409 "undo B's payment again"
expect_jq ".error == \"This share isn't marked paid\"" "the not-paid sentence"

echo "--- reopen and delete ---"
req POST "/api/bonuses/$M13_B_ID/shares/$M13_B_PA/paid" "$ADMIN" '{"undo":true}'
expect_status 200 "undo A's payment"
req POST "/api/bonuses/$M13_B_ID/reopen" "$ADMIN" '{}'
expect_status 200 "reopen"
expect_jq '.status == "draft" and .confirmed == null and .confirmedDate == null and .owedCents == 0 and .rateBp == 200 and .checks.hours == false and .ticked == 5 and .earnedCents == 42857' \
  "a draft again, following the current 2.00% (Hours still set by hand)"
expect_jq '[.shares[].paid] | all(. == null)' "only the live preview, nothing paid"
req POST "/api/bonuses/$M13_B_ID/reopen" "$ADMIN" '{}'
expect_status 409 "reopen a draft"
expect_jq '.error == "Only a confirmed bonus can be reopened"' "the confirmed-only sentence"
req GET /api/bonuses/summary "$ADMIN"
expect_status 200 "the summary after reopening"
expect_jq "[.people[] | select(.personId == $M13_B_PA or .personId == $M13_B_PB or .personId == $M13_B_PC)] | length == 0" \
  "no share rows left: a draft counts nowhere"
req POST "/api/bonuses/$M13_B_ID/shares/$M13_B_PA/paid" "$ADMIN" '{}'
expect_status 409 "mark paid on a draft"
expect_jq '.error == "Confirm the bonus first"' "the confirm-first sentence"
req DELETE "/api/bonuses/$M13_B_ID" "$ADMIN"
expect_status 200 "delete the draft"
expect_jq '.ok == true' "deleted"
req GET "/api/bonuses/$M13_B_ID" "$ADMIN"
expect_status 404 "GET the deleted bonus"

echo "--- audit ---"
# Only this run's rows (above the high-water mark noted before the create). A deleted draft's id
# is never given again (lib/bonuses.js), so the bonus's rows are all this run's anyway.
req GET "/api/audit?entityType=bonus&entityId=$M13_B_ID&limit=200" "$ADMIN"
expect_status 200 "the bonus's audit rows, as the owner"
for M13_B_ACTION in bonus.create bonus.update bonus.confirm bonus.paid bonus.unpaid bonus.reopen bonus.delete; do
  expect_jq "[.rows[] | select(.id > $M13_B_AUDIT0 and .action == \"$M13_B_ACTION\")] | length >= 1" "a $M13_B_ACTION row"
done
expect_jq "[.rows[] | select(.id > $M13_B_AUDIT0 and .action == \"bonus.confirm\")][0].after | .earnedCents == 32143 and .rateBp == 150 and .ticked == 5 and .confirmedDate == \"$M13_B_TODAY\" and (.shares | length) == 3" \
  "the confirm row holds the frozen figures"
expect_jq "[.rows[] | select(.id > $M13_B_AUDIT0 and .action == \"bonus.paid\")] | length == 3" "three bonus.paid rows (B, C, then A by Mark all paid)"
expect_jq "[.rows[] | select(.id > $M13_B_AUDIT0 and .action == \"bonus.paid\" and .after.personId == $M13_B_PC and .after.payRunId == $M13_B_RUN_FIN)] | length == 1" \
  "C's bonus.paid row names the finalised pay run"
req GET "/api/audit?entityType=bonus_settings&action=bonus_settings.update&limit=200" "$ADMIN"
expect_status 200 "the settings audit rows"
expect_jq "[.rows[] | select(.after.rateBp == 150 and (.after.holders | map(.personId) | index($M13_B_PA)) != null)] | length >= 1" \
  "a bonus_settings.update row with the run's holders"
req GET /api/audit "$ACCT"
expect_status 403 "acct has no audit.view"

echo "--- put back ---"
# The finalised test pay run: no share names it any more (C's payment was undone), so it can be
# reopened (users.admin) and deleted (no sheet was typed in).
req POST "/api/payruns/$M13_B_RUN_FIN/reopen" "$ADMIN"
expect_status 200 "admin reopens the finalised test pay run"
req DELETE "/api/payruns/$M13_B_RUN_FIN" "$ACCT"
expect_status 204 "acct deletes the test pay run"
req PUT /api/bonuses/settings "$ADMIN" "$M13_B_SAVED"
expect_status 200 "the settings put back"
expect_jq "({rateBp: .rateBp, holders: [.holders[] | {personId: .personId, points: .points}]} | tojson) == $(jq -nc --arg s "$M13_B_SAVED" '$s')" \
  "the settings are as they were"
for M13_B_X in A B C; do
  M13_B_VAR="M13_B_P$M13_B_X"
  req PATCH "/api/payruns/people/${!M13_B_VAR}" "$ACCT" '{"archived":true}'
  expect_status 200 "acct archives M13 Person $M13_B_X"
done
