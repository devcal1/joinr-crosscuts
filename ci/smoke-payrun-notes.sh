# Pay run day notes smoke (0.2.17, migration 061): an admin's note on one person's day, GET and PUT
# /api/payruns/day-notes. Sourced by ci/smoke.sh after the weekend suite, so it shares that script's
# helpers (step, req, expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie jars ($ADMIN
# $ACCT $SHOW). No shebang and no `set`: the caller owns both. It does not assume a pristine database
# and works on any day: the fortnights come from GET /api/payruns, it makes its own worker, and it
# leaves next fortnight as it found it (a run it started is deleted again; a run that was already
# there is never finalised).

# ============================================================================
step "payrun-notes. admin day notes on the pay run"
# ============================================================================

req GET /api/payruns "$ADMIN"
expect_status 200 "GET /api/payruns for the fortnights"
DN_CUR=$(jqr '.current.startDate')
DN_NEXT=$(jqr '.next.startDate')
DN_RUN=$(jqr '.next.payRunId // empty')
DN_ANCHOR=$(jqr '.rules.anchor')
DN_STARTED=0
DN_D1=$DN_NEXT
DN_D2=$(date -u -d "$DN_NEXT + 1 day" +%F)
DN_SAT=$(date -u -d "$DN_CUR + 5 days" +%F)
DN_BEFORE=$(date -u -d "$DN_ANCHOR - 7 days" +%F)
DN_FAR=$(date -u -d "$DN_NEXT + 14 days" +%F)
echo "current $DN_CUR, next $DN_NEXT (run '${DN_RUN:-none}'), anchor $DN_ANCHOR"

DN_NAME="CI Day Note Worker $RANDOM$RANDOM"
req POST /api/workers "$ADMIN" "{\"name\":\"$DN_NAME\"}"
expect_status 201 "create the day note worker"
DN_W=$(jqr '.id')
DN_URL="/api/payruns/day-notes"

# A PUT body: worker, date, note, updatedAt (the last one raw JSON: null or a quoted stamp).
dn_put() { # date note updatedAt-json [jar]
  req PUT "$DN_URL" "${4:-$ADMIN}" "{\"workerId\":$DN_W,\"date\":\"$1\",\"note\":\"$2\",\"updatedAt\":$3}"
}
dn_audit_count() {
  req GET "/api/audit?action=payrun.daynote&limit=1" "$ADMIN"
  expect_status 200 "GET /api/audit for day notes"
  jqr '.total'
}

echo "--- access ---"
req GET "$DN_URL?workerId=$DN_W&date=$DN_D1" "$ACCT"
expect_status 403 "accounts role GET day-notes"
req GET "$DN_URL?workerId=$DN_W&date=$DN_D1" "$SHOW"
expect_status 403 "showroom role GET day-notes"
dn_put "$DN_D1" "x" null "$ACCT"
expect_status 403 "accounts role PUT day-notes"
dn_put "$DN_D1" "x" null "$SHOW"
expect_status 403 "showroom role PUT day-notes"
req GET "$DN_URL?workerId=$DN_W&date=$DN_D1"
expect_status 401 "logged out GET day-notes"
req PUT "$DN_URL" "" "{\"workerId\":$DN_W,\"date\":\"$DN_D1\",\"note\":\"x\",\"updatedAt\":null}"
expect_status 401 "logged out PUT day-notes"

