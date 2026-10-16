# M7 smoke, Wave 1 B: the automatic planner events (lib/planner/auto.js).
# Sourced by ci/smoke.sh after the M7 users are made, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok), the cookie jars ($ADMIN $SCHED $ACCT $DPM
# $SHOW $WSHOP $ACCT2 $MULTI) and $BASE. No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: it makes its own jobs, rows, worker, leave, invoices and
# task in June 2035 (clear of the other suites) and checks only those ids. The overdue invoice is
# made through the M2 routes (a draft's dueDate can be set in the past before it is issued), so no
# direct database write is needed. Contract: docs/plans/m7-contracts.md sections 8, 9 and 15.3.

# ============================================================================
step "m7-auto. automatic events"
# ============================================================================

# 2035-06-04 is a Monday: Tue 06-05, Wed 06-06, Thu 06-07, Fri 06-08, Sat 06-09, Mon 06-11.
M7A_MON=2035-06-04
M7A_FROM=2035-06-01
M7A_TO=2035-06-30
# "Today" is always the server's Sydney date, never the runner's clock (a run can cross Sydney
# midnight). M7A_YESTERDAY is fixed once: the overdue invoice is backdated to it.
m7a_server_today() {
  req GET /api/planner/layers "$ADMIN"
  expect_status 200 "admin reads the server's today"
  M7A_TODAY=$(jqr '.today')
}
m7a_server_today
M7A_YESTERDAY=$(date -u -d "$M7A_TODAY - 1 day" +%F)
M7A_CLIENT="CI M7A Secret Client"
M7A_ADDR="77 M7A Hidden Lane"
M7A_VALUE=4242421
M7A_SUPPLIER="CI M7A Secret Supplier"
M7A_HOST="CI M7A Secret Host"
M7A_LNOTE="CI M7A private leave note"
# Every automatic item is read-only and carries no reminder, series or author.
M7A_RO='.readOnly == true and .canEdit == false and .eventId == null and .occurrence == null and .reminder == null and .remindLayer == false and .repeat == "none" and .repeatUntil == null and .changed == false and .notes == "" and .createdBy == null and .updatedAt == null'

# m7a_get JAR FROM TO [LAYERS]: GET /api/planner/events, expecting 200.
m7a_get() {
  local q="/api/planner/events?from=$2&to=$3"
  if [ -n "${4:-}" ]; then q="$q&layers=$4"; fi
  req GET "$q" "$1"
  expect_status 200 "GET $q"
}
# m7a_one ID FILTER WHAT: exactly one item with that id in the last response, and FILTER holds on it.
m7a_one() {
  expect_jq "[.events[] | select(.id == \"$1\")] | length == 1 and (.[0] | $2)" "$3"
}
# m7a_none ID WHAT: no item with that id in the last response.
m7a_none() {
  expect_jq "[.events[] | select(.id == \"$1\")] | length == 0" "$2"
}
# m7a_issue INVOICE_ID: issues as acct; sets the business details first if no earlier suite has.
m7a_issue() {
  req POST "/api/invoices/$1/issue" "$ACCT" '{}'
  if [ "$STATUS" = 409 ] && [[ $BODY == *"Business details"* ]]; then
    req PUT /api/settings "$ADMIN" \
      '{"business":{"tradingName":"Crosscuts CI Joinery","abn":"51824753556","address":"1 Workshop Rd, Sydney NSW 2000","phone":"0200000000","email":"accounts@example.test","bankAccountName":"Crosscuts CI","bsb":"062000","accountNumber":"12345678"},"invoice":{"termsText":"Payment within 10 days."}}'
    expect_status 200 "admin sets the business details"
    req POST "/api/invoices/$1/issue" "$ACCT" '{}'
  fi
  expect_status 200 "issue invoice $1"
  M7A_NUM=$(jqr '.number')
}

