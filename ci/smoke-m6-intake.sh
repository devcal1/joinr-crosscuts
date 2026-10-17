# M6 smoke, Wave 1 A (and B in its marked block): the Joinr intake puller.
# Sourced by ci/smoke.sh after the M5 suites, so it shares that script's helpers
# (step, req, expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie jars
# ($ADMIN $SCHED $ACCT $DPM $SHOW). No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: every quote it sends has its own ids ("CI-M6-...").
# Contract: docs/plans/m6-contracts.md sections 2 to 4 and 8; the wire contract is
# docs/integrations/joinr-crosscuts-intake.md.
#
# A stand-in Joinr (ci/fake-joinr.js) runs inside the container on 127.0.0.1:4999, and
# Crosscuts is pointed at it through files in /data/config. Both files are removed at the
# end, so later suites and the cutover rehearsal (step k) see no Joinr set-up.
#
# The sync timer may fire during this suite (every 5 minutes once a key is set). It shares
# the run lock with POST /sync, so every check below looks at the stored state, not at how
# many items one particular call handled, and forced failures stay on until cleared.

# ============================================================================
step "m6-intake. Joinr puller: sync, status and import against a stand-in Joinr"
# ============================================================================

M6_KEY='ci-joinr-smoke-key-7f3a9c2e5b1d4a68'
M6_LAST4=${M6_KEY: -4}
M6_PORT=4999
M6_BASE_URL="http://127.0.0.1:$M6_PORT"
M6_OUT=""

# m6_fake METHOD PATH [json] -> M6_OUT (the fake's response body). Runs inside the container.
m6_fake() {
  M6_OUT=$(docker exec "$CONTAINER" node -e '
const [m, p, b] = process.argv.slice(1);
fetch("http://127.0.0.1:4999" + p, { method: m, headers: { "content-type": "application/json" }, body: b || undefined })
  .then(async (r) => { process.stdout.write(await r.text()); if (!r.ok) process.exit(1); })
  .catch((e) => { console.error(String(e)); process.exit(1); });' "$1" "$2" "${3:-}") \
    || fail "fake joinr $1 $2 failed: ${M6_OUT:0:300}"
}

# jq -e over M6_OUT must be truthy.
m6_expect_out() { # FILTER WHAT
  printf '%s' "$M6_OUT" | jq -e "$1" >/dev/null || fail "$2: jq '$1' is not true for: ${M6_OUT:0:600}"
  ok
}

# m6_sql SQL -> prints the rows as JSON (read-only connection).
m6_sql() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const db = new D("/data/db/photos.db", { readonly: true });
process.stdout.write(JSON.stringify(db.prepare(process.argv[1]).all()));' "$1"
}

# m6_event ROOT QUOTE EVENT STATUS [extra-json] -> appends an item to the fake (M6_OUT = the item).
m6_event() {
  local extra=${5:-}
  [ -n "$extra" ] || extra='{}'
  m6_fake POST /_control/event "$(jq -nc --arg r "$1" --arg q "$2" --arg e "$3" --arg s "$4" --argjson x "$extra" \
    '{rootQuoteId:$r, quoteId:$q, event:$e, status:$s} + $x')"
}

m6_set_fail() { # MODE-JSON (e.g. 500 or "\"hang\"" or null)
  m6_fake POST /_control/fail "{\"fail\":$1,\"count\":1000}"
}

# m6_sync JAR WHAT: POST /api/joinr/sync twice. If a timer run was in flight, the first call
# returns that run's result (the shared lock), which may predate the event just appended;
# the second call is then a fresh run. Leaves STATUS/BODY of the second call.
m6_sync() {
  req POST /api/joinr/sync "$1" '{}'
  expect_status 200 "$2 (first call)"
  req POST /api/joinr/sync "$1" '{}'
  expect_status 200 "$2"
}

m6_intake_field() { # ROOT FIELD -> the field of that intake record ("null" if none)
  m6_sql "SELECT $2 AS v FROM joinr_intake WHERE root_quote_id = '$1'" | jq -r '.[0].v // "null"'
}

m6_intake_count() { # ROOT
  m6_sql "SELECT COUNT(*) AS n FROM joinr_intake WHERE root_quote_id = '$1'" | jq -r '.[0].n'
}

m6_cursor() {
  m6_sql "SELECT cursor FROM integration_sync WHERE name = 'joinr'" | jq -r '.[0].cursor // "null"'
}

# Joinr quote ids (fixed uuids; one root per quote).
M6_Q0=c6000000-0000-4000-8000-000000000000
M6_Q1=c6000000-0000-4000-8000-000000000001
M6_Q2=c6000000-0000-4000-8000-000000000002
M6_Q3=c6000000-0000-4000-8000-000000000003
M6_Q1B=c6000000-0000-4000-8000-0000000001b1
M6_Q6=c6000000-0000-4000-8000-000000000006
M6_Q7=c6000000-0000-4000-8000-000000000007
M6_Q8=c6000000-0000-4000-8000-000000000008
M6_Q10=c6000000-0000-4000-8000-000000000010

# Joinr is wired to make a job by itself (2026-10-18, Todd): a won quote that arrives from the puller
# or the import becomes a Won job at once (or links to the one live job with its quote number), with
# a team task and an alert for the Design/PM team, and no person decides. Where this suite needs a
# quote to wait for a person, it first makes a job that already holds the quote's root id, which makes
# the automatic Accept fail (the row then stays `new`).
m6_alerts() { # KIND INTAKE_ID -> how many alerts of KIND for that record dpm has (read or not)
  req GET "/api/notifications?limit=100" "$DPM"
  expect_status 200 "dpm notifications"
  jqr "[.rows[] | select(.kind == \"$1\" and .link == \"/intake.html?item=$2\")] | length"
}
m6_hold() { # ROOT_ID WHY -> M6_HOLD (a job that already holds that Joinr root id)
  req POST /api/job-records "$DPM" "{\"name\":\"M6 holds $1\",\"externalRef\":\"$1\"}"
  expect_status 201 "$2"
  M6_HOLD=$(jqr '.id')
}

echo "--- start the stand-in Joinr inside the container ---"
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
docker cp "$(dirname "$0")/fake-joinr.js" "$CONTAINER":/tmp/fake-joinr.js
docker exec -d "$CONTAINER" node /tmp/fake-joinr.js "$M6_PORT" "$M6_KEY"
m6_up=""
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" node -e 'fetch("http://127.0.0.1:4999/_control/requests").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' 2>/dev/null; then
    m6_up=1
    break
  fi
  sleep 0.5
done
[ -n "$m6_up" ] || fail "the stand-in Joinr did not start"
ok

