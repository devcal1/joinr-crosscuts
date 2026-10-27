# M27 smoke: Workshop manager (0.2.6, docs/plans/m27-contracts.md): the fortnightly stock cycle
# (fortnight keys alongside month keys), targets and the order fill, the Finish count bell, the
# maintenance.manage key and Workshop > Maintenance (access, Confirm actioned, the weekly overdue
# bell), board and edge tape stock with reservations, cut 100% and the workshop manager's Waiting on
# you. Sourced by ci/smoke.sh after the M26 suites, so it shares that script's helpers and cookie
# jars (and the M11 suite's m11_st_free). No shebang and no `set`: the caller owns both. Made-up
# names only; it reads only its own rows.

# ============================================================================
step "m27. workshop manager: fortnightly stock, maintenance, reservations"
# ============================================================================

M27_TAG="m27w$(date +%s)"
M27_TODAY=$(TZ=Australia/Sydney date +%F)
M27_START=2026-10-26
M27_DIFF=$(( ( $(date -u -d "$M27_TODAY" +%s) - $(date -u -d "$M27_START" +%s) ) / 86400 ))
if [ "$M27_DIFF" -ge 0 ]; then M27_K=$(( M27_DIFF / 14 )); else M27_K=$(( -((-M27_DIFF + 13) / 14) )); fi
M27_FN=$(date -u -d "$M27_START +$((M27_K * 14)) days" +%F)
M27_NEXTFN=$(date -u -d "$M27_FN +14 days" +%F)
M27_MONTH=${M27_TODAY:0:7}
M27_PLUS8=$(date -u -d "$M27_TODAY +8 days" +%F)
M27_PLUS15=$(date -u -d "$M27_TODAY +15 days" +%F)

echo "--- the key ---"
req GET /api/auth/me "$WSMGR"
expect_jq '.user.perms | index("maintenance.manage") != null' "the workshop manager holds maintenance.manage"
req GET /api/maintenance ""
expect_status 401 "logged out"
req GET /api/maintenance "$WSMGR"
expect_status 200 "the workshop manager reads Maintenance"
req GET /api/maintenance "$ADMIN"
expect_status 200 "admin reads Maintenance"
req GET /api/maintenance "$ORDR"
expect_status 403 "ordering doesn't (no maintenance.manage)"
req GET /api/maintenance "$WSHOP"
expect_status 403 "the workshop login doesn't"
req GET /maintenance.html "$WSMGR"
case $BODY in *'maintenance.js'*) ok ;; *) fail "maintenance.html doesn't load maintenance.js" ;; esac
req GET /shell/shell.js "$WSMGR"
case $BODY in *'"/maintenance.html", key: "maintenance.manage"'*) ok ;; *) fail "the menu has no Workshop > Maintenance" ;; esac

echo "--- the stock cycle ---"
req GET /api/stock/settings "$WSMGR"
expect_status 200 "the cycle"
expect_jq ".cycle == \"fortnightly\" and .cycleStart == \"$M27_START\" and .current == \"$M27_FN\"" "fortnightly from Mon 26 Oct 2026; the current fortnight is $M27_FN"
req PUT /api/stock/settings "$WSMGR" '{"cycle":"monthly"}'
expect_status 403 "the workshop manager doesn't change the cycle"
req PUT /api/stock/settings "$ORDR" '{"cycle":"weekly"}'
expect_status 400 "not a cycle"
req PUT /api/stock/settings "$ORDR" '{"cycleStart":"2026-10-27"}'
expect_status 400 "the start must be a Monday"
req GET "/api/stock/orders/$M27_FN" "$WSMGR"
expect_status 200 "the fortnight"
expect_jq ".period == \"$M27_FN\" and .kind == \"fortnight\" and (.label | test(\" – \"))" "a fortnight key, labelled as a date range"
req GET "/api/stock/orders/$M27_MONTH" "$WSMGR"
expect_status 200 "a month key still reads"
expect_jq '.kind == "month"' "as a month"
req GET "/api/stock/orders/$(date -u -d "$M27_FN +1 day" +%F)" "$WSMGR"
expect_status 400 "a Tuesday isn't a fortnight key"
req GET "/api/stock/orders/$M27_NEXTFN" "$WSMGR"
expect_status 400 "the next fortnight hasn't started"
req GET "/api/stock/orders/2026-13" "$WSMGR"
expect_status 400 "not a month"

