# M5 smoke, Wave 1 B: leave and availability.
# Sourced by ci/smoke.sh after the M4 suites, so it shares that script's helpers
# (step, req, expect_status, expect_jq, expect_eq, jqr, fail, ok), the cookie jars
# ($ADMIN $SCHED $ACCT $DPM $SHOW) and $BASE. No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: it makes its own worker and board row in
# March 2035 and checks only those. Contract: docs/plans/m5-contracts.md sections 3 and 5.

# ============================================================================
step "m5-b. leave and availability"
# ============================================================================

# 2035-03-05 is a Monday, so tue/wed/thu are 2035-03-06/07/08 and fri is 2035-03-09.
M5B_MON=2035-03-05
M5B_TUE=2035-03-06
M5B_THU=2035-03-08
M5B_FRI=2035-03-09

# m5b_state DAY: reads the board week and sets M5B_AWAY (the chip's away value for the CI worker
# on DAY, "null" when none), M5B_WEEK_AWAY (the worker's day in week.away, "null" when none) and
# M5B_OVER ("true"/"false": the chip's overDays) and M5B_IN_OVER ("true"/"false": the worker is
# in week.overDays).
m5b_state() {
  req GET "/api/schedule?week=$M5B_MON" "$ADMIN"
  expect_status 200 "GET /api/schedule for the CI week"
  M5B_AWAY=$(jqr "[.weeks[0].manufacturing[] | select(.rowId == $M5B_ROW) | .cells.$1[] | select(.workerId == $M5B_W) | .away][0]")
  M5B_OVER=$(jqr "[.weeks[0].manufacturing[] | select(.rowId == $M5B_ROW) | .cells.$1[] | select(.workerId == $M5B_W) | .overDays][0]")
  M5B_WEEK_AWAY=$(jqr ".weeks[0].away[\"$M5B_W\"].$1")
  M5B_IN_OVER=$(jqr "(.weeks[0].overDays | index($M5B_W)) != null")
}

# m5b_audit ACTION ID: how many audit entries of that action there are for the entity id.
m5b_audit() {
  req GET "/api/audit?action=$1&entityId=$2&limit=50" "$ADMIN"
  expect_status 200 "GET /api/audit for $1"
  M5B_AUDIT=$(jqr '.total')
}

echo "--- access ---"
for j in "$SHOW" "$ACCT"; do
  req GET /api/availability "$j"
  expect_status 403 "GET /api/availability without scheduling.view"
done
req GET /api/availability "$DPM"
expect_status 200 "dpm GET /api/availability"
expect_jq 'has("workers") and has("leave")' "the list has workers and leave"
req GET /api/availability "$SCHED"
expect_status 200 "sched GET /api/availability"
req GET /availability.html "$SCHED"
expect_status 200 "sched GET /availability.html"
req GET /availability.html "$SHOW"
expect_status 403 "show GET /availability.html"

echo "--- setup: a worker with a board row ---"
req POST /api/workers "$ADMIN" '{"name":"CI M5B Worker"}'
expect_status 201 "create the CI worker"
M5B_W=$(jqr '.id')
req GET /api/availability "$SCHED"
expect_jq "[.workers[] | select(.id == $M5B_W)][0] | .name == \"CI M5B Worker\" and .daysPerWeek == null and .regularDaysOff == [] and .archived == false" "a new worker has no pattern"
req POST /api/rows "$ADMIN" "{\"weekStart\":\"$M5B_MON\",\"panel\":\"manufacturing\",\"jobName\":\"CI M5B Job\"}"
expect_status 201 "create the CI board row"
M5B_ROW=$(jqr '.rowId')
req POST "/api/rows/$M5B_ROW/assignments" "$ADMIN" "{\"day\":\"wed\",\"workerId\":$M5B_W}"
expect_status 201 "assign the worker on wed"
m5b_state wed
expect_eq "$M5B_AWAY" "null" "no away before any leave"
expect_eq "$M5B_OVER" "false" "not over days before any pattern"

