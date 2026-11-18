# Delete order lines and cards smoke (0.2.23, migration 065, docs/plans/purchase-orders-plan.md "Delete lines
# and cards"): POST /api/orders/:id/delete, POST /api/job-records/:id/orders/delete-card, POST
# /api/orders/:id/restore and GET /api/orders?status=deleted. Sourced by ci/smoke.sh right after the
# purchase orders suite, so it shares that script's helpers (step, req, expect_status, expect_jq,
# expect_eq, jqr, fail, ok) and the cookie jars ($ADMIN $DPM $SHOW $ORDR $WSMGR). No shebang and no
# `set`: the caller owns both. It does not assume a pristine database: its jobs and suppliers carry a run
# tag and it checks only its own rows. Made-up names only (this repo is public).

# ============================================================================
step "order delete. lines and cards, soft delete, restore"
# ============================================================================

OD_TAG=$(date +%s)
OD_TODAY=$(TZ=Australia/Sydney date +%F)
OD_YESTERDAY=$(date -u -d "$OD_TODAY - 1 day" +%F)
OD_S1="OD Hinge Works $OD_TAG"
OD_S2="OD Runner Supply $OD_TAG"

# od_job NAME -> OD_JOB (as the admin, with a value so the progress invoice exists).
od_job() {
  req POST /api/job-records "$ADMIN" \
    "{\"name\":\"$1\",\"clientName\":\"OD Client $OD_TAG\",\"valueCents\":2000000}"
  expect_status 201 "create job $1"
  OD_JOB=$(jqr '.id')
}

# od_lines JOB_ID LINES_JSON -> OD_IDS (space-separated line ids).
od_lines() {
  req POST "/api/job-records/$1/orders/batch" "$ADMIN" "{\"lines\":$2}"
  expect_status 201 "add lines to job $1"
  OD_IDS=$(jqr '[.orders[].id] | map(tostring) | join(" ")')
}

# od_audit ACTION ID -> the number of audit rows.
od_audit() {
  req GET "/api/audit?action=$1&entityType=order&entityId=$2&limit=1" "$ADMIN"
  expect_status 200 "GET /api/audit?action=$1"
  jqr '.total'
}

# od_card JOB_ID: the card of a job as ordr -> BODY is the card (or null).
od_card() {
  req GET "/api/orders/cards?finished=1" "$ORDR"
  expect_status 200 "cards"
  BODY=$(printf '%s' "$BODY" | jq -c "[.cards[] | select(.jobId == $1)][0]")
}

od_job "OD Harlow kitchen $OD_TAG"
OD_J1=$OD_JOB
od_lines "$OD_J1" "[{\"supplier\":\"$OD_S1\",\"description\":\"Hinge A\",\"quantity\":4},{\"supplier\":\"$OD_S1\",\"description\":\"Runner B\",\"quantity\":2},{\"supplier\":\"$OD_S2\",\"description\":\"Handle C\",\"quantity\":8}]"
read -r OD_L1 OD_L2 OD_L3 <<<"$OD_IDS"
req GET "/api/job-records/$OD_J1" "$ADMIN"
OD_J1_LABEL="OD Harlow kitchen $OD_TAG"
OD_J1_NUM=$(jqr '.jobNumber // ""')
[ -z "$OD_J1_NUM" ] || OD_J1_LABEL="$OD_J1_NUM $OD_J1_LABEL"

echo "--- delete one line ---"
req POST "/api/orders/$OD_L1/delete" "$ORDR"
expect_status 200 "ordr deletes a to_order line"
expect_jq ".order | .id == $OD_L1 and .status == \"to_order\" and (.deletedAt | type) == \"string\" and .deletedBy.name == \"CI Ordering\"" "the line carries deletedAt and deletedBy"
expect_jq ".job.id == $OD_J1 and (.job | has(\"materialsOrderedDate\"))" "the response has the job state"
req GET "/api/audit?action=order.delete&entityType=order&entityId=$OD_L1&limit=5" "$ADMIN"
expect_jq ".total == 1 and .rows[0].after.supplier == \"$OD_S1\" and .rows[0].after.description == \"Hinge A\" and .rows[0].after.job == \"$OD_J1_LABEL\" and .rows[0].after.jobId == $OD_J1" "order.delete is audited with the job, supplier and description"

