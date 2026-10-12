# M8 smoke, Wave 1 A: pay runs, timesheets and the summary.
# Sourced by ci/smoke.sh after the M7 suites, so it shares that script's helpers
# (step, req, expect_status, expect_jq, expect_eq, jqr, fail, ok), the cookie jars
# ($ADMIN $SCHED $ACCT $DPM $SHOW $WSHOP) and $BASE. No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: every pay run is in 2035 (2035-01-01 and 2035-01-15 are
# on the fortnight grid from the 2026-10-05 anchor), it makes its own workers, job and board row,
# and it checks only those. Made-up names only (this repo is public). Every pay setting it changes
# is put back. Contract: docs/plans/m8-contracts.md sections 5, 6 and 9.2.

# ============================================================================
step "m8-payruns. pay runs, timesheets and the summary"
# ============================================================================

M8_START=2035-01-01
M8_START2=2035-01-15

# m8_sheet: GET the test worker's sheet as acct.
m8_sheet() {
  req GET "/api/payruns/$M8_RUN/timesheets/$M8_TS" "$ACCT"
  expect_status 200 "GET the test worker's sheet"
}

# m8_day DATE FILTER: the filter must hold for that date's row of the last sheet response.
m8_day() {
  expect_jq "[.days[] | select(.date == \"$1\")][0] | $2" "${3:-day $1}"
}

# m8_put DAYS_JSON [UPDATED_AT]: PUT the test worker's sheet with those days, the notes and ticks
# as saved, and the given (default: the current) updatedAt.
m8_put() {
  req PUT "/api/payruns/$M8_RUN/timesheets/$M8_TS" "$ACCT" \
    "$(jq -nc --argjson d "$1" --arg u "${2:-$M8_UPD}" '{days:$d, notes:"M8 note", signed:true, entered:true, updatedAt:$u}')"
}

# m8_unchanged WHAT: the sheet still has the saved updatedAt and totals.
m8_unchanged() {
  m8_sheet
  expect_jq ".updatedAt == \"$M8_UPD\" and .totals.workedMin == 2610 and .totals.pholMin == 480" "nothing changed after: $1"
}

# m8_settings JSON: PUT the pay settings as acct (200 expected).
m8_settings() {
  req PUT /api/payruns/settings "$ACCT" "$1"
  expect_status 200 "PUT /api/payruns/settings $1"
}

echo "--- access ---"
req GET /api/payruns "$ACCT"
expect_status 200 "acct GET /api/payruns"
expect_jq '(.payRuns | type == "array") and (.current.startDate | type == "string") and (.next | has("payRunId")) and .rules.otBandMin != null' "the list has payRuns, current, next and rules"
expect_jq '.next.startDate > .current.startDate' "next comes after current"
req GET /api/payruns "$ADMIN"
expect_status 200 "admin GET /api/payruns"
for j in "$SCHED" "$DPM" "$SHOW" "$WSHOP"; do
  req GET /api/payruns "$j"
  expect_status 403 "GET /api/payruns without accounts.view"
done
req POST /api/payruns "$SCHED" "{\"startDate\":\"$M8_START\"}"
expect_status 403 "sched POST /api/payruns"
for p in /payruns.html /payrun.html /payprint.html; do
  req GET "$p" "$ACCT"
  expect_status 200 "acct GET $p"
  req GET "$p" "$SCHED"
  expect_status 403 "sched GET $p"
done

echo "--- defaults ---"
req GET /api/payruns/settings "$ACCT"
expect_status 200 "GET /api/payruns/settings"
expect_jq '.anchor == "2026-10-05" and .ordinaryMonThuMin == 480 and .ordinaryFriMin == 360 and .otBandMin == 120' "default pay rules"