echo "--- leave: who may write ---"
LEAVE_BODY="{\"workerId\":$M5B_W,\"from\":\"$M5B_TUE\",\"to\":\"$M5B_THU\",\"kind\":\"leave\",\"note\":\"CI holiday\"}"
req POST /api/availability/leave "$DPM" "$LEAVE_BODY"
expect_status 403 "dpm POST leave"
req POST /api/availability/leave "$SHOW" "$LEAVE_BODY"
expect_status 403 "show POST leave"
req POST /api/availability/leave "$ACCT" "$LEAVE_BODY"
expect_status 403 "acct POST leave"
req PATCH "/api/availability/workers/$M5B_W" "$DPM" '{"daysPerWeek":3}'
expect_status 403 "dpm PATCH worker pattern"
req POST /api/availability/leave "$SCHED" "$LEAVE_BODY"
expect_status 201 "sched POST leave"
expect_jq ".worker.id == $M5B_W and .worker.name == \"CI M5B Worker\" and .from == \"$M5B_TUE\" and .to == \"$M5B_THU\" and .kind == \"leave\" and .note == \"CI holiday\"" "the leave object echoes its fields"
expect_jq '.days == 3 and (.id | type == "number") and (.createdBy.id | type == "number") and (.createdAt | type == "string")' "days counts weekdays; createdBy and createdAt are set"
M5B_LEAVE=$(jqr '.id')
req DELETE "/api/availability/leave/$M5B_LEAVE" "$DPM"
expect_status 403 "dpm DELETE leave"

echo "--- leave reaches the board ---"
for d in tue wed thu; do
  m5b_state $d
  expect_eq "$M5B_WEEK_AWAY" "leave" "week.away has the worker on $d"
done
m5b_state wed
expect_eq "$M5B_AWAY" "leave" "the wed chip is away: leave"
expect_eq "$M5B_OVER" "false" "leave alone does not mean over days"
m5b_state mon
expect_eq "$M5B_WEEK_AWAY" "null" "no away on the Monday before the leave"
req GET "/api/availability?from=$M5B_MON&to=$M5B_FRI&workerId=$M5B_W" "$DPM"
expect_status 200 "GET /api/availability with from, to and workerId"
expect_jq "(.leave | length == 1) and .leave[0].id == $M5B_LEAVE and (.workers | length > 0)" "the filtered list has the leave"
req GET "/api/availability?from=2035-04-01&to=2035-04-30&workerId=$M5B_W" "$DPM"
expect_jq '.leave | length == 0' "leave outside the dates is not listed"
req GET "/api/availability?from=nope" "$DPM"
expect_status 400 "GET /api/availability with a bad from"

echo "--- a regular day off, and leave beating it ---"
req PATCH "/api/availability/workers/$M5B_W" "$SCHED" '{"regularDaysOff":["fri"]}'
expect_status 200 "sched PATCH regularDaysOff"
expect_jq '.regularDaysOff == ["fri"] and .daysPerWeek == null' "the worker echoes the day off"
req POST "/api/rows/$M5B_ROW/assignments" "$ADMIN" "{\"day\":\"fri\",\"workerId\":$M5B_W}"
expect_status 201 "assign the worker on fri"
m5b_state fri
expect_eq "$M5B_AWAY" "off" "the fri chip is away: off"
expect_eq "$M5B_WEEK_AWAY" "off" "week.away has fri as off"
req POST /api/availability/leave "$SCHED" "{\"workerId\":$M5B_W,\"from\":\"$M5B_FRI\",\"to\":\"$M5B_FRI\",\"kind\":\"sick\"}"
expect_status 201 "sched POST sick leave on the day off"
expect_jq '.days == 1 and .note == ""' "a one-day leave covers one weekday; note defaults to empty"
M5B_SICK=$(jqr '.id')
m5b_state fri
expect_eq "$M5B_AWAY" "sick" "leave beats the regular day off"
req DELETE "/api/availability/leave/$M5B_SICK" "$SCHED"
expect_status 204 "sched DELETE the sick leave"
m5b_state fri
expect_eq "$M5B_AWAY" "off" "the day off shows again"
req PATCH "/api/availability/workers/$M5B_W" "$SCHED" '{"regularDaysOff":[]}'
expect_status 200 "sched PATCH regularDaysOff to none"
expect_jq '.regularDaysOff == []' "the day off is cleared"
m5b_state fri
expect_eq "$M5B_AWAY" "null" "no away once the day off is cleared"

