# Job cards and supplier orders smoke (0.2.22, migration 063): order line quantity, adding items to a
# job in one go (POST /api/job-records/:id/orders/batch), the supplier suggestions with the Supplier
# accounts names, the job cards (GET /api/orders/cards), marking many lines ordered at once (POST
# /api/orders/mark-ordered) and the print page. Sourced by ci/smoke.sh before the backup suite, so it
# shares that script's helpers (step, req, expect_status, expect_jq, expect_eq, jqr, fail, ok) and the
# cookie jars ($ADMIN $ACCT $SCHED $DPM $SHOW $ORDR $WSMGR). No shebang and no `set`: the caller owns
# both. It does not assume a pristine database: its jobs and suppliers carry a run tag in their names
# and it checks only its own rows. Made-up names only (this repo is public).
# Contract: docs/plans/jobcards-plan.md.

# ============================================================================
step "jobcards. quantity, batch add, suppliers, cards, bulk mark ordered"
# ============================================================================

JC_TAG=$(date +%s)
JC_TODAY=$(TZ=Australia/Sydney date +%F)
JC_YESTERDAY=$(date -u -d "$JC_TODAY - 1 day" +%F)
JC_TOMORROW=$(date -u -d "$JC_TODAY + 1 day" +%F)
JC_NEXTWEEK=$(date -u -d "$JC_TODAY + 7 days" +%F)
JC_S1="JC Hinge Works $JC_TAG"
JC_S2="JC Runner Supply $JC_TAG"
JC_QMSG="Quantity must be a number above 0 and up to 99999, with at most 2 decimals"

# jc_job NAME: a job with a value and a client as the admin -> JC_JOB.
jc_job() {
  req POST /api/job-records "$ADMIN" \
    "{\"name\":\"$1\",\"clientName\":\"JC Client $JC_TAG\",\"valueCents\":2000000}"
  expect_status 201 "create job $1"
  JC_JOB=$(jqr '.id')
}

# jc_batch JAR JOB_ID LINES_JSON: POST the batch.
jc_batch() {
  req POST "/api/job-records/$2/orders/batch" "$1" "{\"lines\":$3}"
}

# jc_audit_total ACTION ID: the number of audit rows for the order.
jc_audit_total() {
  req GET "/api/audit?action=$1&entityType=order&entityId=$2&limit=1" "$ADMIN"
  expect_status 200 "GET /api/audit?action=$1"
  jqr '.total'
}

# jc_progress JOB_ID: the live progress invoices of the job -> JC_PROGRESS (count).
jc_progress() {
  req GET "/api/invoices/job/$1" "$ADMIN"
  expect_status 200 "GET /api/invoices/job/$1"
  JC_PROGRESS=$(jqr '[.[] | select(.kind == "progress" and .status != "void")] | length')
}

jc_job "JC Harlow kitchen $JC_TAG"
JC_J1=$JC_JOB
jc_job "JC Marlow vanity $JC_TAG"
JC_J2=$JC_JOB
jc_job "JC Archive job $JC_TAG"
JC_J3=$JC_JOB
jc_job "JC Cancelled only $JC_TAG"
JC_J4=$JC_JOB

echo "--- quantity on create, edit and clear ---"
req POST "/api/job-records/$JC_J1/orders" "$DPM" "{\"supplier\":\"$JC_S1\",\"description\":\"Hinge 110\",\"quantity\":24}"
expect_status 201 "dpm adds a line with a quantity"
expect_jq '.order.quantity == 24' "the quantity is on the line"
JC_Q1=$(jqr '.order.id')
req POST "/api/job-records/$JC_J1/orders" "$DPM" "{\"supplier\":\"$JC_S1\",\"description\":\"Runner 450\",\"quantity\":\"2.45\"}"
expect_status 201 "a quantity as a string with 2 decimals"
expect_jq '.order.quantity == 2.45' "2.45 is kept"
JC_Q2=$(jqr '.order.id')
req POST "/api/job-records/$JC_J1/orders" "$DPM" "{\"supplier\":\"$JC_S1\",\"description\":\"No qty\"}"
expect_status 201 "a line without a quantity"
expect_jq '.order.quantity == null' "no quantity is null"
JC_Q3=$(jqr '.order.id')
req POST "/api/job-records/$JC_J1/orders" "$DPM" "{\"supplier\":\"$JC_S1\",\"description\":\"Blank qty\",\"quantity\":\"\"}"
expect_status 201 "an empty string quantity"
expect_jq '.order.quantity == null' "blank is null"
JC_Q4=$(jqr '.order.id')
req GET "/api/audit?action=order.create&entityType=order&entityId=$JC_Q1&limit=5" "$ADMIN"
expect_jq '[.rows[] | select(.after.quantity == 24)] | length == 1' "order.create audit carries the quantity"