echo "--- targets and the order fill ---"
req POST /api/stock/items "$WSMGR" "{\"supplier\":\"$M27_TAG Sup A\",\"item\":\"$M27_TAG screws\",\"target\":10}"
expect_status 201 "the workshop manager adds an item with a target"
expect_jq '.target == 10' "target 10"
M27_I1=$(jqr '.id')
req POST /api/stock/items "$WSMGR" "{\"supplier\":\"$M27_TAG Sup B\",\"item\":\"$M27_TAG glue\",\"target\":4}"
expect_status 201 "a second item"
M27_I2=$(jqr '.id')
req PATCH "/api/stock/items/$M27_I2" "$WSMGR" '{"target":5}'
expect_status 200 "the workshop manager changes a target"
expect_jq '.target == 5' "target 5"
req PATCH "/api/stock/items/$M27_I2" "$WSMGR" '{"target":-1}'
expect_status 400 "a negative target"
req PATCH "/api/stock/items/$M27_I2" "$ACCT" '{"target":3}'
expect_status 403 "accounts can't"
req PUT "/api/stock/orders/$M27_FN/have" "$WSMGR" "{\"lines\":[{\"itemId\":$M27_I1,\"have\":3},{\"itemId\":$M27_I2,\"have\":8}]}"
expect_status 200 "Have on the fortnight"
expect_jq "[.groups[].lines[] | select(.itemId == $M27_I1)][0] | .target == 10 and .have == 3 and .order == 7 and .suggested == 7" "Order fills in as target minus have"
expect_jq "[.groups[].lines[] | select(.itemId == $M27_I2)][0] | .order == 0" "never below nothing"
req PUT "/api/stock/orders/$M27_FN/order" "$ORDR" "{\"lines\":[{\"itemId\":$M27_I1,\"order\":9}]}"
expect_status 200 "Ordering overwrites Order"
req PUT "/api/stock/orders/$M27_FN/have" "$WSMGR" "{\"lines\":[{\"itemId\":$M27_I1,\"have\":4}]}"
expect_status 200 "Have changes again"
expect_jq "[.groups[].lines[] | select(.itemId == $M27_I1)][0] | .order == 9 and .suggested == 6" "a typed Order is kept"
req PUT "/api/stock/orders/$M27_FN/have" "$WSMGR" "{\"lines\":[{\"itemId\":$M27_I2,\"have\":2}]}"
expect_jq "[.groups[].lines[] | select(.itemId == $M27_I2)][0] | .order == 3" "a filled Order follows Have"
req GET "/api/audit?action=stock_order.order_fill&limit=5" "$ADMIN"
expect_jq '(.rows | length) >= 1' "the fill is audited"
req POST "/api/stock/orders/$M27_FN/counted" "$WSMGR"
expect_status 200 "Finish count"
req GET "/api/notifications?limit=50" "$ORDR"
expect_jq "[.rows[] | select(.kind == \"stock.counted\" and .link == \"/stock.html?period=$M27_FN\") | .body] == [\"2 lines to order from 2 suppliers.\"]" "the order list to Ordering says how many lines and suppliers"
req GET /api/stock/summary "$WSMGR"
expect_jq "(.stockCount == null) or (.stockCount.period != \"$M27_FN\")" "the counted fortnight is no longer due"
req GET /api/stock/orders "$ORDR"
expect_jq "[.months[] | select(.period == \"$M27_FN\")][0].label | test(\" – \")" "listed with its label"
for i in $M27_I1 $M27_I2; do req PATCH "/api/stock/items/$i" "$ORDR" '{"active":false}'; done

