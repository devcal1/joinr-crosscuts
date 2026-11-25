# Monthly stock orders smoke (0.2.27, migration 068, docs/plans/stock-orders-plan.md and
# stock-orders-contracts.md): stock_lines on the Orders page (/api/stock-lines), a finished count feeding the
# month (rule A: two counts and an unreceived order, a month boundary, reopen), a count from before the
# change sent once (rule G), a supplier order that holds stock and job items under one PO, receiving and
# undoing per item, the closed Order tab routes, Deliveries entries and the dashboard summary. Sourced by
# ci/smoke.sh after the purchase orders suite, so it shares that script's helpers (step, req, expect_status,
# expect_jq, expect_eq, jqr, fail, ok) and the cookie jars ($ADMIN $ACCT $SCHED $DPM $SHOW $ORDR $WSMGR).
# No shebang and no `set`: the caller owns both. It does not assume a pristine database: its items, jobs and
# suppliers carry a run tag, each count works in a month (or Monday) with no record yet, and it checks only
# its own rows (lines by stock item id or id). Made-up names only (this repo is public).
# Contract: docs/plans/stock-orders-contracts.md.

# ============================================================================
step "stock orders. monthly lines, rule A, rule G, combined PO, receive, undo"
# ============================================================================

SKO_TAG=$(date +%s)
req GET /api/orders/deliveries "$ADMIN"
expect_status 200 "admin reads the server's today"
SKO_TODAY=$(jqr '.date')
SKO_THIS=${SKO_TODAY:0:7}
SKO_PREV=$(date -u -d "$SKO_THIS-01 -1 month" +%Y-%m)
SKO_NEXT=$(date -u -d "$SKO_THIS-01 +1 month" +%Y-%m)
SKO_NEXT2=$(date -u -d "$SKO_THIS-01 +2 month" +%Y-%m)
SKO_YESTERDAY=$(date -u -d "$SKO_TODAY - 1 day" +%F)
SKO_NEXTWEEK=$(date -u -d "$SKO_TODAY + 7 days" +%F)
SKO_THIS_LABEL=$(LC_ALL=C date -u -d "$SKO_THIS-01" '+%B %Y')
SKO_SA="SKO Supplier A $SKO_TAG"
SKO_SB="SKO Supplier B $SKO_TAG"
SKO_SC="SKO Supplier C $SKO_TAG"
SKO_SD="SKO Supplier D $SKO_TAG"
SKO_QMSG="Quantity must be a number above 0 and up to 99999, with at most 2 decimals"

# sko_sql SQL: runs SQL against the database (as the legacy rows and clocks this suite can't make through the API).
sko_sql() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.pragma("foreign_keys = ON");
try { d.exec(process.argv[1]); process.stdout.write("ok"); }
catch (e) { process.stdout.write(String(e.message)); }
d.close();' "$1" | tr -d '\r'
}

# sko_q SQL: the first column of the first row (empty when none).
sko_q() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
const r = d.prepare(process.argv[1]).get();
const v = r ? Object.values(r)[0] : null;
process.stdout.write(v === null || v === undefined ? "" : String(v));
d.close();' "$1" | tr -d '\r'
}

# sko_free: sets SKO_FREE to the earliest month from 2001-01 with no stock_orders record.
sko_free() {
  req GET /api/stock/orders "$ORDR"
  expect_status 200 "ordr GET /api/stock/orders"
  local used y m p
  used=$(jqr '.months[].period')
  for y in $(seq 2001 2020); do
    for m in 01 02 03 04 05 06 07 08 09 10 11 12; do
      p="$y-$m"
      if ! printf '%s\n' "$used" | grep -qx "$p"; then
        SKO_FREE=$p
        return 0
      fi
    done
  done
  fail "no free month"
}

# No period may be marked sent by an earlier suite: a count older than a sent one is kept but not sent.
sko_sql "UPDATE stock_orders SET sent_at = NULL, sent_period = NULL" >/dev/null

# sko_count PERIOD "ITEM:HAVE ITEM:HAVE ...": Have typed by the workshop manager, then Finish count.
sko_count() {
  local lines="" pair
  for pair in $2; do
    lines="${lines:+$lines,}{\"itemId\":${pair%%:*},\"have\":${pair##*:}}"
  done
  req PUT "/api/stock/orders/$1/have" "$WSMGR" "{\"lines\":[$lines]}"
  expect_status 200 "wsmgr types Have for $1"
  req POST "/api/stock/orders/$1/counted" "$WSMGR"
  expect_status 200 "wsmgr finishes the count for $1"
}

# sko_lines MONTH: the month's lines as the ordering user -> BODY.
sko_lines() {
  req GET "/api/stock-lines?month=$1" "$ORDR"
  expect_status 200 "ordr GET stock-lines for $1"
}

# sko_item_lines ITEM_ID: every live line of the item, as a compact string "qty:status:source:month,..." (by id).
sko_item_lines() {
  sko_q "SELECT group_concat(printf('%g:%s:%s:%s', quantity, status, source, month), ',') FROM (SELECT * FROM stock_lines WHERE stock_item_id = $1 AND deleted_at IS NULL ORDER BY id)"
}

# sko_item NAME SUPPLIER TARGET [CODE]: a stock item -> SKO_ITEM_ID.
sko_item() {
  local target=${3:-null} code=${4:-}
  req POST /api/stock/items "$ORDR" "{\"supplier\":\"$2\",\"item\":\"$1 $SKO_TAG\",\"code\":\"$code\",\"target\":$target}"
  expect_status 201 "ordr adds stock item $1"
  SKO_ITEM_ID=$(jqr '.id')
}

# sko_notifs JAR KIND LINK: how many KIND notifications the user has with LINK -> SKO_N.
sko_notifs() {
  req GET "/api/notifications?limit=100" "$1"
  expect_status 200 "GET /api/notifications"
  SKO_N=$(jqr "[.rows[] | select(.kind == \"$2\" and .link == \"$3\")] | length")
}

echo "--- the table (migration 068) ---"
SKO_COLS=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
process.stdout.write(d.prepare("PRAGMA table_info(stock_lines)").all().map((c) => c.name).join(","));
process.stdout.write("|" + d.prepare("PRAGMA table_info(stock_orders)").all().map((c) => c.name).filter((n) => n.startsWith("sent")).join(","));
d.close();' | tr -d '\r')
expect_eq "$SKO_COLS" "id,month,supplier,item,code,quantity,status,ordered_date,expected_date,received_date,received_by,notes,delivery_note,source,stock_item_id,supplier_order_id,deleted_at,deleted_by,created_at,created_by,updated_at,updated_by|sent_at,sent_period" "stock_lines has the documented columns and stock_orders gains sent_at and sent_period"
expect_eq "$(sko_sql "INSERT INTO stock_lines (month, supplier, item, quantity, source, created_at, updated_at) VALUES ('2001-01', 'x', 'y', 0, 'hand', 'a', 'a')" | grep -ci 'check')" "1" "quantity must be above 0"
expect_eq "$(sko_sql "INSERT INTO stock_lines (month, supplier, item, quantity, source, created_at, updated_at) VALUES ('2001-01', ' ', 'y', 1, 'hand', 'a', 'a')" | grep -ci 'check')" "1" "the supplier can't be blank"
expect_eq "$(sko_sql "INSERT INTO stock_lines (month, supplier, item, quantity, source, created_at, updated_at) VALUES ('2001-01', 'x', 'y', 1, 'other', 'a', 'a')" | grep -ci 'check')" "1" "source is count or hand"
expect_eq "$(sko_sql "INSERT INTO stock_lines (month, supplier, item, quantity, status, source, created_at, updated_at) VALUES ('2001-01', 'x', 'y', 1, 'cancelled', 'hand', 'a', 'a')" | grep -ci 'check')" "1" "status is to_order, ordered or received"

