# Purchase orders smoke (0.2.23, migration 064): a supplier order's Mark ordered saves the order (PO-NNNN)
# with a frozen snapshot and a stored PDF; GET /api/supplier-orders, /:id and /:id/pdf; the PO number on
# the notes line and on every order line (poNumber, poId). Sourced by ci/smoke.sh right after the job
# cards suite, so it shares that script's helpers (step, req, hdr, expect_status, expect_jq, expect_eq,
# jqr, fail, ok), $BODY_FILE, $CONTAINER and the cookie jars ($ADMIN $DPM $SHOW $ORDR $WSMGR). No
# shebang and no `set`: the caller owns both. It does not assume a pristine database (other suites may
# already have saved orders): PO numbers are captured, never assumed, and its jobs and suppliers carry a
# run tag. Made-up names only (this repo is public). Contract: docs/plans/purchase-orders-plan.md.

# ============================================================================
step "purchase orders. saved supplier orders, frozen snapshot, PDF, PO numbers"
# ============================================================================

PO_TAG=$(date +%s)
PO_TODAY=$(TZ=Australia/Sydney date +%F)
PO_YESTERDAY=$(date -u -d "$PO_TODAY - 1 day" +%F)
PO_NEXTWEEK=$(date -u -d "$PO_TODAY + 7 days" +%F)
PO_S1="PO Hinge Works $PO_TAG"
PO_S2="PO Runner Supply $PO_TAG"
PO_REF="BH-$PO_TAG"

# po_job NAME: a job as the admin -> PO_JOB.
po_job() {
  req POST /api/job-records "$ADMIN" \
    "{\"name\":\"$1\",\"clientName\":\"PO Client $PO_TAG\",\"valueCents\":2000000}"
  expect_status 201 "create job $1"
  PO_JOB=$(jqr '.id')
}

# po_lines JOB_ID LINES_JSON: add lines as the admin -> PO_IDS (a space-separated list of line ids).
po_lines() {
  req POST "/api/job-records/$1/orders/batch" "$ADMIN" "{\"lines\":$2}"
  expect_status 201 "add lines to job $1"
  PO_IDS=$(jqr '[.orders[].id] | map(tostring) | join(" ")')
}

# po_mark JAR IDS_JSON [EXTRA_JSON_FIELDS]: mark the lines ordered as a supplier order.
po_mark() {
  req POST /api/orders/mark-ordered "$1" "{\"orderIds\":$2${3:+,$3}}"
}

# po_plus1 PO-0007 -> PO-0008.
po_plus1() {
  printf 'PO-%04d' "$((10#${1#PO-} + 1))"
}

# po_sha FILE: the SHA-256 of a file.
po_sha() {
  sha256sum "$1" | cut -d' ' -f1
}

# po_enc TEXT: URL-encoded.
po_enc() {
  jq -rn --arg s "$1" '$s | @uri'
}

po_job "PO Harlow kitchen $PO_TAG"
PO_JA=$PO_JOB
po_job "PO Marlow vanity $PO_TAG"
PO_JB=$PO_JOB
po_job "PO Wyatt pantry $PO_TAG"
PO_JC=$PO_JOB

po_lines "$PO_JA" "[{\"supplier\":\"$PO_S1\",\"description\":\"Soft-close hinge\",\"quantity\":24},{\"supplier\":\"$PO_S1\",\"description\":\"Drawer runner\",\"quantity\":10},{\"supplier\":\"$PO_S2\",\"description\":\"Runner pack\",\"quantity\":2},{\"supplier\":\"$PO_S2\",\"description\":\"Pull handle\",\"quantity\":4}]"
read -r PO_A1 PO_A2 PO_A3 PO_A4 <<<"$PO_IDS"
po_lines "$PO_JB" "[{\"supplier\":\"$PO_S1\",\"description\":\"Door stop\",\"quantity\":6},{\"supplier\":\"$PO_S1\",\"description\":\"Never ordered\",\"quantity\":1}]"
read -r PO_B1 PO_B2 <<<"$PO_IDS"
po_lines "$PO_JC" "[{\"supplier\":\"$PO_S2\",\"description\":\"Shelf pin\",\"quantity\":100},{\"supplier\":\"$PO_S1\",\"description\":\"Cabinet lock\",\"quantity\":3},{\"supplier\":\"$PO_S1\",\"description\":\"Ordered singly\",\"quantity\":1}]"
read -r PO_C1 PO_C2 PO_C3 <<<"$PO_IDS"
req GET "/api/job-records/$PO_JA" "$ADMIN"
PO_JA_NUM=$(jqr '.jobNumber // ""')

