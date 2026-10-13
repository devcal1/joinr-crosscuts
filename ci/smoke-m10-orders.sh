# M10 smoke, Wave 1 A: the Ordering and Workshop Manager roles, and receiving deliveries.
# Sourced by ci/smoke.sh after the M9 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok), the cookie jars ($ADMIN $SCHED $ACCT $DPM
# $SHOW $WSHOP $ORDR $WSMGR) and $CONTAINER. No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: its jobs carry a run tag in their names and it checks
# only its own rows (notifications by the job's link, audit rows by the line's id). Made-up names
# only (this repo is public).
# Contract: docs/plans/m10-contracts.md sections 4 and 10.2.

# ============================================================================
step "m10. new roles and receiving deliveries"
# ============================================================================

M10_TAG=$(date +%s)
M10_SUPPLIER="M10 Test Supplier"
M10_NOTE="M10 two of three boxes"

# m10_day N: today (the server's) plus N days, as YYYY-MM-DD. m10_label DATE: "3 Oct 2026".
m10_day() {
  date -u -d "$M10_TODAY $1 day" +%F
}
m10_label() {
  LC_ALL=C date -u -d "$1" '+%-d %b %Y'
}

# m10_me JAR: sets M10_ID and M10_NAME to that user's id and display name.
m10_me() {
  req GET /api/auth/me "$1"
  expect_status 200 "GET /api/auth/me"
  M10_ID=$(jqr '.user.id')
  M10_NAME=$(jqr '.user.displayName')
}

# m10_notifs JAR KIND JOB_ID: sets M10_N to how many KIND notifications the user has for the job.
m10_notifs() {
  req GET "/api/notifications?limit=100" "$1"
  expect_status 200 "GET /api/notifications"
  M10_N=$(jqr "[.rows[] | select(.kind == \"$2\" and (.link | test(\"[?]id=$3#\")))] | length")
}

# m10_line JAR JOB_ID DESCRIPTION: adds a line (201) -> M10_LINE.
m10_line() {
  req POST "/api/job-records/$2/orders" "$1" \
    "{\"supplier\":\"$M10_SUPPLIER\",\"description\":\"$3\"}"
  expect_status 201 "add a line ($3) to job $2"
  M10_LINE=$(jqr '.order.id')
}

# m10_deliveries: wsmgr reads the Deliveries list into BODY.
m10_deliveries() {
  req GET /api/orders/deliveries "$WSMGR"
  expect_status 200 "wsmgr GET /api/orders/deliveries"
}

# m10_group LINE GROUP: on the Deliveries list in BODY, the line is in exactly that group.
m10_group() {
  expect_jq "[.groups[] | select([.lines[] | select(.id == $1)] | length > 0) | .id] == [\"$2\"]" \
    "line $1 is in $2 only"
}

# m10_nogroup LINE WHAT: the line is in no group of the Deliveries list in BODY.
m10_nogroup() {
  expect_jq "[.groups[].lines[] | select(.id == $1)] | length == 0" "$2"
}

# m10_recent LINE COUNT WHAT: the line is in recent COUNT times (0 or 1).
m10_recent() {
  expect_jq "[.recent[] | select(.id == $1)] | length == $2" "$3"
}

# Today is the server's (Sydney) date, as the M7 suite reads it, not the runner's clock.
req GET /api/orders/deliveries "$ADMIN"
expect_status 200 "admin reads the server's today"
M10_TODAY=$(jqr '.date')
M10_YESTERDAY=$(m10_day -1)
M10_TOMORROW=$(m10_day +1)
M10_TODAY_LABEL=$(m10_label "$M10_TODAY")

m10_me "$ORDR"
M10_ORDR_ID=$M10_ID
M10_ORDR_NAME=$M10_NAME
m10_me "$WSMGR"
M10_WSMGR_ID=$M10_ID
M10_WSMGR_NAME=$M10_NAME

