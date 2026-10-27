# M25 smoke: the workshop end-of-shift report (0.2.4, docs/plans/m25-contracts.md): the shift.report
# key, the shift page and today's jobs from the board, shift photos (install or shift), job issues
# (raise, alerts, the Workshop channel, the job page, My projects, Needs install date, resolve), the
# report, the reminder time setting and the install-day reminder.
# Sourced by ci/smoke.sh after the M24 suites, so it shares that script's helpers and cookie jars.
# No shebang and no `set`: the caller owns both. Made-up names only; it reads only its own rows.

# ============================================================================
step "m25. end-of-shift report: shift page, photos, issues, report, reminder"
# ============================================================================

M25_TAG="m25s$(date +%s)"
M25_TODAY=$(TZ=Australia/Sydney date +%F)
M25_DOW=$(date -u -d "$M25_TODAY" +%u)
M25_MON=$(date -u -d "$M25_TODAY -$((M25_DOW - 1)) days" +%F)
M25_DAYS=(x mon tue wed thu fri sat sun)
M25_DAY=${M25_DAYS[$M25_DOW]}

m25_q() {
  docker exec "$CONTAINER" node -e '
const d = require("better-sqlite3")("/data/db/photos.db", { readonly: true });
const [sql, ...args] = process.argv.slice(1);
process.stdout.write(JSON.stringify(d.prepare(sql).all(...args)));' "$@" | tr -d '\r'
}

# m25_upload JAR JOB: the 1x1 test PNG from step c to the shift photo route. Sets STATUS and BODY.
m25_upload() {
  LAST_REQ="POST /api/shift/jobs/$2/photos"
  STATUS=$(curl -s -o "$BODY_FILE" -w '%{http_code}' -H "Origin: $REQ_ORIGIN" -b "$1" \
    -F "photos=@$WORK/test.png;type=image/png" -F "photos=@$WORK/test.png;type=image/png" "$BASE/api/shift/jobs/$2/photos")
  BODY=$(cat "$BODY_FILE")
}

echo "--- the key and the page ---"
req GET /api/users/meta "$ADMIN"
expect_jq '(.keys | index("shift.report")) != null and (.presets.admin | index("shift.report")) != null and (.presets.workshop | index("shift.report")) != null and (.presets.scheduling | index("shift.report")) == null' "shift.report: workshop and admin"
req GET /api/shift/today ""
expect_status 401 "logged out"
req GET /api/shift/today "$ORDR"
expect_status 403 "ordering has no shift.report"
req GET /shift.html "$ORDR"
expect_status 403 "nor the page"
req GET /shift.html "$WSHOP"
expect_status 200 "the workshop login opens the shift page"
req GET /shell/shell.js "$WSHOP"
case $BODY in *'href: "/shift.html", key: "shift.report"'*) ok ;; *) fail "shell.js has no End of shift link" ;; esac

echo "--- a worker on today's install row ---"
req POST /api/workers "$ADMIN" "{\"name\":\"$M25_TAG fitter\"}"
expect_status 201 "a worker"
M25_W=$(jqr '.id')
req GET /api/shift/today "$WSHOP"
expect_status 200 "unlinked login"
expect_jq '.worker == null and (.jobs | length) == 0 and .installDay == false' "no worker, no jobs"
req PUT "/api/users/$WSHOP_ID/worker" "$ADMIN" "{\"workerId\":$M25_W}"
expect_status 200 "linked to the worker"
req GET /api/auth/me "$DPM"; M25_DPM_ID=$(jqr '.user.id')
req POST /api/job-records "$DPM" "{\"name\":\"$M25_TAG install\",\"stage\":\"won\"}"
expect_status 201 "a job"
M25_J=$(jqr '.id')
req PUT "/api/job-records/$M25_J/owner" "$DPM" "{\"ownerId\":$M25_DPM_ID}"; expect_status 200 "dpm owns it"
req POST /api/job-records "$DPM" "{\"name\":\"$M25_TAG other\",\"stage\":\"won\"}"
M25_K=$(jqr '.id')
if [ "$M25_DOW" -le 5 ]; then
  req POST /api/rows "$SCHED" "{\"weekStart\":\"$M25_MON\",\"panel\":\"installing\",\"jobId\":$M25_J}"
  expect_status 201 "an install row this week"
  M25_ROW=$(jqr '.rowId')
  req POST "/api/rows/$M25_ROW/assignments" "$SCHED" "{\"day\":\"$M25_DAY\",\"workerId\":$M25_W}"
  expect_status 201 "the fitter on it today"
  req GET /api/shift/today "$WSHOP"
  expect_jq ".worker.id == $M25_W and .installDay == true and ([.jobs[] | select(.id == $M25_J)][0].panels == [\"installing\"]) and .report == null" "today's install job, no report yet"
