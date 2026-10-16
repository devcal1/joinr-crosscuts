# M11 smoke, Wave 1 B: the monthly stock order, the board stocktake and stock value, and the stock
# part of Deliveries. Sourced by ci/smoke.sh after the M10 suites, so it shares that script's
# helpers (step, req, expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie jars
# ($ADMIN $ORDR $WSMGR $ACCT $DPM $SCHED). No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: its items and boards carry a run tag, each part works in
# a past month that has no record yet (found through the API), and it checks only its own rows
# (notifications by their link or title, deliveries by their id). Made-up names only (this repo is
# public). Today is the server's.
# Contract: docs/plans/m11-contracts.md sections 7, 8, 9, 11.8 and 12.2.

# ============================================================================
step "m11. stock order, board stocktake, stock deliveries"
# ============================================================================

M11_ST_TAG=$(date +%s)
M11_ST_SUPA="M11 Stock Supplier A $M11_ST_TAG"
M11_ST_SUPB="M11 Stock Supplier B $M11_ST_TAG"

# m11_st_label PERIOD: "October 2026".
m11_st_label() {
  LC_ALL=C date -u -d "$1-01" '+%B %Y'
}

# m11_st_free PATH: sets M11_ST_FREE to the earliest month from 2001-01 that PATH (a list of
# {months: [{period}]}) doesn't list, so each run works in a month of its own.
m11_st_free() {
  req GET "$1" "$ORDR"
  expect_status 200 "ordr GET $1"
  local used y m p
  used=$(jqr '.months[].period')
  for y in $(seq 2001 2020); do
    for m in 01 02 03 04 05 06 07 08 09 10 11 12; do
      p="$y-$m"
      if ! printf '%s\n' "$used" | grep -qx "$p"; then
        M11_ST_FREE=$p
        return 0
      fi
    done
  done
  fail "no free month for $1"
}

# m11_st_notifs JAR KIND LINK: sets M11_ST_N to how many KIND notifications the user has with LINK.
m11_st_notifs() {
  req GET "/api/notifications?limit=100" "$1"
  expect_status 200 "GET /api/notifications"
  M11_ST_N=$(jqr "[.rows[] | select(.kind == \"$2\" and .link == \"$3\")] | length")
}

# m11_st_me JAR: sets M11_ST_ID to that user's id.
m11_st_me() {
  req GET /api/auth/me "$1"
  expect_status 200 "GET /api/auth/me"
  M11_ST_ID=$(jqr '.user.id')
}

req GET /api/orders/deliveries "$ADMIN"
expect_status 200 "admin reads the server's today"
M11_ST_TODAY=$(jqr '.date')
M11_ST_THIS=${M11_ST_TODAY:0:7}
M11_ST_NEXT=$(date -u -d "$M11_ST_THIS-01 +1 month" +%Y-%m)
m11_st_me "$WSMGR"
M11_ST_WSMGR_ID=$M11_ST_ID

echo "--- access ---"
req GET /api/stock/items "$WSMGR"
expect_status 200 "wsmgr GET /api/stock/items"
req GET /api/stock/items "$ORDR"
expect_status 200 "ordr GET /api/stock/items"
req GET /api/stock/items "$ACCT"
expect_status 403 "acct GET /api/stock/items"
req GET /api/stock/items "$DPM"
expect_status 403 "dpm GET /api/stock/items"
req POST /api/stock/items "$WSMGR" "{\"supplier\":\"$M11_ST_SUPA\",\"item\":\"M11 Test Hinge\"}"
expect_status 403 "wsmgr adds a stock item"
req GET /api/boards "$WSMGR"
expect_status 200 "wsmgr GET /api/boards"
req GET /api/boards "$ACCT"
expect_status 403 "acct GET /api/boards"

echo "--- the stock list ---"
req POST /api/stock/items "$ORDR" \
  "{\"supplier\":\"$M11_ST_SUPA\",\"code\":\"M11-A\",\"item\":\"M11 Test Hinge\",\"link\":\"https://example.com/m11-hinge\"}"
