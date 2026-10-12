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
M10_TODAY=$(TZ=Australia/Sydney date +%F)
M10_YESTERDAY=$(date -u -d "$M10_TODAY - 1 day" +%F)
M10_TOMORROW=$(date -u -d "$M10_TODAY + 1 day" +%F)
M10_TODAY_LABEL=$(LC_ALL=C date -u -d "$M10_TODAY" '+%-d %b %Y')
M10_SUPPLIER="M10 Test Supplier"
M10_NOTE="M10 two of three boxes"

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

req POST /api/job-records "$ADMIN" \
  "{\"name\":\"M10 Test Deliveries Job $M10_TAG\",\"clientName\":\"M10 Test Client\"}"
expect_status 201 "admin makes a second job"
M10_J2=$(jqr '.id')
m10_line "$ORDR" "$M10_J2" "M10 still to order"
M10_T=$M10_LINE
req PATCH "/api/orders/$M10_T" "$WSMGR" "{\"deliveryNote\":\"$M10_NOTE\"}"
expect_status 409 "a delivery note on a to_order line"
expect_jq '.error == "Only an ordered or received line takes a delivery note"' "and says why"

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

echo "--- deliveries ---"
m10_line "$ORDR" "$M10_J2" "M10 due yesterday"
M10_D1=$M10_LINE
m10_line "$ORDR" "$M10_J2" "M10 no date"
M10_D2=$M10_LINE
for M10_X in "$M10_D1" "$M10_D2"; do
  req PATCH "/api/orders/$M10_X" "$ORDR" '{"status":"ordered"}'
  expect_status 200 "ordr marks line $M10_X ordered"
done
req PATCH "/api/orders/$M10_D1" "$ORDR" "{\"expectedDate\":\"$M10_YESTERDAY\"}"
expect_status 200 "ordr sets an expected date of yesterday"
req GET /api/orders/deliveries "$WSMGR"
expect_status 200 "wsmgr GET /api/orders/deliveries"
expect_jq ".date == \"$M10_TODAY\" and ([.groups[].id] == [\"overdue\",\"today\",\"week\",\"later\",\"nodate\"]) and ([.groups[].label] == [\"Overdue\",\"Today\",\"Next 7 days\",\"Later\",\"No date yet\"])" \
  "the date and the five groups, in order"
expect_jq "[.groups[] | select(.id == \"overdue\") | .lines[] | select(.id == $M10_D1)] | length == 1 and (.[0] | .jobName == \"M10 Test Deliveries Job $M10_TAG\" and .expectedDate == \"$M10_YESTERDAY\" and .overdue == true)" \
  "the line expected yesterday is overdue"
expect_jq "[.groups[] | select(.id == \"nodate\") | .lines[] | select(.id == $M10_D2 or .id == $M10_L2)] | length == 2" \
  "the lines with no date are in No date yet"
expect_jq "[.groups[].lines[] | select(.id == $M10_T or .id == $M10_L1)] | length == 0" \
  "to_order and received lines are in no group"
expect_jq '.counts.overdue >= 1 and (.counts.overdue == ([.groups[] | select(.id == "overdue") | .lines[]] | length)) and (.counts.today == ([.groups[] | select(.id == "today") | .lines[]] | length))' \
  "the counts match the groups"
expect_jq "[.recent[] | select(.id == $M10_L1)] | length == 1 and (.[0] | .receivedBy.id == $M10_WSMGR_ID and .receivedDate == \"$M10_TODAY\")" \
  "the received line is in recent"

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