echo "--- maintenance ---"
req POST /api/maintenance "$ORDR" "{\"title\":\"$M27_TAG no\",\"repeat\":\"weekly\",\"startDate\":\"$M27_TODAY\"}"
expect_status 403 "ordering can't add maintenance"
req POST /api/maintenance "$WSMGR" "{\"title\":\"$M27_TAG oil the saw\",\"repeat\":\"weekly\",\"startDate\":\"$M27_TODAY\",\"assigneeId\":1}"
expect_status 201 "the workshop manager adds an item"
expect_jq '.kind == "maintenance" and .dept == "workshop" and .assignee == null and (.open | length) == 1 and .lastDone == null' "the Workshop department's, due today"
M27_M1=$(jqr '.id')
M27_T1=$(jqr '.open[0].taskId')
req POST /api/maintenance "$WSMGR" "{\"title\":\"$M27_TAG grease the press\",\"repeat\":\"weekly\",\"startDate\":\"$M27_TODAY\"}"
expect_status 201 "a second item"
M27_M2=$(jqr '.id')
req GET /api/recurring "$ADMIN"
expect_jq "[.rules[] | select(.id == $M27_M1 or .id == $M27_M2)] | length == 0" "Admin > Tasks doesn't list maintenance"
req GET "/api/recurring/$M27_M1" "$ADMIN"
expect_status 404 "nor open it"
req GET /api/maintenance "$WSMGR"
expect_jq "[.items[] | select(.id == $M27_M1)][0] | .repeatText == \"Every week\" and .nextDue == \"$M27_TODAY\"" "listed with its repeat and next due"
req GET /api/my-work "$WSMGR"
expect_jq '[.items[] | select(.key == "maintenanceDue")][0].count >= 2' "Waiting on you: maintenance due today"
req POST "/api/tasks/$M27_T1/done" "$ORDR" '{}'
expect_status 403 "the Tasks page's Done is refused without maintenance.manage"
req POST "/api/maintenance/occurrences/$M27_T1/done" "$ORDR" '{"note":"x"}'
expect_status 403 "so is Confirm actioned"
req POST "/api/maintenance/occurrences/$M27_T1/done" "$WSMGR" "{\"note\":\"$(printf 'x%.0s' $(seq 1 1001))\"}"
expect_status 400 "a note over 1000 characters"
req POST "/api/maintenance/occurrences/$M27_T1/done" "$WSMGR" '{"note":"Blade changed too"}'
expect_status 200 "Confirm actioned with a note"
expect_jq '(.open | length) == 0 and .lastDone.note == "Blade changed too" and .lastDone.by.name == "CI Workshop Manager"' "who, when and the note"
req POST "/api/maintenance/occurrences/$M27_T1/done" "$WSMGR" '{}'
expect_status 409 "not twice"
req POST "/api/maintenance/occurrences/$M27_T1/reopen" "$WSMGR" '{}'
expect_status 200 "undone"
expect_jq '(.open | length) == 1 and .lastDone == null' "open again"
req POST "/api/tasks/$M27_T1/done" "$WSMGR" '{}'
expect_status 200 "the workshop manager may tick it on the Tasks page too"
req GET "/api/audit?action=maintenance.done&entityId=$M27_T1&limit=5" "$ADMIN"
expect_jq '(.rows | length) == 1' "Confirm actioned is audited"
req POST /api/maintenance/run "$WSMGR" "{\"today\":\"$M27_PLUS8\"}"
expect_status 200 "run as of eight days on"
expect_jq '.belled >= 1' "the open one, 8 days overdue, bells admin"
req GET "/api/notifications?limit=100" "$ADMIN"
expect_jq "[.rows[] | select(.kind == \"maintenance.overdue\" and .title == \"Maintenance overdue: $M27_TAG grease the press\")] | length == 1" "admin is told once"
req GET "/api/notifications?limit=100" "$WSMGR"
expect_jq "[.rows[] | select(.kind == \"maintenance.overdue\")] | length == 0" "not the workshop manager"
req POST /api/maintenance/run "$WSMGR" "{\"today\":\"$M27_PLUS8\"}"
req GET "/api/notifications?limit=100" "$ADMIN"
expect_jq "[.rows[] | select(.kind == \"maintenance.overdue\" and .title == \"Maintenance overdue: $M27_TAG grease the press\")] | length == 1" "not again the same week"
req POST /api/maintenance/run "$WSMGR" "{\"today\":\"$M27_PLUS15\"}"
req GET "/api/notifications?limit=100" "$ADMIN"
expect_jq "[.rows[] | select(.kind == \"maintenance.overdue\" and .title == \"Maintenance overdue: $M27_TAG grease the press\")] | length >= 2" "again a week later"
req POST "/api/maintenance/$M27_M2/pause" "$WSMGR" '{}'
expect_status 200 "paused"
expect_jq '.active == false' "inactive"
for m in $M27_M1 $M27_M2; do req DELETE "/api/maintenance/$m" "$WSMGR"; expect_status 204 "deleted"; done
req GET "/api/maintenance/$M27_M1" "$WSMGR"
expect_status 404 "gone"