echo "--- access ---"
req GET /orders.html "$ORDR"
expect_status 200 "ordr GET /orders.html"
req GET /orders.html "$WSMGR"
expect_status 200 "wsmgr GET /orders.html"
req GET /orders.html "$ACCT"
expect_status 200 "acct GET /orders.html"
req GET /orders.html "$WSHOP"
expect_status 403 "wshop GET /orders.html"
req GET /orders.html "$SHOW"
expect_status 403 "show GET /orders.html"
req GET /deliveries.html "$WSMGR"
expect_status 200 "wsmgr GET /deliveries.html"
req GET /deliveries.html "$ORDR"
expect_status 200 "ordr GET /deliveries.html"
req GET /deliveries.html "$DPM"
expect_status 200 "dpm GET /deliveries.html"
req GET /deliveries.html "$ACCT"
expect_status 403 "acct GET /deliveries.html"
req GET /deliveries.html "$SCHED"
expect_status 403 "sched GET /deliveries.html"
req GET /job.html "$WSMGR"
expect_status 403 "wsmgr GET /job.html (no job pages)"
req GET /api/orders "$WSMGR"
expect_status 200 "wsmgr GET /api/orders"
req GET /api/orders "$SCHED"
expect_status 200 "sched GET /api/orders (orders.view)"
req GET /api/orders "$WSHOP"
expect_status 403 "wshop GET /api/orders"
req GET /api/orders/deliveries "$WSMGR"
expect_status 200 "wsmgr GET /api/orders/deliveries"
req GET /api/orders/deliveries "$ACCT"
expect_status 403 "acct GET /api/orders/deliveries"

echo "--- Ordering places the order ---"
req POST /api/job-records "$ADMIN" \
  "{\"name\":\"M10 Test Job $M10_TAG\",\"clientName\":\"M10 Test Client\",\"valueCents\":2000000}"
expect_status 201 "admin makes a job"
M10_J=$(jqr '.id')
req GET "/api/job-records/$M10_J/orders" "$WSMGR"
expect_status 403 "wsmgr GET a job's lines (jobs.view)"
m10_line "$ORDR" "$M10_J" "M10 carcass board"
M10_L1=$M10_LINE
expect_jq ".order.status == \"to_order\" and .order.updatedBy.id == $M10_ORDR_ID and .order.receivedBy == null and .order.deliveryNote == \"\" and .order.deliveryNoteAt == null" \
  "line 1 is to_order, updatedBy ordr, no receipt and no note"
m10_line "$ORDR" "$M10_J" "M10 hinges"
M10_L2=$M10_LINE
req POST "/api/job-records/$M10_J/orders" "$WSMGR" "{\"supplier\":\"$M10_SUPPLIER\"}"
expect_status 403 "wsmgr adds a line"
req PATCH "/api/orders/$M10_L1" "$ORDR" '{"status":"ordered"}'
expect_status 200 "ordr marks line 1 ordered"
expect_jq ".order.status == \"ordered\" and .order.orderedDate == \"$M10_TODAY\" and .job.materialsOrderedDate == null" \
  "line 1 is ordered; the job's materials-ordered date is still empty"
req PATCH "/api/orders/$M10_L2" "$WSMGR" '{"status":"ordered"}'
expect_status 403 "wsmgr marks line 2 ordered"
req PATCH "/api/orders/$M10_L2" "$ORDR" '{"status":"ordered"}'
expect_status 200 "ordr marks line 2 ordered"
expect_jq ".job.materialsOrderedDate == \"$M10_TODAY\"" "the last line ordered sets the job's materials-ordered date"
req PATCH "/api/orders/$M10_L2" "$ADMIN" '{"status":"ordered"}'
expect_status 409 "marking an ordered line ordered again"
expect_jq ".error == \"It was already marked ordered on $M10_TODAY_LABEL\"" "and says when"
req GET "/api/invoices/job/$M10_J" "$ADMIN"
expect_status 200 "GET /api/invoices/job"
expect_jq '[.[] | select(.kind == "progress" and .status == "due" and .dueReason == "materials_ordered")] | length == 1' \
  "Ordering's last line makes exactly one progress invoice due"