echo "--- a deleted line disappears everywhere ---"
req GET "/api/job-records/$OD_J1/orders" "$ADMIN"
expect_jq "([.[] | select(.id == $OD_L1)] | length) == 0 and length == 2" "the job's line list"
req GET "/api/job-records/$OD_J1/orders?all=1" "$ADMIN"
expect_jq "([.[] | select(.id == $OD_L1)] | length) == 0" "even with all=1"
for st in all open to_order; do
  req GET "/api/orders?status=$st" "$ORDR"
  expect_status 200 "GET /api/orders?status=$st"
  expect_jq "([.[] | select(.id == $OD_L1)] | length) == 0 and ([.[] | select(.id == $OD_L2)] | length) == 1" "status=$st leaves it out and keeps its neighbour"
done
req GET "/api/orders?status=all&jobId=$OD_J1" "$ORDR"
expect_jq "length == 2 and ([.[] | select(.id == $OD_L1)] | length) == 0" "the job's lines with jobId"
req GET "/api/orders?status=all&supplier=$(jq -rn --arg s "$OD_S1" '$s | @uri')" "$ORDR"
expect_jq "([.[] | select(.id == $OD_L1)] | length) == 0 and ([.[] | select(.id == $OD_L2)] | length) == 1" "and by supplier"
od_card "$OD_J1"
expect_jq '.toOrder == 2 and .ordered == 0' "the card counts leave it out"
expect_jq "(.suppliers | length) == 2" "the card still lists both suppliers (other lines use them)"
req GET /api/orders/deliveries "$ORDR"
expect_status 200 "deliveries"
expect_jq "([.groups[].lines[], (.received // [])[]] | map(select(.id == $OD_L1)) | length) == 0" "deliveries never show it"

echo "--- a deleted line can't be changed ---"
req POST "/api/orders/$OD_L1/delete" "$ORDR"
expect_status 409 "deleting it again"
req PATCH "/api/orders/$OD_L1" "$ADMIN" '{"description":"Hinge A edited"}'
expect_status 409 "editing it"
expect_jq '.error == "This item was deleted"' "the sentence"
req PATCH "/api/orders/$OD_L1" "$ORDR" '{"status":"ordered"}'
expect_status 409 "ordering it singly"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$OD_L1]}"
expect_status 409 "ordering it in bulk"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$OD_L2,$OD_L1]}"
expect_status 409 "a bulk call that includes it is refused as a whole"
req POST "/api/orders/$OD_L1/cancel" "$ADMIN"
expect_status 409 "cancelling it"
req GET "/api/orders?status=to_order&jobId=$OD_J1" "$ORDR"
expect_jq "length == 2 and all(.[]; .status == \"to_order\")" "nothing else was changed by the refused calls"

echo "--- access ---"
req POST "/api/orders/$OD_L2/delete" "$WSMGR"
expect_status 403 "wsmgr (no orders.edit) can't delete"
req POST "/api/orders/$OD_L2/delete" "$SHOW"
expect_status 403 "showroom can't delete"
req POST "/api/orders/$OD_L2/delete" ""
expect_status 401 "logged out can't delete"
req POST "/api/orders/999999/delete" "$ORDR"
expect_status 404 "deleting a missing line"
req POST "/api/job-records/$OD_J1/orders/delete-card" "$WSMGR" '{}'
expect_status 403 "wsmgr can't delete a card"
req POST "/api/job-records/$OD_J1/orders/delete-card" "$SHOW" '{}'
expect_status 403 "showroom can't delete a card"
req POST "/api/job-records/$OD_J1/orders/delete-card" "" '{}'
expect_status 401 "logged out can't delete a card"
req POST "/api/orders/$OD_L1/restore" "$ORDR"
expect_status 403 "ordr can't restore"
req POST "/api/orders/$OD_L1/restore" "$DPM"
expect_status 403 "dpm can't restore"
req POST "/api/orders/$OD_L1/restore" ""
expect_status 401 "logged out can't restore"
req GET "/api/orders?status=deleted" "$ORDR"
expect_status 403 "ordr can't list deleted lines"
req GET "/api/orders?status=deleted" "$SHOW"
expect_status 403 "showroom can't list deleted lines"
req GET "/api/orders?status=deleted" ""
expect_status 401 "logged out can't list deleted lines"
req GET "/api/orders/$OD_L2/x" "$ADMIN"
expect_status 404 "(an unknown path is still a 404)"