echo "--- days a week ---"
req POST "/api/rows/$M5B_ROW/assignments" "$ADMIN" "{\"day\":\"mon\",\"workerId\":$M5B_W}"
expect_status 201 "assign the worker on mon"
req POST "/api/rows/$M5B_ROW/assignments" "$ADMIN" "{\"day\":\"tue\",\"workerId\":$M5B_W}"
expect_status 201 "assign the worker on tue"
# Now assigned on mon, tue, wed and fri: four distinct days.
req PATCH "/api/availability/workers/$M5B_W" "$SCHED" '{"daysPerWeek":3}'
expect_status 200 "sched PATCH daysPerWeek 3"
expect_jq '.daysPerWeek == 3' "the worker echoes daysPerWeek"
m5b_state mon
expect_eq "$M5B_OVER" "false" "the first three days are within the pattern"
expect_eq "$M5B_IN_OVER" "true" "week.overDays has the worker"
m5b_state fri
expect_eq "$M5B_OVER" "true" "only the fourth day (fri) is over days (4 days against 3)"
req PATCH "/api/availability/workers/$M5B_W" "$SCHED" '{"daysPerWeek":4}'
expect_status 200 "sched PATCH daysPerWeek 4"
expect_jq '.daysPerWeek == 4' "daysPerWeek changed"
m5b_state fri
expect_eq "$M5B_OVER" "false" "4 days against 4 is not over"
expect_eq "$M5B_IN_OVER" "false" "week.overDays no longer has the worker"
req PATCH "/api/availability/workers/$M5B_W" "$SCHED" '{"daysPerWeek":3,"regularDaysOff":["thu","mon"]}'
expect_status 200 "sched PATCH both fields"
expect_jq '.daysPerWeek == 3 and .regularDaysOff == ["mon","thu"]' "days off come back in week order"
req PATCH "/api/availability/workers/$M5B_W" "$SCHED" '{"daysPerWeek":null,"regularDaysOff":[]}'
expect_status 200 "sched PATCH the pattern back to full time"
expect_jq '.daysPerWeek == null and .regularDaysOff == []' "full time again"
m5b_state mon
expect_eq "$M5B_OVER" "false" "no pattern, not over"
expect_eq "$M5B_IN_OVER" "false" "no pattern, not in week.overDays"
req PATCH "/api/availability/workers/$M5B_W" "$SCHED" '{"daysPerWeek":2}'
expect_status 200 "sched PATCH only daysPerWeek"
req PATCH "/api/availability/workers/$M5B_W" "$SCHED" '{"regularDaysOff":["fri"]}'
expect_status 200 "sched PATCH only regularDaysOff"
expect_jq '.daysPerWeek == 2 and .regularDaysOff == ["fri"]' "a field that is left out is left alone"

echo "--- removing leave ---"
req DELETE "/api/availability/leave/$M5B_LEAVE" "$SCHED"
expect_status 204 "sched DELETE leave"
m5b_state wed
expect_eq "$M5B_AWAY" "null" "removing the leave clears away"
expect_eq "$M5B_WEEK_AWAY" "null" "removing the leave clears week.away"
req DELETE "/api/availability/leave/$M5B_LEAVE" "$SCHED"
expect_status 404 "DELETE leave that is already removed"
req DELETE "/api/availability/leave/999999999" "$SCHED"
expect_status 404 "DELETE leave that does not exist"
req GET "/api/availability?from=$M5B_MON&to=$M5B_FRI&workerId=$M5B_W" "$SCHED"
expect_jq '.leave | length == 0' "removed leave is not listed"