req GET /api/auth/me "$ACCT"
expect_status 200 "me as acct"
M7A_ACCT_ID=$(jqr '.user.id')

echo "--- seed: jobs, orders, inspections, board, leave, invoices, a task ---"
req POST /api/job-records "$ADMIN" \
  "$(jq -nc --arg c "$M7A_CLIENT" --arg a "$M7A_ADDR" --argjson v "$M7A_VALUE" \
    '{name:"CI M7A Alpha kitchen",clientName:$c,siteAddress:$a,valueCents:$v,promisedInstallDate:"2035-06-08"}')"
expect_status 201 "job A with a promised install date"
M7A_JA=$(jqr '.id')
req POST /api/job-records "$ADMIN" '{"name":"CI M7A Beta laundry"}'
expect_status 201 "job B"
M7A_JB=$(jqr '.id')
req POST "/api/job-records/$M7A_JA/materials-ordered" "$ADMIN" '{"date":"2035-06-01"}'
expect_status 200 "job A materials marked ordered"

M7A_LINES=()
for exp in 2035-06-07 2035-06-07 2035-06-08; do
  req POST "/api/job-records/$M7A_JA/orders" "$ADMIN" \
    "$(jq -nc --arg s "$M7A_SUPPLIER" --arg e "$exp" '{supplier:$s,description:"CI M7A board stock",expectedDate:$e}')"
  expect_status 201 "an order line expected $exp"
  M7A_LINES+=("$(jqr '.order.id')")
done
for l in "${M7A_LINES[@]}"; do
  req PATCH "/api/orders/$l" "$ADMIN" '{"status":"ordered"}'
  expect_status 200 "order line $l ordered"
done

req POST "/api/job-records/$M7A_JA/inspections" "$DPM" \
  "$(jq -nc --arg h "$M7A_HOST" '{date:"2035-06-06",time:"10:30",host:$h,notes:"CI M7A inspection note"}')"
expect_status 201 "a booked inspection with a time"
M7A_I1=$(jqr '.id')
req POST "/api/job-records/$M7A_JA/inspections" "$DPM" '{"date":"2035-06-07"}'
expect_status 201 "a booked inspection without a time"
M7A_I2=$(jqr '.id')

req POST /api/workers "$ADMIN" '{"name":"CI M7A Sam"}'
expect_status 201 "a board worker"
M7A_W=$(jqr '.id')
req POST /api/workers "$ADMIN" '{"name":"CI M7A Retired"}'
expect_status 201 "a second worker, to be archived"
M7A_WOLD=$(jqr '.id')
req POST /api/rows "$ADMIN" "{\"weekStart\":\"$M7A_MON\",\"panel\":\"manufacturing\",\"jobId\":$M7A_JA}"
expect_status 201 "job A in manufacturing"
req POST /api/rows "$ADMIN" "{\"weekStart\":\"$M7A_MON\",\"panel\":\"installing\",\"jobId\":$M7A_JB}"
expect_status 201 "job B installing"
M7A_ROWI=$(jqr '.rowId')
for d in tue thu; do
  req POST "/api/rows/$M7A_ROWI/assignments" "$ADMIN" "{\"day\":\"$d\",\"workerId\":$M7A_W}"
  expect_status 201 "assign the worker on $d"
done

# Thursday to the next Tuesday: two weekday runs either side of the weekend.
req POST /api/availability/leave "$ADMIN" \
  "$(jq -nc --argjson w "$M7A_W" --arg n "$M7A_LNOTE" '{workerId:$w,from:"2035-06-07",to:"2035-06-12",kind:"sick",note:$n}')"
expect_status 201 "leave over a weekend"
M7A_LEAVE=$(jqr '.id')
req POST /api/availability/leave "$ADMIN" "{\"workerId\":$M7A_WOLD,\"from\":\"2035-06-07\",\"to\":\"2035-06-07\",\"kind\":\"leave\"}"
expect_status 201 "leave for the worker about to be archived"
req PATCH "/api/workers/$M7A_WOLD" "$ADMIN" '{"archived":true}'
expect_status 200 "archive that worker"

