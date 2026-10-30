# M23 smoke: Projects steps and hand-offs (0.2.2, docs/plans/m23-contracts.md): the step ticks, check
# measure bookings on the Planner, the "needs a project owner" alert and the move to Projects, My
# projects, the requested install date that Send to Ordering needs, the order manager's alert, the
# tile marks, the Projects channel rename and the sixth department, Workshop.
# Sourced by ci/smoke.sh after the M22 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie jars ($ADMIN $DPM $ACCT $SCHED
# $SHOW $WSHOP $ORDR $WSMGR), the ids ($ORDR_ID $SCHED_ID $WSMGR_ID ...), $BASE and $CONTAINER. No
# shebang and no `set`: the caller owns both. Made-up names only; it reads only its own rows.

# ============================================================================
step "m23. project steps, check measures, owner alert, My projects, send rules, Workshop"
# ============================================================================

M23_TAG="m23s$(date +%s)"
M23_TODAY=$(TZ=Australia/Sydney date +%F)
m23_plus() { date -u -d "$1 $2 days" +%F; }
M23_D5=$(m23_plus "$M23_TODAY" +5)
M23_D20=$(m23_plus "$M23_TODAY" +20)

echo "--- the migrations ---"
M23_SCHEMA=$(docker exec "$CONTAINER" node -e '
const d = require("better-sqlite3")("/data/db/photos.db", { readonly: true });
const cols = (t) => d.prepare("SELECT name FROM pragma_table_info(?)").all(t).map((c) => c.name);
const sql = (t) => (d.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t) || {}).sql || "";
process.stdout.write(JSON.stringify({
  jobs: cols("jobs"), steps: cols("job_steps"), cm: cols("check_measures"),
  channels: d.prepare("SELECT slug, name, access_key FROM channels ORDER BY position, id").all(),
  notes: sql("dept_notes"), rec: sql("recurring_tasks"), dtasks: sql("dept_tasks"),
  acks: sql("dept_note_acks"), occ: sql("recurring_occurrences"),
}));' | tr -d '\r')
expect_eq "$(printf '%s' "$M23_SCHEMA" | jq -r '.jobs | index("requested_install_date") != null')" "true" "jobs has requested_install_date"
expect_eq "$(printf '%s' "$M23_SCHEMA" | jq -r '.steps | sort == ["done_at","done_by","job_id","step"]')" "true" "job_steps exists"
expect_eq "$(printf '%s' "$M23_SCHEMA" | jq -r '.cm | index("status") != null and index("time") != null')" "true" "check_measures exists"
expect_eq "$(printf '%s' "$M23_SCHEMA" | jq -r '[.channels[] | select(.slug == "design")][0].name')" "Projects" "the design channel's stored name is Projects (044)"
expect_eq "$(printf '%s' "$M23_SCHEMA" | jq -r '[.channels[] | select(.slug == "ordering" or .slug == "workshop") | .access_key] == ["notes.ordering","notes.workshop"]')" "true" "the Ordering and Workshop channels open by key"
expect_eq "$(printf '%s' "$M23_SCHEMA" | jq -r '[.notes, .rec, .dtasks] | all(contains("'"'"'workshop'"'"'"))')" "true" "the three department tables allow workshop (043)"
expect_eq "$(printf '%s' "$M23_SCHEMA" | jq -r '(.acks | test("REFERENCES \"?dept_notes\"?\\s*\\(id\\)")) and (.occ | test("REFERENCES \"?recurring_tasks\"?\\s*\\(id\\)"))')" "true" "the children still reference their parents"

echo "--- Workshop, the sixth department ---"
req GET /api/users/meta "$ADMIN"
expect_jq '(.keys | index("notes.workshop")) != null and (.presets.admin | index("notes.workshop")) != null and (.presets.workshop_manager | index("notes.workshop")) != null and (.presets.workshop | index("notes.workshop")) != null and (.presets.design_pm | index("notes.workshop")) == null' "notes.workshop: workshop, workshop manager and admin"
req GET /api/notes?dept=workshop "$WSMGR"
expect_status 200 "wsmgr reads the Workshop notes"
expect_jq '.deptLabel == "Workshop"' "labelled Workshop"
req POST /api/notes "$WSHOP" "{\"dept\":\"workshop\",\"date\":\"$M23_TODAY\",\"body\":\"$M23_TAG note\"}"
case $(date -u -d "$M23_TODAY" +%u) in
  6|7) expect_status 400 "a weekend day takes no note" ;;
  *) expect_status 201 "the workshop login sticks a Workshop note" ;;