expect_status 201 "ordr adds item A"
expect_jq ".supplier == \"$M11_ST_SUPA\" and .code == \"M11-A\" and .active == true" "item A as sent, active"
M11_ST_IA=$(jqr '.id')
req POST /api/stock/items "$ORDR" "{\"supplier\":\"$M11_ST_SUPB\",\"item\":\"M11 Test Screw\"}"
expect_status 201 "ordr adds item B (no code, no link)"
expect_jq '.code == "" and .link == ""' "item B has no code or link"
M11_ST_IB=$(jqr '.id')
req POST /api/stock/items "$ORDR" "{\"supplier\":\"$M11_ST_SUPA\",\"item\":\"M11 Bad Link\",\"link\":\"ftp://example.com/x\"}"
expect_status 400 "a link that isn't http(s)"
req POST /api/stock/items "$ORDR" "{\"supplier\":\"$M11_ST_SUPA\"}"
expect_status 400 "an item without its name"
req POST /api/stock/items/reorder "$ORDR" "{\"ids\":[$M11_ST_IB,$M11_ST_IA]}"
expect_status 200 "ordr swaps A and B"
expect_jq "([.items[] | .id] | index($M11_ST_IB)) < ([.items[] | .id] | index($M11_ST_IA))" "B now sorts before A"
req POST /api/stock/items/reorder "$ORDR" "{\"ids\":[$M11_ST_IA,$M11_ST_IB]}"
expect_status 200 "ordr swaps them back"

echo "--- counting ---"
m11_st_free /api/stock/orders
M11_ST_P=$M11_ST_FREE
M11_ST_PL=$(m11_st_label "$M11_ST_P")
req GET "/api/stock/orders/$M11_ST_P" "$WSMGR"
expect_status 200 "wsmgr GET the month (no record yet)"
expect_jq ".period == \"$M11_ST_P\" and .state == \"counting\" and .counted == null" "an empty month is counting"
expect_jq "[.groups[] | select(.supplier == \"$M11_ST_SUPA\") | .lines[] | select(.itemId == $M11_ST_IA)] | length == 1" \
  "item A is listed in its group"
req GET /api/stock/orders "$ORDR"
expect_jq "[.months[] | select(.period == \"$M11_ST_P\")] | length == 0" "reading a month writes nothing"
req PUT "/api/stock/orders/$M11_ST_P/have" "$WSMGR" "{\"lines\":[{\"itemId\":$M11_ST_IA,\"have\":1.5}]}"
expect_status 400 "a fractional Have"
req PUT "/api/stock/orders/$M11_ST_P/have" "$WSMGR" \
  "{\"lines\":[{\"itemId\":$M11_ST_IA,\"have\":3},{\"itemId\":$M11_ST_IB,\"have\":10}]}"
expect_status 200 "wsmgr types Have"
expect_jq "[.groups[].lines[] | select(.itemId == $M11_ST_IA) | .have] == [3]" "item A has 3"
expect_jq "[.groups[].lines[] | select(.itemId == $M11_ST_IB) | .have] == [10]" "item B has 10"
m11_st_notifs "$ORDR" stock.counted "/stock.html?period=$M11_ST_P"
expect_eq "$M11_ST_N" 0 "no stock.counted notice before the count is finished"
req POST "/api/stock/orders/$M11_ST_P/counted" "$WSMGR"
expect_status 200 "wsmgr finishes the count"
expect_jq ".state == \"counted\" and .counted.by.id == $M11_ST_WSMGR_ID and .nothingToOrder == null" "the month is counted, by wsmgr, and stays counted until Ordering acts (section 15.19)"
m11_st_notifs "$ORDR" stock.counted "/stock.html?period=$M11_ST_P"
expect_eq "$M11_ST_N" 1 "ordr is told the stock is counted"
expect_jq "[.rows[] | select(.kind == \"stock.counted\" and .link == \"/stock.html?period=$M11_ST_P\") | .title] == [\"Stock counted: $M11_ST_PL\"]" \
  "the notice names the month"
req PUT "/api/stock/orders/$M11_ST_P/have" "$WSMGR" "{\"lines\":[{\"itemId\":$M11_ST_IA,\"have\":4}]}"
expect_status 409 "wsmgr Have after counting"
expect_jq '.error == "The count is finished; ask Ordering to reopen it"' "and says who reopens it"
req POST "/api/stock/orders/$M11_ST_P/reopen" "$WSMGR"
expect_status 403 "wsmgr reopens the count"
req POST "/api/stock/orders/$M11_ST_P/reopen" "$ORDR"
expect_status 200 "ordr reopens the count"
expect_jq '.state == "counting" and .counted == null' "the month is counting again"
req PUT "/api/stock/orders/$M11_ST_P/have" "$WSMGR" "{\"lines\":[{\"itemId\":$M11_ST_IA,\"have\":4}]}"
expect_status 200 "wsmgr corrects Have"
req POST "/api/stock/orders/$M11_ST_P/counted" "$WSMGR"
expect_status 200 "wsmgr finishes the count again"
expect_jq "[.groups[].lines[] | select(.itemId == $M11_ST_IA) | .have] == [4]" "the corrected Have stands"

