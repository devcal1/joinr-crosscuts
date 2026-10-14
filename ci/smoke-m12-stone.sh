# M12 smoke, Wave 1 A: stone orders and the benchtop sheet.
# Sourced by ci/smoke.sh after the M11 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie jars ($ADMIN $DPM $ORDR $ACCT
# $SCHED $WSMGR). No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: its job and names carry a run tag, it reads its user ids
# from /api/auth/me, and it checks only its own rows. Made-up names only (this repo is public).
# Contract: docs/plans/m12-contracts.md sections 3, 4, 5 and 10.2.

# ============================================================================
step "m12. stone orders and the benchtop sheet"
# ============================================================================

M12_S_TAG=$(date +%s)
M12_S_JOB_NAME="M12 Test Job $M12_S_TAG"
M12_S_QUOTE="M12Q$M12_S_TAG"
M12_S_SUPPLIER="M12 Stone Supplier $M12_S_TAG"
M12_S_BRAND="M12 Stone Brand $M12_S_TAG"

# m12_s_me JAR: sets M12_S_ID and M12_S_NAME to that user's id and display name.
m12_s_me() {
  req GET /api/auth/me "$1"
  expect_status 200 "GET /api/auth/me"
  M12_S_ID=$(jqr '.user.id')
  M12_S_NAME=$(jqr '.user.displayName')
}

# Today is the server's (Sydney) date. m12_s_day N: today plus N days, as YYYY-MM-DD.
req GET /api/orders/deliveries "$ADMIN"
expect_status 200 "admin reads the server's today"
M12_S_TODAY=$(jqr '.date')
m12_s_day() {
  date -u -d "$M12_S_TODAY $1 day" +%F
}
M12_S_PROMISED=$(m12_s_day +30)
M12_S_REQ=$(m12_s_day +3)

m12_s_me "$DPM"
M12_S_DPM_ID=$M12_S_ID
M12_S_DPM_NAME=$M12_S_NAME

echo "--- access ---"
req GET /stone.html "$DPM"
expect_status 200 "dpm GET /stone.html"
req GET /stone.html "$ORDR"
expect_status 200 "ordr GET /stone.html"
req GET /stone.html "$ACCT"
expect_status 403 "acct GET /stone.html"
req GET /stone.html "$WSMGR"
expect_status 403 "wsmgr GET /stone.html"
req GET /stoneprint.html "$ACCT"
expect_status 200 "acct GET /stoneprint.html"
req GET /stoneprint.html "$SCHED"
expect_status 200 "sched GET /stoneprint.html"
req GET /stoneprint.html "$WSMGR"
expect_status 403 "wsmgr GET /stoneprint.html"
req GET /api/stone "$ORDR"
expect_status 200 "ordr GET /api/stone"
req GET /api/stone "$ACCT"
expect_status 403 "acct GET /api/stone"
req GET /api/stone/summary "$DPM"
expect_status 200 "dpm GET /api/stone/summary"
req GET /api/stone/summary "$WSMGR"
expect_status 403 "wsmgr GET /api/stone/summary"

echo "--- create ---"
req POST /api/job-records "$ADMIN" \
  "$(jq -nc --arg n "$M12_S_JOB_NAME" --arg q "$M12_S_QUOTE" --arg p "$M12_S_PROMISED" \
    '{name:$n,quoteNumber:$q,siteAddress:"1 Made Up Street, Nowhere",clientName:"M12 Test Client",clientPhone:"0400 000 012",promisedInstallDate:$p,benchtop:"stone"}')"
expect_status 201 "admin makes the job"
M12_S_JOB=$(jqr '.id')
req POST "/api/job-records/$M12_S_JOB/stone" "$DPM" '{}'
expect_status 201 "dpm starts a stone order from {}"
M12_S_O1=$(jqr '.id')
expect_jq ".status == \"draft\" and .revision == 0 and .jobId == $M12_S_JOB and .form.jobReference == \"$M12_S_JOB_NAME\" and .form.quoteNumber == \"$M12_S_QUOTE\" and .form.clientPhone == \"0400 000 012\" and .form.cabinetryInstallDate == \"$M12_S_PROMISED\" and .form.ourContact == \"$M12_S_DPM_NAME\"" \
  "a prefilled draft"
