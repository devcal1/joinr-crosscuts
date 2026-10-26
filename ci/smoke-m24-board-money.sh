# M24 smoke: board placement and money triggers (0.2.3, docs/plans/m24-contracts.md): the board lead
# setting, the automatic manufacturing row and the 10% at Send to Ordering (once only), On board
# (ordering), all ordered (Ready to cut, the install ask, the Needs install date list and its
# confirm), the quick-add fallback and the 7:00 ETA nudge.
# Sourced by ci/smoke.sh after the M23 suites, so it shares that script's helpers and cookie jars.
# No shebang and no `set`: the caller owns both. Made-up names only; it reads only its own rows.

# ============================================================================
step "m24. board placement, deposit at send, all ordered, install dates, ETA nudge"
# ============================================================================

M24_TAG="m24b$(date +%s)"
M24_TODAY=$(TZ=Australia/Sydney date +%F)
M24_DOW=$(date -u -d "$M24_TODAY" +%u)
M24_MON=$(date -u -d "$M24_TODAY -$((M24_DOW - 1)) days" +%F)
M24_W2=$(date -u -d "$M24_MON +14 days" +%F)
M24_PAST=$(date -u -d "$M24_TODAY -3 days" +%F)

# Reads the live database: prints the JSON of one query's rows.
m24_q() {
  docker exec "$CONTAINER" node -e '
const d = require("better-sqlite3")("/data/db/photos.db", { readonly: true });
const [sql, ...args] = process.argv.slice(1);
process.stdout.write(JSON.stringify(d.prepare(sql).all(...args)));' "$@" | tr -d '\r'
}

echo "--- the board lead setting ---"
req GET /api/settings "$ADMIN"
expect_jq '.board.leadWeeks == 0' "the M22 suite left it at 0"
req PUT /api/settings "$ADMIN" '{"board":{"leadWeeks":13}}'
expect_status 400 "13 weeks is too many"
req PUT /api/settings "$ADMIN" '{"board":{"leadWeeks":1.5}}'
expect_status 400 "a whole number"
req PUT /api/settings "$DPM" '{"board":{"leadWeeks":2}}'
expect_status 403 "only users.admin"
req PUT /api/settings "$ADMIN" '{"board":{"leadWeeks":2}}'
expect_status 200 "two weeks"
expect_jq '.board.leadWeeks == 2' "saved"
req GET /users.html "$ADMIN"
case $BODY in *'id="setLeadWeeks"'*) ok ;; *) fail "users.html has no board lead field" ;; esac

# m24_job NAME: a Won job with a value, owned by dpm, a requested date and two lines; prints its id.
req GET /api/auth/me "$DPM"; M24_DPM_ID=$(jqr '.user.id')
m24_job() {
  req POST /api/job-records "$DPM" "{\"name\":\"$1\",\"stage\":\"won\",\"valueCents\":1000000}"
  expect_status 201 "job $1"
  local id; id=$(jqr '.id')
  req PUT "/api/job-records/$id/owner" "$DPM" "{\"ownerId\":$M24_DPM_ID}"; expect_status 200 "owner"
  req PATCH "/api/job-records/$id" "$DPM" '{"requestedInstallDate":"2031-05-06"}'; expect_status 200 "requested date"
  req POST "/api/job-records/$id/materials" "$DPM" '{"section":"boards","name":"Board 16mm","qty":4,"unit":"sheets","supplier":"M24 Boards Co"}'; expect_status 201 "a board line"
  req POST "/api/job-records/$id/materials" "$DPM" '{"section":"hardware","name":"Hinge","qty":8,"unit":"each","supplier":"M24 Hardware Co"}'; expect_status 201 "a hinge line"
  req POST "/api/job-records/$id/project/finalise" "$DPM" '{}'; expect_status 201 "finalised"
  M24_ID=$id
}