esac
req GET /api/notes?dept=workshop "$DPM"
expect_status 403 "dpm has no Workshop notes"
req GET /shell/shell.js "$WSMGR"
case $BODY in *'home: { href: "/notes.html?dept=workshop", key: "notes.workshop" }'*) ok ;; *) fail "shell.js has no Workshop department" ;; esac
req GET /api/recurring "$ADMIN"
expect_jq '[.depts[] | select(.id == "workshop" and .label == "Workshop")] | length == 1' "Admin > Tasks offers Workshop"
req POST /api/recurring "$ADMIN" "{\"title\":\"$M23_TAG workshop\",\"dept\":\"workshop\",\"repeat\":\"weekly\",\"startDate\":\"$M23_D5\"}"
expect_status 201 "a recurring task for Workshop"
M23_RT=$(jqr '.id // .task.id')
req GET "/api/planner/events?from=$M23_TODAY&to=$M23_D20" "$WSMGR"
expect_jq "[.events[] | select(.title == \"$M23_TAG workshop\")][0].layer == \"workshop\"" "it sits on the Workshop layer"
req GET /api/messages/channels "$WSMGR"
expect_jq '[.rows[].slug] == ["all","ordering","workshop"]' "wsmgr sees All, Ordering and Workshop (it holds both keys)"
req GET /api/messages/channels "$ORDR"
expect_jq '[.rows[].slug] == ["all","ordering"]' "ordr sees All and Ordering"
req GET /api/messages/channels "$DPM"
expect_jq '[.rows[] | select(.slug == "design")][0].name == "Projects"' "the Projects channel reads Projects"

echo "--- the owner alert and the move to Projects ---"
req GET /api/auth/me "$DPM"; M23_DPM_ID=$(jqr '.user.id')
req POST /api/job-records "$DPM" "{\"name\":\"$M23_TAG job\",\"clientName\":\"M23 Test Client\",\"stage\":\"won\"}"
expect_status 201 "a Won job with no owner"
M23_J=$(jqr '.id')
expect_jq '.pipelineStage == "won" and .projectMarks != null and (.projectMarks | map(.mark)) == ["D","CM","N","O"] and (.projectMarks | all(.done == false))' "a Won job carries four empty marks"
req GET "/api/notifications?limit=50" "$ADMIN"
expect_jq "[.rows[] | select(.kind == \"project.owner_needed\" and .link == \"/project.html?id=$M23_J\")] | length == 1" "admin is told it needs a project owner"
expect_jq "[.rows[] | select(.kind == \"project.owner_needed\" and .link == \"/project.html?id=$M23_J\")][0].title == \"$M23_TAG job needs a project manager\"" "the alert's words"
req GET "/api/notifications?limit=50" "$DPM"
expect_jq "[.rows[] | select(.kind == \"project.owner_needed\" and .link == \"/project.html?id=$M23_J\")] | length == 0" "dpm (not an admin) is not"
req GET "/api/notifications?limit=50" "$ORDR"
expect_jq "[.rows[] | select(.kind == \"project.owner_needed\" and .link == \"/project.html?id=$M23_J\")] | length == 0" "ordr (no jobs.edit) is not"
req PATCH "/api/job-records/$M23_J" "$DPM" '{"notes":"another write"}'
expect_status 200 "another write"
req GET "/api/notifications?limit=50" "$ADMIN"
expect_jq "[.rows[] | select(.kind == \"project.owner_needed\" and .link == \"/project.html?id=$M23_J\")] | length == 1" "told once, not on every write"
req PUT "/api/job-records/$M23_J/owner" "$DPM" "{\"ownerId\":$M23_DPM_ID}"
expect_status 200 "dpm takes the job"
expect_jq '.job.pipelineStage == "projects" and .job.stage == "design_ordering"' "the job moved to Projects"
req GET "/api/audit?action=job.stage&entityId=$M23_J&limit=5" "$ADMIN"
expect_jq '[.rows[] | select(.before.stage == "won" and .after.stage == "design_ordering")] | length == 1' "the move is audited"