else
  echo "(weekend: the board parts are skipped)"
fi

echo "--- search and add a job ---"
req GET "/api/shift/jobs?q=$M25_TAG" "$WSHOP"
expect_jq "[.jobs[].id] | index($M25_K) != null" "search finds the other job"
req GET "/api/shift/today?add=$M25_K" "$WSHOP"
expect_jq "[.jobs[] | select(.id == $M25_K)][0].panels == []" "an added job, not on the board"

echo "--- shift photos ---"
m25_upload "$ORDR" "$M25_J"
expect_status 403 "ordering can't upload shift photos"
m25_upload "$WSHOP" 999999
expect_status 404 "no such job"
m25_upload "$WSHOP" "$M25_K"
expect_status 201 "two photos on the added job"
expect_jq '(.created | length) == 2 and all(.created[]; .tags == "shift")' "tagged shift"
m25_upload "$WSHOP" "$M25_J"
expect_status 201 "two photos on the install job"
M25_P1=$(jqr '.created[0].id')
if [ "$M25_DOW" -le 5 ]; then
  expect_jq 'all(.created[]; .tags == "install")' "tagged install"
fi
expect_eq "$(m25_q "SELECT COUNT(*) AS n FROM photos WHERE job_id = ?" "$M25_J" | jq -r '.[0].n')" "2" "stored against the job"
req GET "/api/shift/today?add=$M25_K" "$WSHOP"
expect_jq "([.jobs[] | select(.id == $M25_J)][0].photosToday | length) == 2" "today's photos on the card"

echo "--- raise an issue ---"
req POST "/api/job-records/$M25_J/issues" "$SCHED" '{"body":"x"}'
expect_status 403 "scheduling doesn't raise issues"
req POST "/api/job-records/$M25_J/issues" "$WSHOP" '{"body":"   "}'
expect_status 400 "say what it is"
req POST "/api/job-records/$M25_J/issues" "$WSHOP" '{"body":"x","photoIds":[999999]}'
expect_status 400 "photos must be this job's"
req POST "/api/job-records/$M25_J/issues" "$WSHOP" "{\"body\":\"$M25_TAG pantry door hits the fridge\",\"photoIds\":[$M25_P1]}"
expect_status 201 "raised"
M25_I=$(jqr '.id')
expect_jq ".status == \"open\" and (.photos | length) == 1 and .raisedBy.id == $WSHOP_ID and .canResolve == false" "open, with its photo; the raiser can't resolve"
req GET "/api/notifications?limit=50" "$DPM"
expect_jq "[.rows[] | select(.kind == \"job.issue\" and .link == \"/job.html?id=$M25_J#issues\" and (.title | startswith(\"Issue on $M25_TAG install:\")))] | length == 1" "the project owner is told"
req GET "/api/notifications?limit=50" "$SCHED"
expect_jq "[.rows[] | select(.kind == \"job.issue\" and .link == \"/job.html?id=$M25_J#issues\")] | length == 1" "the schedule manager is told"
req GET "/api/notifications?limit=50" "$ACCT"
expect_jq "[.rows[] | select(.kind == \"job.issue\" and .link == \"/job.html?id=$M25_J#issues\")] | length == 0" "accounts isn't"
expect_eq "$(m25_q "SELECT COUNT(*) AS n FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.slug = 'workshop' AND m.body LIKE ?" "Issue on $M25_TAG install:%" | jq -r '.[0].n')" "1" "posted to the Workshop channel"
req POST "/api/job-records/$M25_K/issues" "$WSHOP" "{\"body\":\"$M25_TAG no owner issue\"}"
expect_status 201 "an issue on a job with no owner"
req GET "/api/notifications?limit=50" "$DPM"
expect_jq "[.rows[] | select(.kind == \"job.issue\" and .link == \"/job.html?id=$M25_K#issues\")] | length == 1" "no owner: design.view holders are told"

echo "--- where issues show ---"
req GET "/api/job-records/$M25_J/issues" "$ORDR"
expect_status 200 "ordering (jobs.view) reads them"
expect_jq '.canResolve == false' "but can't resolve"
req GET "/api/job-records/$M25_J/issues" "$DPM"
expect_jq "(.issues | length) == 1 and .issues[0].canResolve == true" "the owner can resolve"
req GET /job.html "$DPM"
case $BODY in *'id="issues"'*'jobissues.js'*) ok ;; *) fail "the job page has no Issues section" ;; esac
req GET /project.html "$DPM"
case $BODY in *'id="issues"'*'jobissues.js'*) ok ;; *) fail "the project page has no Issues section" ;; esac
req GET /api/my-projects "$DPM"
expect_jq "[.jobs[] | select(.id == $M25_J)][0].openIssues == 1" "My projects counts it"
req GET "/api/shift/today?add=$M25_K" "$WSHOP"
expect_jq "([.jobs[] | select(.id == $M25_J)][0].issues | length) == 1" "the shift card shows it"