echo "--- the Workshop Manager receives ---"
req PATCH "/api/orders/$M10_L1" "$WSMGR" "{\"status\":\"received\",\"receivedDate\":\"$M10_YESTERDAY\"}"
expect_status 400 "a received date before the ordered date"
expect_jq ".error == \"The received date can't be before it was ordered ($M10_TODAY_LABEL)\"" "and says why"
req PATCH "/api/orders/$M10_L1" "$WSMGR" "{\"status\":\"received\",\"receivedDate\":\"$M10_TOMORROW\"}"
expect_status 400 "a future received date"
req PATCH "/api/orders/$M10_L1" "$WSMGR" '{"status":"received"}'
expect_status 200 "wsmgr receives line 1"
expect_jq ".order.status == \"received\" and .order.receivedDate == \"$M10_TODAY\" and .order.receivedBy.id == $M10_WSMGR_ID and .order.receivedBy.name == \"$M10_WSMGR_NAME\" and .order.updatedBy.id == $M10_WSMGR_ID and .order.updatedBy.name == \"$M10_WSMGR_NAME\"" \
  "line 1 is received today, by wsmgr, and wsmgr changed it last"
expect_jq '.job.materialsInDate == null' "not all in yet"
req PATCH "/api/orders/$M10_L1" "$WSMGR" "{\"receivedDate\":\"$M10_YESTERDAY\"}"
expect_status 400 "a received date alone before the ordered date"
expect_jq ".error == \"The received date can't be before it was ordered ($M10_TODAY_LABEL)\"" "and says why"
req PATCH "/api/orders/$M10_L1" "$ORDR" '{"status":"received"}'
expect_status 409 "a second person presses Received on a received line"
expect_jq ".error == \"It was already marked received on $M10_TODAY_LABEL\"" "and says when"
req GET "/api/orders?status=all&jobId=$M10_J" "$ORDR"
expect_status 200 "ordr lists the job's lines"
expect_jq "[.[] | select(.id == $M10_L1)][0] | .receivedBy.id == $M10_WSMGR_ID and .updatedBy.id == $M10_WSMGR_ID and .receivedDate == \"$M10_TODAY\"" \
  "the refused PATCHes changed nothing"
req PATCH "/api/orders/$M10_L1" "$WSMGR" '{"supplier":"M10 Other Supplier"}'
expect_status 403 "wsmgr edits the supplier"
req POST "/api/orders/$M10_L1/cancel" "$WSMGR" '{}'
expect_status 403 "wsmgr cancels a line"

echo "--- delivery notes ---"
req PATCH "/api/orders/$M10_L2" "$WSMGR" "{\"deliveryNote\":\"  $M10_NOTE  \"}"
expect_status 200 "wsmgr writes a delivery note on line 2 (ordered)"
expect_jq ".order.status == \"ordered\" and .order.deliveryNote == \"$M10_NOTE\" and (.order.deliveryNoteAt | type == \"string\") and .order.updatedBy.id == $M10_WSMGR_ID" \
  "the note is trimmed and stamped; the line stays ordered"
expect_jq '.order.updatedAt == .order.deliveryNoteAt' "the note's time is the write's time (one timestamp per write)"
req GET "/api/notifications?limit=100" "$ORDR"
expect_status 200 "ordr GET /api/notifications"
expect_jq ".rows[0] | .kind == \"order.delivery_note\" and .title == \"Delivery note: M10 Test Job $M10_TAG\" and .body == \"$M10_SUPPLIER: $M10_NOTE\" and .link == \"/job.html?id=$M10_J#orders\"" \
  "ordr's newest notification is the delivery note"
m10_notifs "$SCHED" order.delivery_note "$M10_J"
expect_eq "$M10_N" "0" "sched has no delivery-note notification"
req PATCH "/api/orders/$M10_L2" "$WSMGR" "$(jq -nc '{deliveryNote:("x" * 501)}')"
expect_status 400 "a 501-character delivery note"
expect_jq '.error == "The delivery note must be 500 characters or fewer"' "and says why"
req PATCH "/api/orders/$M10_L2" "$WSMGR" '{"deliveryNote":5}'
expect_status 400 "a delivery note that isn't text"
expect_jq '.error == "The delivery note must be text"' "and says why"