echo "--- Send to Ordering: the deposit and the board row ---"
m24_job "$M24_TAG placed"
M24_J=$M24_ID
req POST "/api/job-records/$M24_J/project/send" "$DPM" '{}'
expect_status 200 "sent"
expect_jq ".depositDue == true and .placed.weekStart == \"$M24_W2\" and .job.pipelineStage == \"on_board\"" "the deposit is due and the job is on the board two weeks out"
M24_ROWS=$(m24_q "SELECT wr.week_start, wr.panel, (SELECT COUNT(*) FROM assignments a WHERE a.week_row_id = wr.id) AS people FROM week_rows wr WHERE wr.job_id = ?" "$M24_J")
expect_eq "$(printf '%s' "$M24_ROWS" | jq -c '.')" "[{\"week_start\":\"$M24_W2\",\"panel\":\"manufacturing\",\"people\":0}]" "one manufacturing row, nobody on it"
M24_INV=$(m24_q "SELECT kind, status, due_reason, due_trigger FROM invoices WHERE job_id = ? ORDER BY id" "$M24_J")
expect_eq "$(printf '%s' "$M24_INV" | jq -c '.')" '[{"kind":"deposit","status":"due","due_reason":null,"due_trigger":"order_list_sent"}]' "one deposit, due because the list was sent"
req GET "/api/audit?action=board.autoplace&entityId=$M24_J&limit=5" "$ADMIN"
expect_jq "(.rows | length) == 1 and .rows[0].after.weekStart == \"$M24_W2\"" "the placement is audited"
req GET "/api/notifications?limit=50" "$ACCT"
expect_jq "[.rows[] | select(.kind == \"invoice.due\" and (.title | contains(\"$M24_TAG placed\")) and .body == \"The order list was sent to Ordering.\")] | length == 1" "accounts is told why the deposit is due"

echo "--- On board (ordering) ---"
req GET "/api/job-records/$M24_J" "$DPM"
expect_jq '.stage == "on_board" and .boardOrdering == true and .orderingProgress.ordered == 0 and .orderingProgress.total == 2' "shown On board (ordering), 0 of 2"
req POST "/api/job-records/$M24_J/stage" "$DPM" '{"stage":"ready_to_cut","from":"on_board"}'
expect_status 409 "hand moves stay locked"
req GET /pipeline.js "$DPM"
case $BODY in *'On board (ordering)'*) ok ;; *) fail "pipeline.js has no On board (ordering)" ;; esac

echo "--- a later revision: no second deposit, no second row ---"
req POST "/api/job-records/$M24_J/materials" "$DPM" '{"section":"hardware","name":"Runner","qty":2,"unit":"pairs","supplier":"M24 Hardware Co"}'
req POST "/api/job-records/$M24_J/project/finalise" "$DPM" '{}'; expect_status 201 "revision B"
req POST "/api/job-records/$M24_J/project/send" "$DPM" '{}'
expect_status 200 "revision B sent from the board"
expect_jq '.depositDue == false and .placed == null and .created == 1' "only the new line; no deposit, no row"
expect_eq "$(m24_q "SELECT COUNT(*) AS n FROM invoices WHERE job_id = ? AND kind = 'deposit'" "$M24_J" | jq -r '.[0].n')" "1" "still one deposit"
expect_eq "$(m24_q "SELECT COUNT(*) AS n FROM week_rows WHERE job_id = ?" "$M24_J" | jq -r '.[0].n')" "1" "still one row"

echo "--- all ordered on the board ---"
for M24_L in $(m24_q "SELECT id FROM orders WHERE job_id = ? AND status = 'to_order' ORDER BY id" "$M24_J" | jq -r '.[].id'); do
  req PATCH "/api/orders/$M24_L" "$ORDR" "{\"status\":\"ordered\",\"expectedDate\":\"2031-04-20\"}"
  expect_status 200 "line $M24_L ordered"
done
req GET "/api/job-records/$M24_J" "$DPM"
expect_jq '.stage == "on_board" and .boardOrdering == false and .materialsOrderedDate != null' "stays on the board, no longer ordering"
expect_eq "$(m24_q "SELECT COUNT(*) AS n FROM invoices WHERE job_id = ? AND kind = 'progress' AND status = 'due'" "$M24_J" | jq -r '.[0].n')" "1" "the 50% is due"
req GET "/api/notifications?limit=50" "$SCHED"
expect_jq "[.rows[] | select(.kind == \"job.all_ordered\" and .title == \"All ordered for $M24_TAG placed. Requested install 6 May 2031: set the install date.\")] | length == 1" "the schedule manager is asked for an install date"
req GET "/api/notifications?limit=50" "$ACCT"
expect_jq "[.rows[] | select(.kind == \"job.all_ordered\")] | length == 0" "accounts (no board.edit) isn't"

