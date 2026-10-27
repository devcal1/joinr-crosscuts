# M26 smoke: Morning check and completion (0.2.5, docs/plans/m26-contracts.md): Finish week's
# complete outcome records the job as installed and asks the project manager; Confirm complete
# (owner or admin) completes it and makes the final due; the Pipeline flag; the Morning check (day
# stages and notes, the lists, Done for today) and the dashboard's Waiting on you.
# Sourced by ci/smoke.sh after the M25 suites, so it shares that script's helpers and cookie jars.
# No shebang and no `set`: the caller owns both. Made-up names only; it reads only its own rows.

# ============================================================================
step "m26. installed then confirmed, morning check, waiting on you"
# ============================================================================

M26_TAG="m26m$(date +%s)"
M26_TODAY=$(TZ=Australia/Sydney date +%F)
M26_DOW=$(date -u -d "$M26_TODAY" +%u)
M26_MON=$(date -u -d "$M26_TODAY -$((M26_DOW - 1)) days" +%F)
M26_PREV=$(date -u -d "$M26_TODAY -1 day" +%F)
while [ "$(date -u -d "$M26_PREV" +%u)" -gt 5 ]; do M26_PREV=$(date -u -d "$M26_PREV -1 day" +%F); done
M26_PDOW=$(date -u -d "$M26_PREV" +%u)
M26_PMON=$(date -u -d "$M26_PREV -$((M26_PDOW - 1)) days" +%F)
M26_DAYS=(x mon tue wed thu fri)
M26_PDAY=${M26_DAYS[$M26_PDOW]}

m26_q() {
  docker exec "$CONTAINER" node -e '
const d = require("better-sqlite3")("/data/db/photos.db", { readonly: true });
const [sql, ...args] = process.argv.slice(1);
process.stdout.write(JSON.stringify(d.prepare(sql).all(...args)));' "$@" | tr -d '\r'
}

req GET /api/auth/me "$DPM"; M26_DPM_ID=$(jqr '.user.id')

echo "--- Finish week -> installed, not complete ---"
req POST /api/job-records "$DPM" "{\"name\":\"$M26_TAG fitted\",\"stage\":\"won\",\"valueCents\":1000000}"
expect_status 201 "a job with a value"
M26_J=$(jqr '.id')
req PUT "/api/job-records/$M26_J/owner" "$DPM" "{\"ownerId\":$M26_DPM_ID}"; expect_status 200 "dpm owns it"
req POST /api/invoices "$ACCT" "{\"jobId\":$M26_J,\"kind\":\"deposit\"}"; expect_status 201 "a deposit, so the final follows"
req POST /api/rows "$SCHED" "{\"weekStart\":\"$M26_MON\",\"panel\":\"installing\",\"jobId\":$M26_J}"
expect_status 201 "an install row this week"
req POST /api/rows/finish-week "$SCHED" "{\"weekStart\":\"$M26_MON\",\"results\":[{\"jobId\":$M26_J,\"outcome\":\"complete\",\"stage\":\"install\"}]}"
expect_status 200 "Finish week, Installed"
expect_jq ".installed == [$M26_J] and .completed == []" "marked installed, not completed"
req GET "/api/job-records/$M26_J" "$DPM"
expect_jq ".stage != \"complete\" and .installedDate == \"$M26_TODAY\" and .awaitingConfirm == true and .completedDate == null" "installed today, awaiting confirm"
expect_eq "$(m26_q "SELECT COUNT(*) AS n FROM invoices WHERE job_id = ? AND kind = 'final'" "$M26_J" | jq -r '.[0].n')" "0" "no final yet"
req GET "/api/notifications?limit=50" "$DPM"
expect_jq "[.rows[] | select(.kind == \"job.installed\" and .title == \"$M26_TAG fitted installed: confirm complete\" and .link == \"/project.html?id=$M26_J#confirmComplete\")] | length == 1" "the owner is asked to confirm"
req POST /api/rows/finish-week "$SCHED" "{\"weekStart\":\"$M26_MON\",\"results\":[{\"jobId\":$M26_J,\"outcome\":\"complete\"}]}"
expect_jq '.installed == []' "a repeat records nothing new"
req GET "/api/audit?action=job.installed&entityId=$M26_J&limit=5" "$ADMIN"
expect_jq '(.rows | length) == 1' "audited once"
req GET /schedule.js "$SCHED"
case $BODY in *'{ value: "complete", label: "Installed" }'*) ok ;; *) fail "the Finish week choice isn't labelled Installed" ;; esac