echo "--- the steps ---"
req PUT "/api/job-records/$M23_J/steps/drawn" "$SCHED" '{"done":true}'
expect_status 403 "scheduling can't tick"
req PUT "/api/job-records/$M23_J/steps/drawn" "$ORDR" '{"done":true}'
expect_status 403 "ordering (no jobs.edit) can't tick"
req PUT "/api/job-records/$M23_J/steps/painted" "$DPM" '{"done":true}'
expect_status 400 "an unknown step"
req PUT "/api/job-records/$M23_J/steps/drawn" "$DPM" '{"done":"yes"}'
expect_status 400 "done must be true or false"
req PUT "/api/job-records/$M23_J/steps/drawn" "$DPM" '{"done":true}'
expect_status 200 "dpm ticks Drawn"
expect_jq ".steps.drawn.doneBy.id == $M23_DPM_ID and .steps.drawn.doneAt != null and .steps.nested == null" "who and when"
expect_jq '[.marks[] | select(.done)] | map(.mark) == ["D"]' "the D mark is done"
req PUT "/api/job-records/$M23_J/steps/nested" "$ADMIN" '{"done":true}'
expect_status 200 "admin ticks Nested"
req PUT "/api/job-records/$M23_J/steps/nested" "$DPM" '{"done":false}'
expect_status 200 "dpm unticks Nested"
expect_jq '.steps.nested == null' "unticked"
req GET "/api/audit?action=job.step&entityId=$M23_J&limit=10" "$ADMIN"
expect_jq '[.rows[] | select(.after.step == "nested" and .after.done == false and .before.done == true)] | length == 1' "the untick is audited with what it was"
req GET "/api/job-records/$M23_J" "$SCHED"
expect_jq '[.projectMarks[] | select(.done)] | map(.mark) == ["D"]' "the job record carries the marks"
req GET /pipeline.js "$DPM"
case $BODY in *'pl-marks'*'orderingProgress'*) ok ;; *) fail "pipeline.js shows no marks or ordering progress" ;; esac
req GET /pipeline.html "$DPM"
case $BODY in *'id="plNoOwner"'*) ok ;; *) fail "pipeline.html has no No owner filter" ;; esac

echo "--- check measures ---"
req POST "/api/job-records/$M23_J/check-measures" "$SCHED" "{\"date\":\"$M23_D5\"}"
expect_status 403 "scheduling can't book"
req POST "/api/job-records/$M23_J/check-measures" "$DPM" '{"date":"2026-02-31"}'
expect_status 400 "a real date"
req POST "/api/job-records/$M23_J/check-measures" "$DPM" "{\"date\":\"$M23_D5\",\"time\":\"25:00\"}"
expect_status 400 "a real time"
req POST "/api/job-records/$M23_J/check-measures" "$DPM" "{\"date\":\"$M23_D5\",\"time\":\"09:30\",\"notes\":\"Gate code at the office\"}"
expect_status 201 "dpm books a check measure"
M23_CM=$(jqr '.checkMeasure.id')
expect_jq '.checkMeasure.status == "booked" and .checkMeasure.time == "09:30" and (.checkMeasures | length) == 1' "booked"
req GET "/api/planner/events?from=$M23_TODAY&to=$M23_D20" "$DPM"
expect_jq "[.events[] | select(.source == \"check_measure\" and .job.id == $M23_J)][0] | .layer == \"design_pm\" and .start == \"$M23_D5\" and .startTime == \"09:30\" and .link == \"/project.html?id=$M23_J#steps\"" "it shows on the Planner, Projects layer"
req GET "/api/planner/events?from=$M23_TODAY&to=$M23_D20" "$ACCT"
expect_jq "[.events[] | select(.source == \"check_measure\")] | length == 0" "accounts doesn't see the Projects layer"
req GET "/api/job-records/$M23_J/check-measures" "$SCHED"
expect_status 200 "anyone with jobs.view lists them"
req PATCH "/api/check-measures/$M23_CM" "$DPM" '{"status":"done"}'
expect_status 200 "marked done"
expect_jq '.checkMeasure.status == "done" and .steps.check_measured != null' "done ticks Check measured"
req POST "/api/job-records/$M23_J/check-measures" "$DPM" "{\"date\":\"$M23_D20\"}"
M23_CM2=$(jqr '.checkMeasure.id')
req PATCH "/api/check-measures/$M23_CM2" "$DPM" '{"status":"cancelled"}'
expect_status 200 "a second booking cancelled"
req PATCH "/api/check-measures/$M23_CM2" "$DPM" "{\"date\":\"$M23_D5\"}"
expect_status 409 "a cancelled booking can't change"