echo "--- the deleted list and restore (admin) ---"
req POST "/api/orders/$OD_L2/delete" "$DPM"
expect_status 200 "dpm (orders.edit) deletes the second line"
req GET "/api/orders?status=deleted" "$ADMIN"
expect_status 200 "admin lists deleted lines"
expect_jq "([.[] | select(.id == $OD_L1 or .id == $OD_L2)] | length) == 2 and ([.[].id] | index($OD_L2)) < ([.[].id] | index($OD_L1))" "both are there, newest deleted first"
expect_jq "[.[] | select(.id == $OD_L2)][0] | .jobId == $OD_J1 and .jobName == \"OD Harlow kitchen $OD_TAG\" and .supplier == \"$OD_S1\" and .deletedBy.name == \"CI Design PM\" and (.deletedAt | type) == \"string\"" "with the usual list fields, who and when"
expect_jq 'all(.[]; .deletedAt != null)' "only deleted lines"
req GET "/api/orders?status=deleted&jobId=$OD_J1" "$ADMIN"
expect_jq "length == 2" "narrowed by job"
req GET "/api/orders?status=nonsense" "$ADMIN"
expect_status 400 "an unknown status is still refused"
req POST "/api/orders/$OD_L1/restore" "$ADMIN"
expect_status 200 "admin restores the first line"
expect_jq ".order | .id == $OD_L1 and .status == \"to_order\" and .deletedAt == null and .deletedBy == null" "it is a plain to_order line again"
expect_jq ".job.id == $OD_J1" "with the job state"
req GET "/api/orders?status=to_order&jobId=$OD_J1" "$ORDR"
expect_jq "([.[] | select(.id == $OD_L1)] | length) == 1 and ([.[] | select(.id == $OD_L2)] | length) == 0" "it is back in the lists, the other is still gone"
req GET "/api/job-records/$OD_J1/orders" "$ADMIN"
expect_jq "([.[] | select(.id == $OD_L1)] | length) == 1" "and on the job page"
od_card "$OD_J1"
expect_jq '.toOrder == 2' "and in the card counts"
expect_eq "$(od_audit order.restore "$OD_L1")" "1" "order.restore is audited"
req GET "/api/orders?status=deleted&jobId=$OD_J1" "$ADMIN"
expect_jq "length == 1 and .[0].id == $OD_L2" "it left the deleted list"
req POST "/api/orders/$OD_L1/restore" "$ADMIN"
expect_status 409 "restoring a line that isn't deleted"
req POST "/api/orders/$OD_L1/delete" "$ORDR"
expect_status 200 "a restored line can be deleted again"
expect_eq "$(od_audit order.delete "$OD_L1")" "2" "with a second order.delete row"
req POST "/api/orders/$OD_L1/restore" "$ADMIN"
expect_status 200 "and restored again"

echo "--- ordered and received lines can't be deleted ---"
od_job "OD Marlow vanity $OD_TAG"
OD_J2=$OD_JOB
od_lines "$OD_J2" "[{\"supplier\":\"$OD_S1\",\"description\":\"Ordered one\",\"quantity\":1},{\"supplier\":\"$OD_S1\",\"description\":\"Received one\",\"quantity\":2},{\"supplier\":\"$OD_S2\",\"description\":\"Still to order\",\"quantity\":3}]"
read -r OD_O1 OD_O2 OD_O3 <<<"$OD_IDS"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$OD_O1,$OD_O2],\"orderedDate\":\"$OD_YESTERDAY\"}"
expect_status 200 "ordr orders two lines"
OD_PO_ID=$(jqr '.supplierOrder.id')
req PATCH "/api/orders/$OD_O2" "$ADMIN" "{\"status\":\"received\",\"receivedDate\":\"$OD_TODAY\"}"
expect_status 200 "admin receives one"
req POST "/api/orders/$OD_O1/delete" "$ORDR"
expect_status 409 "an ordered line can't be deleted"
expect_jq '.error | contains("Undo ordered first")' "the message says to undo ordered first"
req POST "/api/orders/$OD_O2/delete" "$ORDR"
expect_status 409 "a received line can't be deleted"
expect_jq '.error | contains("Undo ordered first")' "same message"
req GET "/api/job-records/$OD_J2/orders" "$ADMIN"
expect_jq 'length == 3 and all(.[]; .deletedAt == null)' "nothing was deleted"
req GET "/api/job-records/$OD_J2" "$ADMIN"
expect_jq '.materialsOrderedDate == null' "the job is not all ordered yet (a line is still to order)"