req POST /api/job-records "$ADMIN" \
  "$(jq -nc --arg c "$M7A_CLIENT" '{name:"CI M7A Gamma robes",clientName:$c,valueCents:300000}')"
expect_status 201 "job C (invoice due in range)"
M7A_JC=$(jqr '.id')
req POST /api/job-records "$ADMIN" \
  "$(jq -nc --arg c "$M7A_CLIENT" '{name:"CI M7A Delta vanity",clientName:$c,valueCents:200000}')"
expect_status 201 "job D (overdue invoice)"
M7A_JD=$(jqr '.id')
req POST /api/invoices "$ACCT" "{\"jobId\":$M7A_JC,\"kind\":\"deposit\"}"
expect_status 201 "a deposit for job C"
M7A_INVC=$(jqr '.id')
req PATCH "/api/invoices/$M7A_INVC" "$ACCT" '{"dueDate":"2035-06-15"}'
expect_status 200 "job C's deposit due 2035-06-15"
m7a_issue "$M7A_INVC"
M7A_NUMC=$M7A_NUM
req POST /api/invoices "$ACCT" "{\"jobId\":$M7A_JD,\"kind\":\"deposit\"}"
expect_status 201 "a deposit for job D"
M7A_INVD=$(jqr '.id')
req PATCH "/api/invoices/$M7A_INVD" "$ACCT" "{\"dueDate\":\"$M7A_YESTERDAY\"}"
expect_status 200 "job D's deposit due yesterday"
m7a_issue "$M7A_INVD"
expect_jq '.overdue == true' "job D's deposit is overdue once issued"

req POST /api/tasks "$ACCT" "{\"title\":\"CI M7A chase the stone\",\"assigneeId\":$M7A_ACCT_ID,\"dueDate\":\"2035-06-08\"}"
expect_status 201 "an open task for acct due in range"
M7A_TASK=$(jqr '.id')

echo "--- each source on its layer (as admin) ---"
m7a_get "$ADMIN" "$M7A_FROM" "$M7A_TO"
m7a_one "a:promised_install:$M7A_JA" \
  ".layer == \"install\" and .source == \"promised_install\" and .sourceLabel == \"Job\" and .title == \"Promised install: CI M7A Alpha kitchen\" and .allDay == true and .start == \"2035-06-08\" and .end == \"2035-06-08\" and .startTime == null and .job.id == $M7A_JA and .link == \"/job.html?id=$M7A_JA\" and .overdue == false and $M7A_RO" \
  "promised install item"
m7a_one "a:materials_ordered:$M7A_JA" \
  ".layer == \"install\" and .sourceLabel == \"Orders\" and .title == \"Materials ordered: CI M7A Alpha kitchen\" and .start == \"2035-06-01\" and .link == \"/job.html?id=$M7A_JA#orders\" and $M7A_RO" \
  "materials ordered item"
m7a_one "a:materials_due:$M7A_JA:2035-06-07" \
  ".layer == \"install\" and .sourceLabel == \"Orders\" and .title == \"Materials due: CI M7A Alpha kitchen (2 lines)\" and .start == \"2035-06-07\" and .allDay == true and $M7A_RO" \
  "materials due: two lines on one date"
m7a_one "a:materials_due:$M7A_JA:2035-06-08" '.title == "Materials due: CI M7A Alpha kitchen (1 line)"' "materials due: one line"
m7a_one "a:inspection:$M7A_I1" \
  ".layer == \"install\" and .sourceLabel == \"Inspection\" and .title == \"Inspection: CI M7A Alpha kitchen\" and .allDay == false and .start == \"2035-06-06\" and .startTime == \"10:30\" and .endTime == null and .link == \"/job.html?id=$M7A_JA#inspection\" and $M7A_RO" \
  "timed inspection"
