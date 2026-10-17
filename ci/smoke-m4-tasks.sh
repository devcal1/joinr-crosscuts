# M4 smoke, Wave 1 A: tasks, comments, follows, task attachments and the morning reminder.
# Sourced by ci/smoke.sh after the M3 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, hdr, fail, ok), the cookie jars
# ($ADMIN $SCHED $ACCT $DPM $SHOW), $BASE, $WORK, $BODY_FILE, $HDR_FILE, $REQ_ORIGIN and
# $CONTAINER. No shebang and no `set`: the caller owns both. It does not assume a pristine
# database: it makes its own tasks and checks only those rows.
# Contract: docs/plans/m4-contracts.md section 9.

# ============================================================================
step "m4-a. tasks, comments and the reminder"
# ============================================================================

M4A_TODAY=$(TZ=Australia/Sydney date +%F)
M4A_YESTERDAY=$(date -u -d "$M4A_TODAY - 1 day" +%F)

# The user id behind a cookie jar -> M4A_UID.
m4a_uid() { # JAR
  req GET /api/auth/me "$1"
  expect_status 200 "GET /api/auth/me"
  M4A_UID=$(jqr '.user.id')
}

m4a_uid "$ADMIN"; M4A_ADMIN_ID=$M4A_UID
m4a_uid "$ACCT"; M4A_ACCT_ID=$M4A_UID
m4a_uid "$DPM"; M4A_DPM_ID=$M4A_UID

# How many notifications of KIND that JAR's user has for the task (or job) LINK_PREFIX,
# unread only when UNREAD is 1 -> M4A_N.
m4a_notifs() { # JAR KIND LINK_PREFIX [UNREAD 0|1]
  req GET "/api/notifications?limit=100" "$1"
  expect_status 200 "GET /api/notifications"
  if [ "${4:-0}" = 1 ]; then
    M4A_N=$(jqr "[.rows[] | select(.kind == \"$2\" and (.link == \"$3\" or ((.link // \"\") | startswith(\"$3#\"))) and .readAt == null)] | length")
  else
    M4A_N=$(jqr "[.rows[] | select(.kind == \"$2\" and (.link == \"$3\" or ((.link // \"\") | startswith(\"$3#\"))))] | length")
  fi
}

# Marks every comment.new alert for LINK_PREFIX read, as JAR.
m4a_read_comment_alerts() { # JAR LINK_PREFIX
  req GET "/api/notifications?limit=100" "$1"
  expect_status 200 "GET /api/notifications"
  local ids id
  ids=$(jqr "[.rows[] | select(.kind == \"comment.new\" and (.link == \"$2\" or ((.link // \"\") | startswith(\"$2#\")))) | .id] | .[]")
  for id in $ids; do
    req POST "/api/notifications/$id/read" "$1"
    expect_status 204 "mark alert $id read"
  done
}

# A task made by JAR for ASSIGNEE_ID with extra JSON fields -> M4A_TASK (id), BODY is the task.
m4a_task() { # JAR TITLE ASSIGNEE_ID [EXTRA_JSON_FIELDS e.g. ',"dueDate":"2030-01-01"']
  req POST /api/tasks "$1" "{\"title\":\"$2\",\"assigneeId\":$3${4:-}}"
  expect_status 201 "create task $2"
  M4A_TASK=$(jqr '.id')
}

# Uploads FILE as NAME (declared TYPE) to the task as JAR; sets STATUS and BODY.
m4a_upload() { # JAR TASK_ID FILE NAME TYPE
  LAST_REQ="POST /api/tasks/$2/files ($4)"
  STATUS=$(curl -s -o "$BODY_FILE" -D "$HDR_FILE" -w '%{http_code}' -X POST -H "Origin: $REQ_ORIGIN" \
    -b "$1" -c "$1" -F "file=@$3;filename=$4;type=$5" "$BASE/api/tasks/$2/files")
  BODY=$(cat "$BODY_FILE")
}

