# M3 smoke, Wave 1 B: orders, materials dates and client inspections.
# Sourced by ci/smoke.sh after the M2 suites, so it shares that script's
# helpers (step, req, expect_status, expect_jq, expect_eq, jqr, fail, ok), the
# cookie jars ($ADMIN $SCHED $ACCT $DPM $SHOW) and $CONTAINER. No shebang and
# no `set`: the caller owns both. It does not assume a pristine database: it
# makes its own jobs and checks only their rows.
# Contract: docs/plans/m3-contracts.md section 8 (and 11.8).

# ============================================================================
step "m3-b. orders and inspections"
# ============================================================================

M3B_TODAY=$(TZ=Australia/Sydney date +%F)
M3B_YESTERDAY=$(date -u -d "$M3B_TODAY - 1 day" +%F)
M3B_PLUS3=$(date -u -d "$M3B_TODAY + 3 days" +%F)
M3B_PLUS4=$(date -u -d "$M3B_TODAY + 4 days" +%F)
M3B_PLUS5=$(date -u -d "$M3B_TODAY + 5 days" +%F)

# How many notifications of KIND that JAR's user has for job JOB_ID.
m3b_notifs() { # JAR KIND JOB_ID
  req GET "/api/notifications?limit=100" "$1"
  expect_status 200 "GET /api/notifications"
  M3B_N=$(jqr "[.rows[] | select(.kind == \"$2\" and (.link | test(\"[?]id=$3#\")))] | length")
}

# The live (not void) progress invoices of a job, as the admin -> BODY.
m3b_progress() { # JOB_ID
  req GET "/api/invoices/job/$1" "$ADMIN"
  expect_status 200 "GET /api/invoices/job/$1"
  M3B_PROGRESS=$(jqr '[.[] | select(.kind == "progress" and .status != "void")] | length')
}

# A job as the admin (with a value) -> M3B_JOB.
m3b_job() { # NAME [TWO_PAC true|false]
  req POST /api/job-records "$ADMIN" \
    "{\"name\":\"$1\",\"clientName\":\"CI M3 Client\",\"valueCents\":2000000,\"isTwoPac\":${2:-false}}"
  expect_status 201 "create job $1"
  M3B_JOB=$(jqr '.id')
}

# A line on a job as dpm -> M3B_LINE.
m3b_line() { # JOB_ID SUPPLIER [EXPECTED_DATE]
  local exp=""
  if [ -n "${3:-}" ]; then exp=",\"expectedDate\":\"$3\""; fi
  req POST "/api/job-records/$1/orders" "$DPM" \
    "{\"supplier\":\"$2\",\"description\":\"CI line\"$exp}"
  expect_status 201 "dpm adds a line ($2) to job $1"
  M3B_LINE=$(jqr '.order.id')
}

m3b_audit_min() { # ACTION ENTITY_ID MIN
  req GET "/api/audit?action=$1&entityType=order&entityId=$2&limit=1" "$ADMIN"
  expect_status 200 "GET /api/audit?action=$1"
  local n
  n=$(jqr '.total')
  [ "$n" -ge "$3" ] || fail "expected at least $3 '$1' audit rows for order $2, got $n"
  ok
}

echo "--- access ---"
req GET /api/orders "$SCHED"
expect_status 200 "sched GET /api/orders"
req GET /api/orders "$ACCT"
expect_status 200 "acct GET /api/orders"
req GET /api/orders "$SHOW"
expect_status 403 "show GET /api/orders"
req GET "/api/orders?status=bogus" "$ADMIN"
expect_status 400 "a bad status filter"
req GET /api/orders/suppliers "$SHOW"
expect_status 403 "show GET /api/orders/suppliers"
req GET /api/scheduling/upcoming "$ACCT"
expect_status 403 "acct GET /api/scheduling/upcoming"
req GET /api/scheduling/upcoming "$SHOW"
expect_status 403 "show GET /api/scheduling/upcoming"

m3b_job "CI M3 Orders Job" true
M3B_J=$M3B_JOB

