# M20 smoke: recurring tasks, Admin > Tasks (0.2.0, docs/plans/m20-recurring-tasks.md), plus the
# 0.2.0 menu and page renames (Projects, Benchtops, Overdue client invoices, the Projects dashboard on the
# Projects notes page).
# Sourced by ci/smoke.sh after the M19 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie jars ($ADMIN $SCHED $ACCT $DPM
# $ORDR ...), $BASE and $WORK. No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: its rules and tasks carry a run tag in their titles, and
# it reads only rows with that tag. Dates come from Sydney's today. Made-up names only.

# ============================================================================
step "m20. recurring tasks (Admin > Tasks) and the 0.2.0 renames"
# ============================================================================

M20_TAG="m20r$(date +%s)"
while [ "$(TZ=Australia/Sydney date +%H%M)" -ge 2350 ]; do
  echo "    (waiting for Sydney midnight to pass before the recurring suite starts)"
  sleep 15
done
M20_TODAY=$(TZ=Australia/Sydney date +%F)
m20_plus() { date -u -d "$1 $2 days" +%F; }
M20_D1=$(m20_plus "$M20_TODAY" +1)
M20_D3=$(m20_plus "$M20_TODAY" +3)
M20_D4=$(m20_plus "$M20_TODAY" +4)
M20_D7=$(m20_plus "$M20_TODAY" +7)
M20_D10=$(m20_plus "$M20_TODAY" +10)
M20_D14=$(m20_plus "$M20_TODAY" +14)
M20_D21=$(m20_plus "$M20_TODAY" +21)
M20_YDAY=$(m20_plus "$M20_TODAY" -1)

echo "--- the menu and pages after the renames ---"
req GET /shell/shell.js "$ADMIN"
expect_status 200 "GET /shell/shell.js"
M20_SHELL=$BODY
case $M20_SHELL in *'label: "Projects",'*) ok ;; *) fail "shell.js: no Projects department" ;; esac
case $M20_SHELL in *'Design/PM'*) fail "shell.js still says Design/PM" ;; *) ok ;; esac
case $M20_SHELL in *'href: "/design.html"'*) fail "shell.js still lists the Design/PM page" ;; *) ok ;; esac
case $M20_SHELL in *'{ label: "Benchtops", href: "/stone.html", key: "design.view" }'*) ok ;; *) fail "shell.js: no Benchtops item" ;; esac
case $M20_SHELL in *'{ label: "Overdue client invoices", href: "/accounts.html", key: "accounts.view" }'*) ok ;; *) fail "shell.js: no Overdue client invoices item" ;; esac
case $M20_SHELL in *'{ label: "Tasks", href: "/admintasks.html", key: "users.admin" }'*) ok ;; *) fail "shell.js: no Admin > Tasks item" ;; esac
req GET /design.html "$DPM"
expect_status 302 "dpm GET /design.html redirects"
case $(hdr location) in "/notes.html?dept=design") ok ;; *) fail "/design.html redirects to '$(hdr location)'" ;; esac
req GET /design.html "$ACCT"
expect_status 403 "acct GET /design.html (no design.view)"
req GET "/notes.html?dept=design" "$DPM"
expect_status 200 "dpm GET the Projects notes page"
case $BODY in *'id="pjDash"'*'projectsdash.js'*) ok ;; *) fail "notes.html carries no Projects dashboard" ;; esac
req GET "/notes.html?dept=design" "$ORDR"
expect_status 200 "ordr (design.view, no notes.design) GET the Projects page for its dashboard"
req GET /stone.html "$DPM"
case $BODY in *'<title>Benchtops - Crosscuts</title>'*'>Benchtops</h1>'*) ok ;; *) fail "stone.html is not titled Benchtops" ;; esac
req GET /accounts.html "$ACCT"
case $BODY in *'<h1>Overdue client invoices</h1>'*) ok ;; *) fail "accounts.html is not titled Overdue client invoices" ;; esac
req GET "/api/notes?dept=design" "$DPM"
expect_jq '.deptLabel == "Projects"' "the Projects notes wall's title"
req GET /api/planner/layers "$DPM"
expect_jq '[.layers[] | select(.id == "design_pm") | .label] == ["Projects"]' "the Projects planner layer"

