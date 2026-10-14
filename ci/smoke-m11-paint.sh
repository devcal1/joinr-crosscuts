# M11 smoke, Wave 1 C: paint orders, and their job lines on Orders (Decision 6).
# Sourced by ci/smoke.sh after the M10 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok), the cookie jars ($ADMIN $ACCT $DPM $ORDR
# $WSMGR) and $CONTAINER. No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: its jobs and paint items carry a run tag in their names,
# it reads its user ids from /api/auth/me, and it checks only its own rows. Made-up names only
# (this repo is public).
# Contract: docs/plans/m11-contracts.md sections 5, 6.3, 9 and 12.2.

# ============================================================================
step "m11. paint orders"
# ============================================================================

M11_P_TAG=$(date +%s)
M11_P_SUPPLIER="M11 Paint Supplier"
M11_P_COLOUR="M11 Test Paint $M11_P_TAG"
M11_P_MAKER="M11 Paint Maker"
M11_P_DISC="M11 Test Disc $M11_P_TAG"
M11_P_HARDENER="M11 Test Hardener"
M11_P_NOTE="M11 one tin short"

# m11_p_me JAR: sets M11_P_ID to that user's id.
m11_p_me() {
  req GET /api/auth/me "$1"
  expect_status 200 "GET /api/auth/me"
  M11_P_ID=$(jqr '.user.id')
}

# m11_p_job NAME: admin makes a job (201) -> M11_P_JOB.
m11_p_job() {
  req POST /api/job-records "$ADMIN" \
    "$(jq -nc --arg n "$1" '{name:$n,clientName:"M11 Test Client",valueCents:2000000}')"
  expect_status 201 "admin makes $1"
  M11_P_JOB=$(jqr '.id')
}

# m11_p_lines JOB [all]: admin reads the job's order lines into BODY (all: with cancelled ones).
m11_p_lines() {
  req GET "/api/job-records/$1/orders${2:+?all=1}" "$ADMIN"
  expect_status 200 "GET job $1's order lines"
}

# Today is the server's (Sydney) date.
req GET /api/orders/deliveries "$ADMIN"
expect_status 200 "admin reads the server's today"
M11_P_TODAY=$(jqr '.date')

m11_p_me "$ORDR"
M11_P_ORDR_ID=$M11_P_ID
m11_p_me "$WSMGR"
M11_P_WSMGR_ID=$M11_P_ID

echo "--- access ---"
# The page itself is Wave 2's (F); its access gate is the scaffold's, and refuses first.
req GET /paint.html "$ACCT"
expect_status 403 "acct GET /paint.html"
req GET /api/paint/items "$ORDR"
expect_status 200 "ordr GET /api/paint/items"
req GET /api/paint/items "$WSMGR"
expect_status 403 "wsmgr GET /api/paint/items"
req GET /api/paint/orders "$WSMGR"
expect_status 403 "wsmgr GET /api/paint/orders"
req GET /api/paint/settings "$WSMGR"
expect_status 403 "wsmgr GET /api/paint/settings"
req GET /api/paint/orders "$DPM"
expect_status 403 "dpm GET /api/paint/orders"

echo "--- the litres factor ---"
req PUT /api/paint/settings "$ORDR" '{"litresPerKg":0.85}'
expect_status 200 "ordr sets the litres factor"
expect_jq '.litresPerKg == 0.85' "the factor is 0.85"
req PUT /api/paint/settings "$ORDR" '{"litresPerKg":0.05}'
expect_status 400 "a factor below 0.1"
req PUT /api/paint/settings "$ORDR" '{"litresPerKg":5.5}'
expect_status 400 "a factor above 5"
req PUT /api/paint/settings "$ORDR" '{"litresPerKg":"0.85"}'
expect_status 400 "a factor that isn't a number"
req GET /api/paint/settings "$ORDR"
expect_status 200 "ordr GET /api/paint/settings"
expect_jq '.litresPerKg == 0.85' "the bad factors changed nothing"