echo "--- validation: leave ---"
leave_bad() { # what json
  req POST /api/availability/leave "$SCHED" "$2"
  expect_status 400 "$1"
}
leave_bad "from is not a real date" "{\"workerId\":$M5B_W,\"from\":\"2035-02-30\",\"to\":\"2035-03-01\",\"kind\":\"leave\"}"
leave_bad "from is not a date" "{\"workerId\":$M5B_W,\"from\":\"soon\",\"to\":\"2035-03-01\",\"kind\":\"leave\"}"
leave_bad "from is missing" "{\"workerId\":$M5B_W,\"to\":\"2035-03-01\",\"kind\":\"leave\"}"
leave_bad "to is missing" "{\"workerId\":$M5B_W,\"from\":\"2035-03-01\",\"kind\":\"leave\"}"
leave_bad "from is after to" "{\"workerId\":$M5B_W,\"from\":\"2035-03-09\",\"to\":\"2035-03-05\",\"kind\":\"leave\"}"
leave_bad "367 days" "{\"workerId\":$M5B_W,\"from\":\"2035-01-01\",\"to\":\"2036-01-02\",\"kind\":\"leave\"}"
leave_bad "unknown worker" "{\"workerId\":999999999,\"from\":\"2035-03-05\",\"to\":\"2035-03-05\",\"kind\":\"leave\"}"
leave_bad "no worker" '{"from":"2035-03-05","to":"2035-03-05","kind":"leave"}'
leave_bad "unknown kind" "{\"workerId\":$M5B_W,\"from\":\"2035-03-05\",\"to\":\"2035-03-05\",\"kind\":\"holiday\"}"
leave_bad "no kind" "{\"workerId\":$M5B_W,\"from\":\"2035-03-05\",\"to\":\"2035-03-05\"}"
M5B_LONG_NOTE=$(printf 'n%.0s' $(seq 1 501))
leave_bad "a 501 character note" "{\"workerId\":$M5B_W,\"from\":\"2035-03-05\",\"to\":\"2035-03-05\",\"kind\":\"other\",\"note\":\"$M5B_LONG_NOTE\"}"
req POST /api/availability/leave "$SCHED" '[1]'
expect_status 400 "a body that is not an object"
req GET "/api/availability?from=2035-03-01&to=2035-03-31&workerId=$M5B_W" "$SCHED"
expect_jq '.leave | length == 0' "no refused request wrote anything"
# The limits themselves are allowed: 366 days and a 500 character note.
M5B_NOTE500=$(printf 'n%.0s' $(seq 1 500))
req POST /api/availability/leave "$SCHED" "{\"workerId\":$M5B_W,\"from\":\"2035-01-01\",\"to\":\"2036-01-01\",\"kind\":\"other\",\"note\":\"$M5B_NOTE500\"}"
expect_status 201 "366 days with a 500 character note is allowed"
expect_jq '.days > 200' "a year of leave counts its weekdays"
M5B_YEAR=$(jqr '.id')
m5b_state wed
expect_eq "$M5B_AWAY" "other" "year-long leave shows on the board"
req DELETE "/api/availability/leave/$M5B_YEAR" "$SCHED"
expect_status 204 "remove the year-long leave"

echo "--- validation: pattern ---"
pattern_bad() { # what json
  req PATCH "/api/availability/workers/$M5B_W" "$SCHED" "$2"
  expect_status 400 "$1"
}
pattern_bad "daysPerWeek 0" '{"daysPerWeek":0}'
pattern_bad "daysPerWeek 5" '{"daysPerWeek":5}'
pattern_bad "daysPerWeek 2.5" '{"daysPerWeek":2.5}'
pattern_bad "daysPerWeek as text" '{"daysPerWeek":"3"}'
pattern_bad "regularDaysOff repeats a day" '{"regularDaysOff":["fri","fri"]}'
pattern_bad "regularDaysOff has five days" '{"regularDaysOff":["mon","tue","wed","thu","fri"]}'
pattern_bad "regularDaysOff has a weekend day" '{"regularDaysOff":["sat"]}'
pattern_bad "regularDaysOff is not a list" '{"regularDaysOff":"fri"}'
pattern_bad "an empty body" '{}'
req PATCH "/api/availability/workers/999999999" "$SCHED" '{"daysPerWeek":3}'
expect_status 404 "PATCH an unknown worker"
req GET /api/availability "$SCHED"
expect_jq "[.workers[] | select(.id == $M5B_W)][0] | .daysPerWeek == 2 and .regularDaysOff == [\"fri\"]" "no refused request changed the pattern"

echo "--- audit ---"
m5b_audit leave.create "$M5B_LEAVE"
expect_eq "$M5B_AUDIT" "1" "the leave is audited as created"
m5b_audit leave.remove "$M5B_LEAVE"
expect_eq "$M5B_AUDIT" "1" "the leave is audited as removed"
m5b_audit worker.pattern "$M5B_W"
[ "$M5B_AUDIT" -ge 5 ] || fail "worker.pattern should be audited for each change, got $M5B_AUDIT"
ok

echo "--- cleanup ---"
req PATCH "/api/availability/workers/$M5B_W" "$SCHED" '{"daysPerWeek":null,"regularDaysOff":[]}'
expect_status 200 "clear the CI worker's pattern"
req DELETE "/api/rows/$M5B_ROW" "$ADMIN"
expect_status 204 "delete the CI board row"
req PATCH "/api/workers/$M5B_W" "$ADMIN" '{"archived":true}'
expect_status 200 "archive the CI worker"
