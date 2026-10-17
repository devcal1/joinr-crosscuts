# M3 smoke, Wave 1 A: the pipeline and stage moves. Sourced by ci/smoke.sh
# (the smoke-m3-*.sh loop after the M2 suites), so it shares that script's shell:
# the helpers (step, req, expect_status, expect_jq, expect_eq, jqr, fail, ok), the
# cookie jars ($ADMIN $SCHED $ACCT $DPM $SHOW) and $CONTAINER. No shebang and no
# `set`: the caller owns both. It must not assume a pristine database.
# Contract: docs/plans/m3-contracts.md sections 2, 3, 4 and 8.

# ============================================================================
step "m3-a. pipeline and stage moves"
# ============================================================================

M3A_TODAY=$(TZ=Australia/Sydney date +%F)
M3A_WEEK=2034-03-06   # a far-future Monday no other suite uses

# Run SQL against the live database through the container's own better-sqlite3.
m3a_db_exec() { # SQL
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.exec(process.argv[1]);
d.close();
' "$1"
}

# The number of job.stage audit rows for one job.
m3a_stage_audits() { # JOB_ID
  req GET "/api/audit?action=job.stage&entityType=job&entityId=$1&limit=1" "$ADMIN"
  expect_status 200 "GET /api/audit?action=job.stage"
  jqr '.total'
}

# Is the job in the board's To start list? -> "true" or "false"
m3a_in_backlog() { # JOB_ID
  req GET /api/schedule "$ADMIN"
  expect_status 200 "GET /api/schedule"
  jqr "[.backlog[] | select(.jobId == $1)] | length > 0"
}

# Is the job in the board's job picker (archived = 0)? -> "true" or "false"
m3a_in_picker() { # JOB_ID
  req GET /api/jobs "$ADMIN"
  expect_status 200 "GET /api/jobs"
  jqr "[.[] | select(.id == $1)] | length > 0"
}

# POST the stage move as JAR: m3a_move JAR JOB_ID STAGE FROM (FROM as JSON: "quoted" or null)
m3a_move() {
  req POST "/api/job-records/$2/stage" "$1" "{\"stage\":\"$3\",\"from\":$4}"
}

echo "--- access ---"
req POST /api/job-records/1/stage "$SCHED" '{"stage":"won","from":"quoted"}'
expect_status 403 "sched POST /api/job-records/1/stage"
req POST /api/job-records/1/stage "$ACCT" '{"stage":"won","from":"quoted"}'
expect_status 403 "acct POST /api/job-records/1/stage"
req POST /api/job-records/1/stage "$SHOW" '{"stage":"won","from":"quoted"}'
expect_status 403 "show POST /api/job-records/1/stage"

req GET /pipeline.html "$DPM"
expect_status 200 "dpm GET /pipeline.html"
req GET /pipeline.html "$SCHED"
expect_status 200 "sched GET /pipeline.html"
req GET /pipeline.html "$SHOW"
expect_status 403 "show GET /pipeline.html"
# /orders.html is Wave 2's page: 403 for the showroom either way, 200 once the file exists.
req GET /orders.html "$SHOW"
expect_status 403 "show GET /orders.html"
if [ -f "$APP_SRC/public/orders.html" ]; then
  req GET /orders.html "$DPM"
  expect_status 200 "dpm GET /orders.html"
  req GET /orders.html "$SCHED"
  expect_status 200 "sched GET /orders.html"
fi

echo "--- moves and key dates ---"
req POST /api/job-records "$DPM" '{"name":"M3A Move Job"}'
expect_status 201 "dpm creates the move job"
expect_jq ".stage == \"quoted\" and .quotedDate == \"$M3A_TODAY\" and .wonDate == null" "a new job is quoted, with quotedDate today and wonDate null"
M3A_JOB=$(jqr '.id')

req POST /api/job-records "$DPM" '{"name":"M3A Dated Job","quotedDate":"2030-01-01"}'
expect_status 201 "dpm creates a job with a quotedDate"
expect_jq '.stage == "quoted" and .quotedDate == "2030-01-01"' "an existing quotedDate is never overwritten by the quoted default"
M3A_DATED=$(jqr '.id')

m3a_move "$DPM" "$M3A_JOB" won '"lead"'
expect_status 409 "stale move (the job is quoted, not lead)"
expect_jq '.stage == "quoted" and (.error | length > 0)' "the stale 409 carries the real stage"