echo "--- validation ---"
req PUT "$DN_URL" "$ADMIN" "{\"date\":\"$DN_D1\",\"note\":\"x\",\"updatedAt\":null}"
expect_status 400 "neither personId nor workerId"
req PUT "$DN_URL" "$ADMIN" "{\"personId\":1,\"workerId\":$DN_W,\"date\":\"$DN_D1\",\"note\":\"x\",\"updatedAt\":null}"
expect_status 400 "both personId and workerId"
req GET "$DN_URL?date=$DN_D1" "$ADMIN"
expect_status 400 "GET with neither id"
req GET "$DN_URL?personId=1&workerId=$DN_W&date=$DN_D1" "$ADMIN"
expect_status 400 "GET with both ids"
req PUT "$DN_URL" "$ADMIN" "{\"personId\":999999999,\"date\":\"$DN_D1\",\"note\":\"x\",\"updatedAt\":null}"
expect_status 404 "unknown person"
req GET "$DN_URL?personId=999999999&date=$DN_D1" "$ADMIN"
expect_status 404 "GET unknown person"
dn_put "2035-13-01" "x" null
expect_status 400 "an impossible date"
dn_put "$DN_BEFORE" "x" null
expect_status 400 "a date before the first pay run"
dn_put "$DN_FAR" "x" null
expect_status 400 "a date after the end of next fortnight"
dn_put "$DN_SAT" "x" null
expect_status 400 "a Saturday"
req PUT "$DN_URL" "$ADMIN" "{\"workerId\":$DN_W,\"date\":\"$DN_D1\",\"note\":5,\"updatedAt\":null}"
expect_status 400 "a number for note"
DN_LONG=$(head -c 501 /dev/zero | tr '\0' x)
dn_put "$DN_D1" "$DN_LONG" null
expect_status 400 "501 characters"
req GET "$DN_URL?workerId=$DN_W&date=$DN_SAT" "$ADMIN"
expect_status 400 "GET a Saturday"

echo "--- before anything exists ---"
req GET "$DN_URL?workerId=$DN_W&date=$DN_D1" "$ADMIN"
expect_status 200 "GET a day with no note"
expect_jq '.dayNote == null and .fortnight.hasSheet == false' "no note, no sheet"
expect_jq ".fortnight.startDate == \"$DN_NEXT\"" "the next fortnight"
if [ -z "$DN_RUN" ]; then
  expect_jq '.fortnight.status == "none"' "no run yet for next fortnight"
fi
req GET /api/payruns/people "$ADMIN"
expect_status 200 "GET /api/payruns/people"
expect_jq "[.people[] | select(.workerId == $DN_W) | .id] | all(. == null)" "a GET made no pay_people row"

if [ -n "$DN_RUN" ]; then
  req GET "/api/payruns/$DN_RUN" "$ADMIN"
  expect_status 200 "GET the existing next fortnight run"
  if [ "$(jqr '.status')" = "finalised" ]; then
    echo "NOTE: next fortnight's run was already finalised: skipping the write checks (a note can't be saved there)"
    dn_put "$DN_D1" "x" null
    expect_status 409 "PUT into a finalised fortnight is refused"
    return 0
  fi
fi

echo "--- set a note ---"
DN_BEFORE_N=$(dn_audit_count)
dn_put "$DN_D1" "  Left early, dentist  " null
expect_status 200 "PUT a first note"
expect_jq '.dayNote.note == "Left early, dentist" and (.dayNote.by.name | length > 0) and (.dayNote.updatedAt | length > 0)' "the trimmed note and who wrote it"
DN_STAMP=$(jqr '.dayNote.updatedAt')
DN_PERSON=$(jqr '.person.id')
expect_jq '.person.id != null' "the worker has a pay person now"
req GET /api/payruns/people "$ADMIN"
expect_jq "[.people[] | select(.workerId == $DN_W) | .id] | all(. != null)" "the worker now has a pay_people row"
expect_eq "$(dn_audit_count)" "$((DN_BEFORE_N + 1))" "one audit row for the first note"

echo "--- the run and the sheet ---"
if [ -z "$DN_RUN" ]; then
  req POST /api/payruns "$ADMIN" "{\"startDate\":\"$DN_NEXT\"}"
  expect_status 201 "start next fortnight's run"
  DN_RUN=$(jqr '.id')
  DN_STARTED=1
fi
req GET "/api/payruns/$DN_RUN" "$ADMIN"
DN_TS=$(jqr ".timesheets[] | select(.person.workerId == $DN_W) | .id")
if [ -n "$DN_TS" ]; then
  # A run started now gives every active worker a sheet; drop the empty one to test "waiting".
  req DELETE "/api/payruns/$DN_RUN/timesheets/$DN_TS" "$ADMIN"
  expect_status 204 "remove the worker's empty sheet"