echo "--- access ---"
req GET /api/tasks "$SHOW"
expect_status 403 "show GET /api/tasks"
req POST /api/tasks "$SHOW" "{\"title\":\"x\",\"assigneeId\":$M4A_ADMIN_ID}"
expect_status 403 "show POST /api/tasks"
req GET "/api/comments?entityType=job&entityId=1" "$SHOW"
expect_status 403 "show GET /api/comments"
req POST /api/tasks/reminder/run "$ACCT"
expect_status 403 "acct POST /api/tasks/reminder/run"
req GET /tasks.html "$DPM"
expect_status 200 "dpm GET /tasks.html"
req GET /tasks.html "$SHOW"
expect_status 403 "show GET /tasks.html"

echo "--- create and alerts ---"
req POST /api/job-records "$ADMIN" '{"name":"CI M4 Tasks Job","clientName":"CI M4 Client","valueCents":100000}'
expect_status 201 "create the job"
M4A_JOB=$(jqr '.id')

req POST /api/tasks "$ACCT" "{\"title\":\"\",\"assigneeId\":$M4A_ADMIN_ID}"
expect_status 400 "an empty title"
req POST /api/tasks "$ACCT" "{\"title\":\"x\",\"assigneeId\":$M4A_ADMIN_ID,\"dueDate\":\"2030-02-31\"}"
expect_status 400 "an impossible date"
req POST /api/tasks "$ACCT" "{\"title\":\"x\",\"assigneeId\":$M4A_ADMIN_ID,\"jobId\":99999999}"
expect_status 400 "a job that does not exist"

m4a_task "$ACCT" "CI chase the supplier" "$M4A_ADMIN_ID" ",\"jobId\":$M4A_JOB,\"dueDate\":\"$M4A_YESTERDAY\",\"notes\":\"CI notes\""
M4A_T1=$M4A_TASK
expect_jq ".status == \"open\" and .overdue == true and .assignee.id == $M4A_ADMIN_ID and .job.id == $M4A_JOB and .canEdit == true and .following == true" "the new task"
M4A_T1_UPDATED=$(jqr '.updatedAt')

m4a_notifs "$ADMIN" task.assigned "/tasks.html?task=$M4A_T1" 1
expect_eq "$M4A_N" 1 "admin has one unread task.assigned linking the task"
m4a_notifs "$ACCT" task.assigned "/tasks.html?task=$M4A_T1"
expect_eq "$M4A_N" 0 "acct (the creator) has no task.assigned"
req GET /api/notifications/unread-count "$ADMIN"
expect_status 200 "admin unread-count"
expect_jq '.tasks >= 1 and .tasksOverdue >= 1' "admin's menu bar counts include the overdue task"

m4a_task "$ACCT" "CI self-assigned" "$M4A_ACCT_ID"
m4a_notifs "$ACCT" task.assigned "/tasks.html?task=$M4A_TASK"
expect_eq "$M4A_N" 0 "assigning to yourself sends no alert"

echo "--- visibility and views ---"
req GET "/api/tasks?view=open" "$SCHED"
expect_status 200 "sched GET /api/tasks?view=open"
expect_jq "[.rows[] | select(.id == $M4A_T1)] | length == 1" "sched sees every open task"
req GET "/api/tasks?view=mine" "$ADMIN"
expect_status 200 "admin GET /api/tasks (mine)"
expect_jq "[.rows[] | select(.id == $M4A_T1)] | length == 1" "the task is in admin's Mine"
req GET "/api/tasks?view=raised" "$ACCT"
expect_jq "[.rows[] | select(.id == $M4A_T1)] | length == 1" "the task is in acct's Raised by me"
req GET "/api/tasks?view=job&jobId=$M4A_JOB" "$SCHED"
expect_status 200 "the job view"
expect_jq "[.rows[].id] | index($M4A_T1) != null" "the job's task list has the task"
req GET "/api/tasks?view=job" "$SCHED"
expect_status 400 "the job view needs jobId"
req GET "/api/tasks?view=nonsense" "$SCHED"
expect_status 400 "an unknown view"
req GET /api/tasks/99999999 "$SCHED"
expect_status 404 "a task that does not exist"