echo "--- the Lead stage is retired (2026-10-17) ---"
m3a_move "$DPM" "$M3A_JOB" lead '"quoted"'
expect_status 400 "a move to lead is refused"
expect_jq '.error | test("Lead")' "and the message says Lead is no longer used"
m3a_move "$ADMIN" "$M3A_JOB" lead '"quoted"'
expect_status 400 "a move to lead is refused for the admin too"
req POST /api/job-records "$DPM" '{"name":"M3A Lead Create","stage":"lead"}'
expect_status 400 "creating a job at lead is refused"
req PATCH "/api/job-records/$M3A_JOB" "$ADMIN" '{"stage":"lead"}'
expect_status 400 "the admin PATCH to lead is refused"
req GET "/api/job-records/$M3A_JOB" "$ADMIN"
expect_jq '.stage == "quoted"' "the job is still quoted"
# A row that still holds 'lead' (migration 003's CHECK allows it) is treated as quoted:
# it is listed under stage=quoted and moves on as normal.
req POST /api/job-records "$DPM" '{"name":"M3A Legacy Lead"}'
expect_status 201 "dpm creates the legacy lead job"
M3A_LEAD=$(jqr '.id')
m3a_db_exec "UPDATE jobs SET stage = 'lead' WHERE id = $M3A_LEAD"
req GET "/api/job-records?stage=quoted" "$DPM"
expect_status 200 "list stage=quoted"
expect_jq "[.[] | select(.id == $M3A_LEAD)] | length == 1" "a legacy lead job is listed with the quoted jobs"
m3a_move "$DPM" "$M3A_LEAD" lead '"lead"'
expect_status 400 "a legacy lead job cannot be moved to lead"
m3a_move "$DPM" "$M3A_LEAD" won '"lead"'
expect_status 200 "a legacy lead job moves on to won"
expect_jq '.stage == "won"' "and is won"

M3A_AUDITS=$(m3a_stage_audits "$M3A_JOB")
m3a_move "$DPM" "$M3A_JOB" quoted '"quoted"'
expect_status 200 "same-stage move"
expect_jq '.stage == "quoted"' "the same-stage move leaves the job unchanged"
expect_eq "$(m3a_stage_audits "$M3A_JOB")" "$M3A_AUDITS" "the same-stage move writes no audit row"

req POST "/api/job-records/$M3A_JOB/stage" "$DPM" '{"stage":"won"}'
expect_status 400 "a move without from"
expect_jq '.error == "from is required"' "the missing-from message"

for target in complete on_board invoiced; do
  m3a_move "$DPM" "$M3A_JOB" "$target" '"quoted"'
  expect_status 400 "dpm drop on $target"
  m3a_move "$ADMIN" "$M3A_JOB" "$target" '"quoted"'
  expect_status 400 "admin drop on $target"
done

echo "--- To start ---"
m3a_move "$DPM" "$M3A_JOB" ready_to_cut '"quoted"'
expect_status 200 "quoted -> ready_to_cut"
expect_jq ".readyToCutDate == \"$M3A_TODAY\" and .inBacklog == true" "readyToCutDate is today and the job is in To start"
expect_eq "$(m3a_in_backlog "$M3A_JOB")" true "the board backlog lists the job"

m3a_move "$DPM" "$M3A_JOB" won '"ready_to_cut"'
expect_status 200 "ready_to_cut -> won"
expect_jq '.inBacklog == false' "leaving ready_to_cut takes the job off To start"
expect_eq "$(m3a_in_backlog "$M3A_JOB")" false "the board backlog no longer lists the job"

m3a_move "$DPM" "$M3A_JOB" ready_to_cut '"won"'
expect_status 200 "won -> ready_to_cut again"
req GET /api/schedule "$ADMIN"
M3A_BL=$(jqr "[.backlog[] | select(.jobId == $M3A_JOB)][0].id // \"\"")
[ -n "$M3A_BL" ] || fail "the job should be back in the backlog"
req DELETE "/api/jobs/backlog/$M3A_BL" "$ADMIN"
expect_status 204 "the scheduler removes the job from To start"
req PATCH "/api/job-records/$M3A_JOB" "$DPM" '{"stage":"ready_to_cut"}'
expect_status 200 "PATCH the same stage"
expect_jq '.inBacklog == false' "a same-stage PATCH does not re-add the job (trap 4)"
expect_eq "$(m3a_in_backlog "$M3A_JOB")" false "still not in the backlog"