echo "--- people ---"
req POST /api/workers "$ADMIN" '{"name":"M8 Test Worker"}'
expect_status 201 "create M8 Test Worker"
M8_W=$(jqr '.id')
req POST /api/workers "$ADMIN" '{"name":"M8 Off Worker"}'
expect_status 201 "create M8 Off Worker"
M8_OFF=$(jqr '.id')
req PUT "/api/payruns/people/worker/$M8_OFF" "$SCHED" '{"onPayRun":false}'
expect_status 403 "sched PUT a worker's switch"
req PUT "/api/payruns/people/worker/$M8_OFF" "$ACCT" '{"onPayRun":false}'
expect_status 200 "acct switches the off worker off"
expect_jq ".workerId == $M8_OFF and .kind == \"worker\" and .onPayRun == false and .name == \"M8 Off Worker\" and (.id | type == \"number\")" "the off worker's person"
M8_OFF_PERSON=$(jqr '.id')
req PUT /api/payruns/people/worker/999999999 "$ACCT" '{"onPayRun":false}'
expect_status 404 "PUT an unknown worker's switch"
req POST /api/payruns/people "$ACCT" '{"name":"M8 Office Person"}'
expect_status 201 "add a pay-only person"
expect_jq '.kind == "pay_only" and .onPayRun == true and .archived == false and .workerId == null and .name == "M8 Office Person"' "the pay-only person"
M8_OFFICE=$(jqr '.id')
req POST /api/payruns/people "$ACCT" '{"name":"   "}'
expect_status 400 "a blank pay-only name"
req GET /api/payruns/people "$ACCT"
expect_status 200 "GET /api/payruns/people"
expect_jq "[.people[] | select(.workerId == $M8_W)][0] | .id == null and .onPayRun == true and .kind == \"worker\"" "a worker with no row is on the pay run"
expect_jq "[.people[] | select(.workerId == $M8_OFF)][0].onPayRun == false" "the off worker is listed as off"
expect_jq "[.people[] | select(.id == $M8_OFFICE)] | length == 1" "the office person is listed"
req PATCH "/api/payruns/people/$M8_OFF_PERSON" "$ACCT" '{"name":"M8 Renamed"}'
expect_status 400 "rename a worker's row"
expect_jq '.error == "Board workers are changed on the Workers page"' "the workers-page sentence"

echo "--- create ---"
req POST /api/payruns "$ACCT" '{"startDate":"2035-01-02"}'
expect_status 400 "a start off the grid"
expect_jq ".error == \"That date doesn't start a pay fortnight\"" "the off-grid sentence"
req POST /api/payruns "$ACCT" "{\"startDate\":\"$M8_START\"}"
expect_status 201 "create the 2035-01-01 pay run"
expect_jq '.startDate == "2035-01-01" and .endDate == "2035-01-12" and .status == "open" and .finalisedBy == null and .myobEnteredDate == null' "the new run"
expect_jq "[.timesheets[] | select(.person.workerId == $M8_W)] | length == 1" "a sheet for the test worker"
expect_jq "[.timesheets[] | select(.person.id == $M8_OFFICE)] | length == 1" "a sheet for the office person"
expect_jq "[.timesheets[] | select(.person.workerId == $M8_OFF)] | length == 0" "no sheet for the off worker"
M8_RUN=$(jqr '.id')
M8_TS=$(jqr "[.timesheets[] | select(.person.workerId == $M8_W)][0].id")
M8_TSO=$(jqr "[.timesheets[] | select(.person.id == $M8_OFFICE)][0].id")
req POST /api/payruns "$ACCT" "{\"startDate\":\"$M8_START\"}"
expect_status 409 "create the same fortnight again"
expect_jq '.error == "A pay run for that fortnight already exists"' "the exists sentence"
req GET /api/payruns "$ACCT"
expect_jq "[.payRuns[] | select(.id == $M8_RUN)][0] | .timesheetCount >= 2 and .enteredCount == 0 and .label == \"1–12 Jan 2035\"" "the run row in the list"