echo "--- edit rules and the stale check ---"
req PATCH "/api/tasks/$M4A_T1" "$SCHED" "{\"updatedAt\":\"$M4A_T1_UPDATED\",\"title\":\"hijacked\"}"
expect_status 403 "sched (not the creator or assignee) PATCH"
req PATCH "/api/tasks/$M4A_T1" "$ADMIN" "{\"updatedAt\":\"$M4A_T1_UPDATED\",\"title\":\"CI chase the supplier (edited)\"}"
expect_status 200 "admin PATCH with the right updatedAt"
expect_jq '.title == "CI chase the supplier (edited)" and .updatedAt != null' "the edit is saved"
M4A_T1_NEW=$(jqr '.updatedAt')
req PATCH "/api/tasks/$M4A_T1" "$ACCT" "{\"updatedAt\":\"$M4A_T1_UPDATED\",\"notes\":\"stale\"}"
expect_status 409 "acct PATCH with the old updatedAt"
expect_jq ".task.id == $M4A_T1 and .task.title == \"CI chase the supplier (edited)\" and (.error | length > 0)" "the stale 409 carries the current task"
req PATCH "/api/tasks/$M4A_T1" "$ACCT" '{"title":"no updatedAt"}'
expect_status 400 "PATCH without updatedAt"

echo "--- status ---"
req POST "/api/tasks/$M4A_T1/done" "$ADMIN"
expect_status 200 "admin marks it done"
expect_jq ".status == \"done\" and .doneBy.id == $M4A_ADMIN_ID and .doneAt != null" "done records who and when"
m4a_notifs "$ACCT" task.done "/tasks.html?task=$M4A_T1"
expect_eq "$M4A_N" 1 "acct (the creator) gets task.done"
req POST "/api/tasks/$M4A_T1/done" "$ADMIN"
expect_status 409 "done again"
req POST "/api/tasks/$M4A_T1/reopen" "$SCHED"
expect_status 200 "sched reopens it"
expect_jq '.status == "open" and .doneAt == null and .doneBy == null' "reopen clears done"
m4a_notifs "$ADMIN" task.reopened "/tasks.html?task=$M4A_T1"
expect_eq "$M4A_N" 1 "admin (the assignee) gets task.reopened"
req POST "/api/tasks/$M4A_T1/reopen" "$SCHED"
expect_status 409 "reopen a task that is open"
req POST "/api/tasks/$M4A_T1/cancel" "$SCHED"
expect_status 403 "sched cancel (not the creator)"
req POST "/api/tasks/$M4A_T1/cancel" "$ACCT"
expect_status 200 "acct (the creator) cancels"
expect_jq '.status == "cancelled"' "the task is cancelled"
M4A_T1_CLOSED=$(jqr '.updatedAt')
req PATCH "/api/tasks/$M4A_T1" "$ACCT" "{\"updatedAt\":\"$M4A_T1_CLOSED\",\"title\":\"closed\"}"
expect_status 409 "PATCH a cancelled task"
req POST "/api/tasks/$M4A_T1/reopen" "$SCHED"
expect_status 409 "a cancelled task cannot be reopened"
req GET "/api/tasks?view=done" "$SCHED"
expect_jq "[.rows[] | select(.id == $M4A_T1)] | length == 1" "the Done view lists the cancelled task"
req GET "/api/audit?entityType=task&entityId=$M4A_T1&limit=50" "$ADMIN"
expect_status 200 "GET /api/audit for the task"
expect_jq '[.rows[].action] | (index("task.create") != null and index("task.update") != null and index("task.done") != null and index("task.reopen") != null and index("task.cancel") != null)' "every task change is audited"

