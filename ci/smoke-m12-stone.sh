# M12 smoke, Wave 1 A: stone orders and the benchtop sheet.
# Sourced by ci/smoke.sh after the M11 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie jars ($ADMIN $DPM $ORDR $ACCT
# $SCHED $WSMGR). No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: its job and names carry a run tag, it reads its user ids
# from /api/auth/me, it checks only its own rows, and the Design/PM summary is checked by its change
# from a reading taken at the start. Made-up names only (this repo is public).
# Contract: docs/plans/m12-contracts.md sections 3, 4, 5 and 10.2 (with the "Added at 4.3" list).

# ============================================================================
step "m12. stone orders and the benchtop sheet"
# ============================================================================

M12_S_TAG=$(date +%s)
M12_S_JOB_NAME="M12 Test Job $M12_S_TAG"
M12_S_QUOTE="M12Q$M12_S_TAG"
M12_S_SUPPLIER="M12 Stone Supplier $M12_S_TAG"
M12_S_BRAND="M12 Stone Brand $M12_S_TAG"
M12_S_STALE="2000-01-01T00:00:00.000Z"

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
# Today as the refusals write a date ("15 Oct 2026").
M12_S_TODAY_LABEL=$(LC_ALL=C date -u -d "$M12_S_TODAY" '+%-d %b %Y')
M12_S_PROMISED=$(m12_s_day +30)
M12_S_REQ=$(m12_s_day +3)

m12_s_me "$DPM"
M12_S_DPM_ID=$M12_S_ID
M12_S_DPM_NAME=$M12_S_NAME

# m12_s_audit_count ACTION ORDER: sets M12_S_N to the number of ACTION audit rows for that order.
m12_s_audit_count() {
  req GET "/api/audit?action=$1&entityType=stone_order&entityId=$2&limit=200" "$ADMIN"
  expect_status 200 "the order's $1 rows"
  M12_S_N=$(jqr '.rows | length')
}

# m12_s_sum DRAFTS CHANGED SOON WHAT: the Design/PM summary has changed by exactly these amounts
# since the start reading (M12_S_D0, M12_S_C0, M12_S_I0).
m12_s_sum() {
  req GET /api/stone/summary "$DPM"
  expect_status 200 "the summary after $4"
  expect_jq ".date == \"$M12_S_TODAY\" and .drafts == $((M12_S_D0 + $1)) and .changed == $((M12_S_C0 + $2)) and .installsSoon == $((M12_S_I0 + $3))" \
    "after $4: drafts +$1, changed +$2, installs soon +$3 (start $M12_S_D0/$M12_S_C0/$M12_S_I0)"
}

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
req GET /api/stone/summary "$WSMGR"
expect_status 403 "wsmgr GET /api/stone/summary"
req GET /api/stone/summary "$DPM"
expect_status 200 "dpm GET /api/stone/summary"
expect_jq ".date == \"$M12_S_TODAY\" and (.drafts | type) == \"number\" and (.changed | type) == \"number\" and (.installsSoon | type) == \"number\"" \
  "the start reading of the summary"
M12_S_D0=$(jqr '.drafts')
M12_S_C0=$(jqr '.changed')
M12_S_I0=$(jqr '.installsSoon')

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
m12_s_sum 1 0 0 "a new draft"
req POST "/api/job-records/$M12_S_JOB/stone" "$DPM" '{"supplier":""}'
expect_status 201 "dpm starts a second order with supplier empty"
M12_S_O2=$(jqr '.id')
expect_jq ".form.supplier == \"\" and .form.jobReference == \"$M12_S_JOB_NAME\" and .form.quoteNumber == \"$M12_S_QUOTE\" and .form.clientName == \"M12 Test Client\"" \
  "supplier stays empty, the rest prefilled"
m12_s_sum 2 0 0 "a second draft"
req POST "/api/job-records/$M12_S_JOB/stone" "$ORDR" '{}'
expect_status 403 "ordr starts a stone order"
req GET "/api/job-records/$M12_S_JOB/stone" "$ACCT"
expect_status 200 "acct GET the job's stone orders"
expect_jq "(.orders | length) == 2 and .orders[0].id == $M12_S_O1 and .orders[1].id == $M12_S_O2 and .job.benchtop == \"stone\" and .job.archived == false and .benchtopText == [] and (.prefill | type) == \"object\"" \
  "both orders, the job, the prefill and no benchtop text yet"