echo "--- suggestions ---"
req POST /api/job-records "$ADMIN" '{"name":"M8 Test Job","quoteNumber":"M8Q1"}'
expect_status 201 "create the M8 job"
M8_JOB=$(jqr '.id')
req POST /api/rows "$ADMIN" "{\"weekStart\":\"$M8_START\",\"panel\":\"manufacturing\",\"jobId\":$M8_JOB}"
expect_status 201 "create the 2035-01-01 board row"
M8_ROW=$(jqr '.rowId')
req POST "/api/rows/$M8_ROW/assignments" "$ADMIN" "{\"day\":\"mon\",\"workerId\":$M8_W}"
expect_status 201 "the test worker on Monday"
req POST /api/availability/leave "$SCHED" "{\"workerId\":$M8_W,\"from\":\"2035-01-03\",\"to\":\"2035-01-03\",\"kind\":\"leave\"}"
expect_status 201 "leave on 2035-01-03"
req POST /api/payruns/holidays "$ACCT" '{"date":"2035-01-04","name":"M8 Test Holiday"}'
expect_status 201 "add a holiday on 2035-01-04"
expect_jq '.date == "2035-01-04" and .name == "M8 Test Holiday" and .weekday == "Thu"' "the holiday"
m8_sheet
expect_jq '.saved == false and .runStatus == "open" and (.days | length == 10) and .days[0].date == "2035-01-01" and .days[9].date == "2035-01-12"' "an unsaved sheet with ten days"
expect_jq '.suggestions["2035-01-01"].job | contains("M8Q1")' "Monday's job suggestion"
expect_jq '.suggestions["2035-01-03"].arlMin == 480 and .suggestions["2035-01-03"].reason == "leave"' "leave suggests ARL"
expect_jq '.suggestions["2035-01-04"].pholMin == 480 and .suggestions["2035-01-04"].reason == "holiday" and .suggestions["2035-01-04"].holidayName == "M8 Test Holiday"' "the holiday suggests P HOL"
expect_jq '.suggestions["2035-01-02"].job == "" and .suggestions["2035-01-02"].reason == null' "no suggestion on Tuesday"
req GET "/api/payruns/$M8_RUN/timesheets/$M8_TSO" "$ACCT"
expect_status 200 "GET the office person's sheet"
expect_jq '(.suggestions | length == 10) and ([.suggestions[] | .job] | all(. == ""))' "the office person has no job suggestions"
expect_jq '.suggestions["2035-01-04"].pholMin == 480' "the office person gets the holiday"
req PATCH "/api/availability/workers/$M8_OFF" "$SCHED" '{"regularDaysOff":["thu"]}'
expect_status 200 "the off worker has Thursdays off"
req POST "/api/payruns/$M8_RUN/timesheets" "$ACCT" "{\"workerId\":$M8_OFF}"
expect_status 201 "add a sheet for the off worker"
M8_TSD=$(jqr '.id')
expect_jq '.suggestions["2035-01-04"].reason == "dayoff" and .suggestions["2035-01-04"].pholMin == null' "no holiday hours on a regular day off"
expect_jq '.suggestions["2035-01-11"].reason == "dayoff" and .suggestions["2035-01-03"].reason == null' "only Thursdays are days off"
req DELETE "/api/payruns/$M8_RUN/timesheets/$M8_TSD" "$ACCT"
expect_status 204 "remove the off worker's empty sheet"
req PATCH "/api/availability/workers/$M8_OFF" "$SCHED" '{"regularDaysOff":[]}'
expect_status 200 "the off worker's days off cleared"
req GET "/api/payruns/$M8_RUN/timesheets/999999999" "$ACCT"
expect_status 404 "a sheet that isn't in the run"

echo "--- maths ---"
m8_sheet
M8_UPD=$(jqr '.updatedAt')
M8_DAYS='[
  {"date":"2035-01-01","startMin":420,"finishMin":1020,"lunchMin":30,"onsiteMin":120,"job":"M8 Test Job (M8Q1)"},
  {"date":"2035-01-02","startMin":360,"finishMin":1110,"lunchMin":30},
  {"date":"2035-01-04","pholMin":480},
  {"date":"2035-01-05","startMin":420,"finishMin":900,"lunchMin":30},
  {"date":"2035-01-08","startMin":null,"finishMin":null,"job":""},
  {"date":"2035-01-10","startMin":420,"finishMin":660,"arlMin":240},
  {"date":"2035-01-12","startMin":360,"finishMin":1020,"lunchMin":30}
]'
m8_put "$M8_DAYS"
expect_status 200 "save the unit-table days"
expect_jq '.saved == true and .notes == "M8 note" and .signed == true and .entered == true' "the saved sheet"
m8_day 2035-01-01 '.workedMin == 570 and .normalMin == 480 and .otMin == 90 and .dtMin == 0 and .onsiteMin == 120 and .job == "M8 Test Job (M8Q1)"'
m8_day 2035-01-02 '.workedMin == 720 and .normalMin == 480 and .otMin == 120 and .dtMin == 120'
m8_day 2035-01-05 '.workedMin == 450 and .normalMin == 360 and .otMin == 90 and .dtMin == 0'
m8_day 2035-01-12 '.workedMin == 630 and .normalMin == 360 and .otMin == 120 and .dtMin == 150'
m8_day 2035-01-10 '.workedMin == 240 and .normalMin == 240 and .otMin == 0 and .dtMin == 0 and .arlMin == 240'
m8_day 2035-01-04 '.workedMin == 0 and .normalMin == 0 and .otMin == 0 and .dtMin == 0 and .pholMin == 480 and .startMin == null'
m8_day 2035-01-08 '.startMin == null and .job == "" and .workedMin == 0' "an all-blank day stores nothing"
expect_jq '.totals == {workedMin:2610, normalMin:1920, otMin:420, dtMin:270, pholMin:480, sickMin:0, arlMin:240, onsiteMin:120}' "the sheet totals"
M8_NDAYS=$(docker exec "$CONTAINER" node -e "console.log(require('better-sqlite3')('/data/db/photos.db').prepare('SELECT COUNT(*) AS n FROM pay_days WHERE timesheet_id = $M8_TS').get().n)")
expect_eq "$M8_NDAYS" 6 "only the six typed days are stored"
M8_UPD=$(jqr '.updatedAt')
req GET "/api/payruns/$M8_RUN/summary" "$ACCT"
expect_status 200 "GET the summary"
expect_jq ".frozen == false and .payRun.id == $M8_RUN and .rules.ordinaryFriMin == 360" "a live summary"
expect_jq "[.rows[] | select(.timesheetId == $M8_TS)][0] | .name == \"M8 Test Worker\" and .normalMin == 1920 and .otMin == 420 and .dtMin == 270 and .pholMin == 480 and .arlMin == 240 and .sickMin == 0 and .onsiteMin == 120 and .workedMin == 2610 and .notes == \"M8 note\" and .signed == true and .entered == true" "the summary row matches the sheet"
expect_jq '.totals.normalMin >= 1920 and .totals.workedMin >= 2610' "the summary totals include the sheet"