echo "--- comments and follows ---"
m4a_task "$ACCT" "CI comment target" "$M4A_DPM_ID"
M4A_T2=$M4A_TASK
req POST /api/comments "$DPM" "{\"entityType\":\"task\",\"entityId\":$M4A_T2,\"body\":\"First comment <b>not bold</b> https://example.com/a\"}"
expect_status 201 "dpm comments on the task"
expect_jq ".author.id == $M4A_DPM_ID and .canRemove == true and .removed == false" "the new comment"
M4A_C1=$(jqr '.id')
m4a_notifs "$ACCT" comment.new "/tasks.html?task=$M4A_T2" 1
expect_eq "$M4A_N" 1 "acct (a follower) gets one comment.new"
m4a_notifs "$DPM" comment.new "/tasks.html?task=$M4A_T2"
expect_eq "$M4A_N" 0 "the author gets no alert"
req POST /api/comments "$DPM" "{\"entityType\":\"task\",\"entityId\":$M4A_T2,\"body\":\"Second comment\"}"
expect_status 201 "dpm comments again"
m4a_notifs "$ACCT" comment.new "/tasks.html?task=$M4A_T2" 1
expect_eq "$M4A_N" 1 "still exactly one unread comment.new (dedupe)"
req POST /api/comments "$ACCT" "{\"entityType\":\"task\",\"entityId\":$M4A_T2,\"body\":\"   \"}"
expect_status 400 "an empty comment"
req POST /api/comments "$ACCT" "{\"entityType\":\"task\",\"entityId\":$M4A_T2,\"body\":\"$(printf 'x%.0s' $(seq 1 4001))\"}"
expect_status 400 "a 4,001 character comment"
req POST /api/comments "$ACCT" "{\"entityType\":\"task\",\"entityId\":99999999,\"body\":\"x\"}"
expect_status 404 "a comment on a task that does not exist"
req GET "/api/comments?entityType=task&entityId=$M4A_T2" "$ACCT"
expect_status 200 "acct GET /api/comments"
expect_jq '.following == true and (.rows | length) == 2 and .rows[0].id < .rows[1].id' "oldest first, and acct follows"

m4a_read_comment_alerts "$ACCT" "/tasks.html?task=$M4A_T2"
req POST /api/comments/unfollow "$ACCT" "{\"entityType\":\"task\",\"entityId\":$M4A_T2}"
expect_status 204 "acct unfollows"
req GET "/api/comments?entityType=task&entityId=$M4A_T2" "$ACCT"
expect_jq '.following == false' "acct no longer follows"
req POST /api/comments "$DPM" "{\"entityType\":\"task\",\"entityId\":$M4A_T2,\"body\":\"Third comment\"}"
expect_status 201 "dpm comments after the unfollow"
m4a_notifs "$ACCT" comment.new "/tasks.html?task=$M4A_T2" 1
expect_eq "$M4A_N" 0 "no new comment.new for the unfollower"
req POST /api/comments/follow "$ACCT" "{\"entityType\":\"task\",\"entityId\":$M4A_T2}"
expect_status 204 "acct follows again"
req POST /api/comments/follow "$ACCT" "{\"entityType\":\"task\",\"entityId\":$M4A_T2}"
expect_status 204 "following twice is fine"

req POST /api/comments "$SCHED" "{\"entityType\":\"job\",\"entityId\":$M4A_JOB,\"body\":\"A job comment\"}"
expect_status 201 "sched (messages.use) comments on a job"
req POST /api/comments "$SHOW" "{\"entityType\":\"job\",\"entityId\":$M4A_JOB,\"body\":\"nope\"}"
expect_status 403 "show comments on a job"
req GET "/api/comments?entityType=job&entityId=$M4A_JOB" "$ACCT"
expect_status 200 "acct reads the job's comments"
expect_jq '(.rows | length) >= 1' "the job comment is listed"
req POST /api/comments "$ACCT" "{\"entityType\":\"job\",\"entityId\":$M4A_JOB,\"body\":\"A reply\"}"
expect_status 201 "acct replies on the job"
m4a_notifs "$SCHED" comment.new "/job.html?id=$M4A_JOB" 1
expect_eq "$M4A_N" 1 "sched (a follower) gets one comment.new linking the job"

