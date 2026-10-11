# M5 smoke, Wave 1 C: the Lookahead (GET /api/scheduling/lookahead and /lookahead.html).
# Sourced by ci/smoke.sh after the M4 suites, so it shares that script's helpers
# (step, req, expect_status, expect_jq, expect_eq, jqr, sydney_monday, fail, ok) and the
# cookie jars ($ADMIN $SCHED $ACCT $DPM $SHOW). No shebang and no `set`: the caller owns
# both. It does not assume a pristine database: it adds its own backlog jobs ("M5 LA ...")
# and checks the order of those, plus the whole list's ordering rule.
# Contract: docs/plans/m5-contracts.md sections 3 to 5.

# ============================================================================
step "m5-lookahead. lookahead endpoint and page"
# ============================================================================

# Adds backlog job NAME -> M5LA_BACKLOG (backlog id) and M5LA_JOB (job id).
m5la_backlog_job() { # NAME
  req POST /api/jobs/backlog "$ADMIN" "{\"name\":\"$1\"}"
  expect_status 201 "POST /api/jobs/backlog $1"
  M5LA_BACKLOG=$(jqr '.id')
  M5LA_JOB=$(jqr '.jobId')
}

echo "--- access ---"
req GET /api/scheduling/lookahead "$SHOW"
expect_status 403 "show GET /api/scheduling/lookahead"
req GET /api/scheduling/lookahead "$ACCT"
expect_status 403 "acct GET /api/scheduling/lookahead"
req GET /api/scheduling/lookahead "$DPM"
expect_status 200 "dpm GET /api/scheduling/lookahead"
req GET /api/scheduling/lookahead "$SCHED"
expect_status 200 "sched GET /api/scheduling/lookahead"
req GET /lookahead.html "$SHOW"
expect_status 403 "show GET /lookahead.html"
req GET /lookahead.html "$SCHED"
expect_status 200 "sched GET /lookahead.html"
req GET /lookahead.js "$SCHED"
expect_status 200 "sched GET /lookahead.js"

echo "--- the weeks parameter ---"
for w in 0 7 x -1 2.5 ""; do
  req GET "/api/scheduling/lookahead?weeks=$w" "$SCHED"
  expect_status 400 "lookahead?weeks=$w"
done
req GET "/api/scheduling/lookahead" "$SCHED"
expect_status 200 "lookahead default"
expect_jq '(.weeks | length) == 4' "the default is four weeks"
for w in 1 2 6; do
  req GET "/api/scheduling/lookahead?weeks=$w" "$SCHED"
  expect_status 200 "lookahead?weeks=$w"
  expect_jq "(.weeks | length) == $w" "weeks=$w returns $w weeks"
done

echo "--- the weeks start at the Sydney Monday ---"
M5LA_MON=$(sydney_monday)
M5LA_MON2=$(date -u -d "$M5LA_MON + 7 days" +%F)
M5LA_MON3=$(date -u -d "$M5LA_MON + 14 days" +%F)
M5LA_MON4=$(date -u -d "$M5LA_MON + 21 days" +%F)
req GET "/api/scheduling/lookahead?weeks=4" "$SCHED"
expect_status 200 "lookahead?weeks=4"
expect_jq "[.weeks[].start] == [\"$M5LA_MON\",\"$M5LA_MON2\",\"$M5LA_MON3\",\"$M5LA_MON4\"]" "four consecutive weeks from the Sydney Monday"
expect_jq 'all(.weeks[]; has("label") and (.manufacturing | type) == "array" and (.installing | type) == "array" and (.away | type) == "object" and (.overDays | type) == "array")' "each week has the board's week shape"
expect_jq '(.toStart | type) == "array"' "toStart is a list"