echo "--- access ---"
req GET /api/stock-lines/months "$ORDR"
expect_status 200 "ordr GET months"
req GET /api/stock-lines/months "$WSMGR"
expect_status 200 "wsmgr (orders.view) GET months"
req GET /api/stock-lines/months "$SCHED"
expect_status 200 "sched (orders.view) GET months"
req GET /api/stock-lines/months "$SHOW"
expect_status 403 "show GET months"
req GET "/api/stock-lines?month=$SKO_THIS" "$SHOW"
expect_status 403 "show GET a month"
req GET /api/stock-lines/items "$SHOW"
expect_status 403 "show GET items"
req POST /api/stock-lines "$ACCT" "{\"month\":\"$SKO_THIS\",\"supplier\":\"$SKO_SA\",\"item\":\"Nope\",\"quantity\":1}"
expect_status 403 "acct (orders.view only) can't add a line"
req POST /api/stock-lines "$WSMGR" "{\"month\":\"$SKO_THIS\",\"supplier\":\"$SKO_SA\",\"item\":\"Nope\",\"quantity\":1}"
expect_status 403 "wsmgr (receive only) can't add a line"
req PATCH /api/stock-lines/1 "$ACCT" '{"notes":"x"}'
expect_status 403 "acct can't PATCH"
req DELETE /api/stock-lines/1 "$WSMGR"
expect_status 403 "wsmgr can't DELETE"
req POST /api/orders/mark-ordered "$ACCT" '{"stockLineIds":[1]}'
expect_status 403 "acct can't mark ordered"
req POST /api/orders/mark-ordered "$DPM" '{"stockLineIds":[1]}'
expect_status 403 "dpm (no mark_ordered) can't mark stock ordered"

echo "--- the stock list and the count feed the month (rule A) ---"
sko_item "Hinge" "$SKO_SA" 20 "SKO-A"
SKO_IA=$SKO_ITEM_ID
sko_item "Screw" "$SKO_SA" 10
SKO_IB=$SKO_ITEM_ID
sko_item "Glue" "$SKO_SA"
SKO_IC=$SKO_ITEM_ID
sko_item "Runner" "$SKO_SB" 5 "SKO-D"
SKO_ID=$SKO_ITEM_ID
sko_item "Catch" "$SKO_SC"
SKO_IE=$SKO_ITEM_ID
sko_item "Cover" "$SKO_SD" 4
SKO_IF=$SKO_ITEM_ID
req GET /api/stock-lines/items "$ORDR"
expect_status 200 "ordr GET the type-ahead list"
expect_jq "[.[] | select(.id == $SKO_IA)] == [{\"id\":$SKO_IA,\"supplier\":\"$SKO_SA\",\"code\":\"SKO-A\",\"item\":\"Hinge $SKO_TAG\"}]" "the list item has id, supplier, code and item"
sko_free
SKO_P1=$SKO_FREE
sko_notifs "$ORDR" stock.counted "/orders.html?stock=$SKO_THIS"
SKO_N0=$SKO_N
sko_count "$SKO_P1" "$SKO_IA:5 $SKO_IB:10 $SKO_IC:3 $SKO_ID:0"
expect_jq '.state == "counted" and .sent.period != null and (.sent.at | length > 0)' "the count is sent to the month"
expect_jq ".sent.period == \"$SKO_THIS\" and .sentResult == {\"month\":\"$SKO_THIS\",\"added\":2,\"updated\":0,\"removed\":0}" "two lines added to this month: Hinge 15 and Runner 5 (Screw has enough, Glue has no target)"
expect_eq "$(sko_item_lines "$SKO_IA")" "15:to_order:count:$SKO_THIS" "the Hinge line is 15, to order, from the count"
expect_eq "$(sko_item_lines "$SKO_ID")" "5:to_order:count:$SKO_THIS" "the Runner line is 5"
expect_eq "$(sko_item_lines "$SKO_IB")" "" "no line for Screw"
expect_eq "$(sko_item_lines "$SKO_IC")" "" "no line for Glue (no target)"
sko_lines "$SKO_THIS"
expect_jq "[.lines[] | select(.stockItemId == $SKO_IA)][0] | .supplier == \"$SKO_SA\" and .code == \"SKO-A\" and .item == \"Hinge $SKO_TAG\" and .createdBy.id != null and .receivedBy == null and .poNumber == null and .overdue == false and .supplierOrderId == null and .notes == \"\" and .deliveryNote == \"\"" "the line shape"
expect_jq '[.lines[] | keys | sort] | all(. == ["code","createdAt","createdBy","deliveryNote","expectedDate","id","item","month","notes","orderedDate","overdue","poNumber","quantity","receivedBy","receivedDate","source","status","stockItemId","supplier","supplierOrderId"])' "every line has exactly the documented fields"
expect_jq "(.suppliers | index(\"$SKO_SA\")) != null and (.suppliers | index(\"$SKO_SA\")) < (.suppliers | index(\"$SKO_SB\"))" "the month lists its suppliers, A-Z"
sko_notifs "$ORDR" stock.counted "/orders.html?stock=$SKO_THIS"
expect_eq "$SKO_N" "$((SKO_N0 + 1))" "ordr is told, with a link to the month on the Orders page"
req GET "/api/notifications?limit=100" "$ORDR"
SKO_P1_LABEL=$(LC_ALL=C date -u -d "$SKO_P1-01" '+%B %Y')
expect_jq "[.rows[] | select(.kind == \"stock.counted\" and .link == \"/orders.html?stock=$SKO_THIS\" and .title == \"Stock counted: $SKO_P1_LABEL\") | .body] == [\"2 lines added or changed on the $SKO_THIS_LABEL stock order.\"]" "the notice names the count and says how many lines were added or changed"
req GET /api/stock-lines/months "$ORDR"
expect_jq ".current == \"$SKO_THIS\" and .first <= .current and .last >= \"$SKO_NEXT\" and ([.months[] | select(.month == \"$SKO_THIS\")][0] | .toOrder >= 2 and (.ordered | type) == \"number\" and (.received | type) == \"number\")" "the months list has this month's counts"
expect_jq "(.months | length) >= 2 and ([.months[].month] | . == sort) and .months[0].month == .first and .months[-1].month == .last" "from first to last, oldest first"