echo "--- delete a card ---"
req POST "/api/job-records/$OD_J2/orders/delete-card" "$ORDR" '{}'
expect_status 409 "a card with ordered or received lines is refused"
expect_jq '.error == "2 items on this card are already ordered or received"' "the sentence counts them"
req POST "/api/job-records/$OD_J2/orders/delete-card" "$ORDR"
expect_status 409 "no body is the same as {}"
req POST "/api/job-records/$OD_J2/orders/delete-card" "$ORDR" '{"onlyToOrder":"yes"}'
expect_status 400 "onlyToOrder must be a boolean"
req GET "/api/job-records/$OD_J2/orders" "$ADMIN"
expect_jq 'length == 3 and all(.[]; .deletedAt == null)' "the refusals changed nothing"
req POST "/api/job-records/999999/orders/delete-card" "$ORDR" '{}'
expect_status 404 "no such job"
AUD=$(od_audit order.delete "$OD_O3")
req POST "/api/job-records/$OD_J2/orders/delete-card" "$ORDR" '{"onlyToOrder":true}'
expect_status 200 "onlyToOrder deletes just the To order items"
expect_jq ".count == 1 and .job.id == $OD_J2 and .job.materialsOrderedDate == \"$OD_TODAY\"" "one item, and the all-ordered rule ran once"
expect_eq "$(od_audit order.delete "$OD_O3")" "$((AUD + 1))" "each line is audited"
req GET "/api/job-records/$OD_J2/orders" "$ADMIN"
expect_jq "length == 2 and ([.[] | select(.id == $OD_O3)] | length) == 0" "the to_order line is gone"
od_card "$OD_J2"
expect_jq '.toOrder == 0 and .ordered == 1 and .received == 1 and .finished == false' "the card keeps its ordered and received lines"
req GET "/api/invoices/job/$OD_J2" "$ADMIN"
expect_jq '[.[] | select(.kind == "progress" and .status == "due" and .dueReason == "materials_ordered")] | length == 1' "the progress invoice is due, as for a cancel"
req POST "/api/job-records/$OD_J2/orders/delete-card" "$ORDR" '{"onlyToOrder":true}'
expect_status 409 "nothing left to delete"
req POST "/api/job-records/$OD_J2/orders/delete-card" "$ORDR" '{}'
expect_status 409 "the card still has ordered and received lines"

od_job "OD Wyatt pantry $OD_TAG"
OD_J3=$OD_JOB
od_lines "$OD_J3" "[{\"supplier\":\"$OD_S1\",\"description\":\"Shelf pin\",\"quantity\":100},{\"supplier\":\"$OD_S2\",\"description\":\"Cabinet lock\",\"quantity\":3},{\"supplier\":\"$OD_S1\",\"description\":\"Cancelled bit\",\"quantity\":1}]"
read -r OD_W1 OD_W2 OD_W3 <<<"$OD_IDS"
req POST "/api/orders/$OD_W3/cancel" "$ADMIN"
expect_status 200 "admin cancels one line"
req POST "/api/job-records/$OD_J3/orders/delete-card" "$ORDR" '{}'
expect_status 200 "a card of only To order (and cancelled) lines is deleted whole"
expect_jq ".count == 2 and .job.id == $OD_J3" "two lines; the cancelled one is not counted"
expect_eq "$(od_audit order.delete "$OD_W1")" "1" "line 1 audited"
expect_eq "$(od_audit order.delete "$OD_W2")" "1" "line 2 audited"
expect_eq "$(od_audit order.delete "$OD_W3")" "0" "the cancelled line was left alone"
req GET "/api/job-records/$OD_J3/orders?all=1" "$ADMIN"
expect_jq "length == 1 and .[0].id == $OD_W3 and .[0].status == \"cancelled\"" "only the cancelled line is left"
od_card "$OD_J3"
expect_eq "$BODY" "null" "the card is gone, even with finished=1"
req POST "/api/job-records/$OD_J3/orders/delete-card" "$ORDR" '{}'
expect_status 409 "nothing to delete on it now"
req GET "/api/orders?status=deleted&jobId=$OD_J3" "$ADMIN"
expect_jq "length == 2" "the two are in the admin's deleted list"
req POST "/api/orders/$OD_W1/restore" "$ADMIN"
expect_status 200 "restore one of them"
od_card "$OD_J3"
expect_jq '.toOrder == 1 and .ordered == 0' "the card is back with that line"