for jar in "$SCHED" "$ACCT" "$SHOW"; do
  req POST "/api/job-records/$M3B_J/orders" "$jar" '{"supplier":"M3 Supply Co"}'
  expect_status 403 "a user without orders.edit adds a line"
done
req GET "/api/job-records/$M3B_J/orders" "$SHOW"
expect_status 403 "show lists a job's lines"
req GET "/api/job-records/$M3B_J/orders" "$SCHED"
expect_status 200 "sched lists a job's lines"
expect_jq 'length == 0' "a new job has no lines"
req GET /api/job-records/999999/orders "$ADMIN"
expect_status 404 "lines of an unknown job"
req POST /api/job-records/999999/orders "$DPM" '{"supplier":"M3 Supply Co"}'
expect_status 404 "add a line to an unknown job"

echo "--- adding lines ---"
req POST "/api/job-records/$M3B_J/orders" "$DPM" '{"description":"no supplier"}'
expect_status 400 "a line needs a supplier"
req POST "/api/job-records/$M3B_J/orders" "$DPM" '{"supplier":"  "}'
expect_status 400 "a blank supplier"
req POST "/api/job-records/$M3B_J/orders" "$DPM" '{"supplier":"M3 Supply Co","expectedDate":"2030-02-31"}'
expect_status 400 "an impossible expected date"

# Line 1 is overdue (expected yesterday); line 2 is due in 5 days.
m3b_line "$M3B_J" "M3 Supply Co" "$M3B_YESTERDAY"
M3B_L1=$M3B_LINE
expect_jq '.order.status == "to_order" and .order.overdue == true and .order.createdByName == "CI Design PM" and .order.supplier == "M3 Supply Co"' \
  "line 1 is to_order, overdue and attributed"
expect_jq '.job.id == '"$M3B_J"' and .job.materialsOrderedDate == null and .job.materialsInDate == null' "the mutation response carries the job dates"
m3b_line "$M3B_J" "M3 Supply Co" "$M3B_PLUS5"
M3B_L2=$M3B_LINE
expect_jq '.order.overdue == false' "line 2 is not overdue"

echo "--- who can mark a line ordered ---"
req PATCH "/api/orders/$M3B_L1" "$DPM" '{"status":"ordered"}'
expect_status 403 "dpm marks a line ordered"
req PATCH "/api/orders/$M3B_L1" "$SCHED" '{"status":"ordered"}'
expect_status 403 "sched marks a line ordered"
req PATCH "/api/orders/$M3B_L1" "$DPM" '{"status":"cancelled"}'
expect_status 400 "PATCH status cancelled is Use cancel"
req PATCH "/api/orders/$M3B_L1" "$DPM" '{"status":"bogus"}'
expect_status 400 "an unknown status"
req PATCH "/api/orders/$M3B_L1" "$DPM" '{"notes":"edited by dpm"}'
expect_status 200 "dpm edits the notes"
expect_jq '.order.notes == "edited by dpm"' "the notes changed"
req PATCH /api/orders/999999 "$ADMIN" '{"notes":"x"}'
expect_status 404 "PATCH an unknown line"

echo "--- the progress invoice is due exactly once ---"
m3b_progress "$M3B_J"
expect_eq "$M3B_PROGRESS" "0" "no progress invoice before anything is ordered"
req PATCH "/api/orders/$M3B_L1" "$ADMIN" '{"status":"ordered"}'
expect_status 200 "admin orders line 1"
expect_jq ".order.status == \"ordered\" and .order.orderedDate == \"$M3B_TODAY\" and .job.materialsOrderedDate == null" \
  "line 1 is ordered and the job date is still empty"
m3b_progress "$M3B_J"
expect_eq "$M3B_PROGRESS" "0" "no progress invoice while a line is still to order"