echo "--- ordering ---"
req PUT "/api/stock/orders/$M11_ST_P/order" "$WSMGR" "{\"lines\":[{\"itemId\":$M11_ST_IA,\"order\":5}]}"
expect_status 403 "wsmgr types Order"
req PUT "/api/stock/orders/$M11_ST_P/order" "$ORDR" \
  "{\"lines\":[{\"itemId\":$M11_ST_IA,\"order\":5},{\"itemId\":$M11_ST_IB,\"order\":0}]}"
expect_status 200 "ordr types Order"
expect_jq "[.groups[].lines[] | select(.itemId == $M11_ST_IA) | .order] == [5]" "item A orders 5"
expect_jq '.state == "counted"' "still counted (nothing ordered yet)"
req POST "/api/stock/orders/$M11_ST_P/groups" "$ORDR" "{\"supplier\":\"$M11_ST_SUPB\"}"
expect_status 400 "marking a group with nothing to order"
req POST "/api/stock/orders/$M11_ST_P/groups" "$WSMGR" "{\"supplier\":\"$M11_ST_SUPA\"}"
expect_status 403 "wsmgr marks a group ordered"
req GET /api/orders/deliveries "$WSMGR"
expect_status 200 "wsmgr GET deliveries"
M11_ST_TODAY_N=$(jqr '.counts.today')
M11_ST_YDAY=$(date -u -d "$M11_ST_TODAY -1 day" +%F)
req POST "/api/stock/orders/$M11_ST_P/groups" "$ORDR" \
  "{\"supplier\":\"$M11_ST_SUPA\",\"expectedDate\":\"$M11_ST_YDAY\"}"
expect_status 400 "an expected date before the ordered date (section 15 nit)"
expect_jq '.error | test("^The expected date can.t be before it was ordered")' "and says so"
req POST "/api/stock/orders/$M11_ST_P/groups" "$ORDR" \
  "{\"supplier\":\"$M11_ST_SUPA\",\"expectedDate\":\"$M11_ST_TODAY\"}"
expect_status 200 "ordr marks group A ordered, expected today"
expect_jq ".state == \"ordered\"" "group B has no quantities, so group A alone takes the month to ordered (section 15.19)"
expect_jq "[.groups[] | select(.supplier == \"$M11_ST_SUPA\") | .ordered.date] == [\"$M11_ST_TODAY\"]" "ordered today"
req POST "/api/stock/orders/$M11_ST_P/groups" "$ORDR" "{\"supplier\":\"$M11_ST_SUPA\"}"
expect_status 409 "marking it ordered twice"
M11_ST_DID="$M11_ST_P:$M11_ST_SUPA"
req GET /api/orders/deliveries "$WSMGR"
expect_status 200 "wsmgr GET deliveries"
expect_jq "[.stock.items[] | select(.id == \"$M11_ST_DID\" and .type == \"stock\" and .label == \"Stock order $M11_ST_PL\" and .supplier == \"$M11_ST_SUPA\" and .expectedDate == \"$M11_ST_TODAY\" and .overdue == false and .link == \"/stock.html?period=$M11_ST_P\")] | length == 1" \
  "the group is waiting on Deliveries"
expect_eq "$(jqr '.counts.today')" "$((M11_ST_TODAY_N + 1))" "counts.today includes it"
expect_jq '.stock.counts.today >= 1' "and so does stock.counts.today"
req PUT "/api/stock/orders/$M11_ST_P/order" "$ORDR" "{\"lines\":[{\"itemId\":$M11_ST_IA,\"order\":6}]}"
expect_status 409 "changing a line in an ordered group"
expect_jq ".error == \"$M11_ST_SUPA has already been ordered\"" "and names the supplier"
req POST "/api/stock/orders/$M11_ST_P/reopen" "$ORDR"
expect_status 409 "reopening the count once a group is ordered"
req POST "/api/stock/orders/$M11_ST_P/groups" "$ORDR" "{\"supplier\":\"$M11_ST_SUPA\",\"undo\":true}"
expect_status 200 "ordr undoes group A"
expect_jq '.state == "counted"' "back to counted"
req POST "/api/stock/orders/$M11_ST_P/groups" "$ORDR" \
  "{\"supplier\":\"$M11_ST_SUPA\",\"orderedDate\":\"$M11_ST_TODAY\",\"expectedDate\":\"$M11_ST_TODAY\"}"
expect_status 200 "ordr marks group A ordered again"

echo "--- receiving ---"
req POST "/api/stock/orders/$M11_ST_P/groups/received" "$WSMGR" \
  "{\"supplier\":\"$M11_ST_SUPA\",\"deliveryNote\":\"M11 one box short\"}"
