# M5 smoke, Wave 1 A: production stage at Finish week, and the row fields the board's
# indicators read (materials, productionStage, stageOptions).
# Sourced by ci/smoke.sh after the M4 suites, so it shares that script's helpers (step,
# req, expect_status, expect_jq, expect_eq, jqr, fail, ok), the cookie jars ($ADMIN
# $SCHED $ACCT $DPM $SHOW) and $CONTAINER. No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: it makes its own jobs on a far-future week and
# checks only their rows.
# Contract: docs/plans/m5-contracts.md sections 2, 3 and 5.

# ============================================================================
step "m5-a. production stages at Finish week"
# ============================================================================

M5A_WK="2035-08-06"                                   # a Monday, clear of the other suites
M5A_NEXT=$(date -u -d "$M5A_WK + 7 days" +%F)
M5A_AFTER=$(date -u -d "$M5A_WK + 14 days" +%F)
M5A_TAG=$(date -u +%s)

# A job as the admin -> M5A_JOB. SPEC is the extra JSON fields (may be empty).
m5a_job() { # NAME SPEC
  req POST /api/job-records "$ADMIN" "{\"name\":\"$1 $M5A_TAG\"$2}"
  expect_status 201 "create job $1"
  M5A_JOB=$(jqr '.id')
}

# A board row for a job on a week -> M5A_ROW.
m5a_row() { # JOB_ID WEEK PANEL
  req POST /api/rows "$ADMIN" "{\"weekStart\":\"$2\",\"panel\":\"$3\",\"jobId\":$1}"
  expect_status 201 "add a $3 row for job $1 on $2"
  M5A_ROW=$(jqr '.rowId')
}

# The first row of a job in /api/schedule?week=WEEK (both panels, weeks[0] only), as
# compact JSON -> M5A_R ("null" when the job has no row that week).
m5a_rowof() { # JOB_ID WEEK
  req GET "/api/schedule?week=$2" "$ADMIN"
  expect_status 200 "GET /api/schedule?week=$2"
  M5A_R=$(jqr "[(.weeks[0].manufacturing + .weeks[0].installing)[] | select(.jobId == $1)][0] | tojson")
}

# Rows of our three jobs in the two weeks after the source week, plus our backlog entries.
m5a_counts() {
  req GET "/api/schedule?week=$M5A_NEXT" "$ADMIN"
  expect_status 200 "GET /api/schedule?week=$M5A_NEXT"
  M5A_COUNTS=$(jqr "[([(.weeks[0].manufacturing + .weeks[0].installing + .weeks[1].manufacturing + .weeks[1].installing)[] | select(.jobId == $M5A_J1 or .jobId == $M5A_J2 or .jobId == $M5A_J3)] | length), ([.backlog[] | select(.jobId == $M5A_J1 or .jobId == $M5A_J2 or .jobId == $M5A_J3)] | length)] | tojson")
}

m5a_finish() { # WEEK RESULTS_JSON
  req POST /api/rows/finish-week "$ADMIN" "{\"weekStart\":\"$1\",\"results\":$2}"
}

echo "--- three jobs on a 2035 week: two-pac stone, laminate, unknown spec ---"
m5a_job "CI M5 TwoPac Stone" ',"isTwoPac":true,"benchtop":"stone"'
M5A_J1=$M5A_JOB
m5a_job "CI M5 Laminate" ',"isTwoPac":false,"benchtop":"laminate"'
M5A_J2=$M5A_JOB
m5a_job "CI M5 Unknown Spec" ''
M5A_J3=$M5A_JOB
req GET "/api/job-records/$M5A_J3" "$ADMIN"
expect_status 200 "GET the unknown-spec job"
expect_jq '.isTwoPac == null' "the unknown-spec job has no two-pac answer"

m5a_row "$M5A_J1" "$M5A_WK" manufacturing
m5a_row "$M5A_J2" "$M5A_WK" manufacturing
m5a_row "$M5A_J3" "$M5A_WK" installing

M5A_ALL='["cut_edge","kit","assemble","inspect","paint","install","return_visit"]'
m5a_rowof "$M5A_J1" "$M5A_WK"
[ "$M5A_R" != "null" ] || fail "job $M5A_J1 has no row on $M5A_WK"
printf '%s' "$M5A_R" | jq -e ".stageOptions == $M5A_ALL and .productionStage == null and .materials == null" >/dev/null \
  || fail "two-pac stone: all seven stages, no stage, no materials: $M5A_R"