fi
req GET "/api/payruns/$DN_RUN" "$ADMIN"
expect_jq ".waitingDayNotes | map(select(.person.workerId == $DN_W and .count == 1)) | length == 1" "no sheet: the worker is waiting with one note"
req POST "/api/payruns/$DN_RUN/timesheets" "$ADMIN" "{\"workerId\":$DN_W}"
expect_status 201 "add the worker's sheet"
DN_TS=$(jqr '.id')
req GET "/api/payruns/$DN_RUN" "$ADMIN"
expect_jq ".waitingDayNotes | map(select(.person.workerId == $DN_W)) | length == 0" "with a sheet the worker stops waiting"
expect_jq ".timesheets | map(select(.id == $DN_TS and .dayNoteCount == 1)) | length == 1" "the sheet counts one note"
req GET "/api/payruns/$DN_RUN/timesheets/$DN_TS" "$ADMIN"
expect_status 200 "GET the sheet"
expect_jq ".dayNotes[\"$DN_D1\"].note == \"Left early, dentist\" and (.dayNotes[\"$DN_D1\"].by.name | length > 0)" "the sheet shows the note"
expect_jq '.saved == false' "the empty sheet is not saved"

echo "--- a note save leaves the sheet alone ---"
req POST "/api/payruns/$DN_RUN/timesheets/$DN_TS/review" "$ADMIN" '{"reviewed":true}'
expect_status 200 "tick the review"
req GET "/api/payruns/$DN_RUN/timesheets/$DN_TS" "$ADMIN"
DN_SHEET_AT=$(jqr '.updatedAt')
dn_put "$DN_D1" "Left at ten" "\"$DN_STAMP\""
expect_status 200 "change the note"
expect_jq '.dayNote.note == "Left at ten"' "the new text"
DN_STAMP2=$(jqr '.dayNote.updatedAt')
[ "$DN_STAMP2" != "$DN_STAMP" ] || fail "the note's stamp did not move on a change"
ok
req GET "/api/payruns/$DN_RUN/timesheets/$DN_TS" "$ADMIN"
expect_eq "$(jqr '.updatedAt')" "$DN_SHEET_AT" "the sheet's updatedAt is unchanged"
expect_jq '.saved == false and .reviewed == true' "still unsaved and the review tick is still on"

echo "--- stale writes ---"
dn_put "$DN_D1" "Stale try" "\"$DN_STAMP\""
expect_status 409 "an old stamp is refused"
expect_jq '.dayNote.note == "Left at ten"' "the 409 carries the current note"
dn_put "$DN_D1" "Null try" null
expect_status 409 "null on a day that has a note is refused"
expect_jq '.dayNote.note == "Left at ten"' "that 409 carries the current note too"

echo "--- same text again ---"
DN_BEFORE_N=$(dn_audit_count)
dn_put "$DN_D1" "Left at ten" "\"$DN_STAMP2\""
expect_status 200 "the same text again"
expect_eq "$(jqr '.dayNote.updatedAt')" "$DN_STAMP2" "the stamp did not move"
expect_eq "$(dn_audit_count)" "$DN_BEFORE_N" "no new audit row for unchanged text"

echo "--- summary, remove and add the sheet back ---"
req GET "/api/payruns/$DN_RUN/summary" "$ADMIN"
expect_status 200 "GET the live summary"
expect_jq ".rows | map(select(.name == \"$DN_NAME\" and (.dayNotes | length) == 1 and .dayNotes[0].date == \"$DN_D1\" and .dayNotes[0].note == \"Left at ten\")) | length == 1" "the summary row lists the note with its date"
req DELETE "/api/payruns/$DN_RUN/timesheets/$DN_TS" "$ADMIN"
expect_status 204 "remove the empty sheet"
req POST "/api/payruns/$DN_RUN/timesheets" "$ADMIN" "{\"workerId\":$DN_W}"
expect_status 201 "add the sheet back"
DN_TS=$(jqr '.id')
expect_jq ".dayNotes[\"$DN_D1\"].note == \"Left at ten\"" "the note survived the sheet coming and going"