req PATCH "/api/orders/$M3B_L2" "$ADMIN" '{"status":"ordered"}'
expect_status 200 "admin orders line 2"
expect_jq ".job.materialsOrderedDate == \"$M3B_TODAY\"" "ordering the last line sets the job's materials-ordered date"
req GET "/api/invoices/job/$M3B_J" "$ADMIN"
expect_status 200 "GET /api/invoices/job"
expect_jq '[.[] | select(.kind == "progress" and .status == "due" and .dueReason == "materials_ordered")] | length == 1' \
  "exactly one progress invoice is due, for materials_ordered"
expect_jq '[.[] | select(.kind == "progress" and .status != "void")] | length == 1' "and it is the only live progress invoice"

req POST "/api/job-records/$M3B_J/materials-ordered" "$ADMIN" '{}'
expect_status 409 "the Materials ordered button after the orders path"

# Upcoming materials: both ordered lines (line 1 flagged overdue).
req GET /api/scheduling/upcoming "$SCHED"
expect_status 200 "sched GET /api/scheduling/upcoming"
expect_jq ".from == \"$M3B_TODAY\" and .to == \"$(date -u -d "$M3B_TODAY + 13 days" +%F)\"" "upcoming covers 14 days"
expect_jq ".materials | map(select(.id == $M3B_L2)) | .[0] | .expectedDate == \"$M3B_PLUS5\" and .overdue == false and .jobId == $M3B_J and .supplier == \"M3 Supply Co\"" \
  "an ordered line due in 5 days is in upcoming.materials"
expect_jq ".materials | map(select(.id == $M3B_L1)) | .[0].overdue == true" "an overdue ordered line is flagged"
req GET /api/scheduling/upcoming "$DPM"
expect_status 200 "dpm GET /api/scheduling/upcoming"

m3b_line "$M3B_J" "M3 Supply Co"
M3B_L3=$M3B_LINE
req PATCH "/api/orders/$M3B_L3" "$ADMIN" '{"status":"ordered"}'
expect_status 200 "admin orders line 3"
expect_jq ".job.materialsOrderedDate == \"$M3B_TODAY\"" "the job date is unchanged"
m3b_progress "$M3B_J"
expect_eq "$M3B_PROGRESS" "1" "still exactly one live progress invoice after a later line is ordered"

echo "--- undo: ordered back to to_order ---"
m3b_line "$M3B_J" "M3 Undo Co"
M3B_LU=$M3B_LINE
req PATCH "/api/orders/$M3B_LU" "$ADMIN" '{"status":"ordered"}'
expect_status 200 "admin orders the undo line"
req PATCH "/api/orders/$M3B_LU" "$DPM" '{"status":"to_order"}'
expect_status 403 "dpm undoes an ordered line"
req PATCH "/api/orders/$M3B_LU" "$ADMIN" '{"status":"to_order"}'
expect_status 200 "admin undoes it"
expect_jq '.order.status == "to_order" and .order.orderedDate == null and .job.materialsOrderedDate != null' \
  "the line is to_order again; the job's date is not undone"
req POST "/api/orders/$M3B_LU/cancel" "$DPM" '{}'
expect_status 200 "dpm cancels the undo line"

echo "--- materials in ---"
m3b_line "$M3B_J" "M3 Timber"
M3B_L4=$M3B_LINE
req PATCH "/api/orders/$M3B_L4" "$DPM" '{"status":"received"}'
expect_status 409 "received straight from to_order"
expect_jq '.error == "Mark it ordered first"' "and says why"
req POST "/api/orders/$M3B_L4/cancel" "$SCHED" '{}'
expect_status 403 "sched cancels a line"
req POST "/api/orders/$M3B_L4/cancel" "$DPM" '{}'
expect_status 200 "dpm cancels line 4"
expect_jq '.order.status == "cancelled"' "line 4 is cancelled"
req POST "/api/orders/$M3B_L4/cancel" "$DPM" '{}'
expect_status 409 "cancel twice"