# A row in the current week shows up in week 0 with the row fields.
req POST /api/rows "$ADMIN" "{\"weekStart\":\"$M5LA_MON\",\"panel\":\"manufacturing\",\"jobName\":\"M5 LA Row\"}"
expect_status 201 "add a row to the current week"
req GET "/api/scheduling/lookahead?weeks=2" "$SCHED"
expect_status 200 "lookahead after adding a row"
expect_jq '[.weeks[0].manufacturing[] | select(.jobName == "M5 LA Row")] | length == 1' "the new row is in week 0 manufacturing"
expect_jq '(.weeks[0].manufacturing[] | select(.jobName == "M5 LA Row")) | has("materials") and has("productionStage") and (.cells | has("mon") and has("fri"))' "the row carries materials, productionStage and day cells"
expect_jq '[.weeks[1].manufacturing[] | select(.jobName == "M5 LA Row")] | length == 0' "and not in week 1"

echo "--- To start: ordered by promised date, nulls last ---"
# Created in this order: A (2035-03-05), B (2035-03-01), C (no date), D (2035-03-05).
# Expected: B, A, D (the same date keeps the backlog order), then C.
m5la_backlog_job "M5 LA A"
M5LA_A_JOB=$M5LA_JOB
req PATCH "/api/job-records/$M5LA_JOB" "$ADMIN" '{"promisedInstallDate":"2035-03-05"}'
expect_status 200 "promise A for 2035-03-05"
m5la_backlog_job "M5 LA B"
req PATCH "/api/job-records/$M5LA_JOB" "$ADMIN" '{"promisedInstallDate":"2035-03-01"}'
expect_status 200 "promise B for 2035-03-01"
m5la_backlog_job "M5 LA C"
m5la_backlog_job "M5 LA D"
req PATCH "/api/job-records/$M5LA_JOB" "$ADMIN" '{"promisedInstallDate":"2035-03-05"}'
expect_status 200 "promise D for 2035-03-05"

# A is marked materials-ordered so the materials mark has a value to show.
req POST "/api/job-records/$M5LA_A_JOB/materials-ordered" "$ADMIN" '{}'
expect_status 200 "mark A materials ordered"

req GET "/api/scheduling/lookahead" "$SCHED"
expect_status 200 "lookahead with the backlog jobs"
expect_jq '[.toStart[] | select(.name | startswith("M5 LA ")) | .name] == ["M5 LA B","M5 LA A","M5 LA D","M5 LA C"]' "toStart order: B, A, D, C"
expect_jq '[.toStart[].promisedInstallDate] as $all | ($all | map(select(. != null))) as $d | ($d == ($d | sort)) and (($all | map(. == null)) == ($all | map(. == null) | sort))' "the whole list is date ascending with the undated last"
expect_jq '(.toStart[] | select(.name == "M5 LA B")) | .promisedInstallDate == "2035-03-01" and (.backlogId | type) == "number" and (.jobId | type) == "number"' "B carries its date, backlogId and jobId"
expect_jq '(.toStart[] | select(.name == "M5 LA C")) | .promisedInstallDate == null and .materials == null and .productionStage == null' "C has no date, materials or stage"
expect_jq '(.toStart[] | select(.name == "M5 LA A")) | .materials == "ordered"' "A shows materials ordered"
expect_jq 'all(.toStart[]; has("backlogId") and has("jobId") and has("name") and has("promisedInstallDate") and has("materials") and has("productionStage"))' "every toStart item has the six fields"

echo "--- the board's backlog order is unchanged ---"
req GET /api/schedule "$ADMIN"
expect_status 200 "GET /api/schedule"
M5LA_BOARD_BEFORE=$(jqr '[.backlog[].id] | @json')
expect_jq '[.backlog[] | select(.name | startswith("M5 LA ")) | .name] == ["M5 LA A","M5 LA B","M5 LA C","M5 LA D"]' "the board backlog keeps the backlog's own order"
req GET "/api/scheduling/lookahead" "$ADMIN"
expect_status 200 "lookahead again"
req GET /api/schedule "$ADMIN"
expect_status 200 "GET /api/schedule again"
expect_eq "$(jqr '[.backlog[].id] | @json')" "$M5LA_BOARD_BEFORE" "the board backlog order after a lookahead call"
expect_jq '(.weeks | length) == 2' "the board still returns two weeks"