req POST /api/job-records "$ADMIN" \
  "{\"name\":\"M10 Test Deliveries Job $M10_TAG\",\"clientName\":\"M10 Test Client\"}"
expect_status 201 "admin makes a second job"
M10_J2=$(jqr '.id')
m10_line "$ORDR" "$M10_J2" "M10 still to order"
M10_T=$M10_LINE
req PATCH "/api/orders/$M10_T" "$WSMGR" "{\"deliveryNote\":\"$M10_NOTE\"}"
expect_status 409 "a delivery note on a to_order line"
expect_jq '.error == "Only an ordered or received line takes a delivery note"' "and says why"
req PATCH "/api/orders/$M10_T" "$WSMGR" '{"deliveryNote":""}'
expect_status 200 "an empty note on a to_order line is allowed"
expect_jq '.order.status == "to_order" and .order.deliveryNote == ""' "and leaves it empty"

echo "--- the note-notice rules ---"
# m10_note_counts: M10_NO and M10_NA are how many delivery-note notifications ordr and admin have
# for the second job.
m10_note_counts() {
  m10_notifs "$ORDR" order.delivery_note "$M10_J2"
  M10_NO=$M10_N
  m10_notifs "$ADMIN" order.delivery_note "$M10_J2"
  M10_NA=$M10_N
}
m10_line "$ORDR" "$M10_J2" "M10 note rules"
M10_NL=$M10_LINE
req PATCH "/api/orders/$M10_NL" "$ORDR" '{"status":"ordered"}'
expect_status 200 "ordr marks the note-rules line ordered"
m10_note_counts
M10_NO0=$M10_NO
M10_NA0=$M10_NA
req PATCH "/api/orders/$M10_NL" "$WSMGR" '{"deliveryNote":"M10 first note"}'
expect_status 200 "wsmgr writes a note"
m10_note_counts
expect_eq "$M10_NO $M10_NA" "$((M10_NO0 + 1)) $((M10_NA0 + 1))" "a note tells Ordering (ordr and admin)"
req PATCH "/api/orders/$M10_NL" "$WSMGR" '{"deliveryNote":"M10 second note"}'
expect_status 200 "wsmgr changes the note"
m10_note_counts
expect_eq "$M10_NO $M10_NA" "$((M10_NO0 + 2)) $((M10_NA0 + 2))" "every change tells Ordering again"
req PATCH "/api/orders/$M10_NL" "$WSMGR" '{"deliveryNote":"M10 second note"}'
expect_status 200 "wsmgr sends the same note again"
m10_note_counts
expect_eq "$M10_NO $M10_NA" "$((M10_NO0 + 2)) $((M10_NA0 + 2))" "an unchanged note tells nobody"
req PATCH "/api/orders/$M10_NL" "$WSMGR" '{"deliveryNote":""}'
expect_status 200 "wsmgr clears the note"
expect_jq '.order.deliveryNote == ""' "the note is cleared"
m10_note_counts
expect_eq "$M10_NO $M10_NA" "$((M10_NO0 + 2)) $((M10_NA0 + 2))" "clearing a note tells nobody"
req PATCH "/api/orders/$M10_NL" "$ORDR" '{"deliveryNote":"M10 note by ordering"}'
expect_status 200 "ordr writes a note"
m10_note_counts
expect_eq "$M10_NO $M10_NA" "$((M10_NO0 + 2)) $((M10_NA0 + 3))" "the writer isn't told: ordr's count stays, admin's goes up"
req PATCH "/api/orders/$M10_NL" "$WSMGR" "$(jq -nc '{deliveryNote:("y" * 500)}')"
expect_status 200 "a note of exactly 500 characters"
expect_jq '.order.deliveryNote | length == 500' "is kept whole"
m10_note_counts
expect_eq "$M10_NO $M10_NA" "$((M10_NO0 + 3)) $((M10_NA0 + 4))" "and tells Ordering"

echo "--- moving a line back to To order clears its note ---"
req PATCH "/api/orders/$M10_NL" "$ORDR" '{"status":"to_order"}'
expect_status 200 "ordr moves the note-rules line back to To order"
expect_jq '.order.status == "to_order" and .order.orderedDate == null and .order.deliveryNote == "" and .order.deliveryNoteAt == null' \
  "the note and its time are cleared with the ordered date"