echo "--- validation ---"
m8_put '[{"date":"2035-01-01","startMin":420}]'
expect_status 400 "start without finish"
expect_jq '.error == "Mon 1 Jan: Give both a start and a finish"' "the start-without-finish sentence"
m8_unchanged "start without finish"
m8_put '[{"date":"2035-01-01","startMin":600,"finishMin":500}]'
expect_status 400 "finish before start"
expect_jq '.error == "Mon 1 Jan: Finish must be after start"' "the finish-before-start sentence"
m8_unchanged "finish before start"
m8_put '[{"date":"2035-01-01","startMin":420,"finishMin":480,"lunchMin":90}]'
expect_status 400 "lunch longer than the day"
expect_jq '.error == "Mon 1 Jan: Lunch is longer than the day"' "the long-lunch sentence"
m8_unchanged "lunch longer than the day"
m8_put '[{"date":"2035-01-01","startMin":0,"finishMin":1440,"arlMin":60}]'
expect_status 400 "more than 24 hours"
expect_jq '.error == "Mon 1 Jan: More than 24 hours in one day"' "the 24-hours sentence"
m8_unchanged "more than 24 hours"
m8_put '[{"date":"2035-01-01","startMin":420,"finishMin":480,"onsiteMin":120}]'
expect_status 400 "on-site more than worked"
expect_jq '.error == "Mon 1 Jan: On-site hours are more than the hours worked"' "the on-site sentence"
m8_unchanged "on-site more than worked"
m8_put '[{"date":"2035-01-06","startMin":420,"finishMin":480}]'
expect_status 400 "a date outside the run"
expect_jq ".error == \"2035-01-06 isn't in this pay run\"" "the outside-date sentence"
m8_unchanged "a date outside the run"
m8_put '[{"date":"2035-01-01","startMin":420,"finishMin":480},{"date":"2035-01-01","startMin":420,"finishMin":500}]'
expect_status 400 "a repeated date"
expect_jq '.error == "Mon 1 Jan: this day is in the sheet twice"' "the repeated-date sentence"
m8_unchanged "a repeated date"
m8_put '[{"date":"2035-01-01","startMin":1500,"finishMin":1510}]'
expect_status 400 "startMin 1500"
expect_jq '.error == "Mon 1 Jan: hours out of range"' "the out-of-range sentence"
m8_unchanged "startMin 1500"

echo "--- concurrency ---"
m8_put "$M8_DAYS" "2000-01-01T00:00:00.000Z"
expect_status 409 "a save with an old updatedAt"
expect_jq ".error == \"Someone else saved this sheet; reload it\" and .timesheet.id == $M8_TS and .timesheet.updatedAt == \"$M8_UPD\"" "the stale sentence and the current sheet"
m8_unchanged "a stale save"