for bad_q in 0 -1 100000 2.456 '"abc"' '"1e3"' '"2,5"' true '[1]' '{}'; do
  req POST "/api/job-records/$JC_J1/orders" "$DPM" "{\"supplier\":\"$JC_S1\",\"description\":\"Bad qty\",\"quantity\":$bad_q}"
  expect_status 400 "create with quantity $bad_q"
  expect_jq ".error == \"$JC_QMSG\"" "the quantity message for $bad_q"
done
req POST "/api/job-records/$JC_J1/orders" "$DPM" "{\"supplier\":\"$JC_S1\",\"description\":\"Max qty\",\"quantity\":99999}"
expect_status 201 "99999 is accepted"
req POST "/api/job-records/$JC_J1/orders" "$DPM" "{\"supplier\":\"$JC_S1\",\"description\":\"Min qty\",\"quantity\":0.01}"
expect_status 201 "0.01 is accepted"

JC_B=$(jc_audit_total order.update "$JC_Q3")
req PATCH "/api/orders/$JC_Q3" "$DPM" '{"quantity":6.5}'
expect_status 200 "dpm sets a quantity"
expect_jq '.order.quantity == 6.5' "the quantity changed"
expect_eq "$(jc_audit_total order.update "$JC_Q3")" "$((JC_B + 1))" "the quantity change is audited in order.update"
req PATCH "/api/orders/$JC_Q3" "$DPM" '{"quantity":"abc"}'
expect_status 400 "PATCH a bad quantity"
req PATCH "/api/orders/$JC_Q3" "$DPM" '{"quantity":0}'
expect_status 400 "PATCH a zero quantity"
req PATCH "/api/orders/$JC_Q3" "$WSMGR" '{"quantity":7}'
expect_status 403 "a user without orders.edit can't change the quantity"
req PATCH "/api/orders/$JC_Q3" "$DPM" '{"quantity":null}'
expect_status 200 "null clears the quantity"
expect_jq '.order.quantity == null' "the quantity is cleared"
req PATCH "/api/orders/$JC_Q1" "$DPM" '{"quantity":""}'
expect_status 200 "an empty string clears the quantity"
expect_jq '.order.quantity == null' "cleared with an empty string"
req PATCH "/api/orders/$JC_Q1" "$DPM" '{"quantity":24}'
expect_status 200 "put the quantity back"
req GET "/api/job-records/$JC_J1/orders" "$DPM"
expect_jq "[.[] | select(.id == $JC_Q1)][0].quantity == 24" "the job's line list carries the quantity"

echo "--- list rows: jobNumber and clientName ---"
req GET "/api/orders?status=to_order&jobId=$JC_J1" "$ORDR"
expect_status 200 "ordr GET /api/orders for the job"
expect_jq "length >= 4 and all(.[]; has(\"jobNumber\") and has(\"quantity\") and .clientName == \"JC Client $JC_TAG\" and .jobName == \"JC Harlow kitchen $JC_TAG\")" \
  "rows carry quantity, jobNumber and clientName"
req GET "/api/job-records/$JC_J1" "$ADMIN"
JC_J1_NUM=$(jqr '.jobNumber // ""')
if [ -n "$JC_J1_NUM" ]; then
  req GET "/api/orders?status=to_order&jobId=$JC_J1" "$ORDR"
  expect_jq "all(.[]; .jobNumber == \"$JC_J1_NUM\")" "the rows' jobNumber is the job's"
fi
req GET /api/orders/deliveries "$WSMGR"
expect_status 200 "deliveries still load"
expect_jq '[.groups[].lines[]] | all(.[]; has("quantity") and has("jobNumber") and has("clientName"))' "Deliveries rows carry the new fields"