m10_note_counts
expect_eq "$M10_NO $M10_NA" "$((M10_NO0 + 3)) $((M10_NA0 + 4))" "the move back tells nobody"
req GET "/api/audit?action=order.status&entityType=order&entityId=$M10_NL&limit=50" "$ADMIN"
expect_status 200 "the note-rules line's order.status rows"
expect_jq '[.rows[] | select(.after.status == "to_order" and (.before.delivery_note | length) == 500 and .after.delivery_note == "")] | length == 1' \
  "the cleared note is in the move's audit row"
req PATCH "/api/orders/$M10_NL" "$WSMGR" '{"deliveryNote":""}'
expect_status 200 "an empty note on the line now to_order"

echo "--- materials in ---"
req PATCH "/api/orders/$M10_L2" "$WSMGR" '{"status":"received"}'
expect_status 200 "wsmgr receives line 2"
expect_jq ".job.materialsInDate == \"$M10_TODAY\" and .order.deliveryNote == \"$M10_NOTE\"" \
  "all in: the job's materials-in date is set and the note is kept"
m10_notifs "$ORDR" materials.in "$M10_J"
expect_eq "$M10_N" "1" "ordr has one materials.in notification for the job"
m10_notifs "$SCHED" materials.in "$M10_J"
expect_eq "$M10_N" "1" "sched has one materials.in notification for the job"
m10_notifs "$ADMIN" materials.in "$M10_J"
expect_eq "$M10_N" "1" "admin (both keys) has exactly one"
m10_notifs "$WSMGR" materials.in "$M10_J"
expect_eq "$M10_N" "0" "wsmgr (the actor) has none"
req PATCH "/api/orders/$M10_L2" "$WSMGR" '{"status":"ordered"}'
expect_status 200 "wsmgr undoes line 2's receipt"
expect_jq ".order.status == \"ordered\" and .order.receivedDate == null and .order.receivedBy == null and .order.deliveryNote == \"$M10_NOTE\" and .job.materialsInDate == null" \
  "line 2 is ordered again: no receipt, the note kept, materials in cleared"

echo "--- materials in: the actor isn't told ---"
# A key holder who receives the last line gets no materials.in notice; the others do.
req POST /api/job-records "$ADMIN" \
  "{\"name\":\"M10 Test Actor Job $M10_TAG\",\"clientName\":\"M10 Test Client\"}"
expect_status 201 "admin makes a third job"
M10_J3=$(jqr '.id')
m10_line "$ORDR" "$M10_J3" "M10 only line"
M10_A=$M10_LINE
req PATCH "/api/orders/$M10_A" "$ORDR" '{"status":"ordered"}'
expect_status 200 "ordr marks the third job's line ordered"
req PATCH "/api/orders/$M10_A" "$ORDR" '{"status":"received"}'
expect_status 200 "ordr receives the third job's last line"
expect_jq ".job.materialsInDate == \"$M10_TODAY\"" "all in"
m10_notifs "$ORDR" materials.in "$M10_J3"
expect_eq "$M10_N" "0" "ordr (the actor, an Ordering key holder) has no materials.in notice"
m10_notifs "$SCHED" materials.in "$M10_J3"
expect_eq "$M10_N" "1" "sched has one"

echo "--- deliveries ---"
# m10_due DESCRIPTION EXPECTED: ordr adds a line to the second job, sets its expected date (when
# one is given) and marks it ordered -> M10_LINE.
m10_due() {
  m10_line "$ORDR" "$M10_J2" "$1"
  if [ -n "$2" ]; then
    req PATCH "/api/orders/$M10_LINE" "$ORDR" "{\"expectedDate\":\"$2\"}"
    expect_status 200 "ordr sets an expected date of $2"
  fi
  req PATCH "/api/orders/$M10_LINE" "$ORDR" '{"status":"ordered"}'
  expect_status 200 "ordr marks line $M10_LINE ordered"
}
# Today is the server's; Next 7 days runs from tomorrow to today + 7, Later from today + 8.
m10_due "M10 due yesterday" "$M10_YESTERDAY"
M10_D1=$M10_LINE
m10_due "M10 no date" ""
M10_D2=$M10_LINE
m10_due "M10 due today" "$M10_TODAY"
M10_D3=$M10_LINE
m10_due "M10 due in 7 days" "$(m10_day +7)"
M10_D4=$M10_LINE
m10_due "M10 due in 8 days" "$(m10_day +8)"
M10_D5=$M10_LINE