echo "--- live rules ---"
m8_settings '{"ordinaryFriMin":300}'
expect_jq '.ordinaryFriMin == 300' "Friday ordinary is 300"
m8_sheet
m8_day 2035-01-05 '.normalMin == 300 and .otMin == 120 and .dtMin == 30' "Fri 5 Jan under the new rule"
m8_day 2035-01-12 '.normalMin == 300 and .otMin == 120 and .dtMin == 210' "Fri 12 Jan under the new rule"
m8_settings '{"ordinaryFriMin":360}'
m8_sheet
m8_day 2035-01-05 '.normalMin == 360 and .otMin == 90 and .dtMin == 0' "Fri 5 Jan back under the default"

echo "--- add and remove sheets ---"
req POST "/api/payruns/$M8_RUN/timesheets" "$ACCT" "{\"workerId\":$M8_OFF}"
expect_status 201 "add a sheet for the off worker"
expect_jq ".person.workerId == $M8_OFF and .name == \"M8 Off Worker\" and .saved == false" "the added sheet"
M8_TS_OFF=$(jqr '.id')
req POST "/api/payruns/$M8_RUN/timesheets" "$ACCT" "{\"personId\":$M8_OFF_PERSON}"
expect_status 409 "add the same person again"
expect_jq '.error == "That person already has a sheet in this pay run"' "the duplicate-sheet sentence"
req POST "/api/payruns/$M8_RUN/timesheets" "$ACCT" '{"personId":999999999}'
expect_status 404 "add an unknown person"
req DELETE "/api/payruns/$M8_RUN/timesheets/$M8_TS" "$ACCT"
expect_status 409 "remove a typed sheet"
expect_jq '.error == "Clear the sheet before removing it"' "the clear-first sentence"
req DELETE "/api/payruns/$M8_RUN/timesheets/$M8_TS_OFF" "$ACCT"
expect_status 204 "remove the empty sheet"

echo "--- finalise ---"
req POST "/api/payruns/$M8_RUN/myob" "$ACCT" '{"entered":true}'
expect_status 409 "MYOB tick on an open run"
expect_jq '.error == "Finalise the pay run first"' "the finalise-first sentence"
req POST "/api/payruns/$M8_RUN/finalise" "$ACCT"
expect_status 200 "acct finalises"
expect_jq '.status == "finalised" and (.finalisedAt | type == "string") and (.finalisedBy.name | type == "string")' "the finalised run"
req GET "/api/payruns/$M8_RUN/summary" "$ACCT"
expect_jq ".frozen == true and .payRun.status == \"finalised\" and ([.rows[] | select(.timesheetId == $M8_TS)][0] | .normalMin == 1920 and .otMin == 420 and .dtMin == 270)" "the frozen summary"
M8_FROZEN=$(jqr '[.rows, .totals, .rules] | tojson')
m8_settings '{"ordinaryFriMin":300}'
req GET "/api/payruns/$M8_RUN/summary" "$ACCT"
expect_eq "$(jqr '[.rows, .totals, .rules] | tojson')" "$M8_FROZEN" "the frozen summary ignores a rule change"
m8_sheet
m8_day 2035-01-05 '.normalMin == 360 and .otMin == 90' "a finalised sheet keeps its frozen rules"
expect_jq '.suggestions == {} and .runStatus == "finalised"' "a finalised sheet has no suggestions"
m8_settings '{"ordinaryFriMin":360}'
req POST "/api/payruns/$M8_RUN/finalise" "$ACCT"
expect_status 409 "finalise twice"
expect_jq '.error == "This pay run is already finalised"' "the already-finalised sentence"
m8_put "$M8_DAYS"
expect_status 409 "save a sheet on a finalised run"
expect_jq '.error == "This pay run is finalised"' "the finalised sentence"
req POST "/api/payruns/$M8_RUN/timesheets" "$ACCT" "{\"workerId\":$M8_OFF}"
expect_status 409 "add a sheet on a finalised run"
req POST "/api/payruns/$M8_RUN/reopen" "$ACCT"
expect_status 403 "acct reopen"
req POST "/api/payruns/$M8_RUN/myob" "$ACCT" '{"entered":true}'
expect_status 200 "tick Entered in MYOB"
expect_jq '.myobEnteredDate | type == "string"' "the MYOB date is set"
req POST "/api/payruns/$M8_RUN/reopen" "$ADMIN"
expect_status 409 "admin reopen while ticked"
expect_jq '.error == "Untick Entered in MYOB first"' "the untick-first sentence"
req POST "/api/payruns/$M8_RUN/myob" "$ACCT" '{"entered":false}'
expect_status 200 "untick Entered in MYOB"
expect_jq '.myobEnteredDate == null' "the MYOB date is cleared"
req POST "/api/payruns/$M8_RUN/reopen" "$ADMIN"
expect_status 200 "admin reopens"
expect_jq '.status == "open" and .finalisedAt == null and .finalisedBy == null' "the reopened run"
req POST "/api/payruns/$M8_RUN/reopen" "$ADMIN"
expect_status 409 "reopen an open run"
expect_jq '.error == "This pay run is open"' "the open sentence"
req GET "/api/payruns/$M8_RUN/summary" "$ACCT"
expect_jq '.frozen == false' "the summary is live again"