echo "--- the paint list ---"
req POST /api/paint/items "$ORDR" \
  "$(jq -nc --arg n "$M11_P_COLOUR" --arg m "$M11_P_MAKER" '{name:$n,finish:"Matt",manufacturer:$m,kind:"colour",unit:"kg"}')"
expect_status 201 "ordr adds a kg colour"
M11_P_ITEM_C=$(jqr '.id')
expect_jq ".name == \"$M11_P_COLOUR\" and .finish == \"Matt\" and .kind == \"colour\" and .unit == \"kg\" and .active == true and .updatedBy.id == $M11_P_ORDR_ID" \
  "the colour is as sent, active"
req POST /api/paint/items "$ORDR" \
  "$(jq -nc --arg n "$M11_P_DISC" '{name:$n,kind:"abrasive",unit:"each"}')"
expect_status 201 "ordr adds an each abrasive"
M11_P_ITEM_D=$(jqr '.id')
req POST /api/paint/items "$ORDR" '{"name":"M11 Bad Kind","kind":"lacquer","unit":"kg"}'
expect_status 400 "a kind not on the list"
req POST /api/paint/items "$ORDR" '{"name":"M11 Bad Unit","kind":"colour","unit":"litre"}'
expect_status 400 "a unit not on the list"
req POST /api/paint/items "$ORDR" '{"name":"  ","kind":"colour","unit":"kg"}'
expect_status 400 "a blank name"
req POST /api/paint/items "$WSMGR" '{"name":"M11 Nope","kind":"colour","unit":"kg"}'
expect_status 403 "wsmgr adds a paint item"
req PATCH "/api/paint/items/$M11_P_ITEM_D" "$ORDR" '{"finish":"P320"}'
expect_status 200 "ordr edits the abrasive"
expect_jq '.finish == "P320" and .unit == "each"' "only the finish changed"
req PATCH /api/paint/items/999999999 "$ORDR" '{"finish":"x"}'
expect_status 404 "editing an item that doesn't exist"
req GET /api/paint/items "$ORDR"
expect_status 200 "ordr GET /api/paint/items"
expect_jq "[.items[] | select(.id == $M11_P_ITEM_C or .id == $M11_P_ITEM_D)] | length == 2" "both items are listed"
req GET "/api/paint/items?all=1" "$ORDR"
expect_status 200 "ordr GET /api/paint/items?all=1"
M11_P_IDS=$(jqr '[.items[].id] | join(",")')
M11_P_REV=$(printf '%s\n' "${M11_P_IDS//,/$'\n'}" | tac | paste -sd, -)
req POST /api/paint/items/reorder "$ORDR" "{\"ids\":[$M11_P_REV]}"
expect_status 200 "ordr reverses the paint list"
expect_jq "[.items[].id] | join(\",\") == \"$M11_P_REV\"" "the list comes back in the new order"
req POST /api/paint/items/reorder "$ORDR" "{\"ids\":[$M11_P_ITEM_C]}"
expect_status 409 "a reorder that leaves items out"

echo "--- a draft with job lines ---"
m11_p_job "M11 Paint Job A $M11_P_TAG"
M11_P_JA=$M11_P_JOB
m11_p_job "M11 Paint Job B $M11_P_TAG"
M11_P_JB=$M11_P_JOB
# m11_p_body JOB: a paint order body with three lines (colour 4 kg and a typed hardener on JOB, the abrasive with no job).
m11_p_body() {
  jq -nc --arg s "$M11_P_SUPPLIER" --arg h "$M11_P_HARDENER" \
    --argjson c "$M11_P_ITEM_C" --argjson d "$M11_P_ITEM_D" --argjson j "$1" \
    '{supplier:$s,notes:"M11 smoke",lines:[{paintItemId:$c,qty:4,jobId:$j},{name:$h,unit:"each",qty:1,jobId:$j},{paintItemId:$d,qty:2}]}'
}
req POST /api/paint/orders "$WSMGR" "$(m11_p_body "$M11_P_JA")"
expect_status 403 "wsmgr makes a paint order"
req POST /api/paint/orders "$ORDR" \
  "$(jq -nc --argjson c "$M11_P_ITEM_C" '{supplier:"M11 Paint Supplier",lines:[{paintItemId:$c,qty:0}]}')"