req PATCH "/api/orders/$M3B_L1" "$DPM" '{"status":"received"}'
expect_status 200 "dpm receives line 1"
expect_jq ".order.receivedDate == \"$M3B_TODAY\" and .job.materialsInDate == null" "line 1 is received; not all in yet"
req PATCH "/api/orders/$M3B_L2" "$DPM" '{"status":"received","receivedDate":"'"$M3B_TODAY"'"}'
expect_status 200 "dpm receives line 2"
expect_jq '.job.materialsInDate == null' "still not all in"
m3b_notifs "$SCHED" materials.in "$M3B_J"
expect_eq "$M3B_N" "0" "no materials.in notification yet"
req PATCH "/api/orders/$M3B_L3" "$DPM" '{"status":"received"}'
expect_status 200 "dpm receives line 3"
expect_jq ".job.materialsInDate == \"$M3B_TODAY\"" "all in: the job's materials-in date is today"
m3b_notifs "$SCHED" materials.in "$M3B_J"
expect_eq "$M3B_N" "1" "sched has one materials.in notification for the job"
req GET "/api/notifications?limit=100" "$SCHED"
expect_jq "[.rows[] | select(.kind == \"materials.in\" and (.link | test(\"[?]id=$M3B_J#orders\")))][0].title == \"Materials in: CI M3 Orders Job\"" \
  "the notification names the job and links to its orders"
m3b_notifs "$DPM" materials.in "$M3B_J"
expect_eq "$M3B_N" "0" "dpm (the actor) has no materials.in notification for the job"

echo "--- a new line clears materials in; cancelling it sets it again ---"
m3b_line "$M3B_J" "M3 Timber"
M3B_L5=$M3B_LINE
expect_jq '.job.materialsInDate == null' "adding line 5 clears the materials-in date"
req POST "/api/orders/$M3B_L5/cancel" "$DPM" '{}'
expect_status 200 "dpm cancels line 5"
expect_jq ".job.materialsInDate == \"$M3B_TODAY\"" "cancelling it puts the materials-in date back"
req GET "/api/job-records/$M3B_J/orders" "$ADMIN"
expect_jq '.[0].id != null' "the job's lines still list"
req PATCH "/api/orders/$M3B_L5" "$DPM" '{"notes":"too late"}'
expect_status 409 "PATCH a cancelled line"
expect_jq '.error == "Cancelled lines can'"'"'t be changed"' "and says why"

echo "--- received -> ordered (undo) clears materials in ---"
req PATCH "/api/orders/$M3B_L3" "$DPM" '{"status":"ordered"}'
expect_status 200 "dpm undoes line 3's receipt"
expect_jq '.order.receivedDate == null and .job.materialsInDate == null' "line 3 is ordered again and materials in is cleared"
req PATCH "/api/orders/$M3B_L3" "$DPM" '{"status":"received"}'
expect_status 200 "dpm receives line 3 again"
expect_jq ".job.materialsInDate == \"$M3B_TODAY\"" "materials in is set again"
# The date is set again, but scheduling is told once per job (M3 review fix 5).
m3b_notifs "$SCHED" materials.in "$M3B_J"
expect_eq "$M3B_N" "1" "toggling lines does not re-send materials.in: sched still has one"