# Back into To start, then onto the board.
m3a_move "$DPM" "$M3A_JOB" won '"ready_to_cut"'
expect_status 200 "ready_to_cut -> won (reset)"
m3a_move "$DPM" "$M3A_JOB" ready_to_cut '"won"'
expect_status 200 "won -> ready_to_cut (reset)"
req GET /api/schedule "$ADMIN"
M3A_BL=$(jqr "[.backlog[] | select(.jobId == $M3A_JOB)][0].id // \"\"")
[ -n "$M3A_BL" ] || fail "the job should be in the backlog before it is placed"

echo "--- on board ---"
req POST "/api/jobs/backlog/$M3A_BL/place" "$ADMIN" "{\"weekStart\":\"$M3A_WEEK\",\"panel\":\"manufacturing\"}"
expect_status 201 "place the job on the board"
req GET "/api/job-records/$M3A_JOB" "$ADMIN"
expect_jq '.stage == "on_board"' "placing the job makes it on_board"
m3a_move "$DPM" "$M3A_JOB" won '"on_board"'
expect_status 409 "dpm moves an on_board job"
m3a_move "$ADMIN" "$M3A_JOB" won '"on_board"'
expect_status 409 "admin moves an on_board job through the stage route"
req PATCH "/api/job-records/$M3A_JOB" "$ADMIN" '{"stage":"won"}'
expect_status 409 "admin PATCH on_board -> won (the job has future rows)"
req PATCH "/api/job-records/$M3A_JOB" "$DPM" '{"stage":"won"}'
expect_status 409 "dpm PATCH on_board -> won"
req GET "/api/job-records/$M3A_JOB" "$ADMIN"
expect_jq '.stage == "on_board"' "the job is still on_board"

echo "--- archived ---"
req POST /api/job-records "$DPM" '{"name":"M3A Archive Job"}'
expect_status 201 "dpm creates the archive job"
M3A_ARCH=$(jqr '.id')
expect_eq "$(m3a_in_picker "$M3A_ARCH")" true "a new job is in the board picker"
m3a_move "$DPM" "$M3A_ARCH" archived '"quoted"'
expect_status 200 "quoted -> archived"
expect_jq '.archived == true and .stage == "archived"' "the archived stage ticks archived"
expect_eq "$(m3a_in_picker "$M3A_ARCH")" false "the board picker omits the archived job"
m3a_move "$DPM" "$M3A_ARCH" quoted '"archived"'
expect_status 200 "archived -> quoted"
expect_jq '.archived == false and .stage == "quoted"' "leaving the archived stage unticks archived"
expect_eq "$(m3a_in_picker "$M3A_ARCH")" true "the board picker lists the job again"

echo "--- complete ---"
req POST /api/job-records "$ADMIN" '{"name":"M3A Complete Job"}'
expect_status 201 "admin creates the complete job"
M3A_DONE=$(jqr '.id')
req PATCH "/api/job-records/$M3A_DONE" "$ADMIN" '{"stage":"complete"}'
expect_status 200 "admin PATCH stage complete"
expect_jq '.stage == "complete"' "the job is complete"
m3a_move "$DPM" "$M3A_DONE" quoted '"complete"'
expect_status 409 "a complete job moves to quoted"
m3a_move "$DPM" "$M3A_DONE" archived '"complete"'
expect_status 200 "a complete job moves to archived"
expect_jq '.stage == "archived" and .archived == true' "complete -> archived ticks archived"

echo "--- rollback (a failed hook fails the move) ---"
req POST /api/job-records "$DPM" '{"name":"M3A Rollback Job","stage":"won"}'
expect_status 201 "dpm creates a won job"
M3A_RB=$(jqr '.id')
m3a_db_exec "CREATE TRIGGER m3_smoke_block BEFORE INSERT ON backlog BEGIN SELECT RAISE(ABORT,'blocked'); END"
m3a_move "$DPM" "$M3A_RB" ready_to_cut '"won"'
expect_status 500 "ready_to_cut with the backlog insert blocked"
m3a_db_exec "DROP TRIGGER m3_smoke_block"
req GET "/api/job-records/$M3A_RB" "$ADMIN"
expect_jq '.stage == "won" and .readyToCutDate == null and .inBacklog == false' "the failed move left the job as it was"