echo "--- access ---"
req GET /api/joinr/status "$SHOW"
expect_status 403 "show GET /api/joinr/status"
req GET /api/joinr/status "$SCHED"
expect_status 403 "sched GET /api/joinr/status"
req GET /api/joinr/status "$ACCT"
expect_status 403 "acct GET /api/joinr/status"
req POST /api/joinr/sync "$SHOW" '{}'
expect_status 403 "show POST /api/joinr/sync"
req POST /api/joinr/sync "$SCHED" '{}'
expect_status 403 "sched POST /api/joinr/sync"
req POST /api/joinr/sync "$ACCT" '{}'
expect_status 403 "acct POST /api/joinr/sync"
req POST /api/joinr/import "$DPM" '{}'
expect_status 403 "dpm POST /api/joinr/import"
req POST /api/joinr/import "$SCHED" '{}'
expect_status 403 "sched POST /api/joinr/import"

echo "--- no key: 409 and no requests to Joinr ---"
req GET /api/joinr/status "$DPM"
expect_status 200 "dpm GET /api/joinr/status"
expect_jq '.configured == false and .running == false and (.lastItems | type) == "number"' "status without a key"
expect_jq 'has("baseUrl") and has("lastRunAt") and has("lastOkAt") and has("lastError") and has("lastErrorAt")' "status has its fields"
docker exec "$CONTAINER" sh -c "printf '%s\n' '$M6_BASE_URL' > /data/config/joinr-base-url"
req POST /api/joinr/sync "$DPM" '{}'
expect_status 409 "dpm POST /api/joinr/sync without a key"
expect_jq '.error == "Joinr is not set up"' "the 409 says Joinr is not set up"
req POST /api/joinr/import "$ADMIN" '{}'
expect_status 409 "admin POST /api/joinr/import without a key"
m6_fake GET /_control/requests
m6_expect_out '.requests | length == 0' "no requests reach Joinr without a key"

# A quote that was already won before Crosscuts was connected: the first sync must not
# bring it in (start from now); the import does.
m6_event "$M6_Q0" "$M6_Q0" won won '{"quoteNumber":"CI-M6-0000","siteAddress":"0 Before St","clientName":"M6 Client Zero"}'

echo "--- with the key: the first sync stores a cursor and creates nothing ---"
docker exec "$CONTAINER" sh -c "printf '%s\n' '$M6_KEY' > /data/config/joinr-api-key"
req GET /api/joinr/status "$DPM"
expect_status 200 "status with a key"
expect_jq ".configured == true and .baseUrl == \"$M6_BASE_URL\"" "status: configured, pointing at the stand-in"
req POST /api/joinr/sync "$DPM" '{}'
expect_status 200 "dpm POST /api/joinr/sync (first)"
expect_jq '.ok == true and .error == null' "the first sync is ok"
m6_fake GET /_control/requests
m6_expect_out '.requests | length >= 1' "the first sync asked Joinr"
m6_expect_out '.requests[0].path == "/api/integrations/crosscuts/won-quotes" and (.requests[0].query | has("after") | not) and (.requests[0].query | has("backfill") | not)' "the first request has no after and no backfill"
m6_expect_out "all(.requests[]; .auth == \"…$M6_LAST4\")" "every request carried the key as a Bearer header"
expect_eq "$(m6_cursor)" "1" "the first sync stored Joinr's current cursor"
expect_eq "$(m6_intake_count "$M6_Q0")" "0" "the quote won before the first sync is not brought in"
req GET /api/joinr/status "$DPM"
expect_jq '.lastOkAt != null and .lastRunAt != null and .lastError == null' "status after the first sync"

echo "--- a won quote becomes a Won job by itself, with a team task and an alert (2026-10-18) ---"
M6_Q1_ITEM='{"quoteNumber":"CI-M6-0001","siteAddress":"1 Far Future St, Sydney","clientName":"M6 Client One","clientPhone":"0400 000 001","quoteDate":"2099-03-01","wonAt":"2099-03-02T01:00:00Z","valueIncGstCents":1234567,"estimatedHours":{"office":2,"factory":30,"site":12,"travel":3},"spec":{"sheetCount":24,"twoPac":true,"benchtop":"stone","jobType":"Kitchen"},"raw":{"doorsPanels":["2pac (S4)"],"benchtops":["Caesarstone"],"jobTypes":["Kitchen"]}}'
m6_event "$M6_Q1" "$M6_Q1" won won "$M6_Q1_ITEM"
m6_sync "$DPM" "sync after a won event"
expect_jq '.ok == true' "the sync is ok"
m6_fake GET /_control/requests
m6_expect_out '.requests[-1].query.after != null' "later syncs ask with after"
expect_eq "$(m6_intake_count "$M6_Q1")" "1" "one intake record for the won quote"
expect_eq "$(m6_intake_field "$M6_Q1" state)" "accepted" "the record was accepted automatically"
expect_eq "$(m6_intake_field "$M6_Q1" quote_number)" "CI-M6-0001" "the record has the quote number"
expect_eq "$(m6_intake_field "$M6_Q1" joinr_status)" "won" "the record has the Joinr status"
expect_eq "$(m6_intake_field "$M6_Q1" changed)" "0" "the record is not flagged"
expect_eq "$(m6_intake_field "$M6_Q1" decided_by)" "null" "no person decided (decided_by is NULL)"
expect_eq "$(m6_sql "SELECT payload FROM joinr_intake WHERE root_quote_id = '$M6_Q1'" | jq -r '.[0].payload | fromjson | .valueIncGstCents')" "1234567" "the payload keeps the value"
M6_Q1_ID=$(m6_intake_field "$M6_Q1" id)
M6_Q1_JOB=$(m6_intake_field "$M6_Q1" job_id)
expect_eq "$(m6_cursor)" "2" "the cursor moved past the item"
req GET "/api/job-records/$M6_Q1_JOB" "$DPM"
expect_status 200 "GET the job the sync made"
expect_jq ".name == \"1 Far Future St, Sydney\" and .stage == \"won\" and .source == \"joinr\" and .externalRef == \"$M6_Q1\" and .valueCents == 1234567 and .sheetCount == 24 and .isTwoPac == true and .benchtop == \"stone\" and .wonDate == \"2099-03-02\"" "the job is the Accept mapping: Won, from Joinr, the quote's fields"
req GET "/api/joinr/intake/$M6_Q1_ID" "$DPM"
expect_jq '.state == "accepted" and .decidedBy.id == null and .decidedBy.name == "Joinr (automatic)" and .decidedAt != null' "the intake object says the decision was automatic"
req GET "/api/audit?action=joinr.accept&entityId=$M6_Q1_ID&limit=1" "$ADMIN"
expect_jq '.rows[0].actorUserId == null and .rows[0].actorLabel == "Joinr (automatic)"' "joinr.accept is audited as Joinr (automatic)"
req GET "/api/audit?action=job.create&entityId=$M6_Q1_JOB&limit=1" "$ADMIN"
expect_jq '.rows[0].actorUserId == null and .rows[0].actorLabel == "Joinr (automatic)"' "job.create is audited as Joinr (automatic)"