echo "--- access: admins only ---"
req GET /admintasks.html "$ADMIN";  expect_status 200 "admin GET /admintasks.html"
req GET /admintasks.html "$DPM";    expect_status 403 "dpm GET /admintasks.html"
req GET /api/recurring;             expect_status 401 "logged out GET /api/recurring"
for M20_J in "$DPM" "$ACCT" "$SCHED"; do
  req GET /api/recurring "$M20_J";  expect_status 403 "a non-admin GET /api/recurring"
  req POST /api/recurring "$M20_J" '{"title":"x"}'; expect_status 403 "a non-admin POST /api/recurring"
  req POST /api/recurring/run "$M20_J" '{}'; expect_status 403 "a non-admin POST /api/recurring/run"
done
req GET /api/auth/me "$ACCT"; M20_ACCT_ID=$(jqr '.user.id')
req GET /api/auth/me "$DPM";  M20_DPM_ID=$(jqr '.user.id')

echo "--- validation ---"
req POST /api/recurring "$ADMIN" "{\"title\":\"$M20_TAG bad\",\"repeat\":\"weekly\",\"startDate\":\"$M20_TODAY\"}"
expect_status 400 "no person or department"
req POST /api/recurring "$ADMIN" "{\"title\":\"$M20_TAG bad\",\"assigneeId\":$M20_ACCT_ID,\"dept\":\"design\",\"repeat\":\"weekly\",\"startDate\":\"$M20_TODAY\"}"
expect_status 400 "a person and a department"
req POST /api/recurring "$ADMIN" "{\"title\":\"$M20_TAG bad\",\"dept\":\"design\",\"repeat\":\"daily\",\"startDate\":\"$M20_TODAY\"}"
expect_status 400 "an unknown repeat"
req POST /api/recurring "$ADMIN" "{\"title\":\"$M20_TAG bad\",\"dept\":\"design\",\"repeat\":\"custom\",\"repeatEvery\":0,\"repeatUnit\":\"day\",\"startDate\":\"$M20_TODAY\"}"
expect_status 400 "custom every 0"
req POST /api/recurring "$ADMIN" "{\"title\":\"$M20_TAG bad\",\"dept\":\"design\",\"repeat\":\"weekly\",\"startDate\":\"$M20_TODAY\",\"leadDays\":61}"
expect_status 400 "lead days over 60"
req POST /api/recurring "$ADMIN" "{\"title\":\"$M20_TAG bad\",\"dept\":\"nowhere\",\"repeat\":\"weekly\",\"startDate\":\"$M20_TODAY\"}"
expect_status 400 "an unknown department"
req POST /api/recurring "$ADMIN" "{\"title\":\"$M20_TAG bad\",\"dept\":\"design\",\"repeat\":\"weekly\",\"startDate\":\"$M20_TODAY\",\"endDate\":\"$M20_YDAY\"}"
expect_status 400 "an end before the start"
req POST /api/recurring/run "$ADMIN" "{\"today\":\"$M20_YDAY\"}"
expect_status 400 "run as of a day before today"

echo "--- a person's rule: due today, made at once, a task and an alert ---"
req POST /api/recurring "$ADMIN" "{\"title\":\"$M20_TAG person\",\"notes\":\"Made-up note.\",\"assigneeId\":$M20_ACCT_ID,\"repeat\":\"weekly\",\"startDate\":\"$M20_TODAY\"}"
expect_status 201 "admin adds a weekly rule for acct"
expect_jq ".assignee.id == $M20_ACCT_ID and .dept == null and .repeatText == \"Every week\" and .active == true and .made == 1 and .lastDue == \"$M20_TODAY\"" "the rule, with today's occurrence made"
M20_P=$(jqr '.id')
req GET "/api/tasks?view=mine" "$ACCT"
expect_jq "[.rows[] | select(.title == \"$M20_TAG person\")] | length == 1" "acct has one task from the rule"
expect_jq "[.rows[] | select(.title == \"$M20_TAG person\")][0] | .dueDate == \"$M20_TODAY\" and .recurring == true and .overdue == false and .assignee.id == $M20_ACCT_ID" "the task's due date and recurring flag"
M20_PT=$(jqr "[.rows[] | select(.title == \"$M20_TAG person\")][0].id")
req GET "/api/notifications?limit=50" "$ACCT"
expect_jq "[.rows[] | select(.kind == \"task.assigned\" and .link == \"/tasks.html?task=$M20_PT\")] | length == 1" "acct got one alert for it"
req GET "/api/tasks?view=mine" "$DPM"
expect_jq "[.rows[] | select(.title == \"$M20_TAG person\")] | length == 0" "dpm doesn't get acct's task in Mine"