echo "--- a job with current or future rows is locked, whatever its stage (M3 review fix 3) ---"
# M3A_JOB is still placed on the 2034 week. Make it 'lost' directly (no route does it while
# it has rows), as a stale lost job with rows would be.
m3a_db_exec "UPDATE jobs SET stage = 'lost' WHERE id = $M3A_JOB"
req GET "/api/job-records/$M3A_JOB" "$ADMIN"
expect_jq '.stage == "lost" and (.onBoardWeeks | length) > 0' "the job is lost and still has board rows"
m3a_move "$DPM" "$M3A_JOB" ready_to_cut '"lost"'
expect_status 409 "dpm moves a lost job that has future rows to ready_to_cut"
expect_jq '.error == "This job is on the board; it moves from the board"' "and says it moves from the board"
m3a_move "$ADMIN" "$M3A_JOB" archived '"lost"'
expect_status 409 "admin moves it through the stage route"
req GET "/api/job-records/$M3A_JOB" "$ADMIN"
expect_jq '.stage == "lost" and .inBacklog == false' "the job stayed lost and is not in To start"
expect_eq "$(m3a_in_backlog "$M3A_JOB")" false "the board backlog does not list it"
# The admin override keeps today's rule: only on_board with rows is refused.
req PATCH "/api/job-records/$M3A_JOB" "$ADMIN" '{"stage":"won"}'
expect_status 200 "admin PATCH lost -> won (override)"
m3a_db_exec "UPDATE jobs SET stage = 'on_board' WHERE id = $M3A_JOB"

echo "--- leaving To start (M3 review fix 4) ---"
# Admin's derived override takes the job off To start, in the same request.
req POST /api/job-records "$DPM" '{"name":"M3A Override Job","stage":"ready_to_cut"}'
expect_status 201 "dpm creates a ready_to_cut job"
M3A_OV=$(jqr '.id')
expect_eq "$(m3a_in_backlog "$M3A_OV")" true "the new ready_to_cut job is in To start"
req PATCH "/api/job-records/$M3A_OV" "$ADMIN" '{"stage":"complete"}'
expect_status 200 "admin PATCH ready_to_cut -> complete"
expect_jq '.stage == "complete" and .inBacklog == false' "the job is complete and off To start"
expect_eq "$(m3a_in_backlog "$M3A_OV")" false "the board backlog no longer lists it"
req GET "/api/audit?action=job.stage&entityType=job&entityId=$M3A_OV&limit=1" "$ADMIN"
expect_status 200 "audit for the override"
expect_jq '.rows[0].after.stage == "complete" and .rows[0].after.toStart == "removed"' "the job.stage audit records toStart removed"

# A move to lost or archived takes the job off To start.
for target in lost archived; do
  req POST /api/job-records "$DPM" "{\"name\":\"M3A To $target Job\",\"stage\":\"ready_to_cut\"}"
  expect_status 201 "dpm creates a ready_to_cut job for $target"
  M3A_X=$(jqr '.id')
  expect_eq "$(m3a_in_backlog "$M3A_X")" true "the job is in To start"
  m3a_move "$DPM" "$M3A_X" "$target" '"ready_to_cut"'
  expect_status 200 "ready_to_cut -> $target"
  expect_eq "$(m3a_in_backlog "$M3A_X")" false "ready_to_cut -> $target takes the job off To start"
  req GET "/api/audit?action=job.stage&entityType=job&entityId=$M3A_X&limit=1" "$ADMIN"
  expect_jq ".rows[0].after.stage == \"$target\" and .rows[0].after.toStart == \"removed\"" "the audit records toStart removed ($target)"
done

# Any stage: a stray backlog row goes when the job is archived or lost.
req POST /api/job-records "$DPM" '{"name":"M3A Stray Backlog Job","stage":"won"}'
expect_status 201 "dpm creates a won job"
M3A_STRAY=$(jqr '.id')
m3a_db_exec "INSERT INTO backlog (job_id, sort_order) VALUES ($M3A_STRAY, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM backlog))"
expect_eq "$(m3a_in_backlog "$M3A_STRAY")" true "the won job has a stray To start row"
m3a_move "$DPM" "$M3A_STRAY" lost '"won"'
expect_status 200 "won -> lost"
expect_eq "$(m3a_in_backlog "$M3A_STRAY")" false "a move to lost removes the stray To start row"