echo "--- adding, editing and deleting by hand ---"
req POST /api/stock-lines "$ORDR" "{\"month\":\"$SKO_PREV\",\"supplier\":\"$SKO_SA\",\"item\":\"Last month\",\"quantity\":1}"
expect_status 400 "a month in the past"
req POST /api/stock-lines "$ORDR" "{\"month\":\"$SKO_NEXT2\",\"supplier\":\"$SKO_SA\",\"item\":\"Too far\",\"quantity\":1}"
expect_status 400 "a month two ahead"
req POST /api/stock-lines "$ORDR" "{\"month\":\"2026-13\",\"supplier\":\"$SKO_SA\",\"item\":\"Bad\",\"quantity\":1}"
expect_status 400 "a month that isn't YYYY-MM"
for bad_q in 0 -1 100000 2.456 '"abc"' '""' null true; do
  req POST /api/stock-lines "$ORDR" "{\"month\":\"$SKO_THIS\",\"supplier\":\"$SKO_SA\",\"item\":\"Bad qty\",\"quantity\":$bad_q}"
  expect_status 400 "quantity $bad_q"
done
req POST /api/stock-lines "$ORDR" "{\"month\":\"$SKO_THIS\",\"supplier\":\"$SKO_SA\",\"item\":\"No qty\"}"
expect_status 400 "no quantity"
req POST /api/stock-lines "$ORDR" "{\"month\":\"$SKO_THIS\",\"supplier\":\" \",\"item\":\"No supplier\",\"quantity\":1}"
expect_status 400 "a blank supplier"
req POST /api/stock-lines "$ORDR" "{\"month\":\"$SKO_THIS\",\"supplier\":\"$SKO_SA\",\"item\":\"\",\"quantity\":1}"
expect_status 400 "a blank item"
req POST /api/stock-lines "$ORDR" "{\"month\":\"$SKO_THIS\",\"supplier\":\"$SKO_SA\",\"item\":\"Bad link\",\"quantity\":1,\"stockItemId\":999999999}"
expect_status 400 "a stock item that doesn't exist"
req POST /api/stock-lines "$ORDR" "{\"month\":\"$SKO_NEXT\",\"supplier\":\"$SKO_SB\",\"item\":\"Hand item $SKO_TAG\",\"quantity\":\"2.5\",\"notes\":\"by hand\",\"stockItemId\":$SKO_IB}"
expect_status 201 "ordr adds a line for next month, linked to a stock item"
expect_jq ".source == \"hand\" and .status == \"to_order\" and .quantity == 2.5 and .month == \"$SKO_NEXT\" and .stockItemId == $SKO_IB and .code == \"\" and .notes == \"by hand\"" "a hand line, with its notes and stock link"
SKO_HAND=$(jqr '.id')
req GET "/api/stock-lines?month=$SKO_NEXT" "$ORDR"
expect_jq "[.lines[] | select(.id == $SKO_HAND)] | length == 1" "it is on next month"
req GET /api/stock-lines/months "$ORDR"
expect_jq ".last >= \"$SKO_NEXT\"" "the months run reaches next month"
req PATCH "/api/stock-lines/$SKO_HAND" "$ORDR" "{\"supplier\":\"$SKO_SA\",\"item\":\"Edited item $SKO_TAG\",\"quantity\":4,\"notes\":\"edited\"}"
expect_status 200 "ordr edits supplier, item, quantity and notes"
expect_jq ".supplier == \"$SKO_SA\" and .item == \"Edited item $SKO_TAG\" and .quantity == 4 and .notes == \"edited\"" "the edit stands"
req PATCH "/api/stock-lines/$SKO_HAND" "$DPM" "{\"quantity\":5}"
expect_status 200 "dpm (orders.edit) edits the quantity"
req PATCH "/api/stock-lines/$SKO_HAND" "$WSMGR" "{\"notes\":\"x\"}"
expect_status 403 "wsmgr (receive only) can't edit notes"
req PATCH "/api/stock-lines/$SKO_HAND" "$ORDR" '{"quantity":0}'
expect_status 400 "quantity 0"
req PATCH "/api/stock-lines/$SKO_HAND" "$ORDR" '{"quantity":null}'
expect_status 400 "quantity cleared"
req PATCH "/api/stock-lines/$SKO_HAND" "$ORDR" '{"status":"maybe"}'
expect_status 400 "an unknown status"
req PATCH "/api/stock-lines/$SKO_HAND" "$ORDR" '{"status":"ordered"}'
expect_status 409 "to_order > ordered is refused: only a supplier order does it"
req PATCH "/api/stock-lines/$SKO_HAND" "$ORDR" '{"status":"received"}'
expect_status 409 "to_order > received is refused"
expect_jq '.error == "Mark it ordered first"' "and says to mark it ordered first"
req PATCH "/api/stock-lines/$SKO_HAND" "$ORDR" '{"expectedDate":"2030-01-01"}'
expect_status 409 "an expected date on a line still to order"
req PATCH /api/stock-lines/999999999 "$ORDR" '{"notes":"x"}'
expect_status 404 "a line that doesn't exist"
req PATCH /api/stock-lines/abc "$ORDR" '{"notes":"x"}'
expect_status 404 "an id that isn't a number"
req DELETE "/api/stock-lines/$SKO_HAND" "$ORDR"
expect_status 200 "ordr deletes the hand line"
req GET "/api/stock-lines?month=$SKO_NEXT" "$ORDR"
expect_jq "[.lines[] | select(.id == $SKO_HAND)] | length == 0" "a deleted line is in no list"
req DELETE "/api/stock-lines/$SKO_HAND" "$ORDR"
expect_status 409 "deleting it twice"
req PATCH "/api/stock-lines/$SKO_HAND" "$ORDR" '{"notes":"back"}'
expect_status 409 "editing a deleted line"
req GET "/api/audit?entityType=stock_line&entityId=$SKO_HAND&limit=20" "$ADMIN"
expect_status 200 "audit for the hand line"
expect_jq '[.rows[].action] | sort == ["stock_line.create","stock_line.delete","stock_line.update","stock_line.update"]' "create, two edits and the delete are audited"
req GET "/api/stock-lines?status=bogus" "$ORDR"
expect_status 400 "an unknown status filter"
req GET "/api/stock-lines" "$ORDR"
expect_status 400 "neither month nor status"
req GET "/api/stock-lines?month=2026-13" "$ORDR"
expect_status 400 "a bad month filter"