ok
m5a_rowof "$M5A_J2" "$M5A_WK"
printf '%s' "$M5A_R" | jq -e '.stageOptions == ["cut_edge","kit","assemble","inspect","install"] and .productionStage == null and .materials == null' >/dev/null \
  || fail "laminate (not two-pac): no paint, no return visit: $M5A_R"
ok
m5a_rowof "$M5A_J3" "$M5A_WK"
printf '%s' "$M5A_R" | jq -e ".stageOptions == $M5A_ALL and .productionStage == null and .materials == null" >/dev/null \
  || fail "unknown spec: all seven stages: $M5A_R"
ok

echo "--- a bad stage is a 400 and writes nothing ---"
m5a_counts
M5A_COUNTS_BEFORE=$M5A_COUNTS
m5a_finish "$M5A_WK" "[{\"jobId\":$M5A_J1,\"outcome\":\"manufacturing\",\"stage\":\"assemble\"},{\"jobId\":$M5A_J2,\"outcome\":\"manufacturing\",\"stage\":\"paint\"}]"
expect_status 400 "paint on a job that is not two-pac"
expect_jq '.error == "That stage doesn'"'"'t apply to this job"' "and says why"
m5a_finish "$M5A_WK" "[{\"jobId\":$M5A_J1,\"outcome\":\"manufacturing\",\"stage\":\"assemble\"},{\"jobId\":$M5A_J3,\"outcome\":\"complete\",\"stage\":\"sanding\"}]"
expect_status 400 "an unknown stage key"
expect_jq '.error | startswith("stage must be one of")' "and lists the stages"
m5a_finish "$M5A_WK" "[{\"jobId\":$M5A_J1,\"outcome\":\"manufacturing\",\"stage\":7}]"
expect_status 400 "a stage that is not a string"
m5a_counts
expect_eq "$M5A_COUNTS" "$M5A_COUNTS_BEFORE" "rejected calls created no next-week rows or backlog entries"
expect_eq "$M5A_COUNTS" "[0,0]" "no rows for these jobs after the source week"
m5a_rowof "$M5A_J1" "$M5A_WK"
printf '%s' "$M5A_R" | jq -e '.productionStage == null' >/dev/null || fail "a rejected call recorded a stage: $M5A_R"
ok
req GET "/api/audit?action=job.production_stage&entityType=job&entityId=$M5A_J1&limit=5" "$ADMIN"
expect_status 200 "GET /api/audit for job.production_stage"
expect_jq '.total == 0' "nothing audited for a rejected call"

echo "--- valid stages are recorded for the finished week ---"
m5a_finish "$M5A_WK" "[{\"jobId\":$M5A_J1,\"outcome\":\"manufacturing\",\"stage\":\"assemble\"},{\"jobId\":$M5A_J2,\"outcome\":\"install\",\"stage\":\"kit\"},{\"jobId\":$M5A_J3,\"outcome\":\"complete\",\"stage\":\"install\"}]"
expect_status 200 "Finish week with stages"
expect_jq "(.created | length) == 2 and (.completed == [$M5A_J3])" "created and completed as before"
expect_jq "(.stages | sort_by(.jobId)) == ([{jobId:$M5A_J1,stage:\"assemble\"},{jobId:$M5A_J2,stage:\"kit\"},{jobId:$M5A_J3,stage:\"install\"}] | sort_by(.jobId))" \
  "the response lists the stages recorded"
m5a_rowof "$M5A_J1" "$M5A_NEXT"
printf '%s' "$M5A_R" | jq -e '.productionStage == "assemble"' >/dev/null || fail "next week's row shows the stage reached: $M5A_R"
ok
m5a_rowof "$M5A_J2" "$M5A_NEXT"
printf '%s' "$M5A_R" | jq -e '.productionStage == "kit"' >/dev/null || fail "next week's install row shows kit: $M5A_R"
ok
m5a_rowof "$M5A_J3" "$M5A_WK"
printf '%s' "$M5A_R" | jq -e '.productionStage == "install"' >/dev/null || fail "a complete job's stage is recorded too: $M5A_R"
ok
m5a_counts
M5A_COUNTS_FIRST=$M5A_COUNTS