expect_status 200 "wsmgr receives group A"
expect_jq '.state == "received"' "the month is received on group A alone (group B has nothing to order)"
expect_jq "[.groups[] | select(.supplier == \"$M11_ST_SUPA\") | .received.by.id] == [$M11_ST_WSMGR_ID]" "received by wsmgr"
m11_st_notifs "$ORDR" stock.delivery_note "/stock.html?period=$M11_ST_P"
expect_eq "$M11_ST_N" 1 "ordr is told about the group's delivery note (section 15.20)"
expect_jq "[.rows[] | select(.kind == \"stock.delivery_note\" and .link == \"/stock.html?period=$M11_ST_P\") | [.title, .body]] == [[\"Delivery note: Stock order $M11_ST_PL\", \"$M11_ST_SUPA: M11 one box short\"]]" \
  "the notice names the month, the supplier and the note"
m11_st_notifs "$WSMGR" stock.delivery_note "/stock.html?period=$M11_ST_P"
expect_eq "$M11_ST_N" 0 "the actor (wsmgr) is not told"
req POST "/api/stock/orders/$M11_ST_P/groups/received" "$WSMGR" "{\"supplier\":\"$M11_ST_SUPA\"}"
expect_status 409 "receiving it twice"
req GET /api/orders/deliveries "$WSMGR"
expect_jq "[.stock.items[] | select(.id == \"$M11_ST_DID\")] | length == 0" "no longer waiting"
expect_jq "[.stock.recent[] | select(.id == \"$M11_ST_DID\" and .receivedDate == \"$M11_ST_TODAY\" and .receivedBy.id == $M11_ST_WSMGR_ID and .deliveryNote == \"M11 one box short\")] | length == 1" \
  "in stock.recent with the note"
req POST "/api/stock/orders/$M11_ST_P/groups" "$ORDR" "{\"supplier\":\"$M11_ST_SUPA\",\"undo\":true}"
expect_status 409 "undoing the order of a received group"
req POST "/api/stock/orders/$M11_ST_P/groups/received" "$WSMGR" "{\"supplier\":\"$M11_ST_SUPA\",\"undo\":true}"
expect_status 200 "wsmgr undoes receiving"
expect_jq '.state == "ordered"' "back to ordered"
req POST "/api/stock/orders/$M11_ST_P/groups/received" "$WSMGR" "{\"supplier\":\"$M11_ST_SUPA\"}"
expect_status 200 "wsmgr receives it again"
expect_jq "[.groups[] | select(.supplier == \"$M11_ST_SUPA\") | .deliveryNote] == [\"M11 one box short\"]" "the note stayed"
m11_st_notifs "$ORDR" stock.delivery_note "/stock.html?period=$M11_ST_P"
expect_eq "$M11_ST_N" 1 "receiving again with the same note sends no second notice"