req GET "/api/job-records/$M12_S_JOB/stone" "$WSMGR"
expect_status 403 "wsmgr GET the job's stone orders"

echo "--- the benchtop text from a Joinr intake record ---"
# A 250-character entry: "M12 long room " (14) and 236 x's. The list cut to 200 keeps 186 x's.
M12_S_LONG="M12 long room $(printf 'x%.0s' $(seq 1 236))"
M12_S_CUT="M12 long room $(printf 'x%.0s' $(seq 1 186))"
expect_eq "${#M12_S_LONG}/${#M12_S_CUT}" "250/200" "the long entry is 250 characters, cut to 200"
M12_S_ROOT="m12-stone-$M12_S_TAG"
M12_S_PAYLOAD=$(jq -nc --arg r "$M12_S_ROOT" --arg q "$M12_S_QUOTE" --arg l "$M12_S_LONG" \
  '{rootQuoteId:$r, quoteId:$r, quoteNumber:$q, clientName:"M12 Test Client",
    raw:{benchtops:["M12 Kitchen 20 mm stone", "", $l, "  M12 Kitchen 20 mm stone  ", "   ", 7, "M12 Laundry 40 mm stone", "M12 Kitchen 20 mm stone"]}}')
M12_S_INTAKE=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
const [root, job, payload] = process.argv.slice(1);
const info = d.prepare(
  "INSERT INTO joinr_intake (root_quote_id, quote_id, joinr_status, last_event, payload, state, job_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
).run(root, root, "won", "won", payload, "accepted", Number(job));
console.log(String(info.lastInsertRowid));
d.close();' "$M12_S_ROOT" "$M12_S_JOB" "$M12_S_PAYLOAD" | tr -d '\r') \
  || fail "inserting the joinr_intake row failed: ${M12_S_INTAKE:-}"
[ -n "$M12_S_INTAKE" ] || fail "inserting the joinr_intake row gave no id"
ok
M12_S_TEXT="[\"M12 Kitchen 20 mm stone\", \"$M12_S_CUT\", \"M12 Laundry 40 mm stone\"]"
req GET "/api/job-records/$M12_S_JOB/stone" "$ACCT"
expect_status 200 "acct GET the job's stone orders (with the intake record)"
expect_jq ".benchtopText == $M12_S_TEXT" "the cleaned list: order kept, duplicate and blank dropped, the long one cut to 200"
req GET "/api/job-records/$M12_S_JOB/benchtop-sheet" "$ACCT"
expect_status 200 "acct GET the benchtop sheet (with the intake record)"
expect_jq ".benchtopText == $M12_S_TEXT" "the benchtop sheet has the same cleaned list"

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
req GET "/api/audit?action=stone.update&entityType=stone_order&entityId=$M12_S_O1&limit=200" "$ADMIN"
expect_status 200 "the order's stone.update rows"
expect_jq "[.rows[] | select(.after.supplier == \"$M12_S_SUPPLIER\")] | length == 1" "one stone.update row for the edit"
expect_jq "[.rows[] | select(.after.supplier == \"$M12_S_SUPPLIER\")][0] | (.before | keys) == [\"measureDate\",\"siteAccess\",\"supplier\"] and (.after | keys) == [\"measureDate\",\"siteAccess\",\"supplier\"] and .before.supplier == \"\" and .before.siteAccess == \"\" and .before.measureDate == null and .after.siteAccess == \"Side gate\"" \
  "stone.update before/after hold only the changed keys"

echo "--- send ---"
req POST "/api/stone/$M12_S_O1/send" "$DPM" '{}'
expect_status 400 "send with the stone brand and colour empty"
expect_jq '(.error | startswith("Fill in before sending: ")) and (.error | contains("Stone brand")) and (.error | contains("Colour"))' \
  "the refusal names them"
req PATCH "/api/stone/$M12_S_O1" "$DPM" \
  "$(jq -nc --arg b "$M12_S_BRAND" --arg r "$M12_S_REQ" '{brand:$b,colour:"M12 Grey",edgeHeight:"20 mm",edgeProfile:"Aris",requestedInstallDate:$r}')"