echo "--- the alert goes to the Design/PM team (notes.design), not to the others ---"
req GET "/api/notifications?limit=100" "$DPM"
expect_status 200 "dpm notifications"
expect_jq "[.rows[] | select(.kind == \"joinr.job\" and .link == \"/job.html?id=$M6_Q1_JOB\")] | length == 1" "dpm has one joinr.job alert linking the job"
expect_jq "(.rows[] | select(.kind == \"joinr.job\" and .link == \"/job.html?id=$M6_Q1_JOB\") | .title) == \"Job created from Joinr: 1 Far Future St, Sydney\"" "the alert title names the job"
expect_jq '[.rows[] | select(.kind == "joinr.new" and (.title | contains("CI-M6-0001")))] | length == 0' "no 'new from Joinr' alert for an automatic job"
req GET "/api/notifications?limit=100" "$ADMIN"
expect_jq "[.rows[] | select(.kind == \"joinr.job\" and .link == \"/job.html?id=$M6_Q1_JOB\")] | length == 1" "admin (notes.design) has the alert too"
for pair in "SCHED:$SCHED" "ACCT:$ACCT" "SHOW:$SHOW"; do
  who=${pair%%:*}; jar=${pair#*:}
  req GET "/api/notifications?limit=100" "$jar"
  expect_status 200 "$who notifications"
  expect_jq '[.rows[] | select(.kind | startswith("joinr."))] | length == 0' "$who gets no Joinr alert"
done

echo "--- the Design/PM team task for the new job ---"
req GET "/api/tasks?view=mine" "$DPM"
expect_status 200 "dpm GET /api/tasks?view=mine"
expect_jq "[.rows[] | select(.job.id == $M6_Q1_JOB)] | length == 1" "the team task is in dpm's Mine"
expect_jq ".rows[] | select(.job.id == $M6_Q1_JOB) | .title == \"New job from Joinr: 1 Far Future St, Sydney - set up the job\" and .team == \"design\" and .assignee.name == \"Design/PM team\" and .assignee.id == null and .createdBy.name == \"Joinr (automatic)\" and .createdBy.id == null and .status == \"open\" and .dueDate == null and .canEdit == true" "its title, team, assignee label, creator label and no due date"
M6_Q1_TASK=$(jqr ".rows[] | select(.job.id == $M6_Q1_JOB) | .id")
req GET "/api/tasks?view=mine" "$ADMIN"
expect_jq "[.rows[] | select(.id == $M6_Q1_TASK)] | length == 1" "it is in admin's Mine too (every member sees it)"
req GET "/api/tasks?view=job&jobId=$M6_Q1_JOB" "$DPM"
expect_jq "[.rows[].id] == [$M6_Q1_TASK]" "the job's task list has it for a member"
for pair in "SCHED:$SCHED" "ACCT:$ACCT"; do
  who=${pair%%:*}; jar=${pair#*:}
  req GET "/api/tasks?view=open" "$jar"
  expect_status 200 "$who GET /api/tasks?view=open"
  expect_jq "[.rows[] | select(.id == $M6_Q1_TASK)] | length == 0" "$who (not on the team) does not see it in All open"
  req GET "/api/tasks?view=job&jobId=$M6_Q1_JOB" "$jar"
  expect_jq '.rows | length == 0' "$who does not see it on the job's task list"
  req GET "/api/tasks/$M6_Q1_TASK" "$jar"
  expect_status 404 "$who GET the team task by id"
  req POST "/api/tasks/$M6_Q1_TASK/done" "$jar"
  expect_status 404 "$who cannot finish it"
done
req GET "/api/tasks/$M6_Q1_TASK" "$SHOW"
expect_status 403 "show GET the team task"
req GET /api/auth/me "$DPM"
M6_DPM_ID=$(jqr '.user.id')
req GET /api/notifications/unread-count "$DPM"
expect_jq '.tasks >= 1' "the menu bar count includes the team task"
req POST "/api/tasks/$M6_Q1_TASK/done" "$DPM"
expect_status 200 "dpm ticks the team task done"
expect_jq ".status == \"done\" and .doneBy.id == $M6_DPM_ID and .doneAt != null" "done records who and when"
req GET "/api/tasks?view=mine" "$ADMIN"
expect_jq "[.rows[] | select(.id == $M6_Q1_TASK)] | length == 0" "it is closed for admin too"
req GET "/api/tasks?view=done" "$ADMIN"
expect_jq "[.rows[] | select(.id == $M6_Q1_TASK)] | length == 1" "admin finds it in Done"
req POST "/api/tasks/$M6_Q1_TASK/done" "$ADMIN"
expect_status 409 "ticking it again"
req POST "/api/tasks/$M6_Q1_TASK/reopen" "$ADMIN"
expect_status 200 "admin reopens it"
expect_jq '.status == "open" and .doneBy == null' "reopened for everyone"
req GET "/api/tasks?view=mine" "$DPM"
expect_jq "[.rows[] | select(.id == $M6_Q1_TASK)] | length == 1" "dpm sees it open again"
req GET "/api/audit?entityType=task&entityId=$M6_Q1_TASK&limit=20" "$ADMIN"
expect_jq '([.rows[].action] | (index("task.create") != null and index("task.done") != null and index("task.reopen") != null)) and ([.rows[] | select(.action == "task.create")][0].actorLabel == "Joinr (automatic)")' "create, done and reopen are audited, the creation by Joinr (automatic)"

echo "--- the same event again: still one record, one job, one alert, one task ---"
m6_event "$M6_Q1" "$M6_Q1" won won "$M6_Q1_ITEM"
m6_sync "$DPM" "sync"
expect_jq '.ok == true' "sync of a repeated item"
expect_eq "$(m6_intake_count "$M6_Q1")" "1" "still one record for the quote"
expect_eq "$(m6_intake_field "$M6_Q1" state)" "accepted" "still accepted"
expect_eq "$(m6_sql "SELECT COUNT(*) AS n FROM jobs WHERE external_ref = '$M6_Q1'" | jq -r '.[0].n')" "1" "still one job for the quote"
req GET "/api/notifications?limit=100" "$DPM"
expect_jq "[.rows[] | select(.kind == \"joinr.job\" and .link == \"/job.html?id=$M6_Q1_JOB\")] | length == 1" "still one joinr.job alert"
req GET "/api/tasks?view=job&jobId=$M6_Q1_JOB" "$DPM"
expect_jq '.rows | length == 1' "still one team task on the job"

echo "--- a revision that wins: flagged as changed, the job is not touched ---"
m6_event "$M6_Q1" "$M6_Q1B" won won "$(printf '%s' "$M6_Q1_ITEM" | jq -c '. + {revision: 1, valueIncGstCents: 1300000}')"
m6_sync "$DPM" "sync"
expect_jq '.ok == true' "sync of a revision"
expect_eq "$(m6_intake_count "$M6_Q1")" "1" "a revision does not make a second record"
expect_eq "$(m6_intake_field "$M6_Q1" quote_id)" "$M6_Q1B" "the record holds the latest revision"
expect_eq "$(m6_intake_field "$M6_Q1" changed)" "1" "the revision flags the accepted record"
expect_eq "$(m6_alerts joinr.changed "$M6_Q1_ID")" "1" "one joinr.changed alert"
req GET "/api/job-records/$M6_Q1_JOB" "$DPM"
expect_jq '.valueCents == 1234567' "the job's value is untouched"
req GET "/api/joinr/job/$M6_Q1_JOB" "$DPM"
expect_jq '.changed == true' "the job page's Joinr callout would show the change"

echo "--- a quote the automatic Accept could not handle waits for a person: un-won: withdrawn; won again: back to new (not automatic); deleted: withdrawn ---"
m6_hold "$M6_Q2" "a job already holding quote 2's root id"
m6_event "$M6_Q2" "$M6_Q2" won won '{"quoteNumber":"CI-M6-0002","siteAddress":"2 Far Future St","clientName":"M6 Client Two"}'
m6_sync "$DPM" "sync"
expect_eq "$(m6_intake_field "$M6_Q2" state)" "new" "quote 2 is left new: the automatic Accept failed and changed nothing"
expect_eq "$(m6_sql "SELECT COUNT(*) AS n FROM jobs WHERE external_ref = '$M6_Q2'" | jq -r '.[0].n')" "1" "no second job was made for quote 2"
M6_Q2_ID=$(m6_intake_field "$M6_Q2" id)
expect_eq "$(m6_alerts joinr.new "$M6_Q2_ID")" "1" "a record left for a person alerts the team as before (joinr.new)"
expect_eq "$(m6_sql "SELECT COUNT(*) AS n FROM team_tasks WHERE title LIKE '%2 Far Future%'" | jq -r '.[0].n')" "0" "the failed automatic Accept left no team task behind"
expect_jq '.ok == true' "the failed automatic Accept does not fail the sync"
m6_event "$M6_Q2" "$M6_Q2" unwon lost '{"quoteNumber":"CI-M6-0002","siteAddress":"2 Far Future St","clientName":"M6 Client Two","wonAt":null}'
m6_sync "$DPM" "sync"
expect_jq '.ok == true' "sync of an unwon item"
expect_eq "$(m6_intake_field "$M6_Q2" state)" "withdrawn" "an unwon undecided quote is withdrawn"
expect_eq "$(m6_intake_field "$M6_Q2" joinr_status)" "lost" "the record shows the status in Joinr"
expect_eq "$(m6_intake_count "$M6_Q2")" "1" "still one record for quote 2"
m6_event "$M6_Q2" "$M6_Q2" won won '{"quoteNumber":"CI-M6-0002","siteAddress":"2 Far Future St","clientName":"M6 Client Two"}'
m6_sync "$DPM" "sync"
expect_eq "$(m6_intake_field "$M6_Q2" state)" "new" "won again: back to new"
m6_event "$M6_Q2" "$M6_Q2" deleted won '{"quoteNumber":"CI-M6-0002","siteAddress":"2 Far Future St","clientName":"M6 Client Two","deletedAt":"2099-04-01T00:00:00Z"}'
m6_sync "$DPM" "sync"
expect_eq "$(m6_intake_field "$M6_Q2" state)" "withdrawn" "deleted in Joinr: withdrawn"

echo "--- an item that fails validation is skipped, logged and passed by the cursor ---"
m6_fake POST /_control/event '{"_verbatim":true,"event":"won","rootQuoteId":"not-a-uuid","status":"won"}'
M6_BAD_CURSOR=$(printf '%s' "$M6_OUT" | jq -r '.cursor')
m6_event "$M6_Q3" "$M6_Q3" won won '{"quoteNumber":"CI-M6-0003","siteAddress":"3 Far Future St","clientName":"M6 Client Three"}'
M6_Q3_CURSOR=$(printf '%s' "$M6_OUT" | jq -r '.cursor')
m6_sync "$DPM" "sync with an invalid item"
expect_jq '.ok == true and .error == null' "an invalid item does not fail the sync"
expect_eq "$(m6_intake_count "$M6_Q3")" "1" "the valid item after it is applied"
expect_eq "$(m6_intake_count not-a-uuid)" "0" "the invalid item made no record"
expect_eq "$(m6_cursor)" "$M6_Q3_CURSOR" "the cursor moved past both items"
M6_LOGS=$(docker logs "$CONTAINER" 2>&1)
grep -qF "[joinr] skipped item $M6_BAD_CURSOR:" <<<"$M6_LOGS" || fail "the invalid item is logged as skipped"
ok

echo "--- import currently won quotes (admin) ---"
M6_CURSOR_BEFORE=$(m6_cursor)
# One item per page, so the import pages through Joinr's opaque "b.<resume>.<uuid>" cursors,
# which Crosscuts must send back exactly as given (the last page's cursor is a plain number).
m6_fake POST /_control/pagesize '{"max":1}'
m6_fake POST /_control/clear
req POST /api/joinr/import "$ADMIN" '{}'
expect_status 200 "admin POST /api/joinr/import"
expect_jq '.ok == true and .error == null and (.truncated | not)' "the import is ok"
m6_fake POST /_control/pagesize '{"max":null}'
m6_fake GET /_control/requests
m6_expect_out '[.requests[] | select(.query.backfill == "won")] | length >= 3' "the import asked with backfill=won, page by page"
m6_expect_out '[.requests[] | select(.query.backfill == "won") | .query.after // empty] | length >= 2 and all(test("^b\\.[0-9]+\\.[^ ]+$"))' "the import sent the opaque cursors back as-is"
expect_eq "$(m6_intake_count "$M6_Q0")" "1" "the quote won before the first sync is imported"
# 2026-10-18: the import makes Won jobs for every past win (cutover.md warns about it).
expect_eq "$(m6_intake_field "$M6_Q0" state)" "accepted" "the imported quote became a Won job, as a sync would"
expect_eq "$(m6_sql "SELECT COUNT(*) AS n FROM jobs WHERE external_ref = '$M6_Q0' AND stage = 'won' AND source = 'joinr'" | jq -r '.[0].n')" "1" "one Won job from Joinr for the imported quote"
expect_eq "$(m6_sql "SELECT COUNT(*) AS n FROM team_tasks WHERE source = 'joinr' AND title LIKE '%0 Before St%'" | jq -r '.[0].n')" "1" "the imported job has its team task"
expect_eq "$(m6_intake_count "$M6_Q1")" "1" "the import does not duplicate quote 1"
expect_eq "$(m6_intake_field "$M6_Q2" state)" "withdrawn" "the import leaves the withdrawn quote alone"
expect_eq "$(m6_cursor)" "$M6_CURSOR_BEFORE" "the import keeps the stored cursor"

echo "--- the Pipeline's Quoted column lists the won quotes still waiting (GET /api/pipeline/joinr-quotes) ---"
# A quote the automatic Accept could not handle stays `new`; the ones that became jobs are not listed.
m6_hold "$M6_Q6" "a job already holding quote 6's root id"
M6_Q6_HOLD=$M6_HOLD
M6_Q6_ITEM='{"quoteNumber":"CI-M6-0006","siteAddress":"6 Far Future St, Sydney","clientName":"M6 Client Six","wonAt":"2099-03-03T01:00:00Z","valueIncGstCents":1300000}'
m6_event "$M6_Q6" "$M6_Q6" won won "$M6_Q6_ITEM"
m6_sync "$DPM" "sync quote 6"
expect_eq "$(m6_intake_field "$M6_Q6" state)" "new" "quote 6 waits for a person"
M6_Q6_ID=$(m6_intake_field "$M6_Q6" id)
req GET /api/pipeline/joinr-quotes "$SHOW"
expect_status 403 "show GET /api/pipeline/joinr-quotes"
req GET /api/pipeline/joinr-quotes "$DPM"
expect_status 200 "dpm GET /api/pipeline/joinr-quotes"
expect_jq '.source == "intake" and .fetchedAt == null and .truncated == false' "Joinr has not released the open-quotes list (the stand-in answers 404), so Quoted lists the intake rows"
expect_jq '[.quotes[] | select(.quoteNumber == "CI-M6-0001")] | length == 0' "a won quote that has become a job is no longer listed"
expect_jq '[.quotes[] | select(.quoteNumber == "CI-M6-0006")] | length == 1' "the quote waiting for a person is listed"
expect_jq ".quotes[] | select(.quoteNumber == \"CI-M6-0006\") | (.url | startswith(\"$M6_BASE_URL/org/\") and endswith(\"/quotes/$M6_Q6\")) and .clientName == \"M6 Client Six\" and .siteAddress == \"6 Far Future St, Sydney\" and .joinrStatus == \"won\" and .valueCents == 1300000" "the line links to the quote in Joinr, with client, site, status and value"
expect_jq '[.quotes[] | select(.quoteNumber == "CI-M6-0002")] | length == 0' "the withdrawn quote is not listed"
expect_jq '.quotes[0].quoteNumber == "CI-M6-0006"' "the newest won (2099) comes first"

echo "--- Joinr misbehaving: the error shows in /status and the app carries on ---"
m6_check_failure() { # MODE-JSON WHAT [ERROR-SUBSTRING]
  m6_set_fail "$1"
  if [ "$1" = '"hang"' ]; then
    # One call: each one waits out the 15 s timeout.
    req POST /api/joinr/sync "$DPM" '{}'
    expect_status 200 "sync while Joinr sends $2"
  else
    m6_sync "$DPM" "sync while Joinr sends $2"
  fi
  expect_jq '.ok == false and (.error | type) == "string" and (.error | length) > 0' "the sync reports $2"
  if [ -n "${3:-}" ]; then expect_jq ".error | contains(\"$3\")" "the error for $2 says \"$3\""; fi
  req GET /api/joinr/status "$DPM"
  expect_status 200 "status after $2"
  expect_jq '.lastError != null and .lastErrorAt != null and .running == false' "status shows the error after $2"
  req GET /api/schedule "$ADMIN"
  expect_status 200 "the board still loads after $2"
  m6_fake POST /_control/fail '{"fail":null}'
}
m6_check_failure '"garbage"' "a garbage page" "not valid JSON"
m6_check_failure '"html"' "an HTML page" "not JSON"
m6_check_failure 500 "a 500" "HTTP 500"
m6_check_failure '"hang"' "nothing (a hang)" "15 seconds"

# A wrong key: Joinr's 401 is reported, and the right key works again.
docker exec "$CONTAINER" sh -c "printf '%s\n' 'ci-wrong-key-0000000000' > /data/config/joinr-api-key"
m6_sync "$DPM" "sync with a wrong key"
expect_jq '.ok == false and (.error | contains("401"))' "a wrong key is reported as a 401"
docker exec "$CONTAINER" sh -c "printf '%s\n' '$M6_KEY' > /data/config/joinr-api-key"

m6_sync "$DPM" "sync with Joinr back"
expect_jq '.ok == true and .error == null' "Joinr back: the sync is ok again"
req GET /api/joinr/status "$DPM"
expect_jq '.lastError == null and .lastOkAt != null' "status is clear after a good sync"

echo "--- the key never leaves the server ---"
req GET /api/joinr/status "$ADMIN"
case $BODY in *"$M6_KEY"*) fail "the key appears in /api/joinr/status" ;; *) ok ;; esac
req GET "/api/audit?limit=500" "$ADMIN"
expect_status 200 "admin GET /api/audit"
case $BODY in *"$M6_KEY"*) fail "the key appears in /api/audit" ;; *) ok ;; esac
M6_LOGS=$(docker logs "$CONTAINER" 2>&1)
if grep -qF "$M6_KEY" <<<"$M6_LOGS"; then fail "the key appears in docker logs"; fi
ok
m6_fake GET /_control/requests
case $M6_OUT in *"$M6_KEY"*) fail "the key appears in a request URL" ;; *) ok ;; esac