echo "--- a department's rule with lead days: one shared task ---"
req POST /api/recurring "$ADMIN" "{\"title\":\"$M20_TAG dept\",\"dept\":\"design\",\"repeat\":\"custom\",\"repeatEvery\":7,\"repeatUnit\":\"day\",\"startDate\":\"$M20_D3\",\"leadDays\":3}"
expect_status 201 "admin adds a Projects rule due in 3 days, shown 3 days before"
expect_jq '.deptLabel == "Projects" and .made == 1 and .leadDays == 3 and .repeatText == "Every 7 days"' "made today, 3 days ahead"
M20_DR=$(jqr '.id')
req POST /api/recurring "$ADMIN" "{\"title\":\"$M20_TAG late\",\"dept\":\"design\",\"repeat\":\"weekly\",\"startDate\":\"$M20_D4\",\"leadDays\":3}"
expect_status 201 "a Projects rule due in 4 days, shown 3 days before"
expect_jq '.made == 0 and .nextShows != null' "not made yet: its show day is tomorrow"
M20_LR=$(jqr '.id')
req GET "/api/tasks?view=mine" "$DPM"
expect_jq "[.rows[] | select(.title == \"$M20_TAG dept\")] | length == 1" "dpm sees the one shared Projects task"
expect_jq "[.rows[] | select(.title == \"$M20_TAG dept\")][0] | .team == \"design\" and .assignee.name == \"Projects team\" and .recurring == true and .dueDate == \"$M20_D3\" and .id >= 2000000000" "it is the team's, due in 3 days"
expect_jq "[.rows[] | select(.title == \"$M20_TAG late\")] | length == 0" "the 4-day rule made nothing yet"
M20_DT=$(jqr "[.rows[] | select(.title == \"$M20_TAG dept\")][0].id")
req GET "/api/tasks?view=mine" "$ACCT"
expect_jq "[.rows[] | select(.title == \"$M20_TAG dept\")] | length == 0" "acct (not in Projects) doesn't see it"
req GET "/api/tasks/$M20_DT" "$ACCT"
expect_status 404 "acct GET the Projects task"
req GET "/api/notifications?limit=50" "$DPM"
expect_jq "[.rows[] | select(.link == \"/tasks.html?task=$M20_DT\")] | length == 1" "dpm got an alert for it"

echo "--- no duplicates on a second run ---"
req POST /api/recurring/run "$ADMIN" '{}'
expect_status 200 "run again"
expect_jq '.made == 0' "nothing more made today"
req GET "/api/tasks?view=open" "$ADMIN"
expect_jq "([.rows[] | select(.title == \"$M20_TAG person\")] | length == 1) and ([.rows[] | select(.title == \"$M20_TAG dept\")] | length == 1)" "still one of each"

echo "--- run as of tomorrow: the 4-day rule is made, the weekly person one not yet ---"
req POST /api/recurring/run "$ADMIN" "{\"today\":\"$M20_D1\"}"
expect_status 200 "run as of tomorrow"
req GET "/api/tasks?view=mine" "$DPM"
expect_jq "[.rows[] | select(.title == \"$M20_TAG late\")] | length == 1" "the 4-day rule's task is made on its show day"
req GET "/api/recurring/$M20_P" "$ADMIN"
expect_jq '.made == 1' "the weekly person rule has still made one"

echo "--- overdue: not ticked by its due date, it stays open in red; the next one still comes ---"
req GET "/api/tasks/$M20_PT" "$ACCT"
M20_U=$(jqr '.updatedAt')
req PATCH "/api/tasks/$M20_PT" "$ADMIN" "{\"dueDate\":\"$M20_YDAY\",\"updatedAt\":\"$M20_U\"}"
expect_status 200 "move the person task's due date to yesterday"
expect_jq '.overdue == true and .status == "open"' "it is overdue and still open"
req POST /api/recurring/run "$ADMIN" "{\"today\":\"$M20_D7\"}"
expect_status 200 "run as of a week on"
req GET "/api/tasks?view=mine" "$ACCT"
expect_jq "[.rows[] | select(.title == \"$M20_TAG person\")] | length == 2" "the next week's task is made too"
expect_jq "[.rows[] | select(.title == \"$M20_TAG person\" and .overdue)] | length == 1" "the old one is still the overdue one"