echo "--- board and edge tape stock ---"
req POST /api/boards "$WSMGR" "{\"name\":\"$M27_TAG white melamine\",\"thickness\":16,\"onHand\":20}"
expect_status 201 "the workshop manager adds a board with on hand"
expect_jq '.kind == "board" and .onHand == 20 and .reserved == 0 and .free == 20 and (has("priceCents") | not)' "on hand, reserved, free; no price"
M27_B=$(jqr '.id')
req POST /api/boards "$WSMGR" "{\"kind\":\"edge\",\"name\":\"$M27_TAG white tape\",\"width\":22,\"thickness\":1,\"colour\":\"White\",\"onHand\":10}"
expect_status 201 "and an edge tape roll"
expect_jq '.kind == "edge" and .width == 22 and .colour == "White" and .free == 10' "edge tape, 22 mm, white"
M27_E=$(jqr '.id')
req PATCH "/api/boards/$M27_E" "$WSMGR" '{"onHand":2.5}'
expect_status 400 "edge tape is whole rolls"
req POST /api/boards "$WSMGR" '{"kind":"veneer","name":"x"}'
expect_status 400 "not a kind"

echo "--- reserve instead of order ---"
req POST /api/job-records "$DPM" "{\"name\":\"$M27_TAG kitchen\",\"stage\":\"won\"}"
expect_status 201 "a job"
M27_J=$(jqr '.id')
req POST "/api/job-records/$M27_J/materials" "$DPM" "{\"section\":\"boards\",\"name\":\"$M27_TAG white melamine\",\"qty\":12,\"unit\":\"sheets\"}"
expect_status 201 "a boards line"
M27_LB=$(jqr '.id')
req POST "/api/job-records/$M27_J/materials" "$DPM" "{\"section\":\"edging\",\"name\":\"$M27_TAG white tape\",\"qty\":4,\"unit\":\"rolls\"}"
expect_status 201 "an edging line"
M27_LE=$(jqr '.id')
req POST "/api/job-records/$M27_J/materials" "$DPM" "{\"section\":\"handles\",\"name\":\"$M27_TAG handle\",\"qty\":4}"
M27_LH=$(jqr '.id')
req POST "/api/job-records/$M27_J/materials/to-orders" "$DPM" "{\"ids\":[$M27_LB,$M27_LE,$M27_LH],\"supplier\":\"$M27_TAG Boards Co\"}"
expect_status 200 "the lines go to Ordering"
M27_OB=$(jqr ".created[] | select(.id == $M27_LB) | .orderId")
M27_OE=$(jqr ".created[] | select(.id == $M27_LE) | .orderId")
M27_OH=$(jqr ".created[] | select(.id == $M27_LH) | .orderId")
req GET "/api/job-records/$M27_J/reservations" "$DPM"
expect_status 200 "the job's reservations"
expect_jq '(.lines | length) == 2 and .canReserve == false and .cut == null' "its boards and edging lines; dpm can't reserve"
req POST "/api/job-records/$M27_J/reservations" "$DPM" "{\"orderId\":$M27_OB,\"boardId\":$M27_B,\"qty\":2}"
expect_status 403 "dpm can't reserve"
req POST "/api/job-records/$M27_J/reservations" "$ORDR" "{\"orderId\":$M27_OB,\"boardId\":$M27_B,\"qty\":25}"
expect_status 409 "no more than free"
req POST "/api/job-records/$M27_J/reservations" "$ORDR" "{\"orderId\":$M27_OE,\"boardId\":$M27_B,\"qty\":2}"
expect_status 400 "an edging line takes edge tape"
req POST "/api/job-records/$M27_J/reservations" "$ORDR" "{\"orderId\":$M27_OH,\"boardId\":$M27_B,\"qty\":2}"
expect_status 400 "a handles line can't be reserved"
req POST "/api/job-records/$M27_J/reservations" "$ORDR" "{\"orderId\":$M27_OE,\"boardId\":$M27_E,\"qty\":1.5}"
expect_status 400 "whole rolls"
req POST "/api/job-records/$M27_J/reservations" "$ORDR" "{\"orderId\":$M27_OB,\"boardId\":$M27_B,\"qty\":8}"
expect_status 201 "ordering reserves 8 sheets; the rest is still to order"
expect_jq '.status == "reserved" and .covers == false and .qty == 8' "reserved"
M27_RB=$(jqr '.id')
req POST "/api/job-records/$M27_J/reservations" "$ORDR" "{\"orderId\":$M27_OE,\"boardId\":$M27_E,\"qty\":4,\"covers\":true}"
expect_status 201 "and all 4 rolls of tape, nothing left to order"
M27_RE=$(jqr '.id')
req POST "/api/job-records/$M27_J/reservations" "$ORDR" "{\"orderId\":$M27_OE,\"boardId\":$M27_E,\"qty\":1,\"covers\":true}"
expect_status 409 "a line wholly reserved once"
req GET /api/boards "$WSMGR"
expect_jq "[.boards[] | select(.id == $M27_B)][0] | .onHand == 20 and .reserved == 8 and .free == 12" "free is on hand less reserved"
req GET "/api/notifications?limit=50" "$WSMGR"
expect_jq "[.rows[] | select(.kind == \"stock.reserve\" and .title == \"Reserve from stock: $M27_TAG kitchen\")] | length == 2" "the workshop manager is belled"
req GET /api/my-work "$WSMGR"
expect_jq '[.items[] | select(.key == "toLabel")][0].count == 2' "Waiting on you: two to label"
req PATCH "/api/orders/$M27_OH" "$ORDR" '{"status":"ordered"}'
req PATCH "/api/orders/$M27_OB" "$ORDR" '{"status":"ordered"}'
expect_status 200 "the rest of the boards line is ordered"
req GET "/api/job-records/$M27_J" "$DPM"
expect_jq '.materialsOrderedDate != null' "all ordered: the tape counts as ordered (reserved)"