echo "--- batch add: access and not found ---"
JC_LINES=$(jq -nc --arg s "$JC_S2" '[{supplier:$s,description:"Handle 128",quantity:10},{supplier:$s,description:"Soft close damper",quantity:"4.5"}]')
for jar in "$SCHED" "$WSMGR"; do
  jc_batch "$jar" "$JC_J2" "$JC_LINES"
  expect_status 403 "a user without orders.edit adds a batch"
done
jc_batch "$SHOW" "$JC_J2" "$JC_LINES"
expect_status 403 "showroom adds a batch"
req POST "/api/job-records/$JC_J2/orders/batch" "" "{\"lines\":$JC_LINES}"
expect_status 401 "logged out batch"
jc_batch "$DPM" 999999 "$JC_LINES"
expect_status 404 "batch to an unknown job"
req GET "/api/job-records/$JC_J2/orders" "$ADMIN"
expect_jq 'length == 0' "nothing was written by the refused batches"

echo "--- batch add: validation (nothing written) ---"
jc_batch "$DPM" "$JC_J2" '[]'
expect_status 400 "no lines"
req POST "/api/job-records/$JC_J2/orders/batch" "$DPM" '{}'
expect_status 400 "no lines key"
req POST "/api/job-records/$JC_J2/orders/batch" "$DPM" '{"lines":"x"}'
expect_status 400 "lines is not a list"
JC_OKROW=$(jq -nc --arg s "$JC_S2" '{supplier:$s,description:"Good row",quantity:2}')
jc_batch "$DPM" "$JC_J2" "[$JC_OKROW,{\"supplier\":\"\",\"description\":\"No supplier\",\"quantity\":1}]"
expect_status 400 "a row without a supplier"
expect_jq '.error | startswith("Row 2: ")' "the error names row 2"
jc_batch "$DPM" "$JC_J2" "[{\"supplier\":\"$JC_S2\",\"description\":\"  \",\"quantity\":1}]"
expect_status 400 "a row without hardware"
expect_jq '.error | startswith("Row 1: ")' "the error names row 1"
jc_batch "$DPM" "$JC_J2" "[$JC_OKROW,$JC_OKROW,{\"supplier\":\"$JC_S2\",\"description\":\"No quantity\"}]"
expect_status 400 "a row without a quantity"
expect_jq '.error | startswith("Row 3: ")' "the error names row 3"
jc_batch "$DPM" "$JC_J2" "[$JC_OKROW,{\"supplier\":\"$JC_S2\",\"description\":\"Bad quantity\",\"quantity\":\"x\"}]"
expect_status 400 "a row with a bad quantity"
expect_jq ".error == \"Row 2: $JC_QMSG\"" "the row error carries the quantity message"
JC_LONG=$(head -c 201 /dev/zero | tr '\0' s)
jc_batch "$DPM" "$JC_J2" "[{\"supplier\":\"$JC_LONG\",\"description\":\"x\",\"quantity\":1}]"
expect_status 400 "a supplier over 200 characters"
JC_LONGD=$(head -c 501 /dev/zero | tr '\0' d)
jc_batch "$DPM" "$JC_J2" "[{\"supplier\":\"$JC_S2\",\"description\":\"$JC_LONGD\",\"quantity\":1}]"
expect_status 400 "hardware over 500 characters"
jc_batch "$DPM" "$JC_J2" '["text"]'
expect_status 400 "a row that is not an object"
JC_51=$(jq -nc --arg s "$JC_S2" '[range(0;51) | {supplier:$s,description:"Bulk \(.)",quantity:1}]')
jc_batch "$DPM" "$JC_J2" "$JC_51"
expect_status 400 "51 rows"
req GET "/api/job-records/$JC_J2/orders" "$ADMIN"
expect_jq 'length == 0' "all-or-nothing: no line was written by any refused batch"

echo "--- batch add: success, 50 rows, audit, archived ---"
JC_B=$(jq -nc --arg s1 "$JC_S1" --arg s2 "$JC_S2" \
  '[{supplier:$s1,description:"Hinge 110",quantity:12},{supplier:$s2,description:"Handle 128",quantity:"10"},{supplier:("  " + $s1 + " "),description:"Door stop",quantity:3,notes:"back door"}]')