expect_jq '.form.supplier == "" and .form.siteAddress == "1 Made Up Street, Nowhere" and .form.clientName == "M12 Test Client" and .changedSinceSent == false and .sentDate == null and (.revisions | length) == 0' \
  "the rest of the new order"
req POST "/api/job-records/$M12_S_JOB/stone" "$DPM" '{"supplier":""}'
expect_status 201 "dpm starts a second order with supplier empty"
M12_S_O2=$(jqr '.id')
expect_jq ".form.supplier == \"\" and .form.jobReference == \"$M12_S_JOB_NAME\" and .form.quoteNumber == \"$M12_S_QUOTE\" and .form.clientName == \"M12 Test Client\"" \
  "supplier stays empty, the rest prefilled"
req POST "/api/job-records/$M12_S_JOB/stone" "$ORDR" '{}'
expect_status 403 "ordr starts a stone order"
req GET "/api/job-records/$M12_S_JOB/stone" "$ACCT"
expect_status 200 "acct GET the job's stone orders"
expect_jq "(.orders | length) == 2 and .orders[0].id == $M12_S_O1 and .orders[1].id == $M12_S_O2 and .job.benchtop == \"stone\" and .job.archived == false and (.benchtopText | type) == \"array\" and (.prefill | type) == \"object\"" \
  "both orders, the job, the prefill and the benchtop text"
req GET "/api/job-records/$M12_S_JOB/stone" "$WSMGR"
expect_status 403 "wsmgr GET the job's stone orders"

echo "--- edit ---"
req PATCH "/api/stone/$M12_S_O1" "$DPM" '{"bogus":1}'
expect_status 400 "an unknown field"
expect_jq '.error == "Unknown field: bogus"' "the unknown field is named"
req PATCH "/api/stone/$M12_S_O1" "$DPM" "$(jq -nc --arg s "$(printf 'x%.0s' $(seq 1 201))" '{supplier:$s}')"
expect_status 400 "a 201-character supplier"
expect_jq '.error == "Supplier must be 200 characters or fewer"' "the too-long sentence"
req PATCH "/api/stone/$M12_S_O1" "$DPM" '{"measureDate":"2026-02-31"}'
expect_status 400 "a bad date"
expect_jq '.error == "Measure / template must be a date"' "the bad-date sentence"
req PATCH "/api/stone/$M12_S_O1" "$ORDR" '{"siteAccess":"M12 nope"}'
expect_status 403 "ordr edits a stone order"
req PATCH "/api/stone/$M12_S_O1" "$DPM" \
  "$(jq -nc --arg s "$M12_S_SUPPLIER" --arg m "$(m12_s_day +1)" '{supplier:$s,siteAccess:"Side gate",measureDate:$m}')"
expect_status 200 "dpm edits the order"
expect_jq ".form.supplier == \"$M12_S_SUPPLIER\" and .form.siteAccess == \"Side gate\" and .form.measureDate == \"$(m12_s_day +1)\" and .status == \"draft\" and .updatedBy.id == $M12_S_DPM_ID" \
  "the fields changed"

echo "--- send ---"
req POST "/api/stone/$M12_S_O1/send" "$DPM" '{}'
expect_status 400 "send with the stone brand and colour empty"
expect_jq '(.error | startswith("Fill in before sending: ")) and (.error | contains("Stone brand")) and (.error | contains("Colour"))' \
  "the refusal names them"
req PATCH "/api/stone/$M12_S_O1" "$DPM" \
  "$(jq -nc --arg b "$M12_S_BRAND" --arg r "$M12_S_REQ" '{brand:$b,colour:"M12 Grey",edgeHeight:"20 mm",edgeProfile:"Aris",requestedInstallDate:$r}')"