echo "--- delete ---"
req POST /api/payruns "$ACCT" "{\"startDate\":\"$M8_START2\"}"
expect_status 201 "create the 2035-01-15 pay run"
M8_RUN2=$(jqr '.id')
req DELETE "/api/payruns/$M8_RUN2" "$ACCT"
expect_status 204 "delete the untouched run"
req GET "/api/payruns/$M8_RUN2" "$ACCT"
expect_status 404 "the deleted run is gone"
req DELETE "/api/payruns/$M8_RUN" "$ACCT"
expect_status 409 "delete a run with typed sheets"
expect_jq '.error == "Only an open pay run with no sheets typed in can be deleted"' "the delete sentence"
req GET /api/payruns/abc "$ACCT"
expect_status 404 "a non-numeric pay-run id"

echo "--- holidays ---"
req GET "/api/payruns/holidays?from=2027-01-01&to=2027-12-31" "$ACCT"
expect_status 200 "GET the 2027 holidays"
expect_jq '[.holidays[] | select(.date == "2027-01-26")][0] | .weekday == "Tue" and (.name | length > 0)' "the seeded 2027-01-26 is listed"
req GET "/api/payruns/holidays?from=2027-01-01&to=2030-01-01" "$ACCT"
expect_status 400 "more than 800 days of holidays"
req POST /api/payruns/holidays "$ACCT" '{"date":"2035-01-04","name":"M8 Test Holiday"}'
expect_status 409 "add the same holiday again"
expect_jq '.error == "That date is already a public holiday"' "the holiday-exists sentence"
req DELETE /api/payruns/holidays/2035-01-04 "$SCHED"
expect_status 403 "sched removes a holiday"
req DELETE /api/payruns/holidays/2035-01-04 "$ACCT"
expect_status 204 "remove the holiday"
req DELETE /api/payruns/holidays/2035-01-04 "$ACCT"
expect_status 404 "remove it again"

echo "--- anchor ---"
req GET /api/payruns/settings "$ACCT"
expect_jq '.anchorLocked == true' "the anchor is locked once a run exists"
req PUT /api/payruns/settings "$ACCT" '{"anchor":"2026-10-12"}'
expect_status 409 "move the anchor while runs exist"
expect_jq ".error == \"The fortnight start can't change once a pay run exists\"" "the anchor-locked sentence"
req PUT /api/payruns/settings "$ACCT" '{"anchor":"2026-10-06"}'
expect_status 400 "an anchor that isn't a Monday"
expect_jq '.error == "The fortnight must start on a Monday"' "the Monday sentence"
req PUT /api/payruns/settings "$ACCT" '{"otBandMin":721}'
expect_status 400 "an OT band over 720"
req GET /api/payruns/settings "$ACCT"
expect_jq '.anchor == "2026-10-05" and .ordinaryMonThuMin == 480 and .ordinaryFriMin == 360 and .otBandMin == 120' "the pay rules are back to the defaults"

echo "--- audit ---"
req GET "/api/audit?entityType=pay_run&entityId=$M8_RUN&limit=100" "$ADMIN"
expect_status 200 "GET the pay run's audit"
for a in payrun.create payrun.finalise payrun.reopen payrun.myob; do
  expect_jq "[.rows[] | .action] | index(\"$a\") != null" "audit has $a"
done
req GET "/api/audit?entityType=timesheet&entityId=$M8_TS&limit=100" "$ADMIN"
expect_status 200 "GET the sheet's audit"
expect_jq '[.rows[] | .action] | index("timesheet.update") != null' "audit has timesheet.update"
expect_jq '[.rows[] | select(.action == "timesheet.update")][-1].after.days["2035-01-01"].startMin == 420' "the update records the changed day"