jc_batch "$DPM" "$JC_J2" "$JC_B"
expect_status 201 "dpm adds three items in one go"
expect_jq '(.orders | length) == 3 and (.orders | all(.[]; .status == "to_order" and .quantity != null)) and .job.id == '"$JC_J2"' and .job.materialsOrderedDate == null' \
  "three to_order lines and the job dates"
expect_jq ".orders[2].supplier == \"$JC_S1\" and .orders[2].notes == \"back door\" and .orders[0].quantity == 12" "trimmed supplier, notes and quantities kept"
JC_L1=$(jqr '.orders[0].id')
JC_L2=$(jqr '.orders[1].id')
JC_L3=$(jqr '.orders[2].id')
for id in "$JC_L1" "$JC_L2" "$JC_L3"; do
  expect_eq "$(jc_audit_total order.create "$id")" "1" "one order.create audit row for line $id"
done
jc_batch "$ORDR" "$JC_J1" "[{\"supplier\":\"$JC_S2\",\"description\":\"Fifty\",\"quantity\":1}]"
expect_status 201 "ordr (orders.edit) adds to a job that already has lines"
JC_EXTRA=$(jqr '.orders[0].id')
JC_J4_LINES=$(jq -nc --arg s "$JC_S1" '[range(0;50) | {supplier:$s,description:"Fifty \(.)",quantity:1}]')
jc_batch "$DPM" "$JC_J4" "$JC_J4_LINES"
expect_status 201 "exactly 50 rows are accepted"
expect_jq '.orders | length == 50' "50 lines created"
# Cancel all 50 so the job has only cancelled lines (it must never show as a card).
for id in $(printf '%s' "$BODY" | jq -r '.orders[].id'); do
  req POST "/api/orders/$id/cancel" "$DPM"
  expect_status 200 "cancel line $id of the cancelled-only job"
done

jc_batch "$DPM" "$JC_J3" "[{\"supplier\":\"$JC_S1\",\"description\":\"Archive line\",\"quantity\":1}]"
expect_status 201 "a line on the job that will be archived"
JC_A1=$(jqr '.orders[0].id')
req PATCH "/api/job-records/$JC_J3" "$ADMIN" '{"archived":true}'
expect_status 200 "archive the job"
jc_batch "$DPM" "$JC_J3" "[{\"supplier\":\"$JC_S1\",\"description\":\"Late item\",\"quantity\":1}]"
expect_status 409 "a batch to an archived job"
expect_jq '.error == "This job is archived; add items to an open job"' "the archived sentence"

echo "--- supplier suggestions ---"
req GET /api/orders/suppliers "$SHOW"
expect_status 403 "showroom GET /api/orders/suppliers"
req GET "/api/orders/suppliers?q=JC%20Hinge" "$ORDR"
expect_status 200 "ordr GET /api/orders/suppliers?q="
expect_jq "index(\"$JC_S1\") != null" "a name used on order lines is suggested"
expect_jq "[.[] | select(ascii_downcase == \"$(printf '%s' "$JC_S1" | tr 'A-Z' 'a-z')\")] | length == 1" "listed once however it was spelled"
JC_ACC="JC Accounts Only Supply $JC_TAG"
req POST /api/suppliers "$ACCT" "$(jq -nc --arg n "$JC_ACC" '{name:$n, fromPeriod:"2024-03"}')"
expect_status 201 "accounts adds a supplier account"
JC_ACC_ID=$(jqr '.id')
req GET "/api/orders/suppliers?q=JC%20Accounts%20Only" "$ORDR"
expect_status 200 "suggestions by prefix"
expect_jq ". == [\"$JC_ACC\"]" "the Supplier accounts name is suggested though no line uses it"
req GET "/api/orders/suppliers?q=jc%20accounts%20only%20supply%20$JC_TAG" "$ORDR"
expect_jq ". == [\"$JC_ACC\"]" "the prefix is case-insensitive"
req GET "/api/orders/suppliers?q=Accounts%20Only" "$ORDR"
expect_jq 'length == 0 or all(.[]; ascii_downcase | startswith("accounts only"))' "the prefix is a prefix, not a substring"
# A free-typed new name becomes a suggestion once it is on a line.
JC_NEW="JC Brand New Supplier $JC_TAG"
req GET "/api/orders/suppliers?q=JC%20Brand%20New" "$ORDR"
expect_jq 'length == 0' "a new name is not suggested before it is used"
jc_batch "$DPM" "$JC_J2" "[{\"supplier\":\"$JC_NEW\",\"description\":\"Edge tape\",\"quantity\":\"2.4\"}]"
expect_status 201 "a free-typed supplier name is accepted"
JC_L4=$(jqr '.orders[0].id')
req GET "/api/orders/suppliers?q=JC%20Brand%20New" "$ORDR"
expect_jq ". == [\"$JC_NEW\"]" "the new name is suggested next time"
# A name in both places is listed once (the order-line spelling).
req POST /api/suppliers "$ACCT" "$(jq -nc --arg n "$(printf '%s' "$JC_NEW" | tr 'a-z' 'A-Z')" '{name:$n, fromPeriod:"2024-03"}')"
expect_status 201 "accounts adds the same name in capitals"
req GET "/api/orders/suppliers?q=JC%20Brand%20New" "$ORDR"
expect_jq ". == [\"$JC_NEW\"]" "the same name in both places is listed once"
req GET /api/orders/suppliers "$ORDR"
expect_jq 'length <= 50' "at most 50 names"