echo "--- before any saved order: lines carry no PO ---"
req GET "/api/orders?status=all&jobId=$PO_JA" "$ORDR"
expect_status 200 "ordr GET /api/orders for job A"
expect_jq 'all(.[]; has("poId") and has("poNumber") and .poId == null and .poNumber == null)' "a line that was never ordered has poId and poNumber null"

echo "--- mark ordered saves the order ---"
po_mark "$ORDR" "[$PO_B1,$PO_A1,$PO_A2]" "\"orderedDate\":\"$PO_YESTERDAY\",\"expectedDate\":\"$PO_NEXTWEEK\",\"supplierRef\":\"  $PO_REF  \""
expect_status 200 "ordr marks a supplier order ordered"
expect_jq '.count == 3 and .jobCount == 2 and (.orders | length) == 3' "the existing count, job count and lines"
expect_jq '.supplierOrder | (.id | type) == "number" and (.poNumber | test("^PO-[0-9]{4,}$")) and .pdfReady == true' "the response names the saved order and says its PDF is ready"
PO1=$(jqr '.supplierOrder.poNumber')
PO1_ID=$(jqr '.supplierOrder.id')
expect_jq "[.orders[] | select(.id == $PO_A1)][0].notes == \"$PO1 \\u00b7 Ref: $PO_REF\"" "the notes line is the PO number and the Ref"
expect_jq "[.orders[] | select(.id == $PO_B1)][0] | .poNumber == \"$PO1\" and .poId == $PO1_ID" "the lines in the response already carry the PO"
po_mark "$ORDR" "[$PO_A3,$PO_A4]"
expect_status 200 "ordr marks a second supplier order (no Ref)"
PO2=$(jqr '.supplierOrder.poNumber')
PO2_ID=$(jqr '.supplierOrder.id')
expect_eq "$PO2" "$(po_plus1 "$PO1")" "the second order's PO number follows the first"
expect_jq "[.orders[] | select(.id == $PO_A3)][0].notes == \"$PO2\"" "with no Ref the notes line is just the PO number"
req PATCH "/api/orders/$PO_A4" "$ORDR" '{"notes":"hand written"}'
expect_status 200 "ordr edits a line's notes after"
expect_jq '.order.notes == "hand written"' "(notes stay editable)"
PO1_NUM=$((10#${PO1#PO-}))

echo "--- audit ---"
req GET "/api/audit?action=supplier_order.create&entityType=supplier_order&entityId=$PO1_ID&limit=5" "$ADMIN"
expect_status 200 "GET /api/audit supplier_order.create"
expect_jq ".total == 1 and .rows[0].after.poNumber == \"$PO1\" and .rows[0].after.lineCount == 3" "one supplier_order.create row with the PO number and line count"

echo "--- the list ---"
req GET /api/supplier-orders "$ORDR"
expect_status 200 "ordr GET /api/supplier-orders"
expect_jq "(.orders | length) >= 2 and .orders[0].poNumber == \"$PO2\" and .orders[1].poNumber == \"$PO1\"" "newest first"
expect_jq "([.orders[].poSeq] | . == (sort | reverse))" "ordered by PO number, highest first"
expect_jq "[.orders[] | select(.id == $PO1_ID)][0] | .poNumber == \"$PO1\" and .poSeq == $PO1_NUM and .supplier == \"$PO_S1\" and .orderedDate == \"$PO_YESTERDAY\" and .expectedDate == \"$PO_NEXTWEEK\" and .supplierRef == \"$PO_REF\" and .orderedBy == \"CI Ordering\" and .itemCount == 3 and (.jobs | length) == 2 and .jobs[0].jobId == $PO_JB and .jobs[1].jobId == $PO_JA and .jobs[0].jobName == \"PO Marlow vanity $PO_TAG\" and (.jobNumbers | type) == \"array\" and (.createdAt | type) == \"string\" and .pdfReady == true" "the list item for the first order"
expect_jq "[.orders[] | select(.id == $PO2_ID)][0] | .supplier == \"$PO_S2\" and .supplierRef == \"\" and .expectedDate == null and .itemCount == 2 and (.jobs | length) == 1" "the list item for the second (no Ref, no expected date)"
expect_jq "(.suppliers | index(\"$PO_S1\")) != null and (.suppliers | index(\"$PO_S2\")) != null and (.suppliers | map(ascii_downcase) | . == sort)" "suppliers lists every saved order's supplier, A-Z"
expect_jq "(.orders[0] | keys | sort) == [\"createdAt\",\"expectedDate\",\"id\",\"itemCount\",\"jobNumbers\",\"jobs\",\"orderedBy\",\"orderedDate\",\"pdfReady\",\"poNumber\",\"poSeq\",\"supplier\",\"supplierRef\"]" "the list item has exactly the documented fields"

req GET "/api/supplier-orders?supplier=$(po_enc "  $(printf '%s' "$PO_S1" | tr 'A-Z' 'a-z')  ")" "$ORDR"
expect_status 200 "supplier filter, other case and padded"
expect_jq "(.orders | length) >= 1 and all(.orders[]; .supplier == \"$PO_S1\") and ([.orders[].poNumber] | index(\"$PO1\")) != null and ([.orders[].poNumber] | index(\"$PO2\")) == null" "the supplier filter is exact, case-insensitive and trimmed"
expect_jq "(.suppliers | index(\"$PO_S2\")) != null" "and does not narrow the supplier list"
req GET "/api/supplier-orders?supplier=$(po_enc "PO Hinge")" "$ORDR"
expect_jq '.orders | length == 0' "a partial supplier name matches nothing"
for q in "$PO1" "$(printf "%s" "$PO1" | tr A-Z a-z)" "po-$PO1_NUM"; do
  req GET "/api/supplier-orders?q=$(po_enc "$q")" "$ORDR"
  expect_status 200 "find '$q'"
  expect_jq "([.orders[].poNumber] | index(\"$PO1\")) != null and ([.orders[].poNumber] | index(\"$PO2\")) == null" "'$q' finds $PO1 and not $PO2"
done
# A bare number is the PO number too (it may also hit a job number that contains it, so only presence is checked).
for q in "$(printf '%04d' "$PO1_NUM")" "$PO1_NUM"; do
  req GET "/api/supplier-orders?q=$(po_enc "$q")" "$ORDR"
  expect_status 200 "find '$q'"
  expect_jq "([.orders[].poNumber] | index(\"$PO1\")) != null" "'$q' finds $PO1"
done
req GET "/api/supplier-orders?q=$(po_enc "$(printf '%s' "$PO_REF" | tr 'A-Z' 'a-z')")" "$ORDR"
expect_jq "(.orders | length) == 1 and .orders[0].id == $PO1_ID" "find by supplier ref, any case"
req GET "/api/supplier-orders?q=$(po_enc "marlow vanity $PO_TAG")" "$ORDR"
expect_jq "(.orders | length) == 1 and .orders[0].id == $PO1_ID" "find by job name (job B is only on the first order)"
req GET "/api/supplier-orders?q=$(po_enc "harlow kitchen $PO_TAG")" "$ORDR"
expect_jq "(.orders | length) == 2 and ([.orders[].id] | sort) == ([$PO1_ID, $PO2_ID] | sort)" "find by job name (job A is on both)"
if [ -n "$PO_JA_NUM" ]; then
  req GET "/api/supplier-orders?q=$(po_enc "$PO_JA_NUM")" "$ORDR"
  expect_jq "([.orders[].id] | index($PO1_ID)) != null and ([.orders[].id] | index($PO2_ID)) != null" "find by job number"
fi
req GET "/api/supplier-orders?q=$(po_enc "no such thing $PO_TAG")" "$ORDR"
expect_jq '.orders == []' "a find with no match is an empty list"
req GET "/api/supplier-orders?q=a&q=b" "$ORDR"
expect_status 400 "a repeated q is refused"

echo "--- the detail ---"
req GET "/api/supplier-orders/$PO1_ID" "$ORDR"
expect_status 200 "ordr GET the saved order"
PO1_DETAIL=$BODY
expect_jq ".id == $PO1_ID and .poNumber == \"$PO1\" and .pdfReady == true and (.pdfMadeAt | type) == \"string\" and (.items | length) == 3" "the detail has the list fields, pdfMadeAt and the items"
expect_jq "[.items[].orderId] == [$PO_B1, $PO_A1, $PO_A2]" "the items are in the screen's order"
expect_jq ".snapshot | .version == 1 and .poNumber == \"$PO1\" and .poSeq == $PO1_NUM and .supplier == \"$PO_S1\" and .orderedDate == \"$PO_YESTERDAY\" and .expectedDate == \"$PO_NEXTWEEK\" and .supplierRef == \"$PO_REF\" and .orderedBy == \"CI Ordering\" and (.createdAt | type) == \"string\"" "the snapshot header"
expect_jq '.snapshot.business | (keys | sort) == ["abn","address","email","legalName","phone","tradingName"]' "the snapshot's business details have no bank fields"
expect_jq ".snapshot.items | (map(keys | sort) | unique) == [[\"description\",\"jobId\",\"jobName\",\"jobNumber\",\"orderId\",\"quantity\",\"supplier\"]] and .[0].orderId == $PO_B1 and .[0].jobId == $PO_JB and .[0].description == \"Door stop\" and .[0].quantity == 6 and .[1].description == \"Soft-close hinge\" and .[1].quantity == 24 and .[1].jobName == \"PO Harlow kitchen $PO_TAG\" and .[1].supplier == \"$PO_S1\"" "the snapshot items"
expect_jq '.items | all(.[]; .current.status == "ordered" and .current.state == "ordered" and .current.receivedDate == null and .current.undoneAt == null and .current.undoneBy == null and .current.laterPo == null)' "every item is Ordered now"
req GET "/api/supplier-orders/$PO1_ID" ""
expect_status 401 "logged out detail"
req GET "/api/supplier-orders/999999" "$ORDR"
expect_status 404 "a missing order"
req GET "/api/supplier-orders/abc" "$ORDR"
expect_status 404 "a bad id"

echo "--- the PDF: headers and bytes ---"
req GET "/api/supplier-orders/$PO1_ID/pdf" "$ORDR"
expect_status 200 "ordr GET the PDF"
case $(hdr content-type) in application/pdf*) ok ;; *) fail "the PDF's Content-Type is '$(hdr content-type)'" ;; esac
expect_eq "$(hdr content-disposition | cut -d';' -f1)" "inline" "the PDF is inline by default"
expect_eq "$(hdr content-disposition | sed -n 's/.*filename="\([^"]*\)".*/\1/p')" "$PO1 $PO_S1.pdf" "the inline file name is the PO number and the supplier"
expect_eq "$(hdr x-content-type-options)" "nosniff" "nosniff"
expect_eq "$(head -c 5 "$BODY_FILE")" "%PDF-" "the body is a PDF"
PO1_SHA=$(po_sha "$BODY_FILE")
req GET "/api/supplier-orders/$PO1_ID/pdf?download=1" "$ORDR"
expect_status 200 "download=1"
expect_eq "$(hdr content-disposition | cut -d';' -f1)" "attachment" "download=1 is an attachment"
expect_eq "$(hdr content-disposition | sed -n 's/.*filename="\([^"]*\)".*/\1/p')" "$PO1 $PO_S1.pdf" "with the file name PO-NNNN Supplier.pdf"
expect_eq "$(po_sha "$BODY_FILE")" "$PO1_SHA" "the download is the same bytes"
req GET "/api/supplier-orders/$PO1_ID/pdf?download=0" "$ORDR"
expect_status 200 "download=0"
expect_eq "$(hdr content-disposition | cut -d';' -f1)" "inline" "download=0 is inline"
req GET "/api/supplier-orders/$PO1_ID/pdf?download=yes" "$ORDR"
expect_status 400 "a bad download value"
req GET "/api/supplier-orders/999999/pdf" "$ORDR"
expect_status 404 "the PDF of a missing order"
req GET "/api/supplier-orders/$PO1_ID/pdf" ""
expect_status 401 "logged out PDF"
# The headless-browser gate falls through to the login for anything without a live token.
req GET "/orderprint.html?mode=po&id=$PO1_ID&pt=$(printf 'A%.0s' $(seq 1 43))" ""
expect_status 302 "the PO print page with a made-up token goes to the login"
req GET "/orderprint.html?mode=po&id=$PO1_ID" ""
expect_status 302 "the PO print page with no token goes to the login"

echo "--- access ---"
for jar in "$ADMIN" "$ORDR"; do
  req GET /api/supplier-orders "$jar"
  expect_status 200 "orders.view reads the list"
  req GET "/api/supplier-orders/$PO1_ID" "$jar"
  expect_status 200 "orders.view reads the detail"
  req GET "/api/supplier-orders/$PO1_ID/pdf" "$jar"
  expect_status 200 "orders.view reads the PDF"
done
req GET /api/supplier-orders "$SHOW"
expect_status 403 "a login without orders.view can't list"
req GET "/api/supplier-orders/$PO1_ID" "$SHOW"
expect_status 403 "or read one"
req GET "/api/supplier-orders/$PO1_ID/pdf" "$SHOW"
expect_status 403 "or its PDF"
req GET /api/supplier-orders ""
expect_status 401 "logged out list"
req POST /api/supplier-orders "$ADMIN" '{}'
expect_status 404 "there is no way to create one but Mark ordered"
req DELETE "/api/supplier-orders/$PO1_ID" "$ADMIN"
expect_status 404 "or to delete one"

echo "--- the snapshot and PDF are frozen ---"
PO1_MADE=$(printf '%s' "$PO1_DETAIL" | jq -r '.pdfMadeAt')
PO1_SNAP=$(printf '%s' "$PO1_DETAIL" | jq -S -c '.snapshot')
req PATCH "/api/orders/$PO_A1" "$ADMIN" '{"description":"Soft-close hinge EDITED","quantity":99}'
expect_status 200 "admin edits the description and quantity of an ordered item"
req PATCH "/api/orders/$PO_B1" "$ORDR" '{"status":"to_order"}'
expect_status 200 "ordr undoes an item back to To order"
req PATCH "/api/orders/$PO_A2" "$ADMIN" "{\"status\":\"received\",\"receivedDate\":\"$PO_TODAY\"}"
expect_status 200 "admin receives an item"
req GET "/api/supplier-orders/$PO1_ID" "$ORDR"
expect_status 200 "the order after the changes"
expect_eq "$(printf '%s' "$BODY" | jq -S -c '.snapshot')" "$PO1_SNAP" "the snapshot is unchanged"
expect_jq '.snapshot.items[1].description == "Soft-close hinge" and .snapshot.items[1].quantity == 24' "it still has the original description and quantity"
expect_jq '.items[1].description == "Soft-close hinge" and .items[1].quantity == 24' "so do the detail's items"
expect_jq ".items[1].current | .status == \"ordered\" and .state == \"ordered\" and .laterPo == null" "the edited item is still Ordered"
expect_jq ".items[2].current | .status == \"received\" and .state == \"received\" and .receivedDate == \"$PO_TODAY\" and .undoneAt == null" "the received item shows Received with its date"
expect_jq ".items[0].current | .status == \"to_order\" and .state == \"undone\" and (.undoneAt | type) == \"string\" and .undoneBy == \"CI Ordering\" and .laterPo == null and .receivedDate == null" "the undone item shows who undid it and when"
expect_eq "$(printf '%s' "$BODY" | jq -r '.pdfMadeAt')" "$PO1_MADE" "pdfMadeAt is unchanged"
req GET "/api/supplier-orders/$PO1_ID/pdf" "$ORDR"
expect_status 200 "the PDF after the changes"
expect_eq "$(po_sha "$BODY_FILE")" "$PO1_SHA" "the PDF bytes are unchanged"
req GET "/api/supplier-orders" "$ORDR"
expect_jq "[.orders[] | select(.id == $PO1_ID)][0].itemCount == 3" "the list still counts the three items"

echo "--- lines carry their current PO ---"
req GET "/api/orders?status=all&jobId=$PO_JB" "$ORDR"
expect_status 200 "job B's lines"
expect_jq "[.[] | select(.id == $PO_B1)][0] | .status == \"to_order\" and .poNumber == null and .poId == null" "an undone line has no current PO"
# The same line, ordered again on a later saved order.
po_mark "$ORDR" "[$PO_B1]"
expect_status 200 "ordr orders the undone line again"
PO3=$(jqr '.supplierOrder.poNumber')
PO3_ID=$(jqr '.supplierOrder.id')
expect_eq "$PO3" "$(po_plus1 "$PO2")" "the next order gets the next number"
expect_jq "[.orders[] | select(.id == $PO_B1)][0].notes == \"$PO1 \\u00b7 Ref: $PO_REF\\n$PO3\"" "the new PO number is appended to the notes that already hold the old one"
req GET "/api/orders?status=all&jobId=$PO_JB" "$ORDR"
expect_jq "[.[] | select(.id == $PO_B1)][0] | .poNumber == \"$PO3\" and .poId == $PO3_ID" "the line's PO is the latest one"
expect_jq "[.[] | select(.id == $PO_B2)][0] | .status == \"to_order\" and .poNumber == null and .poId == null" "a line still to order has none"
req GET "/api/orders?status=all&jobId=$PO_JA" "$ORDR"
expect_jq "[.[] | select(.id == $PO_A1)][0] | .poNumber == \"$PO1\" and .poId == $PO1_ID" "an ordered line carries its PO"
expect_jq "[.[] | select(.id == $PO_A2)][0] | .status == \"received\" and .poNumber == \"$PO1\"" "a received line keeps its PO"
expect_jq "[.[] | select(.id == $PO_A3 or .id == $PO_A4)] | length == 2 and all(.[]; .poNumber == \"$PO2\" and .poId == $PO2_ID)" "the second order's lines carry the second PO"
req GET "/api/job-records/$PO_JA/orders" "$ORDR"
expect_jq "[.[] | select(.id == $PO_A1)][0].poNumber == \"$PO1\"" "the job's own line list carries it too"
req GET "/api/orders?status=open" "$ORDR"
expect_jq "all(.[]; has(\"poId\") and has(\"poNumber\"))" "every line in the open list has the two fields"
# A line ordered singly (not through a supplier order) has no PO.
req PATCH "/api/orders/$PO_C3" "$ORDR" '{"status":"ordered"}'
expect_status 200 "ordr orders one line singly"
expect_jq '.order | .status == "ordered" and .poNumber == null and .poId == null' "no PO for a line ordered one at a time"
req GET "/api/orders?status=all&jobId=$PO_JC" "$ORDR"
expect_jq "[.[] | select(.id == $PO_C3)][0] | .status == \"ordered\" and .poNumber == null and .poId == null" "and the list agrees"

echo "--- a line on two orders over time ---"
req GET "/api/supplier-orders/$PO1_ID" "$ORDR"
expect_status 200 "the first order again"
expect_jq ".items[0] | .orderId == $PO_B1 and .current.status == \"ordered\" and .current.state == \"undone\" and .current.laterPo == {id: $PO3_ID, poNumber: \"$PO3\"} and .current.undoneAt == null" "the line shows as undone, with the later order"
expect_jq '.items[1].current.state == "ordered" and .items[2].current.state == "received"' "the other items are as they were"
req GET "/api/supplier-orders/$PO3_ID" "$ORDR"
expect_jq ".items | length == 1 and .[0].orderId == $PO_B1 and .[0].current.state == \"ordered\" and .[0].current.laterPo == null" "the later order holds it as Ordered"
req GET "/api/supplier-orders" "$ORDR"
expect_jq "[.orders[] | select(.id == $PO1_ID)][0].itemCount == 3" "the first order still lists its three items"

echo "--- an order with more than one supplier (API only) ---"
po_mark "$ORDR" "[$PO_C1,$PO_C2]"
expect_status 200 "ordr marks lines of two suppliers in one call"
PO4=$(jqr '.supplierOrder.poNumber')
PO4_ID=$(jqr '.supplierOrder.id')
expect_eq "$PO4" "$(po_plus1 "$PO3")" "it is still one saved order, next number"
req GET "/api/supplier-orders/$PO4_ID" "$ORDR"
expect_jq ".supplier == \"$PO_S1, $PO_S2\" and .snapshot.supplier == \"$PO_S1, $PO_S2\" and ([.snapshot.items[].supplier] == [\"$PO_S2\", \"$PO_S1\"])" "the supplier is the distinct names A-Z; each item keeps its own"
req GET "/api/supplier-orders?supplier=$(po_enc "$PO_S1")" "$ORDR"
expect_jq "([.orders[].id] | index($PO4_ID)) == null" "the supplier filter is exact, so it does not match the mixed order"
req GET "/api/supplier-orders/$PO4_ID/pdf?download=1" "$ORDR"
expect_status 200 "the mixed order's PDF"
expect_eq "$(hdr content-disposition | sed -n 's/.*filename="\([^"]*\)".*/\1/p')" "$PO4 $PO_S1, $PO_S2.pdf" "its file name has both suppliers"

echo "--- the PDF is made on demand when its file is missing ---"
req GET "/api/supplier-orders/$PO2_ID" "$ORDR"
PO2_MADE=$(jqr '.pdfMadeAt')
PO2_FILE="/data/uploads/files/$PO2.pdf"
docker exec "$CONTAINER" test -f "$PO2_FILE" || fail "the stored PDF $PO2_FILE does not exist after Mark ordered"
ok
docker exec "$CONTAINER" rm -f "$PO2_FILE"
if docker exec "$CONTAINER" test -f "$PO2_FILE"; then fail "could not remove the stored PDF"; fi
ok
req GET "/api/supplier-orders/$PO2_ID" "$ORDR"
expect_jq '.pdfReady == false' "the detail says the PDF is not made"
req GET /api/supplier-orders "$ORDR"
expect_jq "[.orders[] | select(.id == $PO2_ID)][0].pdfReady == false and [.orders[] | select(.id == $PO1_ID)][0].pdfReady == true" "the list says so only for that order"
req GET "/api/supplier-orders/$PO2_ID/pdf?download=1" "$ORDR"
expect_status 200 "the first View after the file went makes it again"
expect_eq "$(head -c 5 "$BODY_FILE")" "%PDF-" "a PDF comes back"
expect_eq "$(hdr content-disposition | sed -n 's/.*filename="\([^"]*\)".*/\1/p')" "$PO2 $PO_S2.pdf" "with the right file name"
PO2_SHA=$(po_sha "$BODY_FILE")
docker exec "$CONTAINER" test -f "$PO2_FILE" || fail "the PDF was not stored again"
ok
req GET "/api/supplier-orders/$PO2_ID" "$ORDR"
expect_jq ".pdfReady == true and .pdfMadeAt > \"$PO2_MADE\"" "pdfReady again, with a new made-at time"
PO2_MADE=$(jqr '.pdfMadeAt')
req GET "/api/supplier-orders/$PO2_ID/pdf" "$ORDR"
expect_status 200 "viewing it again"
expect_eq "$(po_sha "$BODY_FILE")" "$PO2_SHA" "the stored file is served, never re-made"
req GET "/api/supplier-orders/$PO2_ID" "$ORDR"
expect_eq "$(jqr '.pdfMadeAt')" "$PO2_MADE" "pdfMadeAt is unchanged by viewing"
leftovers=$(docker exec "$CONTAINER" ls /data/uploads/files | grep -c '^PO-.*\.part$' || true)
expect_eq "$leftovers" "0" "no half-written PDF is left behind"