# ---- Block B (inbox) ----------------------------------------------------------
# Puller-driven decisions (M6 · 4.3): the stand-in Joinr is still running and Crosscuts
# still points at it; quotes 0 to 3 above exist ($M6_Q0 new, $M6_Q1 new, $M6_Q2 withdrawn,
# $M6_Q3 new). Quotes 4 and 5 are new roots decided on here. Every item carries its own
# wonAt, so a repeat is identical (the fake would otherwise stamp a fresh one).
M6_Q4=c6000000-0000-4000-8000-000000000004
M6_Q5=c6000000-0000-4000-8000-000000000005
M6_Q9=c6000000-0000-4000-8000-000000000009

echo "--- a pulled quote is accepted by itself, then Joinr changes it: flagged, one alert, the job untouched ---"
M6_Q4_ITEM='{"quoteNumber":"CI-M6-0004","siteAddress":"4 Far Future St","clientName":"M6 Client Four","wonAt":"2099-05-02T01:00:00Z","valueIncGstCents":500000}'
m6_event "$M6_Q4" "$M6_Q4" won won "$M6_Q4_ITEM"
m6_sync "$DPM" "sync quote 4"
expect_eq "$(m6_intake_field "$M6_Q4" state)" "accepted" "quote 4 was accepted by itself"
M6_Q4_ID=$(m6_intake_field "$M6_Q4" id)
M6_Q4_JOB=$(m6_intake_field "$M6_Q4" job_id)
req GET "/api/job-records/$M6_Q4_JOB" "$DPM"
expect_jq '.stage == "won" and .source == "joinr"' "quote 4 is a job at won"
req GET "/api/job-records/$M6_Q4_JOB" "$DPM"
expect_jq ".valueCents == 500000 and .externalRef == \"$M6_Q4\"" "the job has the quote's value and root id"
M6_Q4_CHANGED=$(printf '%s' "$M6_Q4_ITEM" | jq -c '. + {valueIncGstCents: 650000}')
m6_event "$M6_Q4" "$M6_Q4" changed won "$M6_Q4_CHANGED"
m6_sync "$DPM" "sync a changed value"
expect_jq '.ok == true' "sync of a change to an accepted quote"
expect_eq "$(m6_intake_field "$M6_Q4" changed)" "1" "the accepted record is flagged changed"
expect_eq "$(m6_intake_field "$M6_Q4" state)" "accepted" "it stays accepted"
expect_eq "$(m6_alerts joinr.changed "$M6_Q4_ID")" "1" "one joinr.changed alert for dpm"
req GET "/api/job-records/$M6_Q4_JOB" "$DPM"
expect_jq '.valueCents == 500000' "the job's value is unchanged"