echo "--- one supplier order for stock and job items ---"
req POST /api/job-records "$ADMIN" "{\"name\":\"SKO Harlow kitchen $SKO_TAG\",\"clientName\":\"SKO Client $SKO_TAG\",\"valueCents\":2000000}"
expect_status 201 "create a job"
SKO_JOB=$(jqr '.id')
req POST "/api/job-records/$SKO_JOB/orders/batch" "$ADMIN" "{\"lines\":[{\"supplier\":\"$SKO_SA\",\"description\":\"SKO Soft-close hinge\",\"quantity\":24},{\"supplier\":\"$SKO_SB\",\"description\":\"SKO Runner\",\"quantity\":2}]}"
expect_status 201 "add a Supplier A and a Supplier B item to the job"
SKO_J1=$(jqr '.orders[0].id')
SKO_J2=$(jqr '.orders[1].id')
SKO_LA=$(sko_q "SELECT id FROM stock_lines WHERE stock_item_id = $SKO_IA AND deleted_at IS NULL")
SKO_LD=$(sko_q "SELECT id FROM stock_lines WHERE stock_item_id = $SKO_ID AND deleted_at IS NULL")
req POST /api/orders/mark-ordered "$ORDR" '{}'
expect_status 400 "nothing ticked"
req POST /api/orders/mark-ordered "$ORDR" '{"orderIds":[],"stockLineIds":[]}'
expect_status 400 "nothing ticked, two empty lists"
req POST /api/orders/mark-ordered "$ORDR" "{\"stockLineIds\":[$SKO_LA,$SKO_LA]}"
expect_status 400 "a stock line ticked twice"
req POST /api/orders/mark-ordered "$ORDR" '{"stockLineIds":[0]}'
expect_status 400 "a stock line id of 0"
req POST /api/orders/mark-ordered "$ORDR" '{"stockLineIds":"1"}'
expect_status 400 "stockLineIds that isn't a list"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$SKO_J1],\"stockLineIds\":[$SKO_LD]}"
expect_status 400 "a stock item and a job item from different suppliers"
expect_jq '.error == "A supplier order is for one supplier"' "one supplier per order"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$SKO_J1],\"stockLineIds\":[$SKO_LA,999999999]}"
expect_status 409 "a ticked stock line that no longer exists"
expect_eq "$(sko_q "SELECT status FROM orders WHERE id = $SKO_J1")" "to_order" "nothing changed: the job line is still to order"
expect_eq "$(sko_q "SELECT status FROM stock_lines WHERE id = $SKO_LA")" "to_order" "nothing changed: the stock line is still to order"
SKO_POS=$(sko_q "SELECT COUNT(*) FROM supplier_orders")
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$SKO_J1],\"stockLineIds\":[$SKO_LA],\"orderedDate\":\"$SKO_YESTERDAY\",\"expectedDate\":\"$SKO_NEXTWEEK\",\"supplierRef\":\"SKO-$SKO_TAG\"}"
expect_status 200 "ordr marks one job item and one stock item ordered together"
expect_jq ".count == 1 and .jobCount == 1 and .stockCount == 1 and (.stockLines | length) == 1 and (.orders | length) == 1" "count stays the job items; stockCount counts the stock"
SKO_PO=$(jqr '.supplierOrder.poNumber')
SKO_POID=$(jqr '.supplierOrder.id')
expect_jq ".stockLines[0].status == \"ordered\" and .stockLines[0].orderedDate == \"$SKO_YESTERDAY\" and .stockLines[0].expectedDate == \"$SKO_NEXTWEEK\" and .stockLines[0].poNumber == \"$SKO_PO\" and .stockLines[0].supplierOrderId == $SKO_POID and .orders[0].poNumber == \"$SKO_PO\" and .supplierOrder.pdfReady == true" "one PO number on both"
expect_eq "$(sko_q "SELECT COUNT(*) FROM supplier_orders")" "$((SKO_POS + 1))" "one saved order"
expect_eq "$(sko_q "SELECT COUNT(*) FROM supplier_order_lines WHERE supplier_order_id = $SKO_POID")" "1" "supplier_order_lines keeps the job line only"
req GET "/api/supplier-orders/$SKO_POID" "$ORDR"
expect_status 200 "the saved order"
expect_jq ".itemCount == 2 and .hasStock == true and (.jobs | length) == 1 and .jobs[0].jobId == $SKO_JOB and .snapshot.version == 1 and .supplier == \"$SKO_SA\"" "two items, one job, stock flagged"
expect_jq ".items[0].stock == true and .items[0].stockLineId == $SKO_LA and .items[0].orderId == null and .items[0].jobId == null and .items[0].jobNumber == null and .items[0].jobName == \"\" and .items[0].month == \"$SKO_THIS\" and .items[0].quantity == 15 and .items[0].description == \"Hinge $SKO_TAG\" and .items[0].supplier == \"$SKO_SA\"" "the stock item comes first in the snapshot"
expect_jq '(.snapshot.items[0] | keys | sort) == ["description","jobId","jobName","jobNumber","month","orderId","quantity","stock","stockLineId","supplier"]' "with exactly the documented fields"
expect_jq "(.snapshot.items[1] | has(\"stock\") | not) and .snapshot.items[1].orderId == $SKO_J1 and .snapshot.items[1].jobId == $SKO_JOB and .snapshot.items[1].quantity == 24" "the job item has no stock key"
expect_jq '.items[0].current.state == "ordered" and .items[0].current.status == "ordered" and .items[1].current.state == "ordered"' "both are ordered now"
req GET "/api/supplier-orders?q=SKO-$SKO_TAG" "$ORDR"
expect_jq "[.orders[] | select(.id == $SKO_POID)] | length == 1 and .[0].hasStock == true and .[0].itemCount == 2 and (.[0].jobs | length) == 1" "the list says hasStock, counts both and lists the one job"
req GET "/api/supplier-orders/$SKO_POID/pdf" "$ORDR"
expect_status 200 "the PO PDF is made"
req GET "/api/stock-lines?month=$SKO_THIS" "$ORDR"
expect_jq "[.lines[] | select(.id == $SKO_LA)][0] | .status == \"ordered\" and .poNumber == \"$SKO_PO\" and .orderedDate == \"$SKO_YESTERDAY\"" "the month shows it ordered, with its PO"
req GET /api/stock-lines/months "$ORDR"
expect_jq "[.months[] | select(.month == \"$SKO_THIS\")][0] | .ordered >= 1" "and counts it as ordered"
req GET "/api/job-records/$SKO_JOB/orders" "$ADMIN"
expect_jq "[.[] | select(.id == $SKO_J1)][0] | .status == \"ordered\" and .poNumber == \"$SKO_PO\"" "the job item is ordered on the same PO"