echo "--- job cards ---"
req GET /api/orders/cards "$SHOW"
expect_status 403 "showroom GET /api/orders/cards"
req GET /api/orders/cards "$WSMGR"
expect_status 200 "wsmgr (orders.view) GET /api/orders/cards"
req GET "/api/orders/cards?finished=2" "$ORDR"
expect_status 400 "a bad finished value"
req GET /api/orders/cards "$ORDR"
expect_status 200 "ordr GET /api/orders/cards"
expect_jq '(.cards | type) == "array"' "the cards list"
expect_jq "[.cards[] | select(.jobId == $JC_J1)] | length == 1" "job 1 has a card"
expect_jq "[.cards[] | select(.jobId == $JC_J1)][0] | .name == \"JC Harlow kitchen $JC_TAG\" and .client == \"JC Client $JC_TAG\" and .archived == false and .finished == false and .toOrder == 7 and .ordered == 0 and .received == 0 and (has(\"jobNumber\")) and .suppliers == [\"$JC_S1\", \"$JC_S2\"]" \
  "job 1: seven lines to order and its two suppliers, A-Z"
expect_jq "[.cards[] | select(.jobId == $JC_J2)][0] | .toOrder == 4 and .suppliers == [\"$JC_NEW\", \"$JC_S1\", \"$JC_S2\"]" "job 2: four lines and three suppliers, A-Z"
expect_jq "[.cards[] | select(.jobId == $JC_J3 or .jobId == $JC_J4)] | length == 0" "an archived job and a cancelled-only job are not shown"
expect_jq '[.cards[] | select((.suppliers | map(ascii_downcase) | unique | length) != (.suppliers | length))] | length == 0' "no card lists a supplier twice"
req GET "/api/orders/cards?finished=1" "$ORDR"
expect_status 200 "finished=1"
expect_jq "[.cards[] | select(.jobId == $JC_J3)][0] | .archived == true and .finished == false and .toOrder == 1" "finished=1 adds the archived job"
expect_jq "[.cards[] | select(.jobId == $JC_J4)] | length == 0" "a job with only cancelled lines never shows"
expect_jq "[.cards[] | select(.jobId == $JC_J1)] | length == 1" "open jobs are still there with finished=1"
req GET "/api/orders/cards?finished=0" "$ORDR"
expect_jq "[.cards[] | select(.jobId == $JC_J3)] | length == 0" "finished=0 is the default"