echo "--- the identical item again: nothing new (no flag, no alert) ---"
req POST "/api/joinr/intake/$M6_Q4_ID/acknowledge" "$DPM" '{}'
expect_status 200 "dpm acknowledges the change"
expect_eq "$(m6_intake_field "$M6_Q4" changed)" "0" "acknowledged"
# Read alerts are not deduplicated, so a second flag would show as a second alert.
req POST /api/notifications/read-all "$DPM" '{}'
expect_status 204 "dpm marks alerts read"
M6_Q4_SEEN=$(m6_intake_field "$M6_Q4" last_seen_at)
m6_event "$M6_Q4" "$M6_Q4" changed won "$M6_Q4_CHANGED"
m6_sync "$DPM" "sync an identical repeat"
expect_jq '.ok == true' "sync of an identical repeat"
expect_eq "$(m6_intake_field "$M6_Q4" changed)" "0" "an identical repeat does not flag the record"
expect_eq "$(m6_alerts joinr.changed "$M6_Q4_ID")" "1" "still one joinr.changed alert"
[ "$(m6_intake_field "$M6_Q4" last_seen_at)" != "$M6_Q4_SEEN" ] || fail "an identical repeat updates last_seen_at"
ok

echo "--- un-won after Accept: flagged once; the same un-won again: nothing new ---"
M6_Q4_UNWON=$(printf '%s' "$M6_Q4_CHANGED" | jq -c '. + {status: "lost"}')
m6_event "$M6_Q4" "$M6_Q4" unwon lost "$M6_Q4_UNWON"
m6_sync "$DPM" "sync an unwon accepted quote"
expect_eq "$(m6_intake_field "$M6_Q4" changed)" "1" "un-won after Accept is flagged"
expect_eq "$(m6_alerts joinr.changed "$M6_Q4_ID")" "2" "a second joinr.changed alert (the first was read)"
req POST "/api/joinr/intake/$M6_Q4_ID/acknowledge" "$DPM" '{}'
expect_status 200 "dpm acknowledges the un-won"
req POST /api/notifications/read-all "$DPM" '{}'
m6_event "$M6_Q4" "$M6_Q4" unwon lost "$M6_Q4_UNWON"
m6_sync "$DPM" "sync a repeated unwon"
expect_eq "$(m6_intake_field "$M6_Q4" changed)" "0" "a repeated un-won is not a change"
expect_eq "$(m6_alerts joinr.changed "$M6_Q4_ID")" "2" "no alert for a repeated un-won"
req GET "/api/job-records/$M6_Q4_JOB" "$DPM"
expect_jq '.valueCents == 500000 and .stage == "won"' "the job is still untouched"