# m10_received_back DESCRIPTION DAYS: ordr adds a line to the second job and marks it ordered
# 20 days ago; wsmgr receives it DAYS days ago -> M10_LINE.
m10_received_back() {
  m10_line "$ORDR" "$M10_J2" "$1"
  req PATCH "/api/orders/$M10_LINE" "$ORDR" "{\"status\":\"ordered\",\"orderedDate\":\"$(m10_day -20)\"}"
  expect_status 200 "ordr marks line $M10_LINE ordered 20 days ago"
  expect_jq ".order.orderedDate == \"$(m10_day -20)\"" "with that ordered date"
  req PATCH "/api/orders/$M10_LINE" "$WSMGR" "{\"status\":\"received\",\"receivedDate\":\"$(m10_day "-$2")\"}"
  expect_status 200 "wsmgr receives line $M10_LINE $2 days ago"
}
# Recent is the last 14 days, today included: 13 days ago is in it, 14 days ago is not.
m10_received_back "M10 received 13 days ago" 13
M10_R13=$M10_LINE
m10_received_back "M10 received 14 days ago" 14
M10_R14=$M10_LINE
req PATCH "/api/orders/$M10_R13" "$ORDR" "{\"orderedDate\":\"$(m10_day -12)\"}"
expect_status 400 "an ordered date moved after the received date"
expect_jq ".error == \"The ordered date can't be after it was received ($(m10_label "$(m10_day -13)"))\"" "and says why"
req PATCH "/api/orders/$M10_R13" "$ORDR" "{\"orderedDate\":\"$(m10_day -13)\"}"
expect_status 200 "an ordered date on the received day"

# A spare line added by admin and cancelled by ordr: ordr changed it last.
m10_line "$ADMIN" "$M10_J2" "M10 spare"
M10_SPARE=$M10_LINE
req POST "/api/orders/$M10_SPARE/cancel" "$ORDR" '{}'
expect_status 200 "ordr cancels the spare line"
expect_jq ".order.status == \"cancelled\" and .order.updatedBy.id == $M10_ORDR_ID and .order.updatedBy.name == \"$M10_ORDR_NAME\"" \
  "the cancel records who did it"

# A job archived with an ordered line and a received one: neither is listed.
req POST /api/job-records "$ADMIN" \
  "{\"name\":\"M10 Test Archived Job $M10_TAG\",\"clientName\":\"M10 Test Client\"}"
expect_status 201 "admin makes a fourth job"
M10_J4=$(jqr '.id')
m10_line "$ORDR" "$M10_J4" "M10 archived, due today"
M10_X1=$M10_LINE
req PATCH "/api/orders/$M10_X1" "$ORDR" "{\"expectedDate\":\"$M10_TODAY\",\"status\":\"ordered\"}"
expect_status 200 "ordr orders a line due today on the fourth job"
m10_line "$ORDR" "$M10_J4" "M10 archived, received"
M10_X2=$M10_LINE
req PATCH "/api/orders/$M10_X2" "$ORDR" '{"status":"ordered"}'
expect_status 200 "ordr orders the fourth job's second line"
req PATCH "/api/orders/$M10_X2" "$WSMGR" '{"status":"received"}'
expect_status 200 "wsmgr receives it"
m10_deliveries
m10_group "$M10_X1" today
m10_recent "$M10_X2" 1 "the fourth job's received line is in recent"
req PATCH "/api/job-records/$M10_J4" "$ADMIN" '{"archived":true}'
expect_status 200 "admin archives the fourth job"