echo "--- ordered lines: what can change ---"
req PATCH "/api/stock-lines/$SKO_LA" "$ORDR" '{"quantity":16}'
expect_status 409 "quantity on an ordered line"
req PATCH "/api/stock-lines/$SKO_LA" "$ORDR" '{"supplier":"Someone else"}'
expect_status 409 "supplier on an ordered line"
req PATCH "/api/stock-lines/$SKO_LA" "$ORDR" '{"notes":"ordered note"}'
expect_status 200 "notes on an ordered line"
req PATCH "/api/stock-lines/$SKO_LA" "$ORDR" "{\"expectedDate\":\"$SKO_TODAY\"}"
expect_status 200 "ordr moves the expected date"
expect_jq ".expectedDate == \"$SKO_TODAY\"" "the new expected date"
req PATCH "/api/stock-lines/$SKO_LA" "$DPM" "{\"expectedDate\":\"$SKO_NEXTWEEK\"}"
expect_status 403 "dpm (no mark_ordered) can't move the expected date"
req PATCH "/api/stock-lines/$SKO_LA" "$ORDR" '{"expectedDate":"not a date"}'
expect_status 400 "a bad expected date"
req DELETE "/api/stock-lines/$SKO_LA" "$ORDR"
expect_status 409 "deleting an ordered line"
req PATCH "/api/stock-lines/$SKO_LA" "$ORDR" '{"status":"ordered"}'
expect_status 409 "ordering an ordered line again"
req PATCH "/api/stock-lines/$SKO_LA" "$ORDR" "{\"status\":\"received\",\"receivedDate\":\"$(date -u -d "$SKO_TODAY + 1 day" +%F)\"}"
expect_status 400 "a received date in the future"
req PATCH "/api/stock-lines/$SKO_LA" "$ORDR" "{\"status\":\"received\",\"receivedDate\":\"$(date -u -d "$SKO_YESTERDAY - 1 day" +%F)\"}"
expect_status 400 "a received date before it was ordered"

echo "--- receiving per item, and undoing ---"
req GET /api/orders/deliveries "$WSMGR"
expect_status 200 "wsmgr GET deliveries"
expect_jq "[.stock.items[] | select(.type == \"stock_line\" and .id == $SKO_LA)][0] | .label == \"Stock order $SKO_THIS_LABEL\" and .supplier == \"$SKO_SA\" and .item == \"Hinge $SKO_TAG\" and .code == \"SKO-A\" and .quantity == 15 and .orderedDate == \"$SKO_YESTERDAY\" and .expectedDate == \"$SKO_TODAY\" and .overdue == false and .link == \"/orders.html?stock=$SKO_THIS\"" "the ordered stock line is waiting on Deliveries"
SKO_TODAY_N=$(jqr '.counts.today')
req PATCH "/api/stock-lines/$SKO_LA" "$WSMGR" '{"status":"received","deliveryNote":"SKO one box short"}'
expect_status 200 "wsmgr receives the line, with a delivery note"
expect_jq ".status == \"received\" and .receivedDate == \"$SKO_TODAY\" and .receivedBy.id != null and .deliveryNote == \"SKO one box short\" and .poNumber == \"$SKO_PO\"" "received today by wsmgr, keeping its PO"
sko_notifs "$ORDR" stock.delivery_note "/orders.html?stock=$SKO_THIS"
expect_eq "$SKO_N" 1 "ordr is told about the delivery note, with a link to the month"
req GET "/api/notifications?limit=100" "$ORDR"
expect_jq "[.rows[] | select(.kind == \"stock.delivery_note\" and .link == \"/orders.html?stock=$SKO_THIS\") | [.title, .body]] == [[\"Delivery note: Stock order $SKO_THIS_LABEL\", \"$SKO_SA: SKO one box short\"]]" "the notice names the month, the supplier and the note"
sko_notifs "$WSMGR" stock.delivery_note "/orders.html?stock=$SKO_THIS"
expect_eq "$SKO_N" 0 "the actor is not told"
req PATCH "/api/stock-lines/$SKO_LA" "$WSMGR" '{"status":"received"}'
expect_status 409 "receiving it twice"
req GET /api/orders/deliveries "$WSMGR"
expect_jq "[.stock.items[] | select(.type == \"stock_line\" and .id == $SKO_LA)] | length == 0" "no longer waiting"
expect_jq "[.stock.recent[] | select(.type == \"stock_line\" and .id == $SKO_LA and .receivedDate == \"$SKO_TODAY\" and .deliveryNote == \"SKO one box short\" and .receivedBy.id != null)] | length == 1" "in the recently received, with the note"
expect_eq "$(jqr '.counts.today')" "$((SKO_TODAY_N - 1))" "counts.today drops it"
req PATCH "/api/stock-lines/$SKO_LA" "$ORDR" '{"status":"to_order"}'
expect_status 409 "undoing ordered on a received line"
expect_jq '.error | test("received to to_order")' "and says why"
req PATCH "/api/stock-lines/$SKO_LA" "$ORDR" '{"quantity":99}'
expect_status 409 "quantity on a received line"
req DELETE "/api/stock-lines/$SKO_LA" "$ORDR"
expect_status 409 "deleting a received line"
req PATCH "/api/stock-lines/$SKO_LA" "$DPM" '{"status":"ordered"}'
expect_status 200 "dpm (orders.receive) undoes received"
expect_jq '.status == "ordered" and .receivedDate == null and .receivedBy == null and .deliveryNote == "SKO one box short"' "back to ordered; the note stayed"
req PATCH "/api/stock-lines/$SKO_LA" "$WSMGR" '{"status":"to_order"}'
expect_status 403 "wsmgr (receive only) can't undo ordered"
req PATCH "/api/stock-lines/$SKO_LA" "$ORDR" '{"status":"to_order"}'
expect_status 200 "ordr undoes ordered"
expect_jq ".status == \"to_order\" and .orderedDate == null and .expectedDate == null and .deliveryNote == \"\" and .poNumber == null and .supplierOrderId == null and .receivedDate == null" "dates, delivery note and PO link are cleared"
req GET "/api/supplier-orders/$SKO_POID" "$ORDR"
expect_jq '.items[0].current.state == "undone" and .items[0].current.status == "to_order" and .items[0].current.undoneBy != null and .items[1].current.state == "ordered"' "the saved order shows the stock item undone and the job item still ordered"
expect_jq '.snapshot.items[0].stock == true and .snapshot.items[0].quantity == 15' "the frozen snapshot is untouched"
req GET "/api/audit?entityType=stock_line&entityId=$SKO_LA&limit=30" "$ADMIN"
expect_jq '[.rows[].action] | (index("stock_line.create") != null) and (index("stock_line.status") != null) and (index("stock_line.update") != null)' "the line's history is audited"

echo "--- a supplier order of stock alone ---"
req POST /api/orders/mark-ordered "$ORDR" "{\"stockLineIds\":[$SKO_LA],\"orderedDate\":\"$SKO_YESTERDAY\"}"
expect_status 200 "ordr orders the Hinge line again, on stock alone (no orderIds)"
expect_jq '.count == 0 and .jobCount == 0 and .stockCount == 1 and (.orders | length) == 0 and .supplierOrder.poNumber != null' "no job items, one stock item, a new PO"
SKO_PO2=$(jqr '.supplierOrder.poNumber')
SKO_PO2ID=$(jqr '.supplierOrder.id')
[ "$SKO_PO2" != "$SKO_PO" ] || fail "the second order must have its own PO number"
ok
req GET "/api/supplier-orders/$SKO_PO2ID" "$ORDR"
expect_jq ".itemCount == 1 and .hasStock == true and .jobs == [] and .jobNumbers == [] and .items[0].current.state == \"ordered\"" "the stock-only order lists no jobs"
req GET "/api/supplier-orders/$SKO_POID" "$ORDR"
expect_jq ".items[0].current.state == \"undone\" and .items[0].current.laterPo.poNumber == \"$SKO_PO2\"" "the first order shows the line is now on the later one"
req POST /api/orders/mark-ordered "$ORDR" "{\"stockLineIds\":[$SKO_LA]}"
expect_status 409 "ordering a line that is already ordered"
req GET "/api/stock-lines?status=to_order" "$ORDR"
expect_status 200 "every month still to order"
expect_jq "([.lines[] | select(.id == $SKO_LD)] | length == 1) and ([.lines[] | select(.id == $SKO_LA)] | length == 0) and .month == null" "?status=to_order lists to_order lines across months and not the ordered one"