echo "--- deleting the last To order line: the all-ordered rule ---"
od_job "OD Last line $OD_TAG"
OD_J4=$OD_JOB
od_lines "$OD_J4" "[{\"supplier\":\"$OD_S1\",\"description\":\"First\",\"quantity\":1},{\"supplier\":\"$OD_S1\",\"description\":\"Second\",\"quantity\":1}]"
read -r OD_P1 OD_P2 <<<"$OD_IDS"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$OD_P1],\"orderedDate\":\"$OD_YESTERDAY\"}"
expect_status 200 "ordr orders the first line"
req GET "/api/job-records/$OD_J4" "$ADMIN"
expect_jq '.materialsOrderedDate == null' "the job isn't all ordered yet"
req POST "/api/orders/$OD_P2/delete" "$ORDR"
expect_status 200 "ordr deletes the last To order line"
expect_jq ".job.materialsOrderedDate == \"$OD_TODAY\"" "the job's materials-ordered date is set"
req GET "/api/job-records/$OD_J4" "$ADMIN"
expect_jq ".materialsOrderedDate == \"$OD_TODAY\"" "on the job too"
req GET "/api/invoices/job/$OD_J4" "$ADMIN"
expect_jq '[.[] | select(.kind == "progress" and .status == "due" and .dueReason == "materials_ordered")] | length == 1' "the progress invoice is made due"
req POST "/api/orders/$OD_P2/restore" "$ADMIN"
expect_status 200 "restoring the line"
req GET "/api/job-records/$OD_J4" "$ADMIN"
expect_jq ".materialsOrderedDate == \"$OD_TODAY\"" "the materials-ordered date stays (not reversed)"
req GET "/api/invoices/job/$OD_J4" "$ADMIN"
expect_jq '[.[] | select(.kind == "progress" and .status == "due" and .dueReason == "materials_ordered")] | length == 1' "and so does the invoice"
req GET "/api/orders?status=to_order&jobId=$OD_J4" "$ORDR"
expect_jq "length == 1 and .[0].id == $OD_P2" "the restored line is to order again"

echo "--- a saved supplier order that held a line which was later deleted ---"
od_job "OD PO history $OD_TAG"
OD_J5=$OD_JOB
od_lines "$OD_J5" "[{\"supplier\":\"$OD_S1\",\"description\":\"Ordered then undone\",\"quantity\":5}]"
read -r OD_R1 <<<"$OD_IDS"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$OD_R1]}"
expect_status 200 "ordr orders it (a saved order)"
OD_R_PO=$(jqr '.supplierOrder.id')
req PATCH "/api/orders/$OD_R1" "$ORDR" '{"status":"to_order"}'
expect_status 200 "ordr undoes it"
req POST "/api/orders/$OD_R1/delete" "$ORDR"
expect_status 200 "and deletes it"
req GET "/api/orders?status=all&jobId=$OD_J5" "$ORDR"
expect_jq 'length == 0' "it is gone from the lists"
req GET "/api/supplier-orders/$OD_R_PO" "$ORDR"
expect_status 200 "the saved order is still there"
expect_jq ".items | length == 1 and .[0].orderId == $OD_R1 and .[0].description == \"Ordered then undone\" and .[0].current.state == \"undone\" and .[0].current.status == \"to_order\"" "its item shows as undone, with the snapshot intact"
req GET /api/supplier-orders "$ORDR"
expect_jq "[.orders[] | select(.id == $OD_R_PO)][0].itemCount == 1" "the saved order's list item is unchanged"
req GET "/api/supplier-orders/$OD_R_PO/pdf" "$ORDR"
expect_status 200 "and its PDF still opens"