expect_status 200 "dpm fills the needed fields"
M12_S_UPD=$(jqr '.updatedAt')
m12_s_sum 2 0 1 "a draft with an install in 3 days"
req POST "/api/stone/$M12_S_O1/send" "$DPM" '{"bogus":1}'
expect_status 400 "an unknown key on send"
expect_jq '.error == "Unknown field: bogus"' "the unknown key on send is named"
req POST "/api/stone/$M12_S_O1/send" "$DPM" '{"expectUpdatedAt":123}'
expect_status 400 "a non-string expectUpdatedAt"
expect_jq '.error == "expectUpdatedAt must be text"' "the expectUpdatedAt sentence"
req POST "/api/stone/$M12_S_O1/send" "$DPM" "$(jq -nc --arg u "$M12_S_STALE" --arg d "$(m12_s_day +1)" '{expectUpdatedAt:$u,sentDate:$d}')"
expect_status 409 "send with a stale expectUpdatedAt (and a future date: the stale copy is checked first)"
expect_jq '.error == "This stone order was changed by someone else"' "the stale-copy sentence"
req GET "/api/stone/$M12_S_O1" "$DPM"
expect_status 200 "dpm reads the order after the stale send"
expect_jq ".status == \"draft\" and .revision == 0 and (.revisions | length) == 0 and .updatedAt == \"$M12_S_UPD\"" \
  "the stale send wrote nothing"
req POST "/api/stone/$M12_S_O1/send" "$DPM" "$(jq -nc --arg d "$(m12_s_day +1)" '{sentDate:$d}')"
expect_status 400 "a sent date in the future"
expect_jq '.error == "The sent date can'"'"'t be in the future"' "the future sentence"
req POST "/api/stone/$M12_S_O1/send" "$DPM" "$(jq -nc --arg d "$(m12_s_day -1)" '{sentDate:$d}')"
expect_status 400 "a first sent date before the order was started"
expect_jq ".error == \"The sent date can't be before the order was started ($M12_S_TODAY_LABEL)\"" "the before-started sentence"
req POST "/api/stone/$M12_S_O1/send" "$DPM" "$(jq -nc --arg u "$M12_S_UPD" '{expectUpdatedAt:$u}')"
expect_status 200 "dpm sends the order with the right expectUpdatedAt"
expect_jq ".status == \"sent\" and .revision == 1 and .sentDate == \"$M12_S_TODAY\" and (.revisions | length) == 1 and .sentBy.id == $M12_S_DPM_ID and .changedSinceSent == false" \
  "sent, revision 1, today"
m12_s_sum 1 0 0 "the send (a sent, unchanged order adds nothing to installs soon)"
req POST "/api/stone/$M12_S_O1/send" "$DPM" '{}'
expect_status 409 "send again with nothing changed"
expect_jq '.error == "Nothing has changed since revision 1 was sent"' "the unchanged sentence"
req PATCH "/api/stone/$M12_S_O1" "$DPM" '{"colour":"M12 White","edgeHeight":"20 mm"}'
expect_status 200 "dpm changes the colour (edge height sent unchanged)"
expect_jq '.changedSinceSent == true and .status == "sent" and .revision == 1' "changed since sent, still sent"
m12_s_sum 1 1 1 "a change after sending"
req GET "/api/audit?action=stone.update&entityType=stone_order&entityId=$M12_S_O1&limit=200" "$ADMIN"
expect_status 200 "the order's stone.update rows"
expect_jq '[.rows[] | select(.after.colour == "M12 White")] | length == 1' "one stone.update row for the colour change"
expect_jq '[.rows[] | select(.after.colour == "M12 White")][0] | (.before | keys) == ["colour"] and (.after | keys) == ["colour"] and .before.colour == "M12 Grey"' \
  "the colour change's before/after hold only the colour"