echo "--- two counts and an order not yet received ---"
sko_free
SKO_P2=$SKO_FREE
sko_count "$SKO_P2" "$SKO_IA:3 $SKO_ID:0"
expect_jq ".sentResult == {\"month\":\"$SKO_THIS\",\"added\":1,\"updated\":0,\"removed\":0}" "target 20, have 3, 15 on order: 2 more, as a new line (the Runner line already says 5)"
expect_eq "$(sko_item_lines "$SKO_IA")" "15:ordered:count:$SKO_THIS,2:to_order:count:$SKO_THIS" "the Hinge: 15 ordered and 2 to order"
expect_eq "$(sko_item_lines "$SKO_ID")" "5:to_order:count:$SKO_THIS" "the Runner line is the same line, not added again"
SKO_LD_BEFORE=$(sko_q "SELECT updated_at FROM stock_lines WHERE id = $SKO_LD")
sko_free
SKO_P3=$SKO_FREE
sko_count "$SKO_P3" "$SKO_IA:4 $SKO_ID:3"
expect_jq ".sentResult == {\"month\":\"$SKO_THIS\",\"added\":0,\"updated\":2,\"removed\":0}" "a later count changes the lines in place: Hinge 2 -> 1 and Runner 5 -> 2"
expect_eq "$(sko_item_lines "$SKO_IA")" "15:ordered:count:$SKO_THIS,1:to_order:count:$SKO_THIS" "the Hinge to order is 1"
expect_eq "$(sko_item_lines "$SKO_ID")" "2:to_order:count:$SKO_THIS" "the Runner is 2, same line"
expect_eq "$(sko_q "SELECT id FROM stock_lines WHERE stock_item_id = $SKO_ID AND deleted_at IS NULL")" "$SKO_LD" "the same Runner line"
sko_free
SKO_P4=$SKO_FREE
sko_count "$SKO_P4" "$SKO_IA:19 $SKO_ID:5"
expect_jq ".sentResult == {\"month\":\"$SKO_THIS\",\"added\":0,\"updated\":0,\"removed\":2}" "enough on the shelf and on order: both to-order lines are removed"
expect_eq "$(sko_item_lines "$SKO_IA")" "15:ordered:count:$SKO_THIS" "only the ordered Hinge line is left"
expect_eq "$(sko_item_lines "$SKO_ID")" "" "no Runner line"
expect_eq "$(sko_q "SELECT COUNT(*) FROM stock_lines WHERE stock_item_id = $SKO_ID AND deleted_at IS NOT NULL")" "1" "the removed line is kept, hidden"
req GET "/api/audit?action=stock_line.delete&entityType=stock_line&entityId=$SKO_LD&limit=5" "$ADMIN"
expect_jq '.total == 1 and .rows[0].after.via == "count"' "its removal is audited as the count's"

echo "--- the month boundary and duplicate count lines ---"
req GET "/api/stock-lines?month=$SKO_THIS" "$ORDR"
sko_free
SKO_P5=$SKO_FREE
sko_count "$SKO_P5" "$SKO_ID:0"
expect_jq ".sentResult == {\"month\":\"$SKO_THIS\",\"added\":1,\"updated\":0,\"removed\":0}" "Runner is counted at 0: a new line of 5"
SKO_LD2=$(sko_q "SELECT id FROM stock_lines WHERE stock_item_id = $SKO_ID AND deleted_at IS NULL")
sko_sql "UPDATE stock_lines SET month = '$SKO_PREV', quantity = 9 WHERE id = $SKO_LD2" >/dev/null
sko_sql "INSERT INTO stock_lines (month, supplier, item, code, quantity, status, source, stock_item_id, created_at, updated_at) VALUES ('$SKO_PREV', '$SKO_SB', 'Dupe', '', 1, 'to_order', 'count', $SKO_ID, 'a', 'a')" >/dev/null
sko_free
SKO_P6=$SKO_FREE
sko_count "$SKO_P6" "$SKO_ID:0"
expect_jq ".sentResult == {\"month\":\"$SKO_THIS\",\"added\":0,\"updated\":1,\"removed\":1}" "a line left from last month is set to the need and moved here; the duplicate goes"
expect_eq "$(sko_item_lines "$SKO_ID")" "5:to_order:count:$SKO_THIS" "one Runner line, 5, this month"
expect_eq "$(sko_q "SELECT id FROM stock_lines WHERE stock_item_id = $SKO_ID AND deleted_at IS NULL")" "$SKO_LD2" "the first line was kept"
req GET "/api/stock-lines?month=$SKO_PREV" "$ORDR"
expect_jq "[.lines[] | select(.stockItemId == $SKO_ID)] | length == 0" "nothing is left on last month"
sko_sql "INSERT INTO stock_lines (month, supplier, item, code, quantity, status, source, stock_item_id, created_at, updated_at) VALUES ('$SKO_THIS', '$SKO_SB', 'Hand Runner', '', 3, 'to_order', 'hand', $SKO_ID, 'a', 'a')" >/dev/null
sko_free
SKO_P7=$SKO_FREE
sko_count "$SKO_P7" "$SKO_ID:5"
expect_eq "$(sko_item_lines "$SKO_ID")" "3:to_order:hand:$SKO_THIS" "the count at target removes its own line and leaves the hand line alone"