echo "--- date edits without a status change ---"
req PATCH "/api/orders/$M3B_L3" "$DPM" "{\"orderedDate\":\"$M3B_YESTERDAY\"}"
expect_status 403 "dpm edits an ordered date"
req PATCH "/api/orders/$M3B_L3" "$ADMIN" "{\"orderedDate\":\"$M3B_YESTERDAY\"}"
expect_status 200 "admin edits an ordered date"
expect_jq ".order.orderedDate == \"$M3B_YESTERDAY\"" "the ordered date changed"
req PATCH "/api/orders/$M3B_L3" "$DPM" "{\"receivedDate\":\"$M3B_YESTERDAY\"}"
expect_status 200 "dpm edits a received date"
req PATCH "/api/orders/$M3B_L3" "$DPM" '{"receivedDate":"nope"}'
expect_status 400 "a bad received date"
# A date after Sydney today is refused (M3 review fix 6).
req PATCH "/api/orders/$M3B_L3" "$ADMIN" "{\"orderedDate\":\"$M3B_PLUS3\"}"
expect_status 400 "a future ordered date"
expect_jq '.error == "orderedDate can'"'"'t be in the future"' "and says why"
req PATCH "/api/orders/$M3B_L3" "$DPM" "{\"receivedDate\":\"$M3B_PLUS3\"}"
expect_status 400 "a future received date"
expect_jq '.error == "receivedDate can'"'"'t be in the future"' "and says why"
req PATCH "/api/orders/$M3B_L3" "$DPM" "{\"status\":\"ordered\"}"
expect_status 200 "dpm undoes line 3 receipt (future-date check)"
req PATCH "/api/orders/$M3B_L3" "$DPM" "{\"status\":\"received\",\"receivedDate\":\"$M3B_PLUS3\"}"
expect_status 400 "a future received date on the status change"
req PATCH "/api/orders/$M3B_L3" "$DPM" "{\"status\":\"received\"}"
expect_status 200 "dpm receives line 3 again (future-date check)"
req PATCH "/api/orders/$M3B_L3" "$DPM" "{\"receivedDate\":\"$M3B_YESTERDAY\"}"
expect_status 200 "dpm puts line 3 received date back"
req GET "/api/job-records/$M3B_J/orders" "$ADMIN"
expect_jq "[.[] | select(.id == $M3B_L3)][0].orderedDate == \"$M3B_YESTERDAY\"" "the refused dates changed nothing"

echo "--- the audit trail ---"
m3b_audit_min order.create "$M3B_L1" 1
m3b_audit_min order.create "$M3B_L5" 1
m3b_audit_min order.update "$M3B_L1" 1
m3b_audit_min order.status "$M3B_L1" 2
m3b_audit_min order.cancel "$M3B_L4" 1
m3b_audit_min order.cancel "$M3B_L5" 1
req GET "/api/audit?action=job.update&entityType=job&entityId=$M3B_J&limit=50" "$ADMIN"
expect_status 200 "audit rows for the job"
expect_jq '[.rows[] | select(.after != null and (.after | tostring | contains("materials_in_date")))] | length >= 2' \
  "materials_in_date changes are audited"

echo "--- lists and suppliers ---"
req GET "/api/orders?status=all&jobId=$M3B_J" "$SCHED"
expect_status 200 "list every line of the job"
expect_jq 'length == 6' "the job has six lines (five plus the undo line), cancelled included"
expect_jq ".[0] | has(\"jobName\") and has(\"jobStage\") and .jobName == \"CI M3 Orders Job\"" "list rows carry the job name and stage"
req GET "/api/orders?status=cancelled&jobId=$M3B_J" "$SCHED"
expect_jq 'length == 3 and all(.[]; .status == "cancelled")' "the cancelled filter"
req GET "/api/orders?status=open&jobId=$M3B_J" "$SCHED"
expect_jq 'length == 0' "nothing on the job is still open"
req GET "/api/orders?status=received&jobId=$M3B_J&supplier=m3%20supply%20co" "$SCHED"
expect_jq 'length == 3' "the supplier filter is case-insensitive"
req GET "/api/orders?status=all&jobId=abc" "$SCHED"
expect_status 400 "a bad jobId"
req GET "/api/job-records/$M3B_J/orders" "$SCHED"
expect_jq 'length == 3 and all(.[]; .status != "cancelled")' "a job's lines hide cancelled by default"
req GET "/api/job-records/$M3B_J/orders?all=1" "$SCHED"
expect_jq 'length == 6' "?all=1 shows them"
req GET "/api/job-records/$M3B_J/orders?all=2" "$SCHED"
expect_status 400 "a bad all flag"
req GET "/api/orders/suppliers?q=M3" "$DPM"
expect_status 200 "supplier suggestions"
expect_jq 'index("M3 Supply Co") != null and index("M3 Timber") != null and .[0] == "M3 Supply Co"' \
  "the suppliers are listed, most used first"
req GET "/api/orders/suppliers?q=m3%20t" "$DPM"
expect_jq '. == ["M3 Timber"]' "the prefix is case-insensitive"