echo "--- an un-won after the automatic Accept flags the job and leaves it in place ---"
m6_event "$M6_Q4" "$M6_Q4" unwon lost "$(printf '%s' "$M6_Q4_CHANGED" | jq -c '. + {status: "lost", valueIncGstCents: 660000}')"
m6_sync "$DPM" "sync an unwon with another change"
expect_eq "$(m6_intake_field "$M6_Q4" changed)" "1" "flagged again"
req GET "/api/joinr/job/$M6_Q4_JOB" "$DPM"
expect_jq '.changed == true and .state == "accepted"' "the job page callout shows it"
req GET "/api/job-records/$M6_Q4_JOB" "$DPM"
expect_jq '.id != null and .valueCents == 500000' "the job is still there with its own value"
req POST "/api/joinr/intake/$M6_Q4_ID/acknowledge" "$DPM" '{}'
expect_status 200 "dpm acknowledges"

echo "--- ignore a pulled quote (one that waits for a person), then Joinr changes it: flagged silently ---"
m6_hold "$M6_Q5" "a job already holding quote 5's root id"
M6_Q5_ITEM='{"quoteNumber":"CI-M6-0005","siteAddress":"5 Far Future St","clientName":"M6 Client Five","wonAt":"2099-05-03T01:00:00Z","valueIncGstCents":300000}'
m6_event "$M6_Q5" "$M6_Q5" won won "$M6_Q5_ITEM"
m6_sync "$DPM" "sync quote 5"
expect_eq "$(m6_intake_field "$M6_Q5" state)" "new" "quote 5 waits for a person"
M6_Q5_ID=$(m6_intake_field "$M6_Q5" id)
req POST "/api/joinr/intake/$M6_Q5_ID/ignore" "$DPM" '{}'
expect_status 200 "dpm ignores quote 5"
m6_event "$M6_Q5" "$M6_Q5" changed won "$(printf '%s' "$M6_Q5_ITEM" | jq -c '. + {valueIncGstCents: 310000}')"
m6_sync "$DPM" "sync a change to an ignored quote"
expect_eq "$(m6_intake_field "$M6_Q5" changed)" "1" "the ignored record is flagged changed"
expect_eq "$(m6_intake_field "$M6_Q5" state)" "ignored" "it stays ignored"
expect_eq "$(m6_alerts joinr.changed "$M6_Q5_ID")" "0" "no joinr.changed alert for an ignored quote"