req DELETE "/api/comments/$M4A_C1" "$ACCT"
expect_status 403 "acct removes dpm's comment"
req DELETE "/api/comments/$M4A_C1" "$DPM"
expect_status 204 "dpm removes their own comment"
req GET "/api/comments?entityType=task&entityId=$M4A_T2" "$ACCT"
expect_jq "[.rows[] | select(.id == $M4A_C1)][0] | (.removed == true and .body == null and .canRemove == false)" "a removed comment has no body"
req DELETE "/api/comments/$M4A_C1" "$DPM"
expect_status 409 "removing it again"
req GET "/api/audit?action=comment.remove&entityType=comment&entityId=$M4A_C1&limit=5" "$ADMIN"
expect_jq '.total >= 1' "the removal is audited"

echo "--- attachments ---"
printf '%s\n' '%PDF-1.4' '1 0 obj' '<< >>' 'endobj' 'trailer' '<< >>' '%%EOF' > "$WORK/m4a-test.pdf"
printf '<!doctype html><script>alert(1)</script>\n' > "$WORK/m4a-evil.html"
printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n' > "$WORK/m4a-evil.svg"
printf '%s' "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" | base64 -d > "$WORK/m4a-fake.pdf"

m4a_upload "$ACCT" "$M4A_T2" "$WORK/m4a-test.pdf" "CI spec sheet.pdf" application/pdf
expect_status 201 "acct uploads a PDF to the task"
expect_jq '(.files | length) == 1 and .files[0].name == "CI spec sheet.pdf" and .files[0].mime == "application/pdf"' "the task lists the file"
M4A_FILE=$(jqr '.files[0].id')
req GET "/api/files/$M4A_FILE" "$SCHED"
expect_status 200 "sched downloads the task file"
expect_eq "$(hdr content-type)" "application/pdf" "the PDF's Content-Type"
expect_eq "$(hdr x-content-type-options)" "nosniff" "nosniff on the download"
expect_eq "$(hdr cache-control)" "private, no-store" "no caching of the download"
req GET "/api/files/$M4A_FILE" "$SHOW"
expect_status 404 "show cannot download it (404, not 403)"
m4a_upload "$ACCT" "$M4A_T2" "$WORK/m4a-evil.html" "evil.html" text/html
expect_status 400 "an .html upload"
m4a_upload "$ACCT" "$M4A_T2" "$WORK/m4a-evil.svg" "evil.svg" image/svg+xml
expect_status 400 "an .svg upload"
m4a_upload "$ACCT" "$M4A_T2" "$WORK/m4a-fake.pdf" "fake.pdf" application/pdf
expect_status 400 "a PNG named .pdf"
m4a_upload "$SHOW" "$M4A_T2" "$WORK/m4a-test.pdf" "show.pdf" application/pdf
expect_status 403 "show uploads to a task"
m4a_upload "$SCHED" "$M4A_T2" "$WORK/m4a-test.pdf" "sched.pdf" application/pdf
expect_status 403 "sched (not the creator or assignee) uploads to a task"
m4a_upload "$ACCT" "$M4A_T1" "$WORK/m4a-test.pdf" "closed.pdf" application/pdf
expect_status 409 "upload to a cancelled task"
parts=$(docker exec "$CONTAINER" sh -c 'ls /data/uploads/files | grep -c "\.part$" || true')
expect_eq "$parts" 0 "no .part files left in uploads/files after the refusals"
req DELETE "/api/tasks/$M4A_T2/files/$M4A_FILE" "$SCHED"
expect_status 403 "sched removes the attachment"
req DELETE "/api/tasks/$M4A_T2/files/$M4A_FILE" "$ACCT"
expect_status 200 "the uploader removes the attachment"
expect_jq '(.files | length) == 0' "the task has no files"
req GET "/api/files/$M4A_FILE" "$SCHED"
expect_status 404 "a removed file is 404"

echo "--- the morning reminder ---"
m4a_task "$ACCT" "CI due today" "$M4A_ADMIN_ID" ",\"dueDate\":\"$M4A_TODAY\""
req POST /api/tasks/reminder/run "$ADMIN"
expect_status 200 "admin forces the reminder"
expect_jq '.sent >= 1 and (.date | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))' "the reminder reports who it told"
req GET "/api/notifications?limit=100" "$ADMIN"
expect_jq '[.rows[] | select(.kind == "task.reminder" and .link == "/tasks.html?view=mine")] | length >= 1' "admin has a task.reminder linking Mine"