expect_status 200 "dpm fills the needed fields"
req POST "/api/stone/$M12_S_O1/send" "$DPM" "$(jq -nc --arg d "$(m12_s_day +1)" '{sentDate:$d}')"
expect_status 400 "a sent date in the future"
expect_jq '.error == "The sent date can'"'"'t be in the future"' "the future sentence"
req POST "/api/stone/$M12_S_O1/send" "$DPM" '{}'
expect_status 200 "dpm sends the order"
expect_jq ".status == \"sent\" and .revision == 1 and .sentDate == \"$M12_S_TODAY\" and (.revisions | length) == 1 and .sentBy.id == $M12_S_DPM_ID and .changedSinceSent == false" \
  "sent, revision 1, today"
req POST "/api/stone/$M12_S_O1/send" "$DPM" '{}'
expect_status 409 "send again with nothing changed"
expect_jq '.error == "Nothing has changed since revision 1 was sent"' "the unchanged sentence"
req PATCH "/api/stone/$M12_S_O1" "$DPM" '{"colour":"M12 White"}'
expect_status 200 "dpm changes the colour"
expect_jq '.changedSinceSent == true and .status == "sent" and .revision == 1' "changed since sent, still sent"
req POST "/api/stone/$M12_S_O1/send" "$DPM" "$(jq -nc --arg d "$(m12_s_day -1)" '{sentDate:$d}')"
expect_status 400 "a sent date before revision 1's"
expect_jq '.error | startswith("The sent date can'"'"'t be before revision 1 (")' "the before-revision sentence"
req POST "/api/stone/$M12_S_O1/send" "$DPM" "$(jq -nc --arg d "$M12_S_TODAY" '{sentDate:$d}')"
expect_status 200 "dpm sends revision 2"
expect_jq '.revision == 2 and (.revisions | length) == 2 and .changedSinceSent == false' "revision 2"
req GET "/api/stone/$M12_S_O1/revisions/1" "$ACCT"
expect_status 200 "acct reads revision 1"
expect_jq ".revision == 1 and .orderId == $M12_S_O1 and .form.colour == \"M12 Grey\" and .sentDate == \"$M12_S_TODAY\"" \
  "revision 1 has the old colour"
req GET "/api/stone/$M12_S_O1/revisions/3" "$ACCT"
expect_status 404 "revision 3"
req GET "/api/stone/$M12_S_O1" "$ACCT"
expect_status 200 "acct reads the order"
expect_jq '(.business | keys) == ["address","email","legalName","phone","tradingName"] and (.business | has("abn") | not)' \
  "business has the five keys and no abn"

echo "--- summary and list ---"
req GET /api/stone/summary "$DPM"
expect_status 200 "dpm GET the summary"
expect_jq ".date == \"$M12_S_TODAY\" and .installsSoon >= 1 and .drafts >= 1" "an install soon, and the other order is a draft"
req GET /api/stone "$ORDR"
expect_status 200 "ordr GET the open list"
expect_jq "[.orders[] | select(.id == $M12_S_O1 and .status == \"sent\")] | length == 1" "the sent order is listed"
expect_jq "[.orders[] | select(.id == $M12_S_O2 and .status == \"draft\")] | length == 1" "the draft is listed"
req GET "/api/stone?status=bogus" "$ORDR"
expect_status 400 "status=bogus"