echo "--- an old order not yet received counts against the need ---"
sko_free
SKO_PL=$SKO_FREE
sko_sql "INSERT INTO stock_orders (period, counted_at, counted_by, created_at, updated_at) VALUES ('$SKO_PL', '2001-01-02T00:00:00.000Z', (SELECT MIN(id) FROM users), 'a', 'a');
INSERT INTO stock_order_lines (stock_order_id, stock_item_id, supplier, code, item, have, order_qty) VALUES ((SELECT id FROM stock_orders WHERE period = '$SKO_PL'), $SKO_IB, '$SKO_SA', '', 'Screw', 1, 7);
INSERT INTO stock_order_groups (stock_order_id, supplier, ordered_date, ordered_by, expected_date) VALUES ((SELECT id FROM stock_orders WHERE period = '$SKO_PL'), '$SKO_SA', '2001-01-02', (SELECT MIN(id) FROM users), NULL);" >/dev/null
expect_eq "$(sko_q "SELECT COUNT(*) FROM stock_order_groups WHERE stock_order_id = (SELECT id FROM stock_orders WHERE period = '$SKO_PL')")" "1" "an old group, ordered and not received, is in place"
sko_free
SKO_P8=$SKO_FREE
sko_count "$SKO_P8" "$SKO_IB:0"
expect_jq ".sentResult == {\"month\":\"$SKO_THIS\",\"added\":1,\"updated\":0,\"removed\":0}" "Screw: target 10, have 0, 7 on the old order: 3"
expect_eq "$(sko_item_lines "$SKO_IB")" "3:to_order:count:$SKO_THIS" "the line is 3"
echo "--- reopen ---"
req POST "/api/stock/orders/$SKO_P8/reopen" "$WSMGR"
expect_status 403 "wsmgr can't reopen"
req POST "/api/stock/orders/$SKO_P8/reopen" "$ORDR"
expect_status 200 "ordr reopens the count"
expect_jq '.state == "counting" and .sent == null' "counting again, and no longer sent"
expect_eq "$(sko_item_lines "$SKO_IB")" "3:to_order:count:$SKO_THIS" "the month's line stays"
req PUT "/api/stock/orders/$SKO_P8/have" "$WSMGR" "{\"lines\":[{\"itemId\":$SKO_IB,\"have\":8}]}"
expect_status 200 "wsmgr corrects Have"
req POST "/api/stock/orders/$SKO_P8/counted" "$WSMGR"
expect_status 200 "and finishes the count again"
expect_jq ".sentResult == {\"month\":\"$SKO_THIS\",\"added\":0,\"updated\":0,\"removed\":1} and .sent.period == \"$SKO_THIS\"" "rule A runs again: 10 - 8 - 7 is nothing, so the line goes"
expect_eq "$(sko_item_lines "$SKO_IB")" "" "no Screw line"
req POST "/api/stock/orders/$SKO_PL/reopen" "$ORDR"
expect_status 409 "an old count with an ordered group can't be reopened"
expect_jq '.error == "A supplier has already been ordered; undo that first"' "and says to undo that first"

echo "--- an older count never replaces a newer one's lines ---"
req POST "/api/stock/orders/$SKO_P7/reopen" "$ORDR"
expect_status 409 "an older sent count can't be reopened once a newer one is sent"
expect_jq '.error | test("newer count")' "and says why"
sko_sql "INSERT INTO stock_orders (period, created_at, updated_at) VALUES ('2000-12', 'a', 'a')" >/dev/null
sko_count "2000-12" "$SKO_IB:0"
expect_jq '.sentResult.skipped == true and .sentResult.added == 0 and .sent == null and .state == "counted"' "a late older count is finished but not sent"
expect_eq "$(sko_item_lines "$SKO_IB")" "" "and adds no line"
req GET /api/stock/summary "$ORDR"
expect_jq '[.stockToSend[] | select(.period == "2000-12")] | length == 0' "and isn't offered to send"
echo "--- stock received since the count stops a reopen ---"
sko_sql "INSERT INTO stock_lines (month, supplier, item, code, quantity, status, received_date, source, stock_item_id, created_at, updated_at) VALUES ('$SKO_THIS', '$SKO_SA', 'Screw', '', 1, 'received', '$SKO_TODAY', 'count', $SKO_IB, '2999-01-01', '2999-01-01')" >/dev/null
req POST "/api/stock/orders/$SKO_P8/reopen" "$ORDR"
expect_status 409 "a count can't be reopened once its stock has arrived"
expect_jq '.error | test("received since the count")' "and says why"
sko_sql "DELETE FROM stock_lines WHERE created_at = '2999-01-01'" >/dev/null

echo "--- a group already ordered in the period is left alone ---"
sko_free
SKO_P9=$SKO_FREE
sko_sql "INSERT INTO stock_orders (period, created_at, updated_at) VALUES ('$SKO_P9', 'a', 'a');
INSERT INTO stock_order_groups (stock_order_id, supplier, ordered_date, ordered_by) VALUES ((SELECT id FROM stock_orders WHERE period = '$SKO_P9'), '$SKO_SD', '2001-01-02', (SELECT MIN(id) FROM users));
INSERT INTO stock_lines (month, supplier, item, code, quantity, status, source, stock_item_id, created_at, updated_at) VALUES ('$SKO_THIS', '$SKO_SD', 'Cover', '', 9, 'to_order', 'count', $SKO_IF, 'a', 'a');" >/dev/null
sko_count "$SKO_P9" "$SKO_IF:0"
expect_jq '.sentResult.added == 0 and .sentResult.updated == 0 and .sentResult.removed == 0' "nothing is added, changed or removed for an item whose group is ordered"
expect_eq "$(sko_item_lines "$SKO_IF")" "9:to_order:count:$SKO_THIS" "the Cover line is as it was"
req POST "/api/stock/orders/$SKO_P9/reopen" "$ORDR"
expect_status 409 "and the period can't be reopened"

echo "--- the Order tab is closed ---"
req PUT "/api/stock/orders/$SKO_P1/order" "$ORDR" "{\"lines\":[{\"itemId\":$SKO_IA,\"order\":5}]}"
expect_status 409 "typing an Order quantity"
expect_jq '.error == "Stock is ordered on the Orders page now"' "says where stock is ordered"
req POST "/api/stock/orders/$SKO_P1/nothing" "$ORDR" '{}'
expect_status 409 "marking a month nothing to order"
expect_jq '.error == "Stock is ordered on the Orders page now"' "the same sentence"
req POST "/api/stock/orders/$SKO_P1/groups" "$ORDR" "{\"supplier\":\"$SKO_SA\"}"
expect_status 409 "marking a group ordered"
expect_jq '.error == "Stock is ordered on the Orders page now"' "the same sentence again"
req POST "/api/stock/orders/$SKO_PL/groups/received" "$WSMGR" "{\"supplier\":\"$SKO_SA\",\"deliveryNote\":\"SKO old group\"}"
expect_status 200 "an old group is still received"
expect_jq "[.groups[] | select(.supplier == \"$SKO_SA\") | .received.date] == [\"$SKO_TODAY\"]" "on Deliveries' route"
req POST "/api/stock/orders/$SKO_PL/groups/received" "$WSMGR" "{\"supplier\":\"$SKO_SA\",\"undo\":true}"
expect_status 200 "and its receiving can be undone"
req POST "/api/stock/orders/$SKO_PL/groups" "$ORDR" "{\"supplier\":\"$SKO_SA\",\"undo\":true}"
expect_status 200 "and its ordering can be undone"
expect_jq "[.groups[] | select(.supplier == \"$SKO_SA\") | .ordered] == [null]" "the old group is no longer ordered"