echo "--- label, release, cut 100% ---"
req POST "/api/reservations/$M27_RB/confirm" "$DPM" '{}'
expect_status 403 "dpm can't tick Reserved"
req POST "/api/reservations/$M27_RB/confirm" "$WSMGR" '{}'
expect_status 200 "the workshop manager ticks Reserved"
expect_jq '.status == "confirmed" and .confirmed.by.name == "CI Workshop Manager"' "confirmed"
req POST "/api/reservations/$M27_RB/confirm" "$WSMGR" '{}'
expect_status 409 "not twice"
req POST "/api/reservations/$M27_RE/release" "$ORDR" '{}'
expect_status 200 "ordering releases the tape"
expect_jq '.status == "released"' "released"
req GET /api/boards "$WSMGR"
expect_jq "[.boards[] | select(.id == $M27_E)][0].free == 10" "back to free stock"
req POST "/api/job-records/$M27_J/reservations" "$ORDR" "{\"orderId\":$M27_OE,\"boardId\":$M27_E,\"qty\":4,\"covers\":true}"
expect_status 201 "reserved again"
M27_RE=$(jqr '.id')
req POST "/api/reservations/$M27_RE/confirm" "$WSMGR" '{}'
expect_status 200 "and labelled"
req GET /api/reservations "$WSMGR"
expect_status 200 "the To reserve page"
expect_jq "([.toCut[] | select(.jobId == $M27_J)] | length == 1) and ([.reservedNotCut[] | select(.jobId == $M27_J)] | length == 2)" "the job is waiting to be cut"
req GET /api/my-work "$WSMGR"
expect_jq '[.items[] | select(.key == "toCut")][0].count >= 1' "Waiting on you: a job to mark cut"
req POST /api/workshop/cut "$ACCT" "{\"jobIds\":[$M27_J]}"
expect_status 403 "accounts can't record a cut"
req POST /api/workshop/cut "$WSMGR" '{"jobIds":[]}'
expect_status 400 "no jobs"
req POST /api/workshop/cut "$WSMGR" "{\"jobIds\":[$M27_J]}"
expect_status 200 "cut 100%"
expect_jq "[.cut[] | select(.jobId == $M27_J)][0].taken == 2" "both reservations come off stock"
req GET /api/boards "$WSMGR"
expect_jq "[.boards[] | select(.id == $M27_B)][0] | .onHand == 12 and .reserved == 0 and .free == 12" "the board's on hand goes down by 8"
expect_jq "[.boards[] | select(.id == $M27_E)][0].onHand == 6" "the tape's by 4"
req POST /api/workshop/cut "$WSMGR" "{\"jobIds\":[$M27_J]}"
expect_jq "[.skipped[] | select(.jobId == $M27_J)] | length == 1" "a second time is skipped"
req POST "/api/reservations/$M27_RB/release" "$WSMGR" '{}'
expect_status 409 "a cut reservation can't be released"
req GET "/api/audit?action=job.cut_complete&entityId=$M27_J&limit=5" "$ADMIN"
expect_jq '(.rows | length) == 1' "cut 100% is audited"
req GET "/api/job-records/$M27_J/reservations" "$DPM"
expect_jq ".cut.date == \"$M27_TODAY\" and .cut.by.name == \"CI Workshop Manager\"" "the job page shows it"
req GET "/job.html?id=$M27_J" "$DPM"
case $BODY in *'id="reservations"'*'jobreserve.js'*) ok ;; *) fail "the job page has no Stock reservations section" ;; esac
req GET /reserve.html "$WSMGR"
case $BODY in *'reserve.js'*) ok ;; *) fail "reserve.html doesn't load reserve.js" ;; esac
req GET /shift.html "$WSHOP"
case $BODY in *'id="shCut"'*'shiftcut.js'*) ok ;; *) fail "the shift page has no cut 100% block" ;; esac

echo "--- the count resets on hand ---"
m11_st_free /api/boards/counts
M27_BP=$M11_ST_FREE
req PUT "/api/boards/counts/$M27_BP/lines" "$WSMGR" "{\"lines\":[{\"boardId\":$M27_E,\"qty\":2.5}]}"
expect_status 400 "edge tape counts whole rolls"
req PUT "/api/boards/counts/$M27_BP/lines" "$WSMGR" "{\"lines\":[{\"boardId\":$M27_B,\"qty\":15},{\"boardId\":$M27_E,\"qty\":7}]}"
expect_status 200 "counted"
req POST "/api/boards/counts/$M27_BP/counted" "$WSMGR"
expect_status 200 "the count is finished"
req GET /api/boards "$WSMGR"
expect_jq "[.boards[] | select(.id == $M27_B or .id == $M27_E) | .onHand] == [15, 7]" "on hand is what was counted"
for b in $M27_B $M27_E; do req PATCH "/api/boards/$b" "$WSMGR" '{"active":false}'; done