echo "--- a month that needs nothing: counted until Ordering closes it (section 15.19) ---"
m11_st_free /api/stock/orders
M11_ST_P2=$M11_ST_FREE
req PUT "/api/stock/orders/$M11_ST_P2/have" "$WSMGR" "{\"lines\":[{\"itemId\":$M11_ST_IA,\"have\":7}]}"
expect_status 200 "wsmgr types a Have in another month"
expect_jq '.state == "counting"' "still counting"
req POST "/api/stock/orders/$M11_ST_P2/nothing" "$ORDR" '{}'
expect_status 409 "marking nothing to order before the count is finished"
req POST "/api/stock/orders/$M11_ST_P2/counted" "$WSMGR"
expect_status 200 "wsmgr finishes the count; no group has anything to order"
expect_jq '.state == "counted" and .nothingToOrder == null' "the month is counted, to order (not done)"
req GET /api/stock/summary "$ORDR"
expect_status 200 "ordr GET /api/stock/summary"
expect_jq "[.stockToOrder[] | select(.period == \"$M11_ST_P2\" and .state == \"counted\")] | length == 1" "the dashboard lists it"
req POST "/api/stock/orders/$M11_ST_P2/nothing" "$WSMGR" '{}'
expect_status 403 "wsmgr marks nothing to order"
req POST "/api/stock/orders/$M11_ST_P2/nothing" "$ORDR" '{"undo":true}'
expect_status 409 "undoing a month that isn't marked"
req PUT "/api/stock/orders/$M11_ST_P2/order" "$ORDR" "{\"lines\":[{\"itemId\":$M11_ST_IA,\"order\":2}]}"
expect_status 200 "ordr types an Order"
req POST "/api/stock/orders/$M11_ST_P2/nothing" "$ORDR" '{}'
expect_status 409 "marking nothing to order with a quantity present"
expect_jq '.error == "Some items have an order quantity. Clear them, or mark their groups ordered."' "and says what to do"
req PUT "/api/stock/orders/$M11_ST_P2/order" "$ORDR" "{\"lines\":[{\"itemId\":$M11_ST_IA,\"order\":0}]}"
expect_status 200 "ordr takes it back to 0"
expect_jq '.state == "counted"' "still counted (quantities cleared, nothing closed)"
req POST "/api/stock/orders/$M11_ST_P2/nothing" "$ORDR" '{}'
expect_status 200 "ordr marks the month nothing to order"
expect_jq ".state == \"nothing\" and .nothingToOrder.by.id != null and (.nothingToOrder.at | length > 0)" "the month is closed, with who and when"
req GET /api/stock/summary "$ORDR"
expect_jq "all(.stockToOrder[]; .period != \"$M11_ST_P2\")" "the dashboard no longer lists it"
req GET /api/stock/orders "$ORDR"
expect_jq "[.months[] | select(.period == \"$M11_ST_P2\") | .state] == [\"nothing\"]" "the months list shows nothing"
req POST "/api/stock/orders/$M11_ST_P2/nothing" "$ORDR" '{}'
expect_status 409 "marking it twice"
req PUT "/api/stock/orders/$M11_ST_P2/order" "$ORDR" "{\"lines\":[{\"itemId\":$M11_ST_IA,\"order\":2}]}"
expect_status 409 "saving an Order quantity while marked"
expect_jq '.error == "This month is marked nothing to order. Undo that first."' "and says to undo"
req POST "/api/stock/orders/$M11_ST_P2/reopen" "$ORDR"
expect_status 409 "reopening the count while marked"
req POST "/api/stock/orders/$M11_ST_P2/nothing" "$WSMGR" '{"undo":true}'
expect_status 403 "wsmgr undoes nothing to order"
req POST "/api/stock/orders/$M11_ST_P2/nothing" "$ORDR" '{"undo":true}'
expect_status 200 "ordr undoes it"
expect_jq '.state == "counted" and .nothingToOrder == null' "back to counted"
req GET /api/stock/summary "$ORDR"
expect_jq "[.stockToOrder[] | select(.period == \"$M11_ST_P2\")] | length == 1" "and back on the dashboard"
req PUT "/api/stock/orders/$M11_ST_P2/order" "$ORDR" "{\"lines\":[{\"itemId\":$M11_ST_IA,\"order\":2}]}"
expect_status 200 "an Order quantity saves again"
req PUT "/api/stock/orders/$M11_ST_P2/order" "$ORDR" "{\"lines\":[{\"itemId\":$M11_ST_IA,\"order\":0}]}"
expect_status 200 "and clears again"
req POST "/api/stock/orders/$M11_ST_P2/nothing" "$ORDR" '{}'
expect_status 200 "ordr closes the run's month as nothing to order"
req GET /api/stock/orders "$WSMGR"
expect_jq "[.months[] | select(.period == \"$M11_ST_P\") | .state] == [\"received\"]" "the months list shows it received"

echo "--- periods ---"
req GET "/api/stock/orders/$M11_ST_NEXT" "$WSMGR"
expect_status 400 "a future month"
req PUT "/api/stock/orders/$M11_ST_NEXT/have" "$WSMGR" "{\"lines\":[{\"itemId\":$M11_ST_IA,\"have\":1}]}"
expect_status 400 "Have for a future month"
req GET /api/stock/orders/2026-13 "$WSMGR"
expect_status 400 "a month that isn't YYYY-MM"
req GET "/api/stock/orders/$M11_ST_THIS" "$WSMGR"
expect_status 200 "this month"

# The run's items leave the list (a later run's months don't carry them).
req PATCH "/api/stock/items/$M11_ST_IB" "$ORDR" '{"active":false}'
expect_status 200 "ordr deactivates item B"
expect_jq '.active == false' "item B is inactive"
req GET "/api/stock/items?all=1" "$WSMGR"
expect_jq "[.items[] | select(.id == $M11_ST_IB)] | length == 0" "wsmgr's ?all=1 still lists active items only"
req GET "/api/stock/items?all=1" "$ORDR"
expect_jq "[.items[] | select(.id == $M11_ST_IB)] | length == 1" "ordr's ?all=1 includes it"
req PATCH "/api/stock/items/$M11_ST_IA" "$ORDR" '{"active":false}'
expect_status 200 "ordr deactivates item A"
req GET "/api/stock/orders/$M11_ST_P" "$WSMGR"
expect_jq "[.groups[].lines[] | select(.itemId == $M11_ST_IA or .itemId == $M11_ST_IB)] | length == 2" \
  "the counted month keeps its own lines"