req POST "/api/stone/$M12_S_O1/send" "$DPM" "$(jq -nc --arg d "$(m12_s_day -1)" '{sentDate:$d}')"
expect_status 400 "a sent date before revision 1's"
expect_jq ".error == \"The sent date can't be before revision 1 ($M12_S_TODAY_LABEL)\"" "the before-revision sentence"
req POST "/api/stone/$M12_S_O1/send" "$DPM" "$(jq -nc --arg d "$M12_S_TODAY" '{sentDate:$d}')"
expect_status 200 "dpm sends revision 2"
expect_jq '.revision == 2 and (.revisions | length) == 2 and .changedSinceSent == false' "revision 2"
M12_S_UPD=$(jqr '.updatedAt')
m12_s_sum 1 0 0 "sending again"
req GET "/api/stone/$M12_S_O1/revisions/1" "$ACCT"
expect_status 200 "acct reads revision 1"
expect_jq ".revision == 1 and .orderId == $M12_S_O1 and .status == \"sent\" and .form.colour == \"M12 Grey\" and .sentDate == \"$M12_S_TODAY\"" \
  "revision 1 has the old colour and the order's status"
req GET "/api/stone/$M12_S_O1/revisions/3" "$ACCT"
expect_status 404 "revision 3"
req GET "/api/stone/$M12_S_O1" "$ACCT"
expect_status 200 "acct reads the order"
expect_jq '(.business | keys) == ["address","email","legalName","phone","tradingName"] and (.business | has("abn") | not)' \
  "business has the five keys and no abn"

echo "--- a PATCH that changes nothing ---"
m12_s_audit_count stone.update "$M12_S_O1"
M12_S_UPDATES=$M12_S_N
req PATCH "/api/stone/$M12_S_O1" "$DPM" '{"colour":"M12 White","siteAccess":"Side gate"}'
expect_status 200 "dpm PATCHes the same values"
expect_jq ".updatedAt == \"$M12_S_UPD\" and .changedSinceSent == false and .revision == 2" "nothing changed on the order"
m12_s_audit_count stone.update "$M12_S_O1"
expect_eq "$M12_S_N" "$M12_S_UPDATES" "a PATCH changing nothing writes no stone.update row"

echo "--- summary and list ---"
m12_s_sum 1 0 0 "the sends (the other order is still a draft)"
req GET /api/stone "$ORDR"
expect_status 200 "ordr GET the open list"
expect_jq "[.orders[] | select(.id == $M12_S_O1 and .status == \"sent\")] | length == 1" "the sent order is listed"
expect_jq "[.orders[] | select(.id == $M12_S_O2 and .status == \"draft\")] | length == 1" "the draft is listed"
req GET /api/stone "$DPM"
expect_status 200 "dpm GET the open list"
expect_jq "[.orders[] | select(.id == $M12_S_O1)][0].form | .clientName == \"M12 Test Client\" and .clientPhone == \"0400 000 012\" and .siteAddress == \"1 Made Up Street, Nowhere\" and .siteAccess == \"Side gate\"" \
  "with jobs.view the list's form has the client and address details"
req GET "/api/stone?status=bogus" "$ORDR"
expect_status 400 "status=bogus"

echo "--- cancel and restore ---"
req POST "/api/stone/$M12_S_O1/cancel" "$DPM" '{"reason":"M12"}'
expect_status 400 "an unknown key on cancel"
expect_jq '.error == "Unknown field: reason"' "the unknown key on cancel is named"
req POST "/api/stone/$M12_S_O1/cancel" "$DPM" '{}'
expect_status 200 "dpm cancels the order"
expect_jq ".status == \"cancelled\" and .cancelledBy.id == $M12_S_DPM_ID" "cancelled"
m12_s_sum 1 0 0 "cancelling a sent, unchanged order"
req GET /api/stone "$ORDR"
expect_status 200 "the open list"
expect_jq "[.orders[] | select(.id == $M12_S_O1)] | length == 0" "a cancelled order is not open"
req GET "/api/stone?status=cancelled" "$ORDR"
expect_status 200 "the cancelled list"
expect_jq "[.orders[] | select(.id == $M12_S_O1)] | length == 1" "it is in the cancelled list"
req GET "/api/stone/$M12_S_O1/revisions/1" "$ACCT"
expect_status 200 "acct reads revision 1 of the cancelled order"
expect_jq '.revision == 1 and .status == "cancelled"' "the revision carries the order's status now: cancelled"
req PATCH "/api/stone/$M12_S_O1" "$DPM" '{"notes":"M12 nope"}'
expect_status 409 "editing a cancelled order"
expect_jq '.error == "This stone order is cancelled"' "the cancelled sentence"
req POST "/api/stone/$M12_S_O1/send" "$DPM" '{}'
expect_status 409 "sending a cancelled order"
expect_jq '.error == "This stone order is cancelled"' "the cancelled sentence on send"
req POST "/api/stone/$M12_S_O1/cancel" "$DPM" '{}'
expect_status 409 "cancelling it again"
expect_jq '.error == "This stone order is already cancelled"' "the already-cancelled sentence"
req POST "/api/stone/$M12_S_O1/restore" "$DPM" '{"bogus":1}'
expect_status 400 "an unknown key on restore"
expect_jq '.error == "Unknown field: bogus"' "the unknown key on restore is named"
req POST "/api/stone/$M12_S_O1/restore" "$DPM" '{}'
expect_status 200 "dpm restores the order"
expect_jq '.status == "sent" and .revision == 2 and .cancelledAt == null' "back to sent, revision 2"
req POST "/api/stone/$M12_S_O2/restore" "$DPM" '{}'
expect_status 409 "restoring an order that isn't cancelled"
expect_jq '.error == "Only a cancelled stone order can be restored"' "the restore sentence"