expect_status 400 "a zero quantity"
req POST /api/paint/orders "$ORDR" \
  "$(jq -nc --argjson c "$M11_P_ITEM_C" '{supplier:"M11 Paint Supplier",lines:[{paintItemId:$c,qty:1.234}]}')"
expect_status 400 "a quantity finer than 0.01"
req POST /api/paint/orders "$ORDR" \
  "$(jq -nc --argjson c "$M11_P_ITEM_C" '{supplier:"M11 Paint Supplier",lines:[{paintItemId:$c,qty:1,jobId:999999999}]}')"
expect_status 400 "a job that doesn't exist"
req POST /api/paint/orders "$ORDR" '{"supplier":"M11 Paint Supplier","lines":[{"qty":1}]}'
expect_status 400 "a typed line without a name or unit"
req POST /api/paint/orders "$ORDR" '{"lines":[]}'
expect_status 400 "no supplier"

req POST /api/paint/orders "$ORDR" "$(m11_p_body "$M11_P_JA")"
expect_status 201 "ordr makes a draft with three lines"
M11_P_PO=$(jqr '.id')
expect_jq ".status == \"draft\" and .supplier == \"$M11_P_SUPPLIER\" and .orderedDate == null and (.lines | length) == 3" \
  "a draft with three lines"
expect_jq ".lines[0].litres == 3.4 and .lines[0].unit == \"kg\" and .lines[0].name == \"$M11_P_COLOUR\" and .lines[0].finish == \"Matt\" and .lines[0].jobId == $M11_P_JA" \
  "4 kg of the colour is 3.4 litres, the item's text copied"
expect_jq ".lines[1].paintItemId == null and .lines[1].unit == \"each\" and .lines[1].litres == null and .lines[2].jobId == null" \
  "the typed line and the workshop line"
expect_jq "[.jobs[] | .jobId] == [$M11_P_JA]" "one job link, job A"
M11_P_DESC="Paint: 4 kg $M11_P_COLOUR (Matt, $M11_P_MAKER); 1 × $M11_P_HARDENER"
m11_p_lines "$M11_P_JA"
expect_jq "length == 1" "job A has one order line"
expect_jq ".[0].kind == \"paint\" and .[0].paintOrderId == $M11_P_PO and .[0].status == \"to_order\" and .[0].supplier == \"$M11_P_SUPPLIER\" and .[0].notes == \"Paint order $M11_P_PO\"" \
  "job A's line is the paint order's"
M11_P_GOT=$(jqr '.[0].description')
expect_eq "$M11_P_GOT" "$M11_P_DESC" "job A's line describes its paint"
M11_P_LA=$(jqr '.[0].id')

echo "--- the paint line can't be changed from Orders ---"
M11_P_SAYS="This line is part of paint order $M11_P_PO; change it there"
req PATCH "/api/orders/$M11_P_LA" "$ORDR" '{"notes":"M11 changed"}'
expect_status 409 "a plain PATCH of the paint line"
expect_jq ".error == \"$M11_P_SAYS\"" "and says where to change it"
req PATCH "/api/orders/$M11_P_LA" "$ORDR" '{"status":"ordered"}'
expect_status 409 "a plain mark-ordered of the paint line"
req POST "/api/orders/$M11_P_LA/cancel" "$ORDR"
expect_status 409 "a plain cancel of the paint line"
expect_jq ".error == \"$M11_P_SAYS\"" "and says where to change it"