echo "--- boards ---"
req POST /api/boards "$ORDR" '{"supplier":"M","thickness":16,"name":"M11 Test Board One","finish":"Matt","priceCents":12345}'
expect_status 201 "ordr adds board 1, priced"
M11_ST_B1=$(jqr '.id')
req POST /api/boards "$ORDR" '{"supplier":"M","thickness":18,"name":"M11 Test Board Two","finish":"Gloss","priceCents":6789}'
expect_status 201 "ordr adds board 2, priced"
M11_ST_B2=$(jqr '.id')
req POST /api/boards "$ORDR" '{"supplier":"N","thickness":25,"name":"M11 Test Board Three"}'
expect_status 201 "ordr adds board 3, no price"
expect_jq '.priceCents == null' "board 3 has no price"
M11_ST_B3=$(jqr '.id')
req POST /api/boards "$WSMGR" '{"name":"M11 Test Board Four"}'
expect_status 403 "wsmgr adds a board"
req POST /api/boards "$ORDR" '{"name":"M11 Test Board Bad","thickness":0}'
expect_status 400 "a zero thickness"
req GET /api/boards "$WSMGR"
expect_status 200 "wsmgr GET /api/boards"
expect_jq "[.boards[] | select(.id == $M11_ST_B1)] | length == 1" "wsmgr sees board 1"
expect_jq '[.boards[] | has("priceCents")] | any | not' "wsmgr sees no priceCents key"
req GET /api/boards "$ORDR"
expect_jq "[.boards[] | select(.id == $M11_ST_B1) | .priceCents] == [12345]" "ordr sees the price"

m11_st_free /api/boards/counts
M11_ST_BP=$M11_ST_FREE
M11_ST_BPL=$(m11_st_label "$M11_ST_BP")
req GET "/api/boards/counts/$M11_ST_BP" "$WSMGR"
expect_status 200 "wsmgr GET the board month (no record yet)"
expect_jq '.status == "open" and (has("valueCents") | not) and ([.lines[] | has("priceCents")] | any | not)' \
  "open, and no money for wsmgr"
req PUT "/api/boards/counts/$M11_ST_BP/lines" "$WSMGR" "{\"lines\":[{\"boardId\":$M11_ST_B1,\"qty\":0.3}]}"
expect_status 400 "qty 0.3"
req PUT "/api/boards/counts/$M11_ST_BP/lines" "$WSMGR" \
  "{\"lines\":[{\"boardId\":$M11_ST_B1,\"qty\":2.5},{\"boardId\":$M11_ST_B2,\"qty\":1},{\"boardId\":$M11_ST_B3,\"qty\":3}]}"
expect_status 200 "wsmgr sets qty 2.5, 1 and 3"
expect_jq "[.lines[] | select(.boardId == $M11_ST_B1) | .qty] == [2.5]" "board 1 counts 2.5"
expect_jq '[.lines[] | has("priceCents")] | any | not' "the answer has no prices"
req PUT "/api/boards/counts/$M11_ST_BP/lines" "$ORDR" "{\"lines\":[{\"boardId\":$M11_ST_B2,\"qty\":1}]}"
expect_status 200 "ordr (stock.count too) saves a line"
expect_jq '.provisional == true and .unpriced == 1' "ordr's answer is provisional, one unpriced"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentCents":-500,"adjustmentNote":"M11 early"}'
expect_status 409 "ordr saves an adjustment on an open month"
expect_jq '.error == "Finish the count first"' "with the sentence"
req POST "/api/boards/counts/$M11_ST_BP/counted" "$WSMGR"
expect_status 200 "wsmgr finishes the board count"
expect_jq ".status == \"counted\" and .counted.by.id == $M11_ST_WSMGR_ID" "counted by wsmgr"
m11_st_notifs "$ORDR" boards.counted "/boards.html?period=$M11_ST_BP"
expect_eq "$M11_ST_N" 1 "ordr is told the boards are counted"
expect_jq "[.rows[] | select(.kind == \"boards.counted\" and .link == \"/boards.html?period=$M11_ST_BP\") | [.title, .body]] == [[\"Board count done: $M11_ST_BPL\", \"Confirm the stock value.\"]]" \
  "the notice names the month and asks for the value"
req PUT "/api/boards/counts/$M11_ST_BP/lines" "$WSMGR" "{\"lines\":[{\"boardId\":$M11_ST_B1,\"qty\":3}]}"
expect_status 409 "wsmgr qty after counting"
expect_jq '.error == "The count is finished"' "with the sentence"