m7a_one "a:inspection:$M7A_I2" '.allDay == true and .startTime == null and .start == "2035-06-07"' "inspection without a time is all-day"
expect_jq "[.events[] | select(.source == \"leave\" and (.id | startswith(\"a:leave:$M7A_LEAVE:\")))] | map([.id, .start, .end, .title, .layer, .sourceLabel, .allDay]) == [[\"a:leave:$M7A_LEAVE:2035-06-07\",\"2035-06-07\",\"2035-06-08\",\"CI M7A Sam away\",\"company\",\"Availability\",true],[\"a:leave:$M7A_LEAVE:2035-06-11\",\"2035-06-11\",\"2035-06-12\",\"CI M7A Sam away\",\"company\",\"Availability\",true]]" \
  "leave over a weekend comes back as two weekday runs"
expect_jq '[.events[] | select(.title == "CI M7A Retired away")] | length == 0' "an archived worker's leave is left out"
m7a_one "a:invoice_due:$M7A_INVC" \
  ".layer == \"accounts\" and .sourceLabel == \"Accounts\" and .title == \"$M7A_NUMC due: CI M7A Gamma robes\" and .start == \"2035-06-15\" and .overdue == false and .link == \"/accounts.html?invoice=$M7A_INVC\" and $M7A_RO" \
  "invoice due item"
m7a_none "a:task_due:$M7A_TASK" "admin does not see acct's task"
expect_jq "[.weeks[] | select(.weekStart == \"$M7A_MON\")] | length == 1" "one band entry for the CI week"
expect_jq "[.weeks[] | select(.weekStart == \"$M7A_MON\") | .manufacturing[] | select(.jobId == $M7A_JA)] == [{\"jobId\":$M7A_JA,\"name\":\"CI M7A Alpha kitchen\",\"link\":\"/job.html?id=$M7A_JA\"}]" \
  "the band lists job A once in manufacturing"
expect_jq "[.weeks[] | select(.weekStart == \"$M7A_MON\") | .installing[] | select(.jobId == $M7A_JB)] == [{\"jobId\":$M7A_JB,\"name\":\"CI M7A Beta laundry\",\"link\":\"/job.html?id=$M7A_JB\",\"days\":[\"2035-06-05\",\"2035-06-07\"]}]" \
  "the band lists job B installing, with exactly the Tue and Thu dates"
expect_jq '[.events[].start] as $s | [range(1; $s | length) | $s[. - 1] <= $s[.]] | all' "events are sorted by start"

echo "--- nothing private ---"
expect_jq '[.. | objects | select(has("kind") or has("note") or has("supplier") or has("host") or has("valueCents") or has("clientName"))] | length == 0' \
  "no item carries kind, note, supplier, host, value or client fields"
for s in "$M7A_CLIENT" "$M7A_ADDR" "$M7A_VALUE" "$M7A_SUPPLIER" "$M7A_HOST" "$M7A_LNOTE" "CI M7A inspection note" "CI M7A board stock" "sick"; do
  if [[ $BODY == *"$s"* ]]; then fail "the planner response contains private text: $s"; fi
  ok
done