echo "--- moving job A's lines to job B ---"
req PUT "/api/paint/orders/$M11_P_PO" "$ORDR" "$(m11_p_body "$M11_P_JB")"
expect_status 200 "ordr moves the job lines to job B"
expect_jq "[.jobs[] | .jobId] == [$M11_P_JB] and .notes == \"M11 smoke\"" "one job link, job B"
m11_p_lines "$M11_P_JA" all
expect_jq ".[] | select(.id == $M11_P_LA) | .status == \"cancelled\"" "job A's line is cancelled"
m11_p_lines "$M11_P_JA"
expect_jq "length == 0" "job A has no live lines"
m11_p_lines "$M11_P_JB"
expect_jq "length == 1 and .[0].kind == \"paint\" and .[0].paintOrderId == $M11_P_PO and .[0].status == \"to_order\"" \
  "job B has one paint line"
M11_P_LB=$(jqr '.[0].id')

echo "--- marking it ordered ---"
# A user with stock.order but not orders.mark_ordered: wsmgr with a grant for this check only.
req PUT "/api/users/$M11_P_WSMGR_ID/overrides/stock.order" "$ADMIN" '{"effect":"grant"}'
expect_status 200 "admin grants stock.order to wsmgr"
req POST "/api/paint/orders/$M11_P_PO/ordered" "$WSMGR" '{}'
M11_P_GRANTED=$STATUS
req DELETE "/api/users/$M11_P_WSMGR_ID/overrides/stock.order" "$ADMIN"
expect_status 200 "admin removes the grant"
STATUS=$M11_P_GRANTED
expect_status 403 "mark ordered without orders.mark_ordered (job lines)"
req POST "/api/paint/orders/$M11_P_PO/ordered" "$ORDR" "{\"orderedDate\":\"2999-01-01\"}"
expect_status 400 "an ordered date in the future"
req POST "/api/paint/orders/$M11_P_PO/ordered" "$ORDR" "{\"expectedDate\":\"$M11_P_TODAY\"}"
expect_status 200 "ordr marks it ordered"
expect_jq ".status == \"ordered\" and .orderedDate == \"$M11_P_TODAY\" and .expectedDate == \"$M11_P_TODAY\" and .orderedBy.id == $M11_P_ORDR_ID" \
  "ordered today by ordr"
m11_p_lines "$M11_P_JB"
expect_jq ".[0].status == \"ordered\" and .[0].orderedDate == \"$M11_P_TODAY\" and .[0].expectedDate == \"$M11_P_TODAY\"" \
  "job B's line is ordered with the order's dates"
req GET "/api/invoices/job/$M11_P_JB" "$ADMIN"
expect_status 200 "GET job B's invoices"
expect_jq '[.[] | select(.kind == "progress" and .status == "due" and .dueReason == "materials_ordered")] | length == 1' \
  "job B's progress invoice is due (its only line was ordered)"
req POST "/api/paint/orders/$M11_P_PO/ordered" "$ORDR" '{}'
expect_status 409 "marking it ordered again"
req PUT "/api/paint/orders/$M11_P_PO" "$ORDR" "$(m11_p_body "$M11_P_JB")"
expect_status 409 "a draft PUT after ordering"
expect_jq '.error == "Only a draft can be changed"' "and says why"
req POST "/api/paint/orders/$M11_P_PO/cancel" "$ORDR"
expect_status 409 "cancelling an ordered paint order"

echo "--- deliveries ---"
req GET /api/orders/deliveries "$WSMGR"
expect_status 200 "wsmgr GET /api/orders/deliveries"
expect_jq "[.groups[].lines[] | select(.id == $M11_P_LB)] | length == 0" "job B's paint line is not in the five groups"
expect_jq "[.stock.items[] | select(.type == \"paint\" and .id == $M11_P_PO)] | length == 1" \
  "the paint order is in stock.items"