m10_deliveries
expect_jq ".date == \"$M10_TODAY\" and ([.groups[].id] == [\"overdue\",\"today\",\"week\",\"later\",\"nodate\"]) and ([.groups[].label] == [\"Overdue\",\"Today\",\"Next 7 days\",\"Later\",\"No date yet\"])" \
  "the date and the five groups, in order"
m10_group "$M10_D1" overdue
expect_jq "[.groups[] | select(.id == \"overdue\") | .lines[] | select(.id == $M10_D1)] | length == 1 and (.[0] | .jobName == \"M10 Test Deliveries Job $M10_TAG\" and .expectedDate == \"$M10_YESTERDAY\" and .overdue == true)" \
  "the line expected yesterday is overdue"
m10_group "$M10_D3" today
m10_group "$M10_D4" week
m10_group "$M10_D5" later
m10_group "$M10_D2" nodate
m10_group "$M10_L2" nodate
expect_jq "[.groups[].lines[] | select(.id == $M10_T or .id == $M10_L1 or .id == $M10_NL or .id == $M10_SPARE or .id == $M10_R13)] | length == 0" \
  "to_order, received and cancelled lines are in no group"
m10_nogroup "$M10_X1" "an ordered line on an archived job is in no group"
expect_jq '.counts.overdue >= 1 and .counts.today >= 1 and (.counts.overdue == ([.groups[] | select(.id == "overdue") | .lines[]] | length)) and (.counts.today == ([.groups[] | select(.id == "today") | .lines[]] | length))' \
  "the counts match the groups"
expect_jq "[.recent[] | select(.id == $M10_L1)] | length == 1 and (.[0] | .receivedBy.id == $M10_WSMGR_ID and .receivedDate == \"$M10_TODAY\")" \
  "the received line is in recent"
m10_recent "$M10_R13" 1 "a line received 13 days ago is in recent"
m10_recent "$M10_R14" 0 "a line received 14 days ago is not"
m10_recent "$M10_X2" 0 "a received line on an archived job is not in recent"

echo "--- Planner ---"
req GET /api/planner/layers "$WSMGR"
expect_status 200 "wsmgr GET /api/planner/layers"
expect_jq '[.layers[].id] | index("workshop") != null' "wsmgr's layers include workshop"
# m10_event JAR LAYER WANT: posts an all-day event; deletes it again when it was made.
m10_event() {
  req POST /api/planner/events "$1" \
    "{\"title\":\"M10 Test Event $M10_TAG\",\"notes\":\"\",\"layer\":\"$2\",\"allDay\":true,\"startDate\":\"2035-08-06\"}"
  expect_status "$3" "post on $2"
  if [ "$STATUS" = 201 ]; then
    local id upd
    id=$(jqr '.id')
    upd=$(jq -rn --arg u "$(jqr '.updatedAt')" '$u|@uri')
    req DELETE "/api/planner/events/$id?updatedAt=$upd" "$1"
    expect_status 204 "tidy the $2 event"
  fi
}
m10_event "$WSMGR" workshop 201
m10_event "$WSMGR" install 403
m10_event "$ORDR" install 201
m10_event "$ORDR" workshop 403

echo "--- audit ---"
req GET "/api/audit?action=order.status&entityType=order&entityId=$M10_L1&limit=50" "$ADMIN"
expect_status 200 "line 1's order.status rows"
expect_jq "[.rows[] | select(.actorUserId == $M10_ORDR_ID and .after.status == \"ordered\")] | length == 1" \
  "ordr's mark-ordered row carries the actor"
expect_jq "[.rows[] | select(.actorUserId == $M10_WSMGR_ID and .after.status == \"received\" and .after.received_by == $M10_WSMGR_ID and .before.received_by == null)] | length == 1" \
  "wsmgr's received row carries the actor and received_by"
req GET "/api/audit?action=order.update&entityType=order&entityId=$M10_L2&limit=50" "$ADMIN"
expect_status 200 "line 2's order.update rows"
expect_jq "[.rows[] | select(.actorUserId == $M10_WSMGR_ID and .after.delivery_note == \"$M10_NOTE\")] | length == 1" \
  "the delivery note is audited as order.update"

echo "M10 orders smoke test passed."