echo "--- cancelling the last to_order line (contracts 11.8) ---"
m3b_job "CI M3 Cancel Admin Job" false
M3B_JA=$M3B_JOB
m3b_line "$M3B_JA" "M3 Cancel Co"
M3B_A1=$M3B_LINE
m3b_line "$M3B_JA" "M3 Cancel Co"
M3B_A2=$M3B_LINE
req PATCH "/api/orders/$M3B_A1" "$ADMIN" '{"status":"ordered"}'
expect_status 200 "admin orders the first line"
m3b_progress "$M3B_JA"
expect_eq "$M3B_PROGRESS" "0" "one line still to order: no progress invoice"
req POST "/api/orders/$M3B_A2/cancel" "$ADMIN" '{}'
expect_status 200 "admin cancels the last to_order line"
expect_jq ".job.materialsOrderedDate == \"$M3B_TODAY\"" "the job's materials-ordered date is set"
req GET "/api/invoices/job/$M3B_JA" "$ADMIN"
expect_jq '[.[] | select(.kind == "progress" and .status == "due" and .dueReason == "materials_ordered")] | length == 1' \
  "exactly one progress invoice is due"

m3b_job "CI M3 Cancel Dpm Job" false
M3B_JD=$M3B_JOB
m3b_line "$M3B_JD" "M3 Cancel Co"
M3B_D1=$M3B_LINE
m3b_line "$M3B_JD" "M3 Cancel Co"
M3B_D2=$M3B_LINE
req PATCH "/api/orders/$M3B_D1" "$ADMIN" '{"status":"ordered"}'
expect_status 200 "admin orders the first line"
req POST "/api/orders/$M3B_D2/cancel" "$DPM" '{}'
expect_status 200 "dpm cancels the last to_order line"
expect_jq '.job.materialsOrderedDate == null' "a design_pm cancel never sets the job's date"
m3b_progress "$M3B_JD"
expect_eq "$M3B_PROGRESS" "0" "and no progress invoice is due"
req POST "/api/job-records/$M3B_JD/materials-ordered" "$ADMIN" '{}'
expect_status 200 "Todd uses the Materials ordered button instead"
m3b_progress "$M3B_JD"
expect_eq "$M3B_PROGRESS" "1" "now the progress invoice is due"

# A job whose only line is cancelled has no lines left: nothing fires.
m3b_job "CI M3 Cancel Only Job" false
M3B_JO=$M3B_JOB
m3b_line "$M3B_JO" "M3 Cancel Co"
req POST "/api/orders/$M3B_LINE/cancel" "$ADMIN" '{}'
expect_status 200 "admin cancels a job's only line"
expect_jq '.job.materialsOrderedDate == null and .job.materialsInDate == null' "no lines left: nothing is set"

echo "--- inspections: access ---"
req GET "/api/job-records/$M3B_J/inspections" "$SCHED"
expect_status 200 "sched GET inspections"
expect_jq 'length == 0' "no inspections yet"
req GET "/api/job-records/$M3B_J/inspections" "$SHOW"
expect_status 403 "show GET inspections"
req GET /api/job-records/999999/inspections "$ADMIN"
expect_status 404 "inspections of an unknown job"
req POST "/api/job-records/$M3B_J/inspections" "$ACCT" "{\"date\":\"$M3B_PLUS3\"}"
expect_status 403 "acct books an inspection"
req POST "/api/job-records/$M3B_J/inspections" "$SCHED" "{\"date\":\"$M3B_PLUS3\"}"
expect_status 403 "sched books an inspection"