echo "--- Needs install date ---"
req GET /api/install-dates/needed "$DPM"
expect_status 403 "board.edit only"
req GET /api/install-dates/needed "$SCHED"
expect_status 200 "sched reads the list"
expect_jq "[.jobs[] | select(.id == $M24_J)][0] | .requestedInstallDate == \"2031-05-06\" and .latestEta == \"2031-04-20\"" "the job, its requested date and latest ETA"
req POST "/api/job-records/$M24_J/confirm-install" "$SCHED" '{"date":"2031-02-30"}'
expect_status 400 "a real date"
req POST "/api/job-records/$M24_J/confirm-install" "$SCHED" '{"date":"2031-05-13"}'
expect_status 200 "confirmed"
expect_jq '.job.promisedInstallDate == "2031-05-13"' "the promised install date"
req GET /api/install-dates/needed "$SCHED"
expect_jq "[.jobs[] | select(.id == $M24_J)] | length == 0" "off the list"
req GET "/notes.html?dept=scheduling" "$SCHED"
case $BODY in *'id="needsInstall"'*'schedulingdash.js'*) ok ;; *) fail "the Scheduling notes page has no Needs install date" ;; esac

echo "--- lead 0: not placed; all ordered moves it to Ready to cut ---"
req PUT /api/settings "$ADMIN" '{"board":{"leadWeeks":0}}'
m24_job "$M24_TAG unplaced"
M24_U=$M24_ID
req POST "/api/job-records/$M24_U/project/send" "$DPM" '{}'
expect_status 200 "sent"
expect_jq '.depositDue == true and .placed == null and .job.pipelineStage == "ordering"' "deposit due, not placed, at Ordering"
for M24_L in $(m24_q "SELECT id FROM orders WHERE job_id = ? AND status = 'to_order' ORDER BY id" "$M24_U" | jq -r '.[].id'); do
  req PATCH "/api/orders/$M24_L" "$ORDR" '{"status":"ordered"}'
done
req GET "/api/job-records/$M24_U" "$DPM"
expect_jq '.stage == "ready_to_cut" and .inBacklog == true' "Ready to cut, in To start"
req PUT /api/settings "$ADMIN" '{"board":{"leadWeeks":2}}'

echo "--- the quick-add fallback ---"
req POST /api/rows "$SCHED" "{\"weekStart\":\"$M24_W2\",\"panel\":\"manufacturing\",\"jobName\":\"$M24_TAG quick\"}"
expect_status 201 "a board quick add"
M24_Q=$(m24_q "SELECT id FROM jobs WHERE name = ?" "$M24_TAG quick" | jq -r '.[0].id')
expect_eq "$(m24_q "SELECT due_reason, due_trigger FROM invoices WHERE job_id = ? AND kind = 'deposit'" "$M24_Q" | jq -c '.')" '[{"due_reason":"scheduled","due_trigger":null}]' "the deposit still comes from placing it"

echo "--- the 7:00 ETA nudge ---"
req POST "/api/job-records/$M24_U/orders" "$DPM" "{\"supplier\":\"M24 Late Co\",\"description\":\"late line\",\"expectedDate\":\"$M24_PAST\"}"
[ "$STATUS" = "201" ] || [ "$STATUS" = "200" ] || fail "a late order line: $STATUS $BODY"
ok
req POST /api/tasks/reminder/run "$ADMIN" '{}'
expect_status 200 "run the 7:00 reminder"
expect_jq '.etaNudges >= 1' "the order managers were nudged"
req GET "/api/notifications?limit=50" "$ORDR"
expect_jq '[.rows[] | select(.kind == "orders.eta_nudge" and .link == "/orders.html" and (.title | contains("past the expected date")))] | length >= 1' "ordr sees the nudge"