echo "--- a row left new can still be accepted by a person (the Accept button) ---"
# Quote 6 was left new above (a job held its root id). Free the id, then Accept by hand.
req PATCH "/api/job-records/$M6_Q6_HOLD" "$DPM" '{"externalRef":null}'
expect_status 200 "the blocking job lets go of the root id"
req POST "/api/joinr/intake/$M6_Q6_ID/accept" "$DPM" '{}'
expect_status 200 "dpm accepts quote 6 by hand"
expect_jq '.item.state == "accepted" and .job.stage == "won" and .job.source == "joinr"' "accepted as a Won job"
M6_Q6_JOB=$(jqr '.job.id')
req GET "/api/joinr/intake/$M6_Q6_ID" "$DPM"
expect_jq ".decidedBy.name == \"CI Design PM\" and .decidedBy.id == $M6_DPM_ID" "a hand decision names the person"
req GET "/api/tasks?view=job&jobId=$M6_Q6_JOB" "$DPM"
expect_jq '.rows | length == 0' "a hand Accept makes no team task (the person doing it is already on it)"

echo "--- exactly one live job with the quote number: linked, moved to Won, nothing overwritten ---"
req POST /api/job-records "$DPM" '{"name":"M6 typed-in kitchen","quoteNumber":"CI-M6-0007","clientName":"Typed Client","stage":"quoted"}'
expect_status 201 "a typed-in job at Quoted with the quote number"
M6_Q7_JOB=$(jqr '.id')
req POST /api/job-records "$DPM" '{"name":"M6 old lost one","quoteNumber":"CI-M6-0007","stage":"lost"}'
expect_status 201 "a lost job with the same number does not count"
M6_Q7_ITEM='{"quoteNumber":"CI-M6-0007","siteAddress":"7 Far Future St","clientName":"Joinr Client Seven","wonAt":"2099-06-02T01:00:00Z","valueIncGstCents":777700,"spec":{"sheetCount":9,"twoPac":false,"benchtop":"laminate","jobType":"Vanity"}}'
m6_event "$M6_Q7" "$M6_Q7" won won "$M6_Q7_ITEM"
m6_sync "$DPM" "sync quote 7"
expect_eq "$(m6_intake_field "$M6_Q7" state)" "linked" "quote 7 was linked by itself"
expect_eq "$(m6_intake_field "$M6_Q7" job_id)" "$M6_Q7_JOB" "to the one live job with its number"
M6_Q7_ID=$(m6_intake_field "$M6_Q7" id)
req GET "/api/job-records/$M6_Q7_JOB" "$DPM"
expect_jq ".externalRef == \"$M6_Q7\" and .name == \"M6 typed-in kitchen\" and .source == \"manual\" and .clientName == \"Typed Client\" and .stage == \"won\" and .wonDate == \"2099-06-02\"" "tied to the quote, kept its own name and client, moved from Quoted to Won"
expect_jq '.siteAddress == "7 Far Future St" and .valueCents == 777700 and .sheetCount == 9 and .benchtop == "laminate"' "its empty fields were filled"
req GET "/api/audit?action=joinr.link&entityId=$M6_Q7_ID&limit=1" "$ADMIN"
expect_jq '.rows[0].actorLabel == "Joinr (automatic)" and .rows[0].actorUserId == null' "joinr.link is audited as Joinr (automatic)"
req GET "/api/tasks?view=job&jobId=$M6_Q7_JOB" "$DPM"
expect_jq '(.rows | length) == 1 and .rows[0].title == "Joinr quote linked to M6 typed-in kitchen - check the job" and .rows[0].team == "design"' "a team task says the quote was linked"
req GET "/api/notifications?limit=100" "$DPM"
expect_jq "[.rows[] | select(.kind == \"joinr.job\" and .link == \"/job.html?id=$M6_Q7_JOB\" and .title == \"Joinr linked to M6 typed-in kitchen\")] | length == 1" "the team is told the quote was linked"

echo "--- two live jobs with the quote number: a new job is made, neither is touched ---"
req POST /api/job-records "$DPM" '{"name":"M6 twin A","quoteNumber":"CI-M6-0008","stage":"quoted"}'
M6_Q8_A=$(jqr '.id')
req POST /api/job-records "$DPM" '{"name":"M6 twin B","quoteNumber":"CI-M6-0008","stage":"quoted"}'
M6_Q8_B=$(jqr '.id')
m6_event "$M6_Q8" "$M6_Q8" won won '{"quoteNumber":"CI-M6-0008","siteAddress":"8 Far Future St","clientName":"M6 Client Eight","wonAt":"2099-06-03T01:00:00Z"}'
m6_sync "$DPM" "sync quote 8"
expect_eq "$(m6_intake_field "$M6_Q8" state)" "accepted" "quote 8 became a new job (the match was not unique)"
M6_Q8_JOB=$(m6_intake_field "$M6_Q8" job_id)
[ "$M6_Q8_JOB" != "$M6_Q8_A" ] && [ "$M6_Q8_JOB" != "$M6_Q8_B" ] || fail "quote 8 was tied to one of the twins"
ok
for j in "$M6_Q8_A" "$M6_Q8_B"; do
  req GET "/api/job-records/$j" "$DPM"
  expect_jq '.externalRef == null and .stage == "quoted"' "the twin $j is untouched"
done

echo "--- a unique match that is further along keeps its stage ---"
req POST /api/job-records "$DPM" '{"name":"M6 already in design","quoteNumber":"CI-M6-0010","stage":"design_ordering"}'
M6_Q10_JOB=$(jqr '.id')
m6_event "$M6_Q10" "$M6_Q10" won won '{"quoteNumber":"CI-M6-0010","siteAddress":"10 Far Future St","clientName":"M6 Client Ten","wonAt":"2099-06-04T01:00:00Z"}'
m6_sync "$DPM" "sync quote 10"
expect_eq "$(m6_intake_field "$M6_Q10" state)" "linked" "quote 10 linked by itself"
req GET "/api/job-records/$M6_Q10_JOB" "$DPM"
expect_jq '.stage == "design_ordering" and .externalRef != null' "the job stays at design_ordering"
# ---- end block B ----------------------------------------------------------------