echo "--- the adjustment saves as typed (section 15.13) ---"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$WSMGR" '{"adjustmentCents":-500,"adjustmentNote":"M11 wsmgr"}'
expect_status 403 "wsmgr (stock.count only) saves an adjustment"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ACCT" '{"adjustmentCents":-500,"adjustmentNote":"M11 acct"}'
expect_status 403 "acct saves an adjustment"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentCents":12.5}'
expect_status 400 "a fractional cent adjustment"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentCents":"-5"}'
expect_status 400 "an adjustment typed as text"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentCents":1000000001}'
expect_status 400 "an adjustment beyond the limit"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" "$(jq -nc --arg n "$(printf 'x%.0s' $(seq 1 501))" '{adjustmentCents:-500,adjustmentNote:$n}')"
expect_status 400 "a note of 501 characters"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentCents":-500}'
expect_status 200 "ordr saves an adjustment with no note yet (drafting)"
expect_jq '.status == "counted" and .adjustmentCents == -500 and .adjustmentNote == "" and .provisional == true' "saved, still counted"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentCents":-500,"adjustmentNote":"M11 offcuts written off"}'
expect_status 200 "ordr saves the note"
req GET "/api/boards/counts/$M11_ST_BP" "$ORDR"
expect_jq '.status == "counted" and .adjustmentCents == -500 and .adjustmentNote == "M11 offcuts written off" and .valueCents == (.subtotalCents - 500)'   "the counted month reads the saved adjustment back"
req GET "/api/boards/counts/$M11_ST_BP" "$WSMGR"
expect_status 200 "wsmgr GET the counted board month"
expect_jq 'has("adjustmentCents") | not' "wsmgr's view has no adjustment"
req GET "/api/audit?action=board_count.adjustment&entityId=$M11_ST_BP&limit=20" "$ADMIN"
expect_status 200 "admin GET the audit log for the adjustment"
expect_jq '.total == 2' "the two adjustment saves are audited"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentCents":-700}'
expect_status 200 "ordr sends only the amount"
expect_jq '.adjustmentCents == -700 and .adjustmentNote == "M11 offcuts written off"' "the saved note is kept (section 15.24)"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentNote":"M11 amount kept"}'
expect_status 200 "ordr sends only the note"
expect_jq '.adjustmentCents == -700 and .adjustmentNote == "M11 amount kept"' "the saved amount is kept"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentCents":-500,"adjustmentNote":"M11 offcuts written off"}'
expect_status 200 "ordr restores both"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentNote":""}'
expect_status 200 "ordr clears the note alone"
expect_jq '.adjustmentCents == -500 and .adjustmentNote == ""' "an empty note clears it; the amount stays"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentNote":"M11 offcuts written off"}'
expect_status 200 "ordr types the note again"

echo "--- the value ---"
req POST "/api/boards/counts/$M11_ST_BP/value" "$WSMGR" '{}'
expect_status 403 "wsmgr confirms the value"
req POST "/api/boards/counts/$M11_ST_BP/value" "$ORDR" '{}'
expect_status 409 "valuing with an unpriced board"
expect_jq '.error == "1 counted board(s) have no price"' "names how many"
req PATCH "/api/boards/$M11_ST_B3" "$ORDR" '{"priceCents":1001}'
expect_status 200 "ordr prices board 3"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentNote":""}'
expect_status 200 "ordr clears the note"
req POST "/api/boards/counts/$M11_ST_BP/value" "$ORDR" '{"adjustmentCents":-500}'
expect_status 400 "an adjustment without a note (the saved note is empty)"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentNote":"M11 offcuts written off"}'
expect_status 200 "ordr types the note"
req POST "/api/boards/counts/$M11_ST_BP/value" "$ORDR" '{}'
expect_status 200 "ordr confirms the value with no body adjustment: the saved one is used"
# round(2.5 x 12345) + 1 x 6789 + 3 x 1001 - 500 = 30863 + 6789 + 3003 - 500
expect_jq '.status == "valued" and .valueCents == 40155 and .subtotalCents == 40655 and .adjustmentCents == -500 and .provisional == false' \
  "value_cents is the exact sum, with the saved adjustment and note"
expect_jq '.adjustmentNote == "M11 offcuts written off"' "the saved note is kept"
req PUT "/api/boards/counts/$M11_ST_BP/adjustment" "$ORDR" '{"adjustmentCents":-100,"adjustmentNote":"M11 late"}'
expect_status 409 "an adjustment saved on a valued month"
expect_jq '.error == "The value is already confirmed"' "with the sentence"
req PATCH "/api/boards/$M11_ST_B1" "$ORDR" '{"priceCents":99999}'
expect_status 200 "ordr changes board 1's price"
req GET "/api/boards/counts/$M11_ST_BP" "$ORDR"
expect_jq "[.lines[] | select(.boardId == $M11_ST_B1) | .priceCents] == [12345] and .valueCents == 40155" \
  "the valued month keeps its frozen price and value"