echo "--- the requested install date and Send to Ordering ---"
req PUT "/api/job-records/$M23_J/steps/nested" "$DPM" '{"done":true}'
req POST "/api/job-records/$M23_J/materials" "$DPM" '{"section":"hardware","name":"Hinge","qty":8,"unit":"each","supplier":"M23 Hardware Co"}'
expect_status 201 "a hardware line"
req POST "/api/job-records/$M23_J/materials" "$DPM" '{"section":"boards","name":"Board 16mm","qty":4,"unit":"sheets","supplier":"M23 Boards Co"}'
expect_status 201 "a board line"
req POST "/api/job-records/$M23_J/project/finalise" "$DPM" '{}'
expect_status 201 "finalised"
expect_jq '.marks | all(.done)' "all four marks done (O from the finalised list)"
req GET "/api/my-projects" "$DPM"
expect_jq "[.jobs[] | select(.id == $M23_J)][0] | .waitingOn == \"Enter a requested install date\" and .revision == \"A\" and .requestedInstallDate == null" "My projects: waiting on the requested date"
req POST "/api/job-records/$M23_J/project/send" "$DPM" '{}'
expect_status 400 "send needs a requested install date"
expect_jq '.error == "Enter a requested install date before sending to Ordering"' "the words"
req PATCH "/api/job-records/$M23_J" "$DPM" '{"requestedInstallDate":"2030-02-30"}'
expect_status 400 "a real date"
req PATCH "/api/job-records/$M23_J" "$DPM" '{"requestedInstallDate":"2030-03-04"}'
expect_status 200 "the requested install date"
expect_jq '.requestedInstallDate == "2030-03-04" and .promisedInstallDate == null' "requested is set; promised stays the confirmed one"
req GET "/api/my-projects" "$DPM"
expect_jq "[.jobs[] | select(.id == $M23_J)][0].waitingOn == \"Send to Ordering\"" "now waiting on the send"
req POST "/api/job-records/$M23_J/project/send" "$DPM" '{}'
expect_status 200 "sent"
expect_jq '.created == 2 and .job.pipelineStage == "ordering"' "two order lines, at Ordering"
req GET "/api/notifications?limit=50" "$ORDR"
expect_jq "[.rows[] | select(.kind == \"project.sent\" and .link == \"/orders.html?job=$M23_J\")][0].title == \"Order list for $M23_TAG job sent: 2 lines, 2 suppliers\"" "the order manager is told, with a link to the job's orders"
req GET "/api/notifications?limit=50" "$DPM"
expect_jq "[.rows[] | select(.kind == \"project.sent\" and .link == \"/orders.html?job=$M23_J\")] | length == 0" "the sender isn't (no orders.mark_ordered anyway)"
req GET /orders.js "$ORDR"
case $BODY in *'qs.set("jobId"'*) ok ;; *) fail "orders.js has no job filter" ;; esac
req GET "/api/job-records/$M23_J" "$DPM"
expect_jq '.orderingProgress == {"ordered":0,"total":2,"latestEta":null}' "Ordering tiles: 0 of 2 ordered"
M23_OL=$(curl -s -b "$ORDR" "$BASE/api/orders?jobId=$M23_J" | jq -r '.[0].id')
req PATCH "/api/orders/$M23_OL" "$ORDR" "{\"status\":\"ordered\",\"expectedDate\":\"$M23_D20\"}"
expect_status 200 "ordr orders one line"
req GET "/api/job-records/$M23_J" "$DPM"
expect_jq ".orderingProgress.ordered == 1 and .orderingProgress.total == 2 and .orderingProgress.latestEta == \"$M23_D20\"" "1 of 2, with its ETA"

echo "--- My projects ---"
req GET "/api/my-projects" "$DPM"
expect_status 200 "dpm reads My projects"
expect_jq "[.jobs[] | select(.id == $M23_J)][0] | .pipelineStage == \"ordering\" and .waitingOn == \"With Ordering\" and .ordering.ordered == 1 and .ordering.total == 2 and (.marks | map(.mark)) == [\"D\",\"CM\",\"N\",\"O\"]" "one line with the marks, ordering progress and who it's with"
expect_jq '.all == false and .canAll == false' "not an admin"
req GET "/api/my-projects?all=1" "$DPM"
expect_jq '.all == false' "all=1 needs users.admin"
req GET "/api/my-projects" "$ADMIN"
expect_jq "[.jobs[] | select(.id == $M23_J)] | length == 0" "admin's own list doesn't hold dpm's job"
req GET "/api/my-projects?all=1" "$ADMIN"
expect_jq ".all == true and ([.jobs[] | select(.id == $M23_J and .owner.id == $M23_DPM_ID)] | length) == 1" "show all owners"
req GET /api/my-projects "$ACCT"
expect_status 403 "accounts (no design.view) has no My projects"
req GET "/notes.html?dept=design" "$DPM"
case $BODY in *'id="pjMine"'*) ok ;; *) fail "the Projects notes page has no My projects" ;; esac

echo "--- tidy up ---"
req DELETE "/api/recurring/$M23_RT" "$ADMIN"
[ "$STATUS" = "200" ] || [ "$STATUS" = "204" ] || fail "deleting the Workshop recurring task: $STATUS"
ok