echo "--- a count from before the change, sent once (rule G) ---"
# The newest Monday with no record (this suite's older periods are months from 2001, so it sorts after them).
SKO_MON=$(date -u -d "$SKO_TODAY - $(( ($(date -u -d "$SKO_TODAY" +%u) - 1) )) days" +%F)
req GET /api/stock/orders "$ORDR"
SKO_USED=$(jqr '.months[].period')
while printf '%s\n' "$SKO_USED" | grep -qx "$SKO_MON"; do SKO_MON=$(date -u -d "$SKO_MON - 7 days" +%F); done
SKO_MON_OLD=$(date -u -d "$SKO_MON - 7 days" +%F)
while printf '%s\n' "$SKO_USED" | grep -qx "$SKO_MON_OLD"; do SKO_MON_OLD=$(date -u -d "$SKO_MON_OLD - 7 days" +%F); done
# No later period may be marked sent, or rule G refuses (other suites' fortnights): clear those marks, as a legacy database has none.
sko_sql "UPDATE stock_orders SET sent_at = NULL, sent_period = NULL WHERE period > '$SKO_MON_OLD'" >/dev/null
sko_sql "INSERT INTO stock_orders (period, counted_at, counted_by, created_at, updated_at) VALUES ('$SKO_MON', '2001-01-02T00:00:00.000Z', (SELECT MIN(id) FROM users), 'a', 'a');
INSERT INTO stock_order_lines (stock_order_id, stock_item_id, supplier, code, item, have, order_qty) VALUES ((SELECT id FROM stock_orders WHERE period = '$SKO_MON'), $SKO_IE, '$SKO_SC', '', 'Catch', 0, 6);
INSERT INTO stock_orders (period, counted_at, counted_by, created_at, updated_at) VALUES ('$SKO_MON_OLD', '2001-01-02T00:00:00.000Z', (SELECT MIN(id) FROM users), 'a', 'a');
INSERT INTO stock_order_lines (stock_order_id, stock_item_id, supplier, code, item, have, order_qty) VALUES ((SELECT id FROM stock_orders WHERE period = '$SKO_MON_OLD'), $SKO_IE, '$SKO_SC', '', 'Catch', 0, 2);" >/dev/null
req GET "/api/stock/orders/$SKO_MON" "$ORDR"
expect_jq '.state == "counted" and .counted != null and .sent == null' "the old count is counted, not sent"
req GET /api/stock/summary "$ORDR"
expect_status 200 "ordr GET the summary"
expect_jq "([.stockToSend[] | select(.period == \"$SKO_MON\")] | length == 1) and ([.stockToSend[] | select(.period == \"$SKO_MON_OLD\")] | length == 1)" "both old counts are offered: Send to monthly order"
expect_jq "[.stockToSend[] | select(.period == \"$SKO_MON\")][0].label | length > 0" "with a label"
req POST "/api/stock/orders/$SKO_MON/send" "$WSMGR"
expect_status 403 "wsmgr can't send"
req POST "/api/stock/orders/$SKO_MON_OLD/send" "$ORDR"
expect_status 200 "the older count goes first (nothing newer is sent yet)"
expect_jq ".sentResult == {\"month\":\"$SKO_THIS\",\"added\":1,\"updated\":0,\"removed\":0}" "its Catch need of 2 is a new line"
req POST "/api/stock/orders/$SKO_MON/send" "$ORDR"
expect_status 200 "ordr sends the newer count"
expect_jq ".sentResult == {\"month\":\"$SKO_THIS\",\"added\":0,\"updated\":1,\"removed\":0} and .sent.period == \"$SKO_THIS\" and .state == \"counted\"" "the line is set to the newer count's need (6)"
expect_eq "$(sko_item_lines "$SKO_IE")" "6:to_order:count:$SKO_THIS" "Catch: one line of 6"
req POST "/api/stock/orders/$SKO_MON/send" "$ORDR"
expect_status 409 "sending it twice"
req POST "/api/stock/orders/$SKO_MON_OLD/send" "$ORDR"
expect_status 409 "sending the older count again"
sko_sql "UPDATE stock_orders SET sent_at = NULL, sent_period = NULL WHERE period = '$SKO_MON_OLD'" >/dev/null
req POST "/api/stock/orders/$SKO_MON_OLD/send" "$ORDR"
expect_status 409 "an older count after a newer one has been sent"
expect_jq '.error | test("newer")' "and says a newer count was sent"
sko_free
SKO_PN=$SKO_FREE
req POST "/api/stock/orders/$SKO_PN/send" "$ORDR"
expect_status 409 "a period that isn't counted"
req POST "/api/stock/orders/$SKO_NEXT/send" "$ORDR"
expect_status 400 "a month that hasn't started"
req GET /api/stock/summary "$ORDR"
expect_jq "[.stockToSend[] | select(.period == \"$SKO_MON\")] | length == 0" "a sent count is no longer offered"
req GET "/api/audit?action=stock_order.sent&entityType=stock_order&entityId=$SKO_MON&limit=5" "$ADMIN"
expect_jq '.total == 1' "the send is audited"
req POST "/api/stock/orders/$SKO_MON/reopen" "$ORDR"
expect_status 200 "reopening a sent count"
expect_jq '.sent == null and .state == "counting"' "clears the sent mark"
expect_eq "$(sko_item_lines "$SKO_IE")" "6:to_order:count:$SKO_THIS" "and leaves the month's line"
req POST "/api/stock/orders/$SKO_MON/counted" "$WSMGR"
expect_status 200 "finishing it again applies rule A again"
expect_jq '.sent.period != null and .sentResult.added == 0 and .sentResult.updated == 0 and .sentResult.removed == 0' "with nothing to change this time"

echo "--- the dashboard summary ---"
req GET /api/stock/summary "$ORDR"
expect_jq "(.stockToOrder | type) == \"array\" and ([.stockToOrder[] | select(.month == \"$SKO_THIS\")][0] | .toOrder >= 1 and (.label | length > 0)) and (.stockToOrder | map(.month) | . == sort) and all(.stockToOrder[]; (keys | sort) == [\"label\",\"month\",\"toOrder\"])" "stockToOrder lists the months with lines to order, oldest first"
req GET /api/stock/summary "$WSMGR"
expect_jq 'has("stockToOrder") | not' "the count's own user gets no order parts"

echo "--- months a count made are viewable ---"
req GET "/api/stock/orders/$SKO_P1" "$ORDR"
expect_jq ".sent.period == \"$SKO_THIS\" and (.sent.at | length > 0)" "a month view carries sent"
req GET "/api/stock/orders/$SKO_PN" "$ORDR"
expect_jq '.sent == null' "and null when not sent"

echo "--- the run's items leave the list ---"
for it in "$SKO_IA" "$SKO_IB" "$SKO_IC" "$SKO_ID" "$SKO_IE" "$SKO_IF"; do
  req PATCH "/api/stock/items/$it" "$ORDR" '{"active":false}'
  expect_status 200 "ordr deactivates item $it"
done
# This suite's lines are tidied away so later suites and the dashboard don't carry them.
sko_sql "UPDATE stock_lines SET deleted_at = '2001-01-01T00:00:00.000Z' WHERE status = 'to_order' AND (supplier LIKE 'SKO %')" >/dev/null
echo "stock orders suite passed."