echo "--- cancel and restore ---"
req POST "/api/stone/$M12_S_O1/cancel" "$DPM" '{}'
expect_status 200 "dpm cancels the order"
expect_jq ".status == \"cancelled\" and .cancelledBy.id == $M12_S_DPM_ID" "cancelled"
req GET /api/stone "$ORDR"
expect_status 200 "the open list"
expect_jq "[.orders[] | select(.id == $M12_S_O1)] | length == 0" "a cancelled order is not open"
req GET "/api/stone?status=cancelled" "$ORDR"
expect_status 200 "the cancelled list"
expect_jq "[.orders[] | select(.id == $M12_S_O1)] | length == 1" "it is in the cancelled list"
req PATCH "/api/stone/$M12_S_O1" "$DPM" '{"notes":"M12 nope"}'
expect_status 409 "editing a cancelled order"
expect_jq '.error == "This stone order is cancelled"' "the cancelled sentence"
req POST "/api/stone/$M12_S_O1/cancel" "$DPM" '{}'
expect_status 409 "cancelling it again"
req POST "/api/stone/$M12_S_O1/restore" "$DPM" '{}'
expect_status 200 "dpm restores the order"
expect_jq '.status == "sent" and .revision == 2 and .cancelledAt == null' "back to sent, revision 2"

echo "--- suggestions ---"
req GET /api/stone/suggestions "$DPM"
expect_status 200 "dpm GET the suggestions"
expect_jq "([.suppliers[] | select(. == \"$M12_S_SUPPLIER\")] | length) == 1 and ([.brands[] | select(. == \"$M12_S_BRAND\")] | length) == 1" \
  "the supplier and brand are suggested"
req GET /api/stone/suggestions "$ORDR"
expect_status 403 "ordr GET the suggestions"

echo "--- the benchtop sheet ---"
req GET "/api/job-records/$M12_S_JOB/benchtop-sheet" "$ACCT"
expect_status 200 "acct GET the benchtop sheet"
expect_jq ".job.name == \"$M12_S_JOB_NAME\" and .job.quoteNumber == \"$M12_S_QUOTE\" and (.benchtopText | type) == \"array\" and (.business | has(\"abn\") | not)" \
  "the job's name and its benchtop text"
req GET "/api/job-records/$M12_S_JOB/benchtop-sheet" "$WSMGR"
expect_status 403 "wsmgr GET the benchtop sheet"
req GET /api/stone/letterhead "$ORDR"
expect_status 200 "ordr GET the letterhead"
req GET /api/stone/letterhead "$WSMGR"
expect_status 403 "wsmgr GET the letterhead"

echo "--- orders untouched ---"
req GET "/api/job-records/$M12_S_JOB/orders?all=1" "$ADMIN"
expect_status 200 "the job's order lines"
expect_jq 'length == 0' "a stone order is not an order line"
req GET "/api/job-records/$M12_S_JOB" "$ADMIN"
expect_status 200 "the job"
expect_jq '.materialsOrderedDate == null' "materials ordered is still empty"

echo "--- an archived job ---"
req PATCH "/api/job-records/$M12_S_JOB" "$ADMIN" '{"archived":true}'
expect_status 200 "admin archives the job"
req POST "/api/job-records/$M12_S_JOB/stone" "$DPM" '{}'
expect_status 409 "a new stone order on an archived job"
expect_jq '.error == "The job is archived"' "the archived sentence"
req PATCH "/api/stone/$M12_S_O1" "$DPM" '{"notes":"M12 nope"}'
expect_status 409 "editing an order on an archived job"
req POST "/api/stone/$M12_S_O1/cancel" "$DPM" '{}'
expect_status 200 "cancelling an order on an archived job"

echo "--- audit ---"
for M12_S_ACTION in stone.create stone.update stone.send stone.cancel stone.restore; do
  req GET "/api/audit?action=$M12_S_ACTION&entityType=stone_order&entityId=$M12_S_O1&limit=50" "$ADMIN"
  expect_status 200 "the order's $M12_S_ACTION rows"
  expect_jq "[.rows[] | select(.action == \"$M12_S_ACTION\")] | length >= 1" "a $M12_S_ACTION row for the order"
done
req GET "/api/audit?action=stone.send&entityType=stone_order&entityId=$M12_S_O1&limit=50" "$ADMIN"
expect_jq "[.rows[] | select(.after.revision == 2 and .after.sentDate == \"$M12_S_TODAY\")] | length == 1" \
  "the send row carries the revision and sent date"

echo "M12 stone orders smoke test passed."