echo "--- mark ordered in bulk: access and validation ---"
JC_ID_ARR="[$JC_L1,$JC_L3]"
req POST /api/orders/mark-ordered "$DPM" "{\"orderIds\":$JC_ID_ARR}"
expect_status 403 "dpm (no orders.mark_ordered) marks in bulk"
req POST /api/orders/mark-ordered "$WSMGR" "{\"orderIds\":$JC_ID_ARR}"
expect_status 403 "wsmgr marks in bulk"
req POST /api/orders/mark-ordered "$SHOW" "{\"orderIds\":$JC_ID_ARR}"
expect_status 403 "showroom marks in bulk"
req POST /api/orders/mark-ordered "" "{\"orderIds\":$JC_ID_ARR}"
expect_status 401 "logged out bulk mark"
req POST /api/orders/mark-ordered "$ORDR" '{}'
expect_status 400 "no ids"
req POST /api/orders/mark-ordered "$ORDR" '{"orderIds":[]}'
expect_status 400 "empty ids"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$JC_L1,$JC_L1]}"
expect_status 400 "repeated ids"
req POST /api/orders/mark-ordered "$ORDR" '{"orderIds":[0]}'
expect_status 400 "a zero id"
req POST /api/orders/mark-ordered "$ORDR" '{"orderIds":["1"]}'
expect_status 400 "a text id"
req POST /api/orders/mark-ordered "$ORDR" "$(jq -nc '{orderIds:[range(1;202)]}')"
expect_status 400 "201 ids"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":$JC_ID_ARR,\"orderedDate\":\"$JC_TOMORROW\"}"
expect_status 400 "an ordered date in the future"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":$JC_ID_ARR,\"orderedDate\":\"2030-02-31\"}"
expect_status 400 "an impossible ordered date"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":$JC_ID_ARR,\"expectedDate\":\"nope\"}"
expect_status 400 "a bad expected date"
JC_LONGREF=$(head -c 101 /dev/zero | tr '\0' r)
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":$JC_ID_ARR,\"supplierRef\":\"$JC_LONGREF\"}"
expect_status 400 "a reference over 100 characters"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":$JC_ID_ARR,\"supplierRef\":5}"
expect_status 400 "a numeric reference"
req GET "/api/job-records/$JC_J2/orders" "$ADMIN"
expect_jq '[.[] | select(.status != "to_order")] | length == 0' "nothing was ordered by the refused calls"

echo "--- mark ordered in bulk: the 409 changes nothing ---"
# L3 gets ordered on its own first, so a bulk call that includes it is refused as a whole.
req PATCH "/api/orders/$JC_L3" "$ORDR" '{"status":"ordered"}'
expect_status 200 "ordr orders one line singly"
JC_AUD_L1=$(jc_audit_total order.status "$JC_L1")
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$JC_L1,$JC_L3,$JC_L2],\"supplierRef\":\"PO-X\"}"
expect_status 409 "a line that is no longer to order refuses the whole call"
JC_409_BODY=$BODY
req GET "/api/job-records/$JC_J2" "$ADMIN"
JC_J2_NUM=$(jqr '.jobNumber // empty')
BODY=$JC_409_BODY
JC_J2_LABEL="JC Marlow vanity $JC_TAG"
if [ -n "$JC_J2_NUM" ]; then JC_J2_LABEL="$JC_J2_NUM $JC_J2_LABEL"; fi
expect_jq ".error == \"Door stop ($JC_S1) on $JC_J2_LABEL is no longer to order. Reload and try again.\"" \
  "the 409 sentence names the line, supplier and job"
req GET "/api/job-records/$JC_J2/orders" "$ADMIN"
expect_jq "[.[] | select(.id == $JC_L1 or .id == $JC_L2)] | all(.[]; .status == \"to_order\" and .orderedDate == null and (.notes | contains(\"Ref\") | not))" "the other lines are untouched"
expect_eq "$(jc_audit_total order.status "$JC_L1")" "$JC_AUD_L1" "no audit row was written for them"
# Cancelled and missing ids are refused the same way.
req POST "/api/orders/$JC_L2/cancel" "$DPM"
expect_status 200 "cancel line 2"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$JC_L1,$JC_L2]}"
expect_status 409 "a cancelled line refuses the call"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$JC_L1,999999]}"
expect_status 409 "a missing id refuses the call"
req GET "/api/job-records/$JC_J2/orders" "$ADMIN"
expect_jq "[.[] | select(.id == $JC_L1)][0].status == \"to_order\"" "line 1 is still to order"