echo "--- who sees what ---"
for pair in "admin:$ADMIN" "acct:$ACCT" "acct2:$ACCT2" "multi:$MULTI"; do
  who=${pair%%:*}; jar=${pair#*:}
  m7a_get "$jar" "$M7A_FROM" "$M7A_TO"
  m7a_one "a:invoice_due:$M7A_INVC" '.layer == "accounts"' "$who sees the invoice"
done
for pair in "dpm:$DPM" "sched:$SCHED" "wshop:$WSHOP"; do
  who=${pair%%:*}; jar=${pair#*:}
  m7a_get "$jar" "$M7A_FROM" "$M7A_TO"
  m7a_none "a:invoice_due:$M7A_INVC" "$who does not see the invoice"
  m7a_get "$jar" "$M7A_FROM" "$M7A_TO" "accounts,install,company"
  expect_jq '[.events[] | select(.layer == "accounts")] | length == 0' "$who can't widen to accounts with layers="
  m7a_get "$jar" "$M7A_YESTERDAY" "$M7A_TODAY"
  expect_jq '[.events[] | select(.source == "invoices_overdue" or .source == "invoice_due")] | length == 0' "$who gets no invoice items even today"
done
for pair in "admin:$ADMIN" "acct:$ACCT" "acct2:$ACCT2" "multi:$MULTI" "dpm:$DPM" "sched:$SCHED" "wshop:$WSHOP"; do
  who=${pair%%:*}; jar=${pair#*:}
  m7a_get "$jar" "$M7A_FROM" "$M7A_TO"
  if [ "$who" = acct ]; then
    m7a_one "a:task_due:$M7A_TASK" \
      ".layer == \"personal\" and .sourceLabel == \"Tasks\" and .title == \"Task due: CI M7A chase the stone\" and .start == \"2035-06-08\" and .allDay == true and .link == \"/tasks.html?task=$M7A_TASK\" and $M7A_RO" \
      "acct sees its own task due"
  else
    m7a_none "a:task_due:$M7A_TASK" "$who does not see acct's task"
  fi
  m7a_one "a:promised_install:$M7A_JA" '.layer == "install"' "$who sees the promised install"
  m7a_one "a:inspection:$M7A_I1" '.layer == "install"' "$who sees the inspection"
  m7a_one "a:leave:$M7A_LEAVE:2035-06-07" '.layer == "company"' "$who sees who's away"
  expect_jq "[.weeks[] | select(.weekStart == \"$M7A_MON\")] | length == 1" "$who sees the board band"
done
req GET "/api/planner/events?from=$M7A_FROM&to=$M7A_TO" "$SHOW"
expect_status 403 "show has no planner"

echo "--- links per viewer ---"
m7a_get "$SCHED" "$M7A_FROM" "$M7A_TO"
m7a_one "a:materials_due:$M7A_JA:2035-06-07" ".link == \"/job.html?id=$M7A_JA#orders\"" "sched: materials link to the job's orders"
m7a_one "a:materials_ordered:$M7A_JA" ".link == \"/job.html?id=$M7A_JA#orders\"" "sched: materials ordered link"
m7a_one "a:leave:$M7A_LEAVE:2035-06-07" '.link == null' "sched (no users.admin since 2026-10-16): no Availability link"
m7a_get "$ADMIN" "$M7A_FROM" "$M7A_TO"
m7a_one "a:leave:$M7A_LEAVE:2035-06-07" '.link == "/availability.html"' "admin: who's away links to Availability"
m7a_get "$WSHOP" "$M7A_FROM" "$M7A_TO"
for id in "a:promised_install:$M7A_JA" "a:materials_ordered:$M7A_JA" "a:materials_due:$M7A_JA:2035-06-07" "a:inspection:$M7A_I1"; do
  m7a_one "$id" '.link == null' "wshop: no link on $id"
done
expect_jq "[.weeks[] | select(.weekStart == \"$M7A_MON\") | (.manufacturing + .installing)[] | select(.jobId == $M7A_JA or .jobId == $M7A_JB) | .link] == [\"/schedule.html\",\"/schedule.html\"]" \
  "wshop: the band links to the board"
m7a_one "a:leave:$M7A_LEAVE:2035-06-07" '.link == null' "wshop: no Availability link"
m7a_get "$ACCT" "$M7A_FROM" "$M7A_TO"
m7a_one "a:invoice_due:$M7A_INVC" ".link == \"/accounts.html?invoice=$M7A_INVC\"" "acct: the invoice link"
m7a_one "a:leave:$M7A_LEAVE:2035-06-07" '.link == null' "acct (no users.admin): no Availability link"

echo "--- layers= narrows ---"
m7a_get "$ADMIN" "$M7A_FROM" "$M7A_TO" "company"
expect_jq '(.weeks | length) == 0 and ([.events[] | select(.layer != "company")] | length) == 0' "admin layers=company: no band, company items only"
m7a_get "$DPM" "$M7A_FROM" "$M7A_TO" "accounts"
expect_jq '(.events | length) == 0 and (.weeks | length) == 0' "dpm layers=accounts gives nothing"

echo "--- today: the overdue line ---"
req GET /api/invoices/overdue "$ACCT"
expect_status 200 "the overdue list"
M7A_OD=$(jqr 'length')
[ "$M7A_OD" -ge 1 ] || fail "the overdue list should hold job D's deposit"
ok
if [ "$M7A_OD" = 1 ]; then M7A_ODT="1 invoice overdue"; else M7A_ODT="$M7A_OD invoices overdue"; fi
m7a_server_today
for pair in "admin:$ADMIN" "acct:$ACCT" "acct2:$ACCT2" "multi:$MULTI"; do
  who=${pair%%:*}; jar=${pair#*:}
  m7a_get "$jar" "$M7A_YESTERDAY" "$M7A_TODAY"
  m7a_one "a:invoices_overdue:$M7A_TODAY" \
    ".layer == \"accounts\" and .sourceLabel == \"Accounts\" and .title == \"$M7A_ODT\" and .start == \"$M7A_TODAY\" and .allDay == true and .overdue == true and .link == \"/accounts.html?view=overdue\" and .job == null and $M7A_RO" \
    "$who: the overdue line on today"
  m7a_one "a:invoice_due:$M7A_INVD" ".overdue == true and .start == \"$M7A_YESTERDAY\"" "$who: the past-due invoice is marked overdue"
done
m7a_get "$ACCT" "$M7A_FROM" "$M7A_TO"
expect_jq '[.events[] | select(.source == "invoices_overdue")] | length == 0' "no overdue line when the range doesn't cover today"

echo "--- range edges and the cap ---"
m7a_get "$ADMIN" 2035-06-08 2035-06-08
expect_jq "[.weeks[] | select(.weekStart == \"$M7A_MON\") | .installing[] | select(.jobId == $M7A_JB) | .days] == [[]]" \
  "a one-day range keeps the band (Monday before) but only days inside the range"
m7a_one "a:promised_install:$M7A_JA" '.start == "2035-06-08"' "a one-day range has that day's items"
m7a_none "a:inspection:$M7A_I1" "a one-day range leaves out other days"
m7a_one "a:leave:$M7A_LEAVE:2035-06-08" '.start == "2035-06-08" and .end == "2035-06-08"' "a leave run is clipped to the range (start key moves with it)"
m7a_get "$ADMIN" 2035-06-09 2035-06-10
expect_jq "[.events[] | select(.id | startswith(\"a:leave:$M7A_LEAVE:\"))] | length == 0" "leave over a weekend-only range gives nothing"
m7a_get "$ADMIN" 2035-06-10 2035-06-11
expect_jq "[.weeks[].weekStart] | index(\"$M7A_MON\") != null" "a Sunday 'from' still shows its week's band"
req GET "/api/planner/events?from=2035-06-01&to=2035-08-01" "$ADMIN"
expect_status 200 "62 days is allowed"
req GET "/api/planner/events?from=2035-06-01&to=2035-08-02" "$ADMIN"
expect_status 400 "63 days is refused"

echo "--- stays in step with its source ---"
req PATCH "/api/orders/${M7A_LINES[2]}" "$ADMIN" '{"expectedDate":"2035-06-20"}'
expect_status 200 "move one order line's expected date"
req PATCH "/api/job-records/$M7A_JA" "$ADMIN" '{"promisedInstallDate":"2035-06-15"}'
expect_status 200 "change the promised install date"
m7a_get "$ADMIN" "$M7A_FROM" "$M7A_TO"
m7a_none "a:materials_due:$M7A_JA:2035-06-08" "the old expected date is gone"
m7a_one "a:materials_due:$M7A_JA:2035-06-20" '.title == "Materials due: CI M7A Alpha kitchen (1 line)"' "the line shows on its new date"
m7a_one "a:promised_install:$M7A_JA" '.start == "2035-06-15"' "the promised install follows its date"

req POST "/api/inspections/$M7A_I1/cancel" "$DPM" '{}'
expect_status 200 "cancel the timed inspection"
req DELETE "/api/availability/leave/$M7A_LEAVE" "$ADMIN"
expect_status 204 "remove the leave"
req POST "/api/invoices/$M7A_INVC/paid" "$ACCT" '{}'
expect_status 200 "mark job C's deposit paid"
req POST "/api/tasks/$M7A_TASK/done" "$ACCT" '{}'
expect_status 200 "mark the task done"
req PATCH "/api/rows/$M7A_ROWI/move" "$ADMIN" '{"week":"next"}'
expect_status 200 "move job B's installing row to the next week"
m7a_get "$ADMIN" "$M7A_FROM" "$M7A_TO"
m7a_none "a:inspection:$M7A_I1" "the cancelled inspection is gone"
m7a_one "a:inspection:$M7A_I2" '.start == "2035-06-07"' "the other inspection stays"
expect_jq "[.events[] | select(.id | startswith(\"a:leave:$M7A_LEAVE:\"))] | length == 0" "the removed leave is gone"
m7a_none "a:invoice_due:$M7A_INVC" "the paid invoice is gone"
expect_jq "[.weeks[] | select(.weekStart == \"$M7A_MON\") | .installing[] | select(.jobId == $M7A_JB)] | length == 0" "job B left the old week's band"
expect_jq "[.weeks[] | select(.weekStart == \"2035-06-11\") | .installing[] | select(.jobId == $M7A_JB)] | length == 1" "job B is in the next week's band"
m7a_get "$ACCT" "$M7A_FROM" "$M7A_TO"
m7a_none "a:task_due:$M7A_TASK" "the done task is gone"

for l in "${M7A_LINES[@]}"; do
  req PATCH "/api/orders/$l" "$ADMIN" '{"status":"received"}'
  expect_status 200 "receive order line $l"
done
m7a_get "$ADMIN" "$M7A_FROM" "$M7A_TO"
expect_jq "[.events[] | select(.source == \"materials_due\" and .job.id == $M7A_JA)] | length == 0" "received lines are no longer due"
# Received dates can't be in the future, so materials in lands on today.
m7a_server_today
m7a_get "$ADMIN" "$M7A_YESTERDAY" "$M7A_TODAY"
m7a_one "a:materials_in:$M7A_JA" \
  ".layer == \"install\" and .sourceLabel == \"Orders\" and .title == \"Materials in: CI M7A Alpha kitchen\" and .start == \"$M7A_TODAY\" and .link == \"/job.html?id=$M7A_JA#orders\" and $M7A_RO" \
  "materials in on the day every line was received"

req PATCH "/api/job-records/$M7A_JA" "$ADMIN" '{"archived":true}'
expect_status 200 "archive job A"
m7a_get "$ADMIN" "$M7A_FROM" "$M7A_TO"
m7a_none "a:promised_install:$M7A_JA" "an archived job's promised install is gone"
m7a_none "a:materials_ordered:$M7A_JA" "an archived job's materials ordered is gone"
m7a_none "a:inspection:$M7A_I2" "an archived job's inspection is gone"
m7a_get "$ADMIN" "$M7A_YESTERDAY" "$M7A_TODAY"
m7a_none "a:materials_in:$M7A_JA" "an archived job's materials in is gone"