echo "--- a never-sent order ---"
req POST "/api/job-records/$M12_S_JOB/stone" "$DPM" "$(jq -nc --arg r "$(m12_s_day +5)" '{requestedInstallDate:$r}')"
expect_status 201 "dpm starts a third order with an install in 5 days"
M12_S_O3=$(jqr '.id')
m12_s_sum 2 0 1 "a third draft with an install soon"
req POST "/api/stone/$M12_S_O3/cancel" "$DPM"
expect_status 200 "dpm cancels the never-sent order (no body)"
expect_jq '.status == "cancelled" and .revision == 0' "cancelled, never sent"
m12_s_sum 1 0 0 "cancelling the draft"
req POST "/api/stone/$M12_S_O3/restore" "$DPM" '{}'
expect_status 200 "dpm restores the never-sent order"
expect_jq '.status == "draft" and .revision == 0 and .cancelledAt == null and .cancelledBy == null' "a never-sent order restores to draft"
m12_s_sum 2 0 1 "restoring the draft"

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
expect_jq 'has("materialsOrderedDate") and .materialsOrderedDate == null' "materials ordered is still empty"

echo "--- an archived job ---"
req PATCH "/api/job-records/$M12_S_JOB" "$ADMIN" '{"archived":true}'
expect_status 200 "admin archives the job"
m12_s_sum 0 0 0 "archiving the job (its orders are no longer open)"
req POST "/api/job-records/$M12_S_JOB/stone" "$DPM" '{}'
expect_status 409 "a new stone order on an archived job"
expect_jq '.error == "The job is archived"' "the archived sentence"
req PATCH "/api/stone/$M12_S_O1" "$DPM" '{"notes":"M12 nope"}'
expect_status 409 "editing an order on an archived job"
expect_jq '.error == "The job is archived"' "the archived sentence on edit"
req POST "/api/stone/$M12_S_O1/cancel" "$DPM" '{}'
expect_status 200 "cancelling an order on an archived job"
req POST "/api/stone/$M12_S_O1/restore" "$DPM" '{}'
expect_status 409 "restoring an order on an archived job"
expect_jq '.error == "The job is archived"' "the archived sentence on restore"

echo "--- audit ---"
for M12_S_ACTION in stone.create stone.update stone.send stone.cancel stone.restore; do
  req GET "/api/audit?action=$M12_S_ACTION&entityType=stone_order&entityId=$M12_S_O1&limit=50" "$ADMIN"
  expect_status 200 "the order's $M12_S_ACTION rows"
  expect_jq "[.rows[] | select(.action == \"$M12_S_ACTION\")] | length >= 1" "a $M12_S_ACTION row for the order"
done
req GET "/api/audit?action=stone.send&entityType=stone_order&entityId=$M12_S_O1&limit=50" "$ADMIN"
expect_jq "[.rows[] | select(.after.revision == 2 and .after.sentDate == \"$M12_S_TODAY\")] | length == 1" \
  "the send row carries the revision and sent date"
m12_s_audit_count stone.send "$M12_S_O1"
expect_eq "$M12_S_N" "2" "two stone.send rows: the refused sends wrote none"

echo "M12 stone orders smoke test passed."