echo "--- inspections: booking ---"
req POST "/api/job-records/$M3B_J/inspections" "$DPM" '{"time":"10:30"}'
expect_status 400 "a date is required"
req POST "/api/job-records/$M3B_J/inspections" "$DPM" '{"date":"2030-02-31"}'
expect_status 400 "an impossible date"
req POST "/api/job-records/$M3B_J/inspections" "$DPM" "{\"date\":\"$M3B_PLUS3\",\"time\":\"25:00\"}"
expect_status 400 "time 25:00"
req POST "/api/job-records/$M3B_J/inspections" "$DPM" "{\"date\":\"$M3B_PLUS3\",\"time\":\"9:30\"}"
expect_status 400 "time 9:30 (not zero-padded)"
req POST /api/job-records/999999/inspections "$DPM" "{\"date\":\"$M3B_PLUS3\"}"
expect_status 404 "book on an unknown job"

req POST "/api/job-records/$M3B_J/inspections" "$DPM" "{\"date\":\"$M3B_PLUS3\",\"time\":\"10:30\",\"notes\":\"CI inspection\"}"
expect_status 201 "dpm books an inspection"
expect_jq ".status == \"booked\" and .date == \"$M3B_PLUS3\" and .time == \"10:30\" and .host == \"CI Design PM\" and .jobId == $M3B_J and .jobName == \"CI M3 Orders Job\" and .createdByName == \"CI Design PM\"" \
  "booked at 10:30, host defaults to the booker"
M3B_I=$(jqr '.id')
m3b_notifs "$SCHED" inspection.booked "$M3B_J"
expect_eq "$M3B_N" "1" "sched has an inspection.booked notification"
req GET "/api/notifications?limit=100" "$SCHED"
expect_jq "[.rows[] | select(.kind == \"inspection.booked\" and (.link | test(\"[?]id=$M3B_J#inspection\")))][0].title | startswith(\"Inspection booked: CI M3 Orders Job, \") and endswith(\" 10:30\")" \
  "the title names the job and time"
m3b_notifs "$DPM" inspection.booked "$M3B_J"
expect_eq "$M3B_N" "0" "dpm (the actor) has no inspection.booked notification"

req GET /api/scheduling/upcoming "$SCHED"
expect_jq ".inspections | map(select(.id == $M3B_I)) | .[0] | .date == \"$M3B_PLUS3\" and .time == \"10:30\" and .host == \"CI Design PM\" and .jobId == $M3B_J" \
  "the inspection is in upcoming.inspections"

echo "--- inspections: edit, move, done ---"
req PATCH "/api/inspections/$M3B_I" "$ACCT" "{\"date\":\"$M3B_PLUS4\"}"
expect_status 403 "acct edits an inspection"
req PATCH "/api/inspections/$M3B_I" "$SCHED" "{\"date\":\"$M3B_PLUS4\"}"
expect_status 403 "sched edits an inspection"
req PATCH /api/inspections/999999 "$DPM" "{\"date\":\"$M3B_PLUS4\"}"
expect_status 404 "edit an unknown inspection"
req PATCH "/api/inspections/$M3B_I" "$DPM" '{"time":"25:00"}'
expect_status 400 "PATCH time 25:00"
req PATCH "/api/inspections/$M3B_I" "$DPM" '{"status":"cancelled"}'
expect_status 400 "PATCH status cancelled is Use cancel"
req PATCH "/api/inspections/$M3B_I" "$DPM" '{"status":"bogus"}'
expect_status 400 "an unknown status"
req PATCH "/api/inspections/$M3B_I" "$DPM" '{"host":"Todd","notes":"bring samples"}'
expect_status 200 "dpm edits the host and notes"
m3b_notifs "$SCHED" inspection.moved "$M3B_J"
expect_eq "$M3B_N" "0" "a host or notes change is not a move"
req PATCH "/api/inspections/$M3B_I" "$DPM" "{\"date\":\"$M3B_PLUS4\"}"
expect_status 200 "dpm moves the inspection"
expect_jq ".date == \"$M3B_PLUS4\" and .host == \"Todd\" and .notes == \"bring samples\"" "the date changed and the rest is kept"
m3b_notifs "$SCHED" inspection.moved "$M3B_J"
expect_eq "$M3B_N" "1" "sched has an inspection.moved notification"
m3b_notifs "$DPM" inspection.moved "$M3B_J"
expect_eq "$M3B_N" "0" "dpm (the actor) has no inspection.moved notification"
req PATCH "/api/inspections/$M3B_I" "$DPM" '{"time":null}'
expect_status 200 "dpm clears the time"
expect_jq '.time == null' "time is now not set"
m3b_notifs "$SCHED" inspection.moved "$M3B_J"
expect_eq "$M3B_N" "2" "a time change is a move too"
req GET /api/scheduling/upcoming "$SCHED"
expect_jq ".inspections | map(select(.id == $M3B_I)) | .[0] | .date == \"$M3B_PLUS4\" and .time == null" "the move shows in upcoming"