echo "--- the completion line and Confirm complete ---"
req GET "/api/job-records/$M26_J/completion" "$DPM"
expect_jq ".awaitingConfirm == true and .canConfirm == true and .installedDate == \"$M26_TODAY\" and .openIssues == 0" "the owner may confirm"
req GET "/api/job-records/$M26_J/completion" "$ORDR"
expect_jq '.awaitingConfirm == true and .canConfirm == false' "ordering sees it waiting, can't confirm"
req POST "/api/job-records/$M26_J/confirm-complete" "$ORDR" '{}'
expect_status 403 "ordering (design.view, not the owner) can't"
req POST "/api/job-records/$M26_J/confirm-complete" "$ACCT" '{}'
expect_status 403 "accounts can't"
req POST "/api/job-records/$M26_J/issues" "$WSHOP" "{\"body\":\"$M26_TAG scratch on the end panel\"}"
expect_status 201 "an open issue"
req GET "/api/job-records/$M26_J/completion" "$DPM"
expect_jq '.openIssues == 1 and .canConfirm == true' "the issue warns, doesn't block"
req GET "/api/my-work" "$DPM"
expect_jq "[.items[] | select(.key == \"toConfirm\")] | length == 1" "waiting on the owner: an install to confirm"
req GET /job.html "$DPM"
case $BODY in *'id="confirmComplete"'*'confirmcomplete.js'*) ok ;; *) fail "the job page has no Confirm complete line" ;; esac
req GET /project.html "$DPM"
case $BODY in *'id="confirmComplete"'*'confirmcomplete.js'*) ok ;; *) fail "the project page has no Confirm complete line" ;; esac
req POST "/api/job-records/$M26_J/confirm-complete" "$DPM" '{}'
expect_status 200 "the owner confirms"
expect_jq '.awaitingConfirm == false and .completedDate != null' "complete"
req GET "/api/job-records/$M26_J" "$DPM"
expect_jq ".stage == \"complete\" and .completedDate == \"$M26_TODAY\" and .awaitingConfirm == false" "the job is complete today"
expect_eq "$(m26_q "SELECT status FROM invoices WHERE job_id = ? AND kind = 'final'" "$M26_J" | jq -r '.[0].status')" "due" "the final is due"
req POST "/api/job-records/$M26_J/confirm-complete" "$DPM" '{}'
expect_status 409 "not waiting any more"
req GET /pipeline.js "$DPM"
case $BODY in *'Awaiting PM confirm'*) ok ;; *) fail "pipeline.js has no Awaiting PM confirm" ;; esac