# The time rule (weekdays, 07:00 Sydney, once a day), on fixed instants.
m4a_due() { # ISO_INSTANT LAST_RUN|null
  docker exec "$CONTAINER" node -e '
const t = require("/app/lib/tasks.js");
const last = process.argv[2] === "null" ? null : process.argv[2];
const v = t.reminderDue(new Date(process.argv[1]), last);
console.log(v === null ? "null" : v);
' "$1" "$2"
}
expect_eq "$(m4a_due 2026-10-11T19:59:00Z null)" "null" "Monday 06:59 Sydney is too early"
expect_eq "$(m4a_due 2026-10-11T20:00:00Z null)" "2026-10-12" "Monday 07:00 Sydney runs"
expect_eq "$(m4a_due 2026-10-11T20:00:00Z 2026-10-12)" "null" "it has already run today"
expect_eq "$(m4a_due 2026-10-16T23:00:00Z null)" "null" "Saturday does not run"
expect_eq "$(m4a_due 2026-10-17T23:00:00Z null)" "null" "Sunday does not run"

# ============================================================================
step "m4-team. team tasks: a task for the whole Design/PM team (2026-10-18)"
# ============================================================================
# The team is whoever holds notes.design and tasks.use: admin and dpm here. acct and sched are not on
# it. A team task lives in team_tasks (migration 032) with an id of 1000000000 or more; every
# member sees it, whoever finishes it closes it for all, and non-members get a 404.

echo "--- raising one ---"
req POST /api/tasks "$ACCT" '{"title":"CI team task by a non-member","team":"design"}'
expect_status 403 "acct (not on the team) cannot raise a team task"
req POST /api/tasks "$DPM" "{\"title\":\"both\",\"team\":\"design\",\"assigneeId\":$M4A_ADMIN_ID}"
expect_status 400 "a person and the team together"
req POST /api/tasks "$DPM" '{"title":"x","team":"scheduling"}'
expect_status 400 "an unknown team"
req POST /api/tasks "$DPM" '{"title":"","team":"design"}'
expect_status 400 "an empty title"
req POST /api/tasks "$DPM" "{\"title\":\"CI team: check the drawings\",\"team\":\"design\",\"jobId\":$M4A_JOB,\"dueDate\":\"$M4A_YESTERDAY\",\"notes\":\"CI team notes\"}"
expect_status 201 "dpm raises a team task"
expect_jq ".team == \"design\" and .assignee.id == null and .assignee.name == \"Design/PM team\" and .createdBy.id == $M4A_DPM_ID and .status == \"open\" and .overdue == true and .job.id == $M4A_JOB and .canEdit == true and .files == []" "the new team task"
M4T=$(jqr '.id')
[ "$M4T" -ge 1000000000 ] || fail "a team task id is 1000000000 or more, got $M4T"
ok
M4T_UPDATED=$(jqr '.updatedAt')