req GET /api/boards/counts "$ORDR"
expect_jq "[.months[] | select(.period == \"$M11_ST_BP\") | .valueCents] == [40155]" "the months list has the value for ordr"
req GET /api/boards/counts "$WSMGR"
expect_jq "[.months[] | select(.period == \"$M11_ST_BP\") | has(\"valueCents\")] == [false]" "and not for wsmgr"

echo "--- reopening ---"
req POST "/api/boards/counts/$M11_ST_BP/reopen" "$ORDR"
expect_status 403 "ordr reopens a valued month"
req POST "/api/boards/counts/$M11_ST_BP/reopen-count" "$ORDR"
expect_status 409 "ordr reopens the count of a valued month"
req POST "/api/boards/counts/$M11_ST_BP/reopen" "$ADMIN"
expect_status 200 "admin reopens it"
expect_jq '.status == "counted" and .valued == null and .provisional == true' "counted again, provisional"
expect_jq '.adjustmentCents == -500 and .adjustmentNote == "M11 offcuts written off"' "the saved adjustment is kept for the next confirm"
req POST "/api/boards/counts/$M11_ST_BP/value" "$ORDR" '{"adjustmentCents":-100}'
expect_status 200 "a body with only the amount overrides the amount (section 15.24)"
expect_jq '.status == "valued" and .adjustmentCents == -100 and .adjustmentNote == "M11 offcuts written off"' "the saved note is kept"
req POST "/api/boards/counts/$M11_ST_BP/reopen" "$ADMIN"
expect_status 200 "admin reopens it for another confirm"
req POST "/api/boards/counts/$M11_ST_BP/value" "$ORDR" '{"adjustmentCents":-100,"adjustmentNote":"M11 override"}'
expect_status 200 "a body adjustment overrides the saved one"
expect_jq '.status == "valued" and .adjustmentCents == -100 and .adjustmentNote == "M11 override" and .valueCents == (.subtotalCents - 100)'   "valued with the body's adjustment"
req POST "/api/boards/counts/$M11_ST_BP/reopen" "$ADMIN"
expect_status 200 "admin reopens it again"
expect_jq "[.lines[] | select(.boardId == $M11_ST_B1) | .priceCents] == [99999]" "the price is today's again"
req POST "/api/boards/counts/$M11_ST_BP/reopen-count" "$ORDR"
expect_status 200 "ordr reopens the count"
expect_jq '.status == "open" and .counted == null' "the count is open again"
req PUT "/api/boards/counts/$M11_ST_BP/lines" "$WSMGR" "{\"lines\":[{\"boardId\":$M11_ST_B3,\"qty\":null}]}"
expect_status 200 "wsmgr clears board 3"
expect_jq "[.lines[] | select(.boardId == $M11_ST_B3) | .qty] == [null]" "board 3 has no count"
req GET "/api/boards/counts/$M11_ST_NEXT" "$WSMGR"
expect_status 400 "a future board month"

for b in "$M11_ST_B1" "$M11_ST_B2" "$M11_ST_B3"; do
  req PATCH "/api/boards/$b" "$ORDR" '{"active":false}'
  expect_status 200 "ordr deactivates board $b"
done

req GET "/api/boards?all=1" "$WSMGR"
expect_status 200 "wsmgr GET /api/boards?all=1"
expect_jq "[.boards[] | select(.id == $M11_ST_B1)] | length == 0" "wsmgr's ?all=1 still lists active boards only"
req GET "/api/boards?all=1" "$ORDR"
expect_jq "[.boards[] | select(.id == $M11_ST_B1)] | length == 1" "ordr's ?all=1 includes the inactive board"

echo "--- the dashboard summary ---"
req GET /api/stock/summary "$WSMGR"
expect_status 200 "wsmgr GET /api/stock/summary"
expect_jq 'has("stockCount") and has("boardCount") and (has("drawers") | not) and (has("boardValue") | not) and (has("stockToOrder") | not)' \
  "wsmgr gets the count parts only"
req GET /api/stock/summary "$ORDR"
expect_status 200 "ordr GET /api/stock/summary"
expect_jq '(.drawers.toOrder | type) == "number" and (.drawers.waiting | type) == "number" and (.boardValue | type) == "array" and (.stockToOrder | type) == "array"' \
  "ordr gets the drawer and order parts"
req GET /api/stock/summary "$ACCT"
expect_status 403 "acct GET /api/stock/summary"