echo "--- resolve ---"
req POST "/api/issues/$M25_I/resolve" "$ORDR" '{}'
expect_status 403 "ordering (design.view, not the owner) can't"
req POST "/api/issues/$M25_I/resolve" "$DPM" '{"resolution":"Swapped the hinge side"}'
expect_status 200 "the owner resolves it"
expect_jq '.status == "resolved" and .resolution == "Swapped the hinge side"' "resolved, with the note"
req POST "/api/issues/$M25_I/resolve" "$DPM" '{}'
expect_status 400 "already resolved"
req GET /api/my-projects "$DPM"
expect_jq "[.jobs[] | select(.id == $M25_J)][0].openIssues == 0" "no longer counted"
req GET "/api/audit?action=issue.resolve&entityId=$M25_I&limit=5" "$ADMIN"
expect_jq '(.rows | length) == 1' "audited"

echo "--- the report ---"
req POST /api/shift/report "$WSHOP" "{\"note\":\"$M25_TAG all fitted\",\"jobIds\":[$M25_J,$M25_K]}"
expect_status 200 "sent"
expect_jq ".date == \"$M25_TODAY\" and .note == \"$M25_TAG all fitted\" and .jobIds == [$M25_J,$M25_K]" "the report"
req POST /api/shift/report "$WSHOP" "{\"note\":\"$M25_TAG updated\",\"jobIds\":[$M25_J]}"
expect_status 200 "sent again"
expect_eq "$(m25_q "SELECT COUNT(*) AS n FROM shift_reports WHERE user_id = ? AND date = ?" "$WSHOP_ID" "$M25_TODAY" | jq -r '.[0].n')" "1" "one report a day, replaced"
req GET /api/shift/today "$WSHOP"
expect_jq ".report.note == \"$M25_TAG updated\" and ([.jobs[].id] | index($M25_J)) != null" "the page knows it was sent"
req POST /api/shift/report "$WSHOP" '{"jobIds":[999999]}'
expect_status 400 "unknown job"

echo "--- the reminder time ---"
req GET /api/settings "$ADMIN"
expect_jq '.shift.reminderTime == "16:00"' "16:00 by default"
req PUT /api/settings "$ADMIN" '{"shift":{"reminderTime":"25:00"}}'
expect_status 400 "not a time"
req PUT /api/settings "$ADMIN" '{"shift":{"reminderTime":""}}'
expect_status 200 "off"
expect_jq '.shift.reminderTime == ""' "empty is off"
req PUT /api/settings "$ADMIN" '{"shift":{"reminderTime":"16:00"}}'
expect_status 200 "back to 16:00"
req GET /users.html "$ADMIN"
case $BODY in *'id="setShiftTime"'*) ok ;; *) fail "users.html has no shift reminder field" ;; esac

echo "--- the install-day reminder ---"
req POST /api/shift/reminder/run "$WSHOP" '{}'
expect_status 403 "admins only"
req POST /api/shift/reminder/run "$ADMIN" '{}'
expect_status 200 "run it"
req GET "/api/notifications?limit=50" "$WSHOP"
expect_jq "[.rows[] | select(.kind == \"shift.reminder\")] | length == 0" "a report was sent: no reminder"
if [ "$M25_DOW" -le 5 ]; then
  docker exec "$CONTAINER" node -e '
const d = require("better-sqlite3")("/data/db/photos.db");
d.prepare("DELETE FROM shift_reports WHERE user_id = ? AND date = ?").run(Number(process.argv[1]), process.argv[2]);' "$WSHOP_ID" "$M25_TODAY"
  req POST /api/shift/reminder/run "$ADMIN" '{}'
  expect_jq '.sent >= 1' "sent"
  req GET "/api/notifications?limit=50" "$WSHOP"
  expect_jq "[.rows[] | select(.kind == \"shift.reminder\" and .link == \"/shift.html\")] | length == 1" "on an install today with no report: reminded"
  req POST /api/shift/reminder/run "$ADMIN" '{}'
  req GET "/api/notifications?limit=50" "$WSHOP"
  expect_jq "[.rows[] | select(.kind == \"shift.reminder\")] | length == 1" "once"
  req DELETE "/api/rows/$M25_ROW" "$SCHED"
fi
req PUT "/api/users/$WSHOP_ID/worker" "$ADMIN" '{"workerId":null}'