echo "--- mark ordered in bulk: dates, ref, audit, hand-offs ---"
# Job 1 now: Q1 (24), Q2 (2.45), Q3 (none), Q4 (none), two more (max, min), EXTRA (S2). Give Q2 existing notes.
req PATCH "/api/orders/$JC_Q2" "$ORDR" '{"notes":"existing note"}'
expect_status 200 "notes on line Q2"
req GET "/api/orders?status=to_order&jobId=$JC_J1" "$ORDR"
JC_J1_IDS=$(printf '%s' "$BODY" | jq -c '[.[].id]')
JC_J1_N=$(printf '%s' "$BODY" | jq -r 'length')
jc_progress "$JC_J1"
expect_eq "$JC_PROGRESS" "0" "no progress invoice yet on job 1"
JC_AUD_Q2=$(jc_audit_total order.status "$JC_Q2")
JC_AUDU_Q2=$(jc_audit_total order.update "$JC_Q2")
# A partial call first (all but one): nothing must be marked on the job yet.
JC_LAST=$JC_EXTRA
JC_PART=$(printf '%s' "$JC_J1_IDS" | jq -c --argjson x "$JC_LAST" 'map(select(. != $x))')
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":$JC_PART,\"orderedDate\":\"$JC_YESTERDAY\",\"expectedDate\":\"$JC_NEXTWEEK\",\"supplierRef\":\"  PO-4471  \"}"
expect_status 200 "ordr marks all but one line of job 1 ordered"
expect_jq ".count == $((JC_J1_N - 1)) and .jobCount == 1 and (.orders | length) == $((JC_J1_N - 1))" "the count, the job count and the lines"
expect_jq ".orders | all(.[]; .status == \"ordered\" and .orderedDate == \"$JC_YESTERDAY\" and .expectedDate == \"$JC_NEXTWEEK\")" "every line has the order and expected dates"
expect_jq "[.orders[] | select(.id == $JC_Q2)][0].notes == \"existing note\\nRef: PO-4471\"" "the Ref is appended after existing notes on a new line"
expect_jq "[.orders[] | select(.id == $JC_Q1)][0].notes == \"Ref: PO-4471\"" "a line with no notes gets just the Ref"
expect_eq "$(jc_audit_total order.status "$JC_Q2")" "$((JC_AUD_Q2 + 1))" "one order.status audit row per line"
expect_eq "$(jc_audit_total order.update "$JC_Q2")" "$((JC_AUDU_Q2 + 1))" "one order.update audit row for the expected date and notes"
req GET "/api/audit?action=order.status&entityType=order&entityId=$JC_Q2&limit=1" "$ADMIN"
expect_jq ".rows[0].before.status == \"to_order\" and .rows[0].after.status == \"ordered\" and .rows[0].after.ordered_date == \"$JC_YESTERDAY\"" "the audit row has the status move and the date"
req GET "/api/orders/cards" "$ORDR"
expect_jq "[.cards[] | select(.jobId == $JC_J1)][0] | .toOrder == 1 and .ordered == $((JC_J1_N - 1))" "the card counts follow"
jc_progress "$JC_J1"
expect_eq "$JC_PROGRESS" "0" "no progress invoice while a line is still to order"
req GET "/api/job-records/$JC_J1" "$ADMIN"
expect_jq '.materialsOrderedDate == null' "the job's materials-ordered date is still empty"
# The last line, in a bulk call of one: the progress invoice is made due with the order date.
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$JC_LAST],\"orderedDate\":\"$JC_YESTERDAY\"}"
expect_status 200 "ordr marks the last line in bulk"
expect_jq '.count == 1 and .jobCount == 1 and .orders[0].status == "ordered" and .orders[0].expectedDate == null' "one line, no expected date given"
req GET "/api/job-records/$JC_J1" "$ADMIN"
expect_jq ".materialsOrderedDate == \"$JC_YESTERDAY\"" "the job's materials-ordered date is the order date"
req GET "/api/invoices/job/$JC_J1" "$ADMIN"
expect_jq '[.[] | select(.kind == "progress" and .status == "due" and .dueReason == "materials_ordered")] | length == 1' "exactly one progress invoice is made due"
jc_progress "$JC_J1"
expect_eq "$JC_PROGRESS" "1" "and it is the only live progress invoice"
req GET "/api/orders/cards" "$ORDR"
expect_jq "[.cards[] | select(.jobId == $JC_J1)] | length == 1 and .[0].toOrder == 0 and .[0].ordered == $JC_J1_N and .[0].finished == false" "job 1's card is still open: all ordered, none received yet"