echo "--- the Morning check ---"
req GET /api/morning-check "$DPM"
expect_status 403 "board.edit only"
req POST /api/workers "$ADMIN" "{\"name\":\"$M26_TAG maker\"}"; M26_W=$(jqr '.id')
req POST /api/job-records "$DPM" "{\"name\":\"$M26_TAG cabinets\",\"stage\":\"won\"}"; expect_status 201 "a cabinets job"; M26_K=$(jqr '.id')
req PATCH "/api/job-records/$M26_K" "$ADMIN" '{"isTwoPac":false}'
req POST /api/rows "$SCHED" "{\"weekStart\":\"$M26_PMON\",\"panel\":\"manufacturing\",\"jobId\":$M26_K}"
expect_status 201 "a row the previous working week"
M26_ROW=$(jqr '.rowId')
req POST "/api/rows/$M26_ROW/assignments" "$SCHED" "{\"day\":\"$M26_PDAY\",\"workerId\":$M26_W}"
expect_status 201 "the maker on it the previous working day"
req GET /api/morning-check "$SCHED"
expect_status 200 "sched reads it"
expect_jq ".date == \"$M26_PREV\"" "the previous working day by default"
expect_jq "[.jobs[] | select(.id == $M26_K)][0] | .panels == [\"manufacturing\"] and .people == [\"$M26_TAG maker\"] and .dayStage == null and ((.stages | map(.key)) | index(\"paint\")) == null" "the job, who was on it, and its stages (no paint)"
req PUT "/api/morning-check/jobs/$M26_K" "$SCHED" "{\"date\":\"$M26_PREV\",\"stage\":\"paint\"}"
expect_status 400 "paint doesn't apply"
req PUT "/api/morning-check/jobs/$M26_K" "$SCHED" "{\"date\":\"$M26_PREV\",\"stage\":\"bogus\"}"
expect_status 400 "not a stage"
req PUT "/api/morning-check/jobs/$M26_K" "$SCHED" "{\"date\":\"2031-02-30\",\"stage\":\"kit\"}"
expect_status 400 "not a date"
req PUT "/api/morning-check/jobs/$M26_K" "$SCHED" "{\"date\":\"$M26_PREV\",\"stage\":\"assemble\",\"note\":\"Carcasses half done\"}"
expect_status 200 "the day's stage and note"
expect_jq '.stage == "assemble" and .currentStage == "assemble"' "it is the job's current stage"
req GET "/api/schedule?week=$M26_PMON" "$SCHED"
expect_jq "[.weeks[0].manufacturing[] | select(.jobId == $M26_K)][0].productionStage == \"assemble\"" "the board's stage label shows it"
req GET "/api/morning-check?date=$M26_PREV" "$SCHED"
expect_jq "[.jobs[] | select(.id == $M26_K)][0] | .dayStage == \"assemble\" and .note == \"Carcasses half done\"" "read back"
req POST /api/rows/finish-week "$SCHED" "{\"weekStart\":\"$M26_PMON\",\"results\":[{\"jobId\":$M26_K,\"outcome\":\"manufacturing\",\"stage\":\"kit\"}]}"
expect_status 200 "a later Finish week stage"
req GET "/api/job-records/$M26_K" "$SCHED"
req GET "/api/schedule?week=$M26_PMON" "$SCHED"
expect_jq "[.weeks[0].manufacturing[] | select(.jobId == $M26_K)][0].productionStage == \"kit\"" "the later of the two wins"
req PUT "/api/morning-check/jobs/$M26_K" "$SCHED" "{\"date\":\"$M26_PREV\",\"stage\":null,\"note\":\"\"}"
expect_status 200 "cleared"
expect_eq "$(m26_q "SELECT COUNT(*) AS n FROM production_days WHERE job_id = ?" "$M26_K" | jq -r '.[0].n')" "0" "the row is gone"

echo "--- the lists ---"
req POST /api/job-records "$DPM" "{\"name\":\"$M26_TAG empty\",\"stage\":\"won\"}"; expect_status 201 "an empty-row job"; M26_E=$(jqr '.id')
req POST /api/rows "$SCHED" "{\"weekStart\":\"$M26_MON\",\"panel\":\"installing\",\"jobId\":$M26_E}"
req GET /api/morning-check "$SCHED"
expect_jq "[.emptyRows[] | select(.jobId == $M26_E)] | length == 1" "a row this week with nobody on it"
expect_jq "[.installsNoPromised[] | select(.id == $M26_E)] | length == 1" "an install this week with no promised date"
expect_jq "[.openIssues[] | select(.jobId == $M26_J)] | length == 1" "the open issue"
req PATCH "/api/job-records/$M26_E" "$ADMIN" '{"promisedInstallDate":"2031-01-01"}'
req GET /api/morning-check "$SCHED"
expect_jq "[.installsNoPromised[] | select(.id == $M26_E)] | length == 0" "a promised date takes it off"
req GET "/notes.html?dept=scheduling" "$SCHED"
case $BODY in *'id="morningCheck"'*'morningcheck.js'*) ok ;; *) fail "the Scheduling notes page has no Morning check" ;; esac

echo "--- Done for today and Waiting on you ---"
req GET /api/my-work "$SCHED"
expect_status 200 "my work"
if [ "$M26_DOW" -le 5 ]; then
  expect_jq '[.items[] | select(.key == "morning")] | length == 1' "the morning check is waiting"
fi
req POST /api/morning-check/done "$DPM" '{}'
expect_status 403 "board.edit only"
req POST /api/morning-check/done "$SCHED" '{}'
expect_status 200 "done"
expect_jq ".done.date == \"$M26_PREV\" and .done.doneOn == \"$M26_TODAY\" and .done.by.name == \"CI Scheduling\"" "who and when"
req GET /api/morning-check "$SCHED"
expect_jq '.doneToday == true' "done today"
req GET /api/my-work "$SCHED"
expect_jq '[.items[] | select(.key == "morning")] | length == 0' "no longer waiting"
expect_jq '[.items[] | select(.key == "issues")] | length == 1' "open issues still listed"
req GET /api/my-work ""
expect_status 401 "logged out"
req GET / "$SCHED"
req GET /index.html "$SCHED"
case $BODY in *'id="ix-waiting"'*) ok ;; *) fail "the dashboard has no Waiting on you tile" ;; esac