echo "--- a second day, then clearing ---"
dn_put "$DN_D2" "Second day" null
expect_status 200 "a note on the Tuesday"
req GET "/api/payruns/$DN_RUN" "$ADMIN"
expect_jq ".timesheets | map(select(.id == $DN_TS and .dayNoteCount == 2)) | length == 1" "two notes counted"
req GET "/api/payruns/$DN_RUN/summary" "$ADMIN"
expect_jq ".rows | map(select(.name == \"$DN_NAME\")) | .[0].dayNotes | map(.date) == [\"$DN_D1\", \"$DN_D2\"]" "oldest day first"
req GET "$DN_URL?workerId=$DN_W&date=$DN_D2" "$ADMIN"
DN_STAMP3=$(jqr '.dayNote.updatedAt')
dn_put "$DN_D2" "   " "\"$DN_STAMP3\""
expect_status 200 "a whitespace-only note removes it"
expect_jq '.dayNote == null' "the note is gone"
req GET "/api/payruns/$DN_RUN" "$ADMIN"
expect_jq ".timesheets | map(select(.id == $DN_TS and .dayNoteCount == 1)) | length == 1" "back to one note"

echo "--- audit rows ---"
req GET "/api/audit?action=payrun.daynote&limit=20" "$ADMIN"
expect_status 200 "GET audit rows"
expect_jq ".rows | map(select(.action == \"payrun.daynote\" and .after.note == \"Left at ten\" and .before.note == \"Left early, dentist\" and .after.date == \"$DN_D1\")) | length >= 1" "the change row has before and after"
expect_jq ".rows | map(select(.action == \"payrun.daynote\" and .before.note == null and .after.note == \"Left early, dentist\")) | length >= 1" "the first note row has a null before"
expect_jq ".rows | map(select(.action == \"payrun.daynote\" and .before.note == \"Second day\" and .after.note == null)) | length >= 1" "the removal row has a null after"

if [ "$DN_STARTED" = "1" ]; then
  echo "--- finalise a run this suite started ---"
  req POST "/api/payruns/$DN_RUN/finalise" "$ADMIN"
  expect_status 200 "finalise"
  req GET "/api/payruns/$DN_RUN/summary" "$ADMIN"
  expect_jq ".frozen == true and (.rows | map(select(.name == \"$DN_NAME\" and (.dayNotes | length) == 1 and .dayNotes[0].note == \"Left at ten\")) | length == 1)" "the frozen summary has the day notes"
  dn_put "$DN_D1" "Too late" "\"$DN_STAMP2\""
  expect_status 409 "PUT into a finalised fortnight"
  expect_jq '.error | test("finalised")' "the finalised sentence"
  req GET "$DN_URL?workerId=$DN_W&date=$DN_D1" "$ADMIN"
  expect_jq '.fortnight.status == "finalised"' "GET reports finalised"
  req POST "/api/payruns/$DN_RUN/reopen" "$ADMIN"
  expect_status 200 "reopen"
  dn_put "$DN_D1" "Back again" "\"$DN_STAMP2\""
  expect_status 200 "PUT works again after reopening"
  expect_jq '.dayNote.note == "Back again"' "the reopened note"
else
  echo "NOTE: next fortnight already had a run, so the suite did not finalise it (the finalise checks are skipped)"
fi

echo "--- tidy up: next fortnight as it was found ---"
req GET "$DN_URL?workerId=$DN_W&date=$DN_D1" "$ADMIN"
DN_STAMP4=$(jqr '.dayNote.updatedAt')
dn_put "$DN_D1" "" "\"$DN_STAMP4\""
expect_status 200 "clear the last note"
expect_jq '.dayNote == null' "no notes left"
if [ "$DN_STARTED" = "1" ]; then
  req DELETE "/api/payruns/$DN_RUN" "$ADMIN"
  expect_status 204 "delete the run the suite started"
else
  req DELETE "/api/payruns/$DN_RUN/timesheets/$DN_TS" "$ADMIN"
  expect_status 204 "remove the suite's empty sheet from the existing run"
fi