echo "--- the Planner: each occurrence on its due date ---"
req GET "/api/planner/events?from=$M20_YDAY&to=$M20_D14" "$ACCT"
expect_status 200 "acct reads the planner"
expect_jq "[.events[] | select(.source == \"recurring_task\" and .title == \"$M20_TAG person\")] | length == 3" "acct's three: yesterday (moved), next week (made) and the week after (planned)"
expect_jq "[.events[] | select(.source == \"recurring_task\" and .title == \"$M20_TAG person\" and .start == \"$M20_YDAY\")][0] | .layer == \"personal\" and .overdue == true and .allDay == true and .link == \"/tasks.html?task=$M20_PT\"" "the overdue one on Personal, in red"
expect_jq "[.events[] | select(.source == \"task_due\" and .link == \"/tasks.html?task=$M20_PT\")] | length == 0" "not shown twice as a plain task due"
expect_jq "[.events[] | select(.title == \"$M20_TAG dept\")] | length == 0" "acct sees no Projects items"
req GET "/api/planner/events?from=$M20_TODAY&to=$M20_D14" "$DPM"
expect_jq "[.events[] | select(.title == \"$M20_TAG dept\" and .start == \"$M20_D3\")][0] | .layer == \"design_pm\" and .overdue == false" "the Projects one on the Projects layer"
expect_jq "[.events[] | select(.title == \"$M20_TAG dept\")] | length == 2" "and its next one, worked out from the rule"
expect_jq "[.events[] | select(.title == \"$M20_TAG person\")] | length == 0" "dpm doesn't see acct's personal ones"

echo "--- ticked once for all ---"
req POST "/api/tasks/$M20_DT/done" "$DPM" '{}'
expect_status 200 "dpm ticks the Projects task"
req GET "/api/tasks/$M20_DT" "$ADMIN"
expect_jq '.status == "done"' "done for everyone"
req GET "/api/planner/events?from=$M20_D3&to=$M20_D3" "$DPM"
expect_jq "[.events[] | select(.title == \"Done: $M20_TAG dept\")] | length == 1" "the planner shows it done"

echo "--- pause stops it; resume starts from today; delete keeps the tasks made ---"
req GET "/api/recurring/$M20_DR" "$ADMIN"
M20_MADE=$(jqr '.made')
req POST "/api/recurring/$M20_DR/pause" "$ADMIN" '{}'
expect_status 200 "pause the Projects rule"
expect_jq '.active == false and .nextDue == null' "paused"
req POST /api/recurring/run "$ADMIN" "{\"today\":\"$M20_D14\"}"
req GET "/api/recurring/$M20_DR" "$ADMIN"
expect_jq ".made == $M20_MADE" "nothing made while paused"
req POST "/api/recurring/$M20_DR/resume" "$ADMIN" '{}'
expect_status 200 "resume"
expect_jq '.active == true' "active again"
req DELETE "/api/recurring/$M20_P" "$ADMIN"
expect_status 204 "delete the person rule"
req GET "/api/recurring/$M20_P" "$ADMIN"
expect_status 404 "it is gone"
req GET "/api/tasks/$M20_PT" "$ACCT"
expect_status 200 "its tasks stay"
# The paused-period run as of +14 days made the person rule's third (it was still active then).
req POST /api/recurring/run "$ADMIN" "{\"today\":\"$M20_D21\"}"
req GET "/api/tasks?view=mine" "$ACCT"
expect_jq "[.rows[] | select(.title == \"$M20_TAG person\")] | length == 3" "no more made after the delete"
req DELETE "/api/recurring/$M20_DR" "$ADMIN"; expect_status 204 "tidy: delete the Projects rule"
req DELETE "/api/recurring/$M20_LR" "$ADMIN"; expect_status 204 "tidy: delete the 4-day rule"

echo "--- every write is audited ---"
req GET "/api/audit?entityType=recurring_task&limit=200" "$ADMIN"
expect_status 200 "admin reads the audit"
expect_jq "[.rows[] | select((.entityId | tostring) == \"$M20_DR\") | .action] | (index(\"recurring_task.create\") != null and index(\"recurring_task.pause\") != null and index(\"recurring_task.resume\") != null and index(\"recurring_task.delete\") != null)" "create, pause, resume and delete are in the audit"