echo "--- receiving ---"
req GET "/api/paint/orders/$M11_P_PO" "$WSMGR"
expect_status 200 "wsmgr GET the paint order"
expect_jq "(.lines | length) == 3 and .lines[0].litres == 3.4" "with its lines and litres"
expect_jq '(.business | keys) == ["address","email","legalName","phone","tradingName"]' "the letterhead lines for the print, no bank details"
req POST "/api/paint/orders/$M11_P_PO/received" "$ORDR" '{"receivedDate":"2000-01-01"}'
expect_status 400 "a received date before it was ordered"
req POST "/api/paint/orders/$M11_P_PO/received" "$WSMGR" "$(jq -nc --arg n "$M11_P_NOTE" '{deliveryNote:$n}')"
expect_status 200 "wsmgr receives it"
expect_jq ".status == \"received\" and .receivedDate == \"$M11_P_TODAY\" and .receivedBy.id == $M11_P_WSMGR_ID and .deliveryNote == \"$M11_P_NOTE\"" \
  "received today by wsmgr, with the note"
m11_p_lines "$M11_P_JB"
expect_jq ".[0].status == \"received\" and .[0].receivedDate == \"$M11_P_TODAY\" and .[0].receivedBy.id == $M11_P_WSMGR_ID" \
  "job B's line is received by wsmgr"
req GET "/api/job-records/$M11_P_JB" "$ADMIN"
expect_status 200 "GET job B"
expect_jq ".materialsInDate == \"$M11_P_TODAY\"" "job B's materials are in"
req POST "/api/paint/orders/$M11_P_PO/received" "$WSMGR" '{}'
expect_status 409 "receiving it again"

echo "--- undo ---"
req POST "/api/paint/orders/$M11_P_PO/undo-ordered" "$ORDR"
expect_status 409 "undo ordered while it's received"
req POST "/api/paint/orders/$M11_P_PO/received" "$WSMGR" '{"undo":true}'
expect_status 200 "wsmgr undoes receiving"
expect_jq ".status == \"ordered\" and .receivedDate == null and .receivedBy == null" "it's ordered again"
m11_p_lines "$M11_P_JB"
expect_jq ".[0].status == \"ordered\" and .[0].receivedDate == null" "job B's line is ordered again"
req GET "/api/job-records/$M11_P_JB" "$ADMIN"
expect_jq ".materialsInDate == null" "job B's materials are no longer in"
req POST "/api/paint/orders/$M11_P_PO/undo-ordered" "$ORDR"
expect_status 200 "ordr undoes ordering"
expect_jq ".status == \"draft\" and .orderedDate == null and .orderedBy == null" "it's a draft again"
m11_p_lines "$M11_P_JB"
expect_jq ".[0].status == \"to_order\" and .[0].orderedDate == null" "job B's line is back to to_order"

echo "--- cancel ---"
req POST "/api/paint/orders/$M11_P_PO/cancel" "$ORDR"
expect_status 200 "ordr cancels the draft"
expect_jq '.status == "cancelled"' "it's cancelled"
m11_p_lines "$M11_P_JB" all
expect_jq ".[] | select(.id == $M11_P_LB) | .status == \"cancelled\"" "job B's line is cancelled"
req POST "/api/paint/orders/$M11_P_PO/cancel" "$ORDR"
expect_status 409 "cancelling it again"
req POST "/api/paint/orders/$M11_P_PO/ordered" "$ORDR" '{}'
expect_status 409 "marking a cancelled order ordered"

echo "--- a workshop-only order ---"
req POST /api/paint/orders "$ORDR" '{"supplier":"M11 Paint Supplier","lines":[]}'
expect_status 201 "an empty draft"
M11_P_PO2=$(jqr '.id')
req POST "/api/paint/orders/$M11_P_PO2/ordered" "$ORDR" '{}'
expect_status 400 "marking an empty order ordered"
expect_jq '.error == "Add at least one line"' "and says why"
req PUT "/api/paint/orders/$M11_P_PO2" "$ORDR" \
  "$(jq -nc --argjson d "$M11_P_ITEM_D" '{supplier:"M11 Paint Supplier",lines:[{paintItemId:$d,qty:3}]}')"