echo "--- a repeat with a different stage overwrites and creates nothing ---"
m5a_finish "$M5A_WK" "[{\"jobId\":$M5A_J1,\"outcome\":\"manufacturing\",\"stage\":\"paint\"},{\"jobId\":$M5A_J2,\"outcome\":\"install\",\"stage\":\"kit\"},{\"jobId\":$M5A_J3,\"outcome\":\"complete\",\"stage\":\"install\"}]"
expect_status 200 "repeat Finish week with a new stage"
expect_jq '(.created | length) == 0 and (.skipped | length) == 2' "the repeat creates nothing"
expect_jq ".stages == [{jobId:$M5A_J1,stage:\"paint\"}]" "only the changed stage is listed (kit and install were already recorded)"
m5a_counts
expect_eq "$M5A_COUNTS" "$M5A_COUNTS_FIRST" "the repeat changed no row or backlog counts"
m5a_rowof "$M5A_J1" "$M5A_NEXT"
printf '%s' "$M5A_R" | jq -e '.productionStage == "paint"' >/dev/null || fail "the repeat overwrote the stage: $M5A_R"
ok

echo "--- an absent or null stage keeps the one recorded ---"
m5a_finish "$M5A_WK" "[{\"jobId\":$M5A_J1,\"outcome\":\"manufacturing\"},{\"jobId\":$M5A_J2,\"outcome\":\"install\",\"stage\":null}]"
expect_status 200 "Finish week without stages"
expect_jq '.stages == [] and (.created | length) == 0' "nothing recorded, nothing created"
m5a_rowof "$M5A_J1" "$M5A_NEXT"
printf '%s' "$M5A_R" | jq -e '.productionStage == "paint"' >/dev/null || fail "an absent stage cleared the old one: $M5A_R"
ok
m5a_rowof "$M5A_J2" "$M5A_NEXT"
printf '%s' "$M5A_R" | jq -e '.productionStage == "kit"' >/dev/null || fail "a null stage cleared the old one: $M5A_R"
ok

echo "--- stages are kept per week; the current stage is the latest week's ---"
m5a_finish "$M5A_NEXT" "[{\"jobId\":$M5A_J1,\"outcome\":\"install\",\"stage\":\"return_visit\"}]"
expect_status 200 "Finish the next week with return visit (two-pac stone)"
m5a_rowof "$M5A_J1" "$M5A_AFTER"
printf '%s' "$M5A_R" | jq -e '.productionStage == "return_visit"' >/dev/null || fail "the later week's stage is current: $M5A_R"
ok
m5a_finish "$M5A_WK" "[{\"jobId\":$M5A_J1,\"outcome\":\"manufacturing\",\"stage\":\"kit\"}]"
expect_status 200 "re-record the earlier week"
m5a_rowof "$M5A_J1" "$M5A_NEXT"
printf '%s' "$M5A_R" | jq -e '.productionStage == "return_visit"' >/dev/null || fail "an earlier week's record replaced the latest: $M5A_R"
ok

echo "--- the audit log has job.production_stage ---"
req GET "/api/audit?action=job.production_stage&entityType=job&entityId=$M5A_J1&limit=10" "$ADMIN"
expect_status 200 "GET /api/audit for job.production_stage"
expect_jq '.total >= 4' "every change of job $M5A_J1's stage is audited"
expect_jq "[.rows[] | select(.action == \"job.production_stage\")] | length >= 1" "the rows are job.production_stage"

echo "--- materials on the row: null, ordered, in (through the M3 routes) ---"
req POST "/api/job-records/$M5A_J2/materials-ordered" "$ADMIN" '{}'
expect_status 200 "mark the laminate job's materials ordered"
req POST "/api/job-records/$M5A_J1/orders" "$ADMIN" '{"supplier":"CI M5 Supply","description":"CI M5 line"}'
expect_status 201 "add an order line to the two-pac job"
M5A_LINE=$(jqr '.order.id')
req PATCH "/api/orders/$M5A_LINE" "$ADMIN" '{"status":"ordered"}'
expect_status 200 "order the line"
m5a_rowof "$M5A_J1" "$M5A_NEXT"
printf '%s' "$M5A_R" | jq -e '.materials == "ordered"' >/dev/null || fail "ordered but not in: $M5A_R"
ok
req PATCH "/api/orders/$M5A_LINE" "$ADMIN" '{"status":"received"}'
expect_status 200 "receive the line"
expect_jq '.job.materialsInDate != null' "all in: the job has a materials-in date"
m5a_rowof "$M5A_J1" "$M5A_NEXT"
printf '%s' "$M5A_R" | jq -e '.materials == "in"' >/dev/null || fail "materials in: $M5A_R"
ok
m5a_rowof "$M5A_J2" "$M5A_NEXT"
printf '%s' "$M5A_R" | jq -e '.materials == "ordered"' >/dev/null || fail "materials ordered: $M5A_R"
ok
m5a_rowof "$M5A_J3" "$M5A_WK"
printf '%s' "$M5A_R" | jq -e '.materials == null' >/dev/null || fail "no materials tracked: $M5A_R"
ok

echo "M5 stages smoke passed."