echo "--- mark ordered in bulk: two jobs at once, default date ---"
# Job 2 has L1 (to order), L2 cancelled, L3 ordered singly, L4 (S_NEW); job 3 is archived with A1.
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$JC_L1,$JC_L4,$JC_A1]}"
expect_status 200 "ordr marks lines of two jobs (one archived)"
expect_jq ".count == 3 and .jobCount == 2 and (.orders | all(.[]; .orderedDate == \"$JC_TODAY\"))" "the date defaults to today (Sydney); two jobs"
req GET "/api/job-records/$JC_J2" "$ADMIN"
expect_jq ".materialsOrderedDate == \"$JC_TODAY\"" "job 2's materials-ordered date is set when its last line goes"
req GET "/api/invoices/job/$JC_J2" "$ADMIN"
expect_jq '[.[] | select(.kind == "progress" and .status == "due" and .dueReason == "materials_ordered")] | length == 1' "job 2's progress invoice is due"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$JC_L1]}"
expect_status 409 "ordering an already ordered line again is refused"
req GET "/api/orders/cards?finished=1" "$ORDR"
expect_jq "[.cards[] | select(.jobId == $JC_J3)][0] | .archived == true and .ordered == 1 and .toOrder == 0 and .finished == false" "the archived job's card counts the ordered line"
req PATCH "/api/orders/$JC_A1" "$ORDR" '{"status":"received"}'
expect_status 200 "ordr receives the archived job's line"
req GET "/api/orders/cards?finished=1" "$ORDR"
expect_jq "[.cards[] | select(.jobId == $JC_J3)][0] | .received == 1 and .finished == true" "all received: the card is finished"
req GET "/api/orders/cards" "$ORDR"
expect_jq "[.cards[] | select(.jobId == $JC_J3)] | length == 0" "and it is hidden without finished=1"

echo "--- mark ordered in bulk: notes limit, drawers and paint ---"
JC_BIGNOTE=$(head -c 1990 /dev/zero | tr '\0' n)
jc_job "JC Notes limit $JC_TAG"
JC_J5=$JC_JOB
req POST "/api/job-records/$JC_J5/orders" "$DPM" "{\"supplier\":\"$JC_S2\",\"description\":\"Long note line\",\"quantity\":1,\"notes\":\"$JC_BIGNOTE\"}"
expect_status 201 "a line with a long note"
JC_N1=$(jqr '.order.id')
req POST "/api/job-records/$JC_J5/orders" "$DPM" "{\"supplier\":\"$JC_S2\",\"description\":\"Short note line\",\"quantity\":1}"
expect_status 201 "a second line"
JC_N2=$(jqr '.order.id')
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$JC_N2,$JC_N1],\"supplierRef\":\"PO-OVER-THE-LIMIT\"}"
expect_status 400 "a Ref that would pass the notes limit is refused"
expect_jq '.error | contains("Long note line")' "the error names the line"
req GET "/api/job-records/$JC_J5/orders" "$ADMIN"
expect_jq '[.[] | select(.status != "to_order")] | length == 0' "nothing was ordered by it"
req POST /api/orders/mark-ordered "$ORDR" "{\"orderIds\":[$JC_N2]}"
expect_status 200 "the short line alone can be ordered"

echo "--- the print page ---"
req GET /orderprint.html "$ORDR"
expect_status 200 "ordr GET /orderprint.html"
[[ $BODY == *"orderprint.js"* ]] || fail "orderprint.html does not load orderprint.js"
ok
req GET /orderprint.html "$WSMGR"
expect_status 200 "wsmgr (orders.view) GET /orderprint.html"
req GET /orderprint.html "$SHOW"
expect_status 403 "showroom GET /orderprint.html"
req GET /orderprint.html
expect_status 302 "logged out GET /orderprint.html redirects to login"
req GET /orderprint.js "$ORDR"
expect_status 200 "ordr GET /orderprint.js"