expect_status 200 "a workshop line added"
expect_jq '.jobs == [] and (.lines | length) == 1' "no job links"
# No job lines: stock.order is enough, without orders.mark_ordered (wsmgr with the grant again).
req PUT "/api/users/$M11_P_WSMGR_ID/overrides/stock.order" "$ADMIN" '{"effect":"grant"}'
expect_status 200 "admin grants stock.order to wsmgr again"
req POST "/api/paint/orders/$M11_P_PO2/ordered" "$WSMGR" '{}'
M11_P_GRANTED=$STATUS
req DELETE "/api/users/$M11_P_WSMGR_ID/overrides/stock.order" "$ADMIN"
expect_status 200 "admin removes the grant again"
STATUS=$M11_P_GRANTED
expect_status 200 "the workshop-only order is ordered without orders.mark_ordered"
req POST "/api/paint/orders/$M11_P_PO2/received" "$WSMGR" '{}'
expect_status 200 "and received"

echo "--- the list ---"
req GET /api/paint/orders "$ORDR"
expect_status 200 "ordr GET /api/paint/orders"
expect_jq "[.orders[] | select(.id == $M11_P_PO or .id == $M11_P_PO2)] | length == 0" "open orders leave out cancelled and received"
req GET "/api/paint/orders?status=all" "$ORDR"
expect_status 200 "ordr GET /api/paint/orders?status=all"
expect_jq "[.orders[] | select(.id == $M11_P_PO2 or .id == $M11_P_PO)] | map(.id) == [$M11_P_PO2, $M11_P_PO]" "all, newest first"
req GET "/api/paint/orders?status=cancelled" "$ORDR"
expect_jq "[.orders[] | select(.id == $M11_P_PO)] | length == 1" "one status: the cancelled order is listed"
expect_jq 'all(.orders[]; .status == "cancelled")' "one status: only cancelled orders"
req GET "/api/paint/orders?status=lost" "$ORDR"
expect_status 400 "a status that doesn't exist"
req GET /api/paint/orders/999999999 "$ORDR"
expect_status 404 "a paint order that doesn't exist"

echo "--- audit ---"
req GET "/api/audit?action=paint_order.status&entityType=paint_order&entityId=$M11_P_PO&limit=50" "$ADMIN"
expect_status 200 "the paint order's status rows"
expect_jq "[.rows[] | select(.actorUserId == $M11_P_ORDR_ID and .after.status == \"ordered\" and .before.status == \"draft\")] | length == 1" \
  "ordr's mark-ordered row"
expect_jq "[.rows[] | select(.actorUserId == $M11_P_WSMGR_ID and .after.status == \"received\" and .after.received_by == $M11_P_WSMGR_ID)] | length == 1" \
  "wsmgr's received row"
req GET "/api/audit?action=paint_order.create&entityType=paint_order&entityId=$M11_P_PO&limit=50" "$ADMIN"
expect_jq '.rows | length == 1' "one create row"
req GET "/api/audit?action=paint_order.update&entityType=paint_order&entityId=$M11_P_PO&limit=50" "$ADMIN"
expect_jq "(.rows | length) == 1 and .rows[0].after.lines[0].job_id == $M11_P_JB" "one update row, with the moved lines"
req GET "/api/audit?action=paint_order.cancel&entityType=paint_order&entityId=$M11_P_PO&limit=50" "$ADMIN"
expect_jq '.rows | length == 1' "one cancel row"
req GET "/api/audit?action=paint_item.create&entityType=paint_item&entityId=$M11_P_ITEM_C&limit=50" "$ADMIN"
expect_jq '.rows | length == 1' "the paint item's create row"
req GET "/api/audit?action=order.status&entityType=order&entityId=$M11_P_LB&limit=50" "$ADMIN"
expect_jq "[.rows[] | select(.after.status == \"received\" and .actorUserId == $M11_P_WSMGR_ID)] | length == 1" \
  "job B's line has its own order.status rows"

echo "M11 paint smoke test passed."