echo "--- paging faults: an older position, and paging that does not move ---"
M6_CUR=$(m6_cursor)
M6_Q9_ITEM=$(jq -nc --arg r "$M6_Q9" '{cursor: "1", event: "won", quoteId: $r, rootQuoteId: $r, revision: 0,
  quoteNumber: "CI-M6-0009", status: "won", standing: "active", deletedAt: null, wonAt: "2099-05-04T01:00:00Z",
  updatedAt: "2099-05-04T01:00:00Z", clientName: "M6 Client Nine", clientPhone: null, clientEmail: null,
  siteAddress: null, label: null, reference: null, quoteDate: null, valueIncGstCents: null, estimatedHours: null,
  spec: {sheetCount: null, twoPac: null, benchtop: null, jobType: null}, raw: {doorsPanels: [], benchtops: [], jobTypes: []},
  url: "https://app.joinr.com.au/org/o/quotes/x"}')
m6_set_fail "{\"page\":{\"contract\":1,\"cursor\":\"1\",\"more\":false,\"items\":[$M6_Q9_ITEM]}}"
m6_sync "$DPM" "sync while Joinr sends an older position"
expect_jq '.ok == false and (.error | contains("older position"))' "an older position is an error"
expect_eq "$(m6_intake_count "$M6_Q9")" "0" "nothing from that page is applied"
expect_eq "$(m6_cursor)" "$M6_CUR" "the stored cursor is unchanged"
m6_set_fail '{"page":{"contract":1,"cursor":"$after","more":true,"items":[]}}'
m6_sync "$DPM" "sync while Joinr's paging is stuck"
expect_jq '.ok == false and (.error | contains("did not move forward"))' "stuck paging stops the run"
expect_eq "$(m6_cursor)" "$M6_CUR" "the stored cursor is still unchanged"
m6_fake POST /_control/fail '{"fail":null}'
m6_sync "$DPM" "sync with paging fixed"
expect_jq '.ok == true' "the sync is ok again"

echo "--- settings: access ---"
for pair in "ACCT:$ACCT" "DPM:$DPM"; do
  who=${pair%%:*}; jar=${pair#*:}
  req GET /api/joinr/settings "$jar"
  expect_status 403 "$who GET /api/joinr/settings"
  req PUT /api/joinr/settings "$jar" '{"baseUrl":"https://evil.example.com"}'
  expect_status 403 "$who PUT /api/joinr/settings"
  req DELETE /api/joinr/settings/key "$jar"
  expect_status 403 "$who DELETE /api/joinr/settings/key"
  req POST /api/joinr/test "$jar" '{}'
  expect_status 403 "$who POST /api/joinr/test"
  req POST /api/joinr/import "$jar" '{}'
  expect_status 403 "$who POST /api/joinr/import"
done

echo "--- settings: the key through the API (write-only) ---"
req PUT /api/joinr/settings "$ADMIN" "{\"baseUrl\":\"$M6_BASE_URL\",\"apiKey\":\"$M6_KEY\"}"
expect_status 200 "admin PUT key and address"
expect_jq ".key.configured == true and .key.last4 == \"$M6_LAST4\" and .baseUrl == \"$M6_BASE_URL\" and .baseUrlFromEnv == false" "the key shows as set, last four only"
case $BODY in *"$M6_KEY"*) fail "the key appears in the PUT response" ;; *) ok ;; esac
req GET /api/joinr/settings "$ADMIN"
expect_status 200 "admin GET /api/joinr/settings"
expect_jq ".key.configured == true and .key.last4 == \"$M6_LAST4\" and (.key | keys == [\"configured\",\"fromEnv\",\"last4\"])" "GET shows only the last four"
case $BODY in *"$M6_KEY"*) fail "the key appears in /api/joinr/settings" ;; *) ok ;; esac
req POST /api/joinr/test "$ADMIN" '{}'
expect_status 200 "admin POST /api/joinr/test"
expect_jq '.ok == true and (.cursor | type) == "string"' "Test connection reaches the stand-in"
req GET "/api/audit?limit=500" "$ADMIN"
case $BODY in *"$M6_KEY"*) fail "the key appears in /api/audit after the PUT" ;; *) ok ;; esac
req DELETE /api/joinr/settings/key "$ADMIN"
expect_status 200 "admin DELETE the key"
expect_jq '.key.configured == false and .key.last4 == null' "the key is gone"
req POST /api/joinr/test "$ADMIN" '{}'
expect_jq '.ok == false and .error == "No API key is set"' "Test connection without a key"
req PUT /api/joinr/settings "$ADMIN" '{"baseUrl":"http://joinr.example.com"}'
expect_status 400 "plain http to a public address"
expect_jq '.error == "Use an https address"' "the refusal asks for https"

echo "--- settings: changing the address clears the key and the sync position ---"
req PUT /api/joinr/settings "$ADMIN" "{\"apiKey\":\"$M6_KEY\"}"
expect_status 200 "admin sets the key again"
m6_sync "$DPM" "sync before the address change"
[ "$(m6_cursor)" != "null" ] || fail "a cursor is stored before the address change"
ok
req PUT /api/joinr/settings "$ADMIN" '{"baseUrl":"http://192.168.77.1:4999"}'
expect_status 200 "admin changes the address (a private LAN address may be http)"
expect_jq '.baseUrl == "http://192.168.77.1:4999" and .key.configured == false and .sync.lastError == null' "the new address, no key, no old error"
expect_eq "$(m6_cursor)" "null" "the sync position is reset"
req GET "/api/audit?action=joinr.settings&limit=1" "$ADMIN"
expect_jq '.rows[0].after == {"baseUrl":"http://192.168.77.1:4999","key":"cleared","cursor":"reset"}' "the change is audited without the key"
req PUT /api/joinr/settings "$ADMIN" "{\"baseUrl\":\"$M6_BASE_URL\",\"apiKey\":\"$M6_KEY\"}"
expect_status 200 "admin restores the stand-in's address with its key"
expect_jq ".baseUrl == \"$M6_BASE_URL\" and .key.configured == true and .key.last4 == \"$M6_LAST4\"" "address and key restored"
req GET "/api/audit?action=joinr.settings&limit=1" "$ADMIN"
expect_jq ".rows[0].after == {\"baseUrl\":\"$M6_BASE_URL\",\"key\":\"cleared\",\"cursor\":\"reset\",\"newKey\":\"set\"}" "address change plus a new key, audited without it"
case $BODY in *"$M6_KEY"*) fail "the key appears in the audit row" ;; *) ok ;; esac
m6_sync "$DPM" "sync after the address change"
expect_jq '.ok == true' "the sync works at the restored address"
[ "$(m6_cursor)" != "null" ] || fail "the first sync at the new address stores a cursor"
ok

echo "--- tidy up: stop the stand-in and remove the Joinr set-up ---"
m6_fake POST /_control/stop
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
req GET /api/joinr/status "$DPM"
expect_status 200 "status after the tidy-up"
expect_jq '.configured == false' "Joinr is no longer set up"
req POST /api/joinr/sync "$DPM" '{}'
expect_status 409 "sync after the tidy-up"