echo "--- who sees it ---"
req GET "/api/tasks?view=mine" "$ADMIN"
expect_jq "[.rows[] | select(.id == $M4T)] | length == 1" "it is in admin's Mine (a member who did not raise it)"
req GET "/api/tasks?view=mine" "$DPM"
expect_jq "[.rows[] | select(.id == $M4T)] | length == 1" "it is in the creator's Mine too"
req GET "/api/tasks?view=raised" "$DPM"
expect_jq "[.rows[] | select(.id == $M4T)] | length == 1" "it is in dpm's Raised by me"
req GET "/api/tasks?view=raised" "$ADMIN"
expect_jq "[.rows[] | select(.id == $M4T)] | length == 0" "it is not in admin's Raised by me"
req GET "/api/tasks?view=open" "$ADMIN"
expect_jq "[.rows[] | select(.id == $M4T)] | length == 1" "it is in All open for a member"
req GET "/api/tasks?view=job&jobId=$M4A_JOB" "$ADMIN"
expect_jq "[.rows[] | select(.id == $M4T)] | length == 1" "it is on the job's task list for a member"
for pair in "ACCT:$ACCT" "SCHED:$SCHED"; do
  who=${pair%%:*}; jar=${pair#*:}
  for v in mine open raised; do
    req GET "/api/tasks?view=$v" "$jar"
    expect_status 200 "$who GET /api/tasks?view=$v"
    expect_jq "[.rows[] | select(.id == $M4T)] | length == 0" "$who does not see it in $v"
  done
  req GET "/api/tasks?view=job&jobId=$M4A_JOB" "$jar"
  expect_jq "[.rows[] | select(.id == $M4T)] | length == 0" "$who does not see it on the job's task list"
  req GET "/api/tasks/$M4T" "$jar"
  expect_status 404 "$who GET it by id"
  req PATCH "/api/tasks/$M4T" "$jar" "{\"updatedAt\":\"$M4T_UPDATED\",\"title\":\"hijacked\"}"
  expect_status 404 "$who PATCH it"
  req POST "/api/tasks/$M4T/done" "$jar"
  expect_status 404 "$who cannot finish it"
  req GET "/api/comments?entityType=task&entityId=$M4T" "$jar"
  expect_status 404 "$who cannot read its comments"
  req POST /api/comments "$jar" "{\"entityType\":\"task\",\"entityId\":$M4T,\"body\":\"nope\"}"
  expect_status 404 "$who cannot comment on it"
done
req GET "/api/tasks/$M4T" "$SHOW"
expect_status 403 "show GET it by id (no tasks.use)"

echo "--- alerts and counts ---"
m4a_notifs "$ADMIN" task.assigned "/tasks.html?task=$M4T" 1
expect_eq "$M4A_N" 1 "admin (a member) has one unread task.assigned linking the task"
m4a_notifs "$DPM" task.assigned "/tasks.html?task=$M4T"
expect_eq "$M4A_N" 0 "the creator is not alerted about their own task"
m4a_notifs "$ACCT" task.assigned "/tasks.html?task=$M4T"
expect_eq "$M4A_N" 0 "acct (not a member) is not alerted"
req GET /api/notifications/unread-count "$ADMIN"
expect_jq '.tasks >= 1 and .tasksOverdue >= 1' "admin's menu bar counts include the overdue team task"
M4T_ADMIN_OPEN=$(jqr '.tasks')
req GET /api/notifications/unread-count "$ACCT"
M4T_ACCT_OPEN=$(jqr '.tasks')
m4a_task "$DPM" "CI personal task for counts" "$M4A_ADMIN_ID"
req GET /api/notifications/unread-count "$ADMIN"
expect_eq "$(jqr '.tasks')" "$((M4T_ADMIN_OPEN + 1))" "a personal task adds one to admin's count"
req GET /api/notifications/unread-count "$ACCT"
expect_eq "$(jqr '.tasks')" "$M4T_ACCT_OPEN" "and none to acct's"

echo "--- edit rules (any member), the stale check, no assignee, no files ---"
req PATCH "/api/tasks/$M4T" "$ADMIN" "{\"updatedAt\":\"$M4T_UPDATED\",\"title\":\"CI team: check the drawings (edited)\"}"
expect_status 200 "admin (a member, not the creator) edits it"
expect_jq '.title == "CI team: check the drawings (edited)"' "the edit is saved"
req PATCH "/api/tasks/$M4T" "$DPM" "{\"updatedAt\":\"$M4T_UPDATED\",\"notes\":\"stale\"}"
expect_status 409 "an edit with the old updatedAt"
expect_jq ".task.id == $M4T and .task.team == \"design\"" "the stale 409 carries the current task"
M4T_UPDATED=$(jqr '.task.updatedAt')
req PATCH "/api/tasks/$M4T" "$DPM" "{\"updatedAt\":\"$M4T_UPDATED\",\"assigneeId\":$M4A_ADMIN_ID}"
expect_status 400 "a team task cannot be given to one person"
req PATCH "/api/tasks/$M4T" "$DPM" "{\"updatedAt\":\"$M4T_UPDATED\",\"dueDate\":null}"
expect_status 200 "the due date can be cleared"
expect_jq '.dueDate == null and .overdue == false' "no due date now"
M4T_UPDATED=$(jqr '.updatedAt')
m4a_upload "$DPM" "$M4T" "$WORK/m4a-test.pdf" "team.pdf" application/pdf
expect_status 400 "a team task takes no files"
req POST /api/comments "$DPM" "{\"entityType\":\"task\",\"entityId\":$M4T,\"body\":\"CI team comment\"}"
expect_status 201 "a member comments on it"
m4a_notifs "$ADMIN" comment.new "/tasks.html?task=$M4T" 1
expect_eq "$M4A_N" 1 "every other member is alerted to a comment (admin never followed it)"
req GET "/api/comments?entityType=task&entityId=$M4T" "$ADMIN"
expect_jq '(.rows | length) == 1' "admin reads the thread"

echo "--- whoever finishes it closes it for everyone ---"
req POST "/api/tasks/$M4T/done" "$ADMIN"
expect_status 200 "admin ticks it done"
expect_jq ".status == \"done\" and .doneBy.id == $M4A_ADMIN_ID and .doneAt != null" "done records who and when"
req GET "/api/tasks?view=mine" "$DPM"
expect_jq "[.rows[] | select(.id == $M4T)] | length == 0" "it is gone from dpm's Mine"
req GET "/api/tasks?view=done" "$DPM"
expect_jq "[.rows[] | select(.id == $M4T)] | length == 1" "dpm finds it in Done"
req POST "/api/tasks/$M4T/done" "$DPM"
expect_status 409 "ticking it a second time"
m4a_notifs "$DPM" task.done "/tasks.html?task=$M4T"
expect_eq "$M4A_N" 1 "the creator is told it was finished"
req POST "/api/tasks/$M4T/reopen" "$DPM"
expect_status 200 "dpm reopens it"
expect_jq '.status == "open" and .doneBy == null and .doneAt == null' "reopened for everyone"
m4a_notifs "$ADMIN" task.reopened "/tasks.html?task=$M4T"
expect_eq "$M4A_N" 1 "the other members are told it was reopened"
req GET "/api/tasks?view=mine" "$ADMIN"
expect_jq "[.rows[] | select(.id == $M4T)] | length == 1" "it is back in admin's Mine"

echo "--- the morning reminder counts team tasks due ---"
req GET "/api/tasks/$M4T" "$DPM"
M4T_UPDATED=$(jqr '.updatedAt')
req PATCH "/api/tasks/$M4T" "$DPM" "{\"updatedAt\":\"$M4T_UPDATED\",\"dueDate\":\"$M4A_TODAY\"}"
expect_status 200 "the team task is due today"
req POST /api/tasks/reminder/run "$ADMIN"
expect_status 200 "admin forces the reminder"
req GET "/api/notifications?limit=100" "$DPM"
expect_jq '[.rows[] | select(.kind == "task.reminder" and (.body | contains("CI team: check the drawings (edited)")))] | length >= 1' "dpm's reminder lists the team task"
req GET "/api/notifications?limit=100" "$ACCT"
expect_jq '[.rows[] | select(.kind == "task.reminder" and (.body | contains("CI team: check the drawings (edited)")))] | length == 0' "acct's reminder does not"

echo "--- cancel: an admin or the one who raised it; audit ---"
req POST "/api/tasks/$M4T/cancel" "$SCHED"
expect_status 404 "sched cannot cancel it"
req POST "/api/tasks/$M4T/cancel" "$ADMIN"
expect_status 200 "admin cancels it"
expect_jq '.status == "cancelled"' "cancelled"
req GET "/api/audit?entityType=task&entityId=$M4T&limit=50" "$ADMIN"
expect_status 200 "GET /api/audit for the team task"
expect_jq '[.rows[].action] | (index("task.create") != null and index("task.update") != null and index("task.done") != null and index("task.reopen") != null and index("task.cancel") != null)' "every team task change is audited"