# A second inspection, marked done: no notification, and it leaves upcoming.
req POST "/api/job-records/$M3B_J/inspections" "$DPM" "{\"date\":\"$M3B_PLUS5\",\"host\":\"Someone Else\"}"
expect_status 201 "dpm books a second inspection with no time"
expect_jq '.time == null and .host == "Someone Else"' "no time; the host is kept"
M3B_I2=$(jqr '.id')
req PATCH "/api/inspections/$M3B_I2" "$DPM" '{"status":"done"}'
expect_status 200 "dpm marks it done"
expect_jq '.status == "done"' "it is done"
m3b_notifs "$SCHED" inspection.moved "$M3B_J"
expect_eq "$M3B_N" "2" "done does not notify"
req GET /api/scheduling/upcoming "$SCHED"
expect_jq ".inspections | map(select(.id == $M3B_I2)) | length == 0" "a done inspection is not upcoming"

echo "--- inspections: cancel ---"
req POST "/api/inspections/$M3B_I/cancel" "$ACCT" '{}'
expect_status 403 "acct cancels an inspection"
req POST "/api/inspections/$M3B_I/cancel" "$DPM" '{}'
expect_status 200 "dpm cancels the inspection"
expect_jq '.status == "cancelled"' "it is cancelled"
m3b_notifs "$SCHED" inspection.cancelled "$M3B_J"
expect_eq "$M3B_N" "1" "sched has an inspection.cancelled notification"
m3b_notifs "$DPM" inspection.cancelled "$M3B_J"
expect_eq "$M3B_N" "0" "dpm (the actor) has no inspection.cancelled notification"
req GET /api/scheduling/upcoming "$SCHED"
expect_jq ".inspections | map(select(.id == $M3B_I)) | length == 0" "a cancelled inspection is gone from upcoming"
req POST "/api/inspections/$M3B_I/cancel" "$DPM" '{}'
expect_status 409 "cancel twice"
req PATCH "/api/inspections/$M3B_I" "$DPM" "{\"date\":\"$M3B_PLUS3\"}"
expect_status 409 "edit a cancelled inspection"

req GET "/api/job-records/$M3B_J/inspections" "$SCHED"
expect_jq "length == 2 and .[0].date >= .[1].date" "both inspections are listed, newest date first"
expect_jq '[.[].status] | sort == ["cancelled","done"]' "in every status"

echo "--- inspections: audit ---"
for a in inspection.create inspection.update inspection.cancel; do
  req GET "/api/audit?action=$a&entityType=inspection&entityId=$M3B_I&limit=1" "$ADMIN"
  expect_status 200 "GET /api/audit?action=$a"
  n=$(jqr '.total')
  [ "$n" -ge 1 ] || fail "expected at least 1 '$a' audit row for inspection $M3B_I, got $n"
  ok
done

echo "--- upcoming is read-only for dpm and sched ---"
req GET /api/scheduling/upcoming "$DPM"
expect_status 200 "dpm GET /api/scheduling/upcoming"
expect_jq 'has("from") and has("to") and has("inspections") and has("materials") and has("materialsIn")' "the upcoming shape"
req GET /api/scheduling/upcoming "$SCHED"
expect_jq ".materialsIn | map(select(.jobId == $M3B_J)) | .[0] | .jobName == \"CI M3 Orders Job\" and .materialsInDate == \"$M3B_TODAY\"" \
  "a job whose materials came in today is in materialsIn"
