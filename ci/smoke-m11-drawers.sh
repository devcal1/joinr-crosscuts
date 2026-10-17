# M11 smoke, Wave 1 A: drawers (a job's drawer grid, the Drawer order page, placing and undoing,
# the drawer name list) and the Joinr `drawers` field.
# Sourced by ci/smoke.sh after the M10 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok), the cookie jars ($ADMIN $SCHED $ACCT $DPM
# $SHOW $WSHOP $ORDR $WSMGR) and $CONTAINER. No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: its jobs and Joinr quotes carry a run tag, it removes its
# own drawer names before adding them, and it places whatever the Drawer order page shows (other
# runs' checked lines included), checking only its own rows. Made-up names only (this repo is
# public). Contract: docs/plans/m11-contracts.md sections 4, 6.1, 6.2 and 12.2.
#
# A stand-in Joinr (ci/fake-joinr.js) runs inside the container on 127.0.0.1:4996 (the M6 suite's
# runs on 4999 and is stopped by then). Crosscuts is pointed at it through files in /data/config,
# removed at the end. Quotes are pulled with the import (backfill), which doesn't depend on the
# stored sync position.

# ============================================================================
step "m11-drawers. drawer grids, the Drawer order page and the Joinr drawer lines"
# ============================================================================

M11_DW_TAG=$(date +%s)
M11_DW_SUPPLIER="M11 Drawer Supplier"
M11_DW_PORT=4996
M11_DW_KEY='ci-joinr-m11-drawers-key-3c9e1a7b'
M11_DW_MID="M11 Drawer Mid 500"
M11_DW_UNKNOWN="M11 Unknown"

# m11dw_day N: today (the server's) plus N days, as YYYY-MM-DD.
m11dw_day() {
  date -u -d "$M11_DW_TODAY $1 day" +%F
}

# m11dw_me JAR: sets M11_DW_ID to that user's id.
m11dw_me() {
  req GET /api/auth/me "$1"
  expect_status 200 "GET /api/auth/me"
  M11_DW_ID=$(jqr '.user.id')
}

# m11dw_job NAME [extra JSON fields]: admin makes a job -> M11_DW_JOB.
m11dw_job() {
  req POST /api/job-records "$ADMIN" "{\"name\":\"$1\",\"clientName\":\"M11 Test Client\"${2:+,$2}}"
  expect_status 201 "admin makes job $1"
  M11_DW_JOB=$(jqr '.id')
}

# m11dw_line JOB_ID: the job's drawer lines (dpm) into BODY.
m11dw_lines() {
  req GET "/api/job-records/$1/drawers" "$DPM"
  expect_status 200 "dpm GET the drawer lines of job $1"
}

# m11dw_order LINE: the order line (status all, by its job) into M11_DW_OUT.
m11dw_order() { # LINE JOB
  req GET "/api/orders?status=all&jobId=$2" "$ORDR"
  expect_status 200 "ordr lists job $2's lines"
  M11_DW_OUT=$(printf '%s' "$BODY" | jq -c "[.[] | select(.id == $1)][0]")
}

# m11dw_notifs JAR KIND TITLE: sets M11_DW_N to how many KIND notifications with TITLE the user has.
m11dw_notifs() {
  req GET "/api/notifications?limit=100" "$1"
  expect_status 200 "GET /api/notifications"
  M11_DW_N=$(jqr "[.rows[] | select(.kind == \"$2\" and .title == \"$3\")] | length")
}

# m11dw_board: ordr reads the EDGE tab into BODY, and its order ids into M11_DW_IDS (a JSON list).
m11dw_board() {
  req GET "/api/drawers?brand=edge" "$ORDR"
  expect_status 200 "ordr GET /api/drawers?brand=edge"
  M11_DW_IDS=$(printf '%s' "$BODY" | jq -c '[.rows[].orderId]')
  M11_DW_SK=$(jqr '.sheetKey')
}

# m11dw_fake METHOD PATH [json] -> M11_DW_OUT (the stand-in's response body), inside the container.
m11dw_fake() {
  M11_DW_OUT=$(docker exec "$CONTAINER" node -e '
const [port, m, p, b] = process.argv.slice(1);
fetch("http://127.0.0.1:" + port + p, { method: m, headers: { "content-type": "application/json" }, body: b || undefined })
  .then(async (r) => { process.stdout.write(await r.text()); if (!r.ok) process.exit(1); })
  .catch((e) => { console.error(String(e)); process.exit(1); });' "$M11_DW_PORT" "$1" "$2" "${3:-}") \
    || fail "fake joinr $1 $2 failed: ${M11_DW_OUT:0:300}"
}

# m11dw_sql SQL -> prints the rows as JSON (read-only connection).
m11dw_sql() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const db = new D("/data/db/photos.db", { readonly: true });
process.stdout.write(JSON.stringify(db.prepare(process.argv[1]).all()));' "$1"
}

m11dw_intake() { # ROOT FIELD -> the field of that intake record ("null" if none)
  m11dw_sql "SELECT $2 AS v FROM joinr_intake WHERE root_quote_id = '$1'" | jq -r '.[0].v // "null"'
}

# m11dw_quote ROOT QUOTE_NO SITE [jq filter]: appends a won item to the stand-in (fixed wonAt, so
# a repeat is identical).
m11dw_quote() {
  m11dw_fake POST /_control/event "$(jq -nc --arg r "$1" --arg q "$2" --arg s "$3" \
    '{rootQuoteId: $r, quoteId: $r, quoteNumber: $q, siteAddress: $s, clientName: "M11 Test Client",
      wonAt: "2099-06-01T01:00:00Z", updatedAt: "2099-06-01T01:00:00Z"}' | jq -c "${4:-.}")"
}

# m11dw_import WHAT: admin imports every currently won quote from the stand-in.
m11dw_import() {
  req POST /api/joinr/import "$ADMIN" '{}'
  expect_status 200 "admin imports ($1)"
  expect_jq '.ok == true' "the import is ok ($1)"
}

# m11dw_root N: this run's Joinr quote id number N (a uuid made of digits).
m11dw_root() {
  printf 'c11d%04d-0000-4000-8000-%012d' "$1" "$M11_DW_TAG"
}

# A won quote becomes a job by itself on a sync or import (2026-10-18). To test the hand buttons
# (Accept, Link) a quote must be left waiting for a person, so the suite first makes a job that
# already holds the quote's root id: the automatic step then fails and the row stays `new`.
# m11dw_hold N makes that job; m11dw_release N lets go of the root id before the hand decision.
m11dw_hold() { # N
  req POST /api/job-records "$ADMIN" "$(jq -nc --arg n "M11 hold $1 $M11_DW_TAG" --arg r "$(m11dw_root "$1")" '{name: $n, externalRef: $r}')"
  expect_status 201 "a job holding quote $1's root id (keeps it for a person)"
  eval "M11_DW_HOLD_$1=$(jqr '.id')"
}
m11dw_release() { # N
  local h
  eval "h=\$M11_DW_HOLD_$1"
  req PATCH "/api/job-records/$h" "$ADMIN" '{"externalRef":null}'
  expect_status 200 "the holding job lets go of quote $1's root id"
}

# m11dw_unname NAME: removes NAME from the drawer name list if an earlier run left it there.
m11dw_unname() {
  req GET /api/drawers/names "$ORDR"
  expect_status 200 "ordr GET /api/drawers/names"
  local id
  for id in $(jqr ".names[] | select((.name | ascii_downcase) == (\"$1\" | ascii_downcase)) | .id"); do
    req DELETE "/api/drawers/names/$id" "$ORDR"
    expect_status 200 "ordr removes an earlier run's name $1"
  done
}

# Today is the server's (Sydney) date, as the M10 suite reads it.
req GET /api/orders/deliveries "$ADMIN"
expect_status 200 "admin reads the server's today"
M11_DW_TODAY=$(jqr '.date')
M11_DW_LATER=$(m11dw_day +3)
m11dw_me "$DPM"; M11_DW_DPM_ID=$M11_DW_ID
m11dw_me "$WSMGR"; M11_DW_WSMGR_ID=$M11_DW_ID

echo "--- access ---"
req GET /drawers.html "$ORDR"
expect_status 200 "ordr GET /drawers.html"
req GET /drawers.html "$WSMGR"
expect_status 403 "wsmgr GET /drawers.html"
req GET /drawers.html "$DPM"
expect_status 403 "dpm GET /drawers.html"
req GET "/api/drawers?brand=edge" "$ORDR"
expect_status 200 "ordr GET /api/drawers?brand=edge"
req GET "/api/drawers?brand=edge" "$WSMGR"
expect_status 403 "wsmgr GET /api/drawers?brand=edge"
req GET "/api/drawers?brand=oak" "$ORDR"
expect_status 400 "an unknown brand"
req GET /api/drawers/names "$DPM"
expect_status 403 "dpm GET /api/drawers/names"
req GET /api/drawers/settings "$WSMGR"
expect_status 403 "wsmgr GET /api/drawers/settings"

echo "--- settings and the drawer name list ---"
req PUT /api/drawers/settings "$ORDR" "{\"supplierEdge\":\"$M11_DW_SUPPLIER\"}"
expect_status 200 "ordr sets the EDGE supplier"
expect_jq ".supplierEdge == \"$M11_DW_SUPPLIER\" and (.supplierDtc | type) == \"string\"" "the settings answer both names"
req PUT /api/drawers/settings "$ORDR" '{"supplierDtc":"  "}'
expect_status 400 "an empty supplier name"
m11dw_unname "$M11_DW_MID"
m11dw_unname "$M11_DW_UNKNOWN"
req POST /api/drawers/names "$ORDR" "{\"name\":\"$M11_DW_MID\",\"brand\":\"edge\",\"height\":126,\"length\":500}"
expect_status 201 "ordr adds a drawer name"
expect_jq ".name == \"$M11_DW_MID\" and .brand == \"edge\" and .height == 126 and .length == 500 and .ignored == false" "the name maps to EDGE Mid 126/500"
M11_DW_NAME_ID=$(jqr '.id')
req POST /api/drawers/names "$DPM" '{"name":"M11 Drawer Dpm","ignored":true}'
expect_status 403 "dpm adds a drawer name"
req POST /api/drawers/names "$ORDR" "{\"name\":\"  m11 drawer   MID 500 \",\"ignored\":true}"
expect_status 409 "the same name again (case and spaces aside)"
expect_jq '.error == "That name is already on the list"' "and says so"
req POST /api/drawers/names "$ORDR" '{"name":"M11 Drawer Odd","brand":"edge","height":127,"length":500}'
expect_status 400 "a DTC height on an EDGE name"
req POST /api/drawers/names "$ORDR" "{\"name\":\"M11 Drawer Runner $M11_DW_TAG\",\"ignored\":true}"
expect_status 201 "ordr adds an ignored name"
M11_DW_IGN_ID=$(jqr '.id')
expect_jq '.ignored == true and .brand == null and .height == null' "an ignored name has no size"
req PATCH "/api/drawers/names/$M11_DW_IGN_ID" "$ORDR" '{"brand":"dtc","height":178,"length":450}'
expect_status 200 "ordr maps the ignored name to a size"
expect_jq '.ignored == false and .brand == "dtc" and .height == 178 and .length == 450' "it maps to DTC 178/450"
req DELETE "/api/drawers/names/$M11_DW_IGN_ID" "$ORDR"
expect_status 200 "ordr removes it"
req DELETE "/api/drawers/names/$M11_DW_IGN_ID" "$ORDR"
expect_status 404 "removing it again"

echo "--- a manual grid ---"
m11dw_job "M11 Drawer Job A $M11_DW_TAG" '"valueCents":2000000'
M11_DW_JA=$M11_DW_JOB
req POST "/api/job-records/$M11_DW_JA/drawers" "$DPM" \
  '{"brand":"edge","counts":[{"height":174,"length":500,"qty":4},{"height":126,"length":500,"qty":6}],"notes":"M11 soft close"}'
expect_status 201 "dpm adds an EDGE grid"
M11_DW_LA=$(jqr '.order.id')
expect_jq ".order.kind == \"drawers\" and .order.status == \"to_order\" and .order.supplier == \"$M11_DW_SUPPLIER\" and .order.notes == \"M11 soft close\"" \
  "an ordinary to_order line with the EDGE supplier"
expect_jq '.order.description | test("^Drawers [(]EDGE[)]: 6 . Mid 126/500, 4 . High 174/500$")' "the description comes from the counts, in size order"
expect_jq '.order.drawers.brand == "edge" and .order.drawers.source == "manual" and .order.drawers.checked == null and .order.drawers.drawerOrderId == null' \
  "a manual, unchecked EDGE line"
expect_jq '.order.counts == [{"height":126,"length":500,"qty":6},{"height":174,"length":500,"qty":4}] and .order.joinrLines == null' "the counts in size order"
req POST "/api/job-records/$M11_DW_JA/drawers" "$ORDR" '{"brand":"edge","counts":[{"height":93,"length":300,"qty":1}]}'
expect_status 409 "a second EDGE line on the job"
expect_jq '.error == "This job already has an EDGE drawer line waiting to be ordered"' "and says so"
req POST "/api/job-records/$M11_DW_JA/drawers" "$WSMGR" '{"brand":"dtc","counts":[{"height":95,"length":300,"qty":1}]}'
expect_status 403 "wsmgr adds a grid"
req PUT "/api/orders/$M11_DW_LA/drawers" "$ORDR" '{"counts":[{"height":126,"length":500,"qty":7},{"height":174,"length":500,"qty":4}]}'
expect_status 200 "ordr edits the counts"
expect_jq '.order.drawers.checked == null and (.order.description | test("7 . Mid 126/500"))' "the line stays unchecked; the description follows"
req PUT "/api/orders/$M11_DW_LA/drawers" "$ORDR" '{"counts":[{"height":126,"length":500,"qty":7}],"checked":true}'
expect_status 403 "ordr checks the grid (jobs.edit only)"
req POST "/api/orders/$M11_DW_LA/drawers/check" "$ORDR" '{}'
expect_status 403 "ordr POST check"
req POST "/api/orders/$M11_DW_LA/drawers/check" "$DPM" '{}'
expect_status 200 "dpm checks the grid"
expect_jq ".order.drawers.checked.by.id == $M11_DW_DPM_ID and (.order.drawers.checked.at | type) == \"string\"" "checked by dpm"
req PUT "/api/orders/$M11_DW_LA/drawers" "$DPM" '{"counts":[{"height":130,"length":500,"qty":1}]}'
expect_status 400 "a height that isn't EDGE's"
req PUT "/api/orders/$M11_DW_LA/drawers" "$DPM" '{"counts":[{"height":126,"length":500,"qty":1},{"height":126,"length":500,"qty":2}]}'
expect_status 400 "the same cell twice"
req PUT "/api/orders/$M11_DW_LA/drawers" "$DPM" '{"counts":[{"height":126,"length":500,"qty":1000}]}'
expect_status 400 "a count over 999"
req PUT "/api/orders/$M11_DW_LA/drawers" "$DPM" '{"counts":[]}'
expect_status 400 "no counts"
expect_jq '.error == "Add at least one drawer, or cancel the line"' "and says what to do"
req PATCH "/api/orders/$M11_DW_LA" "$ORDR" '{"status":"ordered"}'
expect_status 409 "a plain Mark ordered on a drawer line"
expect_jq '.error == "Drawer lines are ordered from the Drawer order page"' "and says where"
req PATCH "/api/orders/$M11_DW_LA" "$ORDR" '{"supplier":"M11 Other Supplier"}'
expect_status 409 "a plain supplier change on a drawer line"
expect_jq '.error == "The drawer grid sets this line; change the grid"' "and says why"
req PATCH "/api/orders/$M11_DW_LA" "$ORDR" '{"notes":"M11 soft close, grey"}'
expect_status 200 "a plain notes change is allowed"
expect_jq '.order.notes == "M11 soft close, grey" and .order.drawers.checked != null' "notes change; the check stays"
m11dw_lines "$M11_DW_JA"
expect_jq "(.lines | length) == 1 and .lines[0].id == $M11_DW_LA and (.lines[0].counts | length) == 2 and .joinr == null" \
  "the job has one drawer line, and no Joinr record"
req GET "/api/job-records/$M11_DW_JA/drawers" "$WSMGR"
expect_status 403 "wsmgr GET a job's drawer lines (jobs.view)"

m11dw_job "M11 Drawer Job B $M11_DW_TAG"
M11_DW_JB=$M11_DW_JOB
req POST "/api/job-records/$M11_DW_JB/drawers" "$ORDR" '{"brand":"edge","counts":[{"height":238,"length":600,"qty":2}]}'
expect_status 201 "ordr adds an EDGE grid to job B (left unchecked)"
M11_DW_LB=$(jqr '.order.id')

echo "--- the Drawer order page ---"
req PUT /api/drawers/stock "$ORDR" '{"brand":"edge","counts":[{"height":93,"length":450,"qty":2}]}'
expect_status 200 "ordr saves the stock row"
expect_jq '.stock == [{"height":93,"length":450,"qty":2}]' "the stock row is saved"
req PUT /api/drawers/stock "$WSMGR" '{"brand":"edge","counts":[]}'
expect_status 403 "wsmgr saves the stock row"
m11dw_board
expect_jq ".brand == \"edge\" and .supplier == \"$M11_DW_SUPPLIER\"" "the EDGE tab and its supplier"
expect_jq "any(.rows[]; .orderId == $M11_DW_LA and .jobId == $M11_DW_JA and .jobName == \"M11 Drawer Job A $M11_DW_TAG\" and .total == 11)" \
  "the checked line is a row"
expect_jq "any(.waiting[]; .orderId == $M11_DW_LB) and all(.rows[]; .orderId != $M11_DW_LB)" "the unchecked line is waiting, not a row"
expect_jq '.total == ([.rows[].total] | add) + ([.stock[].qty] | add)' "the grand total is the rows plus the stock row"
expect_jq "any(.totals[]; .height == 93 and .length == 450 and .qty >= 2)" "the totals include the stock row"
req POST /api/drawers/place "$ORDR" "{\"brand\":\"edge\",\"sheetKey\":\"$M11_DW_SK\",\"orderIds\":$(printf '%s' "$M11_DW_IDS" | jq -c ". + [$M11_DW_LB]")}"
expect_status 409 "placing with a line that isn't on the page"
expect_jq '.error == "The drawer order changed while you were looking; reload it"' "and says reload"
req POST /api/drawers/place "$ORDR" "{\"brand\":\"edge\",\"sheetKey\":\"$M11_DW_SK\",\"orderIds\":[]}"
expect_status 409 "placing with a stale (empty) list"
req POST /api/drawers/place "$WSMGR" "{\"brand\":\"edge\",\"sheetKey\":\"$M11_DW_SK\",\"orderIds\":$M11_DW_IDS}"
expect_status 403 "wsmgr places"
req POST /api/drawers/place "$ORDR" "{\"brand\":\"edge\",\"sheetKey\":\"$M11_DW_SK\",\"orderIds\":$M11_DW_IDS,\"orderedDate\":\"$(m11dw_day +1)\"}"
expect_status 400 "an ordered date in the future"
req POST /api/drawers/place "$ORDR" "{\"brand\":\"edge\",\"sheetKey\":\"$M11_DW_SK\",\"orderIds\":$M11_DW_IDS,\"expectedDate\":\"$(m11dw_day -1)\"}"
expect_status 400 "an expected date before the ordered date (section 15 nit)"
expect_jq '.error | test("^The expected date can.t be before it was ordered")' "and says so"
req POST /api/drawers/place "$ORDR" "{\"brand\":\"edge\",\"orderIds\":$M11_DW_IDS}"
expect_status 400 "placing without the sheetKey (section 15.23)"
expect_jq '.error == "sheetKey is required"' "and says it is required"
req POST /api/drawers/place "$ORDR" "{\"brand\":\"edge\",\"sheetKey\":\"0000000000000000\",\"orderIds\":$M11_DW_IDS}"
expect_status 409 "placing with a sheetKey that isn't the sheet's"
expect_jq '.error == "The drawer order changed while you were looking; reload it"' "with the reload sentence"
req PUT /api/drawers/stock "$ORDR" '{"brand":"edge","counts":[{"height":93,"length":450,"qty":3}]}'
expect_status 200 "ordr changes the stock row after the page was read"
req POST /api/drawers/place "$ORDR" "{\"brand\":\"edge\",\"sheetKey\":\"$M11_DW_SK\",\"orderIds\":$M11_DW_IDS}"
expect_status 409 "placing a sheet whose stock row changed, with the same line ids (section 15.23)"
expect_jq '.error == "The drawer order changed while you were looking; reload it"' "stale sheets are refused"
req PUT /api/drawers/stock "$ORDR" '{"brand":"edge","counts":[{"height":93,"length":450,"qty":2}]}'
expect_status 200 "ordr puts the stock row back"
m11dw_board
req POST /api/drawers/place "$ORDR" "{\"brand\":\"edge\",\"sheetKey\":\"$M11_DW_SK\",\"orderIds\":$M11_DW_IDS,\"expectedDate\":\"$M11_DW_LATER\"}"
expect_status 201 "ordr places the EDGE order"
M11_DW_P1=$(jqr '.drawerOrder.id')
expect_jq ".drawerOrder.brand == \"edge\" and .drawerOrder.supplier == \"$M11_DW_SUPPLIER\" and .drawerOrder.orderedDate == \"$M11_DW_TODAY\" and .drawerOrder.expectedDate == \"$M11_DW_LATER\"" \
  "the placed order: brand, supplier, dates"
expect_jq "any(.drawerOrder.grid.rows[]; .orderId == $M11_DW_LA) and .drawerOrder.grid.stock == [{\"height\":93,\"length\":450,\"qty\":2}] and .drawerOrder.stockReceived == null" \
  "the frozen grid holds the line and the stock row"
expect_jq ".drawerOrder.grid.rows[] | select(.orderId == $M11_DW_LA) | .notes == \"M11 soft close, grey\""   "the frozen grid keeps the job's note (section 15.15)"
m11dw_order "$M11_DW_LA" "$M11_DW_JA"
printf '%s' "$M11_DW_OUT" | jq -e ".status == \"ordered\" and .orderedDate == \"$M11_DW_TODAY\" and .expectedDate == \"$M11_DW_LATER\" and .drawers.drawerOrderId == $M11_DW_P1" >/dev/null \
  || fail "the line is ordered today, expected on the date given, linked to the order: $M11_DW_OUT"
ok
req GET "/api/job-records/$M11_DW_JA" "$ADMIN"
expect_jq ".materialsOrderedDate == \"$M11_DW_TODAY\"" "the job's last line ordered sets its materials-ordered date"
req GET "/api/invoices/job/$M11_DW_JA" "$ADMIN"
expect_status 200 "GET /api/invoices/job"
expect_jq '[.[] | select(.kind == "progress" and .status == "due" and .dueReason == "materials_ordered")] | length == 1' \
  "placing the job's last line makes exactly one progress invoice due"
m11dw_board
expect_jq ".stock == [] and all(.rows[]; .orderId != $M11_DW_LA) and any(.waiting[]; .orderId == $M11_DW_LB)" \
  "the stock row is empty; the placed line is gone; the waiting one stays"
req GET "/api/drawers/placed?brand=edge" "$ORDR"
expect_status 200 "ordr lists the placed EDGE orders"
expect_jq ".placed[0].id == $M11_DW_P1 and .placed[0].undoable == true and (.placed[0] | has(\"grid\") | not)" "newest first, without the grid"
req PATCH "/api/orders/$M11_DW_LA" "$ORDR" '{"status":"to_order"}'
expect_status 409 "Undo ordered on a drawer line that is on a placed order (section 15.17)"
expect_jq '.error == "These drawers are on a placed drawer order. Use Undo order on the Drawer order page."' "and points to the Drawer order page"
req PATCH "/api/orders/$M11_DW_LA" "$ADMIN" '{"status":"to_order"}'
expect_status 409 "admin gets the same"
m11dw_order "$M11_DW_LA" "$M11_DW_JA"
printf '%s' "$M11_DW_OUT" | jq -e ".status == \"ordered\" and .drawers.drawerOrderId == $M11_DW_P1" >/dev/null || fail "the line stays ordered and linked: $M11_DW_OUT"
ok
req GET "/api/drawers/placed/$M11_DW_P1" "$WSMGR"
expect_status 403 "wsmgr GET a placed order"
req GET "/api/drawers/placed/$M11_DW_P1" "$ORDR"
expect_status 200 "ordr GET the placed order"
expect_jq "(.grid.rows | map(select(.orderId == $M11_DW_LA)) | .[0].notes) == \"M11 soft close, grey\" and ([.grid.rows[] | select(.orderId != $M11_DW_LA) | has(\"notes\")] | any | not)"   "GET shows the note on its row and none on rows without one"

echo "--- editing a placed drawer line's dates (section 15.14) ---"
M11_DW_YDAY=$(m11dw_day -1)
req PATCH "/api/orders/$M11_DW_LA" "$ORDR" "{\"orderedDate\":\"$M11_DW_YDAY\"}"
expect_status 200 "ordr (mark_ordered) edits the ordered date of a placed drawer line"
expect_jq ".order.orderedDate == \"$M11_DW_YDAY\" and .order.status == \"ordered\"" "the ordered date moved"
req PATCH "/api/orders/$M11_DW_LA" "$ORDR" "{\"receivedDate\":\"$M11_DW_YDAY\"}"
expect_status 409 "a received date on a line not yet received"
req PATCH "/api/orders/$M11_DW_LA" "$ORDR" "{\"supplier\":\"M11 Other Supplier\",\"orderedDate\":\"$M11_DW_TODAY\"}"
expect_status 409 "the supplier stays refused alongside a date"
expect_jq '.error == "The drawer grid sets this line; change the grid"' "with the same sentence"
req PATCH "/api/orders/$M11_DW_LA" "$ORDR" "{\"description\":\"M11 other description\"}"
expect_status 409 "the description stays refused"
req PATCH "/api/orders/$M11_DW_LA" "$WSMGR" "{\"orderedDate\":\"$M11_DW_TODAY\"}"
expect_status 403 "wsmgr (no mark_ordered) edits the ordered date"
req PATCH "/api/orders/$M11_DW_LA" "$SCHED" "{\"orderedDate\":\"$M11_DW_TODAY\"}"
expect_status 403 "sched edits the ordered date"
req PATCH "/api/orders/$M11_DW_LA" "$WSMGR" '{"status":"received"}'
expect_status 200 "wsmgr receives the drawer line"
req PATCH "/api/orders/$M11_DW_LA" "$WSMGR" "{\"receivedDate\":\"$M11_DW_YDAY\"}"
expect_status 200 "wsmgr (orders.receive) edits the received date of a received drawer line"
expect_jq ".order.receivedDate == \"$M11_DW_YDAY\" and .order.status == \"received\"" "the received date moved"
req PATCH "/api/orders/$M11_DW_LA" "$ORDR" "{\"orderedDate\":\"$M11_DW_TODAY\"}"
expect_status 400 "an ordered date after the received date"
req PATCH "/api/orders/$M11_DW_LA" "$WSMGR" '{"status":"ordered"}'
expect_status 200 "wsmgr undoes the receiving"
req PATCH "/api/orders/$M11_DW_LA" "$ORDR" "{\"orderedDate\":\"$M11_DW_TODAY\"}"
expect_status 200 "ordr puts the ordered date back"

echo "--- receiving, and undoing the order ---"
req GET /api/orders/deliveries "$WSMGR"
expect_status 200 "wsmgr GET /api/orders/deliveries"
expect_jq "[.groups[].lines[] | select(.id == $M11_DW_LA)] | length == 1" "the drawer line is on Deliveries"
req PATCH "/api/orders/$M11_DW_LA" "$WSMGR" '{"status":"received"}'
expect_status 200 "wsmgr receives the drawer line"
req POST "/api/drawers/placed/$M11_DW_P1/undo" "$ORDR" '{}'
expect_status 409 "undo with a line received"
expect_jq '.error == "Something on this order has already been received"' "and says why"
req PATCH "/api/orders/$M11_DW_LA" "$WSMGR" '{"status":"ordered"}'
expect_status 200 "wsmgr undoes the receiving"
req POST "/api/drawers/placed/$M11_DW_P1/undo" "$WSMGR" '{}'
expect_status 403 "wsmgr undoes the order"
req POST "/api/drawers/placed/$M11_DW_P1/undo" "$ORDR" '{}'
expect_status 200 "ordr undoes the order"
expect_jq '.undone == true' "undone"
m11dw_order "$M11_DW_LA" "$M11_DW_JA"
printf '%s' "$M11_DW_OUT" | jq -e '.status == "to_order" and .orderedDate == null and .drawers.drawerOrderId == null and .drawers.checked != null' >/dev/null \
  || fail "the line is back to to_order, unlinked, still checked: $M11_DW_OUT"
ok
req GET "/api/drawers/placed/$M11_DW_P1" "$ORDR"
expect_status 404 "the undone order is gone"
m11dw_board
expect_jq ".stock == [{\"height\":93,\"length\":450,\"qty\":2}] and any(.rows[]; .orderId == $M11_DW_LA)" \
  "the stock row is back as the draft; the line is a row again"
req GET "/api/audit?action=drawer_order.undo&entityId=$M11_DW_P1&limit=1" "$ADMIN"
expect_status 200 "GET the undo's audit row"
expect_jq ".total >= 1 and (.rows[0].before.grid.stock | length) == 1" "the undo is audited with the frozen grid (newest first; an id freed by a later undo can be reused)"

echo "--- the stock row's delivery ---"
req POST /api/drawers/place "$ORDR" "{\"brand\":\"edge\",\"sheetKey\":\"$M11_DW_SK\",\"orderIds\":$M11_DW_IDS}"
expect_status 201 "ordr places the EDGE order again"
M11_DW_P2=$(jqr '.drawerOrder.id')
expect_jq '.drawerOrder.expectedDate == null and .drawerOrder.stockTotal == 2' "no expected date this time; two stock drawers"
req GET /api/orders/deliveries "$WSMGR"
expect_status 200 "wsmgr GET /api/orders/deliveries"
expect_jq "any(.stock.items[]; .type == \"drawer_stock\" and .id == $M11_DW_P2 and .label == \"Drawer stock (EDGE)\")" \
  "the stock row waits on Deliveries"
req POST "/api/drawers/placed/$M11_DW_P2/stock-received" "$WSMGR" "{\"receivedDate\":\"$(m11dw_day +1)\"}"
expect_status 400 "a stock delivery in the future"
req POST "/api/drawers/placed/$M11_DW_P2/stock-received" "$SCHED" '{}'
expect_status 403 "sched receives the stock row (no orders.receive)"
req POST "/api/drawers/placed/$M11_DW_P2/stock-received" "$WSMGR" '{"deliveryNote":"  M11 one box short  "}'
expect_status 200 "wsmgr receives the stock row"
expect_jq ".stockReceived.date == \"$M11_DW_TODAY\" and .stockReceived.by.id == $M11_DW_WSMGR_ID and .stockDeliveryNote == \"M11 one box short\" and .undoable == false" \
  "received today by wsmgr, with the note"
req POST "/api/drawers/placed/$M11_DW_P2/stock-received" "$WSMGR" '{}'
expect_status 409 "receiving the stock row twice"
req GET /api/orders/deliveries "$WSMGR"
expect_jq "any(.stock.recent[]; .type == \"drawer_stock\" and .id == $M11_DW_P2) and all(.stock.items[]; .id != $M11_DW_P2)" \
  "the stock row is in recent, no longer waiting"
req POST "/api/drawers/placed/$M11_DW_P2/undo" "$ORDR" '{}'
expect_status 409 "undo once the stock row is received"
req POST "/api/drawers/placed/$M11_DW_P2/stock-received" "$WSMGR" '{"undo":true}'
expect_status 200 "wsmgr undoes the stock delivery"
expect_jq '.stockReceived == null and .stockDeliveryNote == "M11 one box short"' "not received; the note stays"
req POST "/api/drawers/placed/$M11_DW_P2/stock-received" "$WSMGR" '{}'
expect_status 200 "wsmgr receives it again"

echo "--- undoing a stock-only order holds a stock cell at 999 ---"
req PUT /api/drawers/stock "$ORDR" '{"brand":"edge","counts":[{"height":93,"length":450,"qty":5}]}'
expect_status 200 "ordr types a stock row of 5"
m11dw_board
req POST /api/drawers/place "$ORDR" "{\"brand\":\"edge\",\"sheetKey\":\"$M11_DW_SK\",\"orderIds\":$M11_DW_IDS}"
expect_status 201 "ordr places it (the stock row, and whatever else is checked)"
M11_DW_P3=$(jqr '.drawerOrder.id')
req PUT /api/drawers/stock "$ORDR" '{"brand":"edge","counts":[{"height":93,"length":450,"qty":999}]}'
expect_status 200 "ordr types 999 of the same size afterwards"
req POST "/api/drawers/placed/$M11_DW_P3/undo" "$ORDR" '{}'
expect_status 200 "ordr undoes the order"
m11dw_board
expect_jq '[.stock[] | select(.height == 93 and .length == 450)] == [{"height":93,"length":450,"qty":999}]' "the merged cell is held at 999, not 1004"
req PUT /api/drawers/stock "$ORDR" '{"brand":"edge","counts":[]}'
expect_status 200 "ordr clears the stock row"

echo "--- Joinr: start the stand-in ---"
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
docker cp "$(dirname "$0")/fake-joinr.js" "$CONTAINER":/tmp/fake-joinr.js
docker exec -d "$CONTAINER" node /tmp/fake-joinr.js "$M11_DW_PORT" "$M11_DW_KEY"
M11_DW_UP=""
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" node -e 'fetch("http://127.0.0.1:" + process.argv[1] + "/_control/requests").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$M11_DW_PORT" 2>/dev/null; then
    M11_DW_UP=1
    break
  fi
  sleep 0.5
done
[ -n "$M11_DW_UP" ] || fail "the stand-in Joinr did not start"
ok
docker exec "$CONTAINER" sh -c "printf '%s\n' 'http://127.0.0.1:$M11_DW_PORT' > /data/config/joinr-base-url"
docker exec "$CONTAINER" sh -c "printf '%s\n' '$M11_DW_KEY' > /data/config/joinr-api-key"

echo "--- Joinr: accept fills the grid ---"
m11dw_hold 1
m11dw_hold 2
M11_DW_Q1=$(m11dw_root 1)
M11_DW_Q1_SITE="M11 Drawer Site One $M11_DW_TAG"
m11dw_quote "$M11_DW_Q1" "CI-M11-$M11_DW_TAG-1" "$M11_DW_Q1_SITE" \
  ". + {drawers: [{section: \"drawers\", name: \"$M11_DW_MID\", qty: 6}, {section: \"innerDrawers\", name: \"$M11_DW_UNKNOWN\", qty: 2}]}"
M11_DW_Q2=$(m11dw_root 2)
M11_DW_Q2_SITE="M11 Drawer Site Two $M11_DW_TAG"
m11dw_quote "$M11_DW_Q2" "CI-M11-$M11_DW_TAG-2" "$M11_DW_Q2_SITE"
m11dw_import "two quotes"
expect_eq "$(m11dw_intake "$M11_DW_Q1" state)" "new" "quote 1 is new"
expect_eq "$(m11dw_sql "SELECT payload FROM joinr_intake WHERE root_quote_id = '$M11_DW_Q1'" | jq -c '.[0].payload | fromjson | .drawers')" \
  "[{\"section\":\"drawers\",\"name\":\"$M11_DW_MID\",\"qty\":6},{\"section\":\"innerDrawers\",\"name\":\"$M11_DW_UNKNOWN\",\"qty\":2}]" \
  "the stored payload keeps the drawer lines"
expect_eq "$(m11dw_sql "SELECT payload FROM joinr_intake WHERE root_quote_id = '$M11_DW_Q2'" | jq -c '.[0].payload | fromjson | .drawers')" \
  "null" "a quote without drawer lines is stored as not reported"
M11_DW_I1=$(m11dw_intake "$M11_DW_Q1" id)
m11dw_release 1
req POST "/api/joinr/intake/$M11_DW_I1/accept" "$ADMIN" '{}'
expect_status 200 "admin accepts quote 1"
M11_DW_J1=$(jqr '.job.id')
m11dw_lines "$M11_DW_J1"
expect_jq '(.lines | length) == 1 and .lines[0].drawers.brand == "edge" and .lines[0].drawers.source == "joinr" and .lines[0].drawers.checked == null' \
  "accept made one unchecked EDGE line from Joinr"
expect_jq '.lines[0].counts == [{"height":126,"length":500,"qty":6}] and .lines[0].status == "to_order"' "6 x Mid 126/500"
expect_jq ".lines[0].notes == \"From Joinr CI-M11-$M11_DW_TAG-1.\" and .lines[0].supplier == \"$M11_DW_SUPPLIER\"" "the line's notes and supplier"
expect_jq "(.lines[0].joinrLines | length) == 2 and any(.lines[0].joinrLines[]; .name == \"$M11_DW_MID\" and .map.brand == \"edge\" and .map.height == 126) and any(.lines[0].joinrLines[]; .name == \"$M11_DW_UNKNOWN\" and .map == null)" \
  "joinrLines hold both entries, with their mapping"
expect_jq "(.joinr.drawers | length) == 2 and .joinr.unmapped == [{\"section\":\"innerDrawers\",\"name\":\"$M11_DW_UNKNOWN\",\"qty\":2,\"map\":null}] and .joinr.changedSinceFill == false" \
  "the Joinr box: both lines, the unmapped one, unchanged"
M11_DW_L1=$(jqr '.lines[0].id')
m11dw_notifs "$ORDR" drawers.unmapped "Drawer names to add: $M11_DW_Q1_SITE"
expect_eq "$M11_DW_N" "1" "ordr is told about the unmapped name"
req GET "/api/notifications?limit=100" "$ORDR"
expect_jq "[.rows[] | select(.kind == \"drawers.unmapped\" and .title == \"Drawer names to add: $M11_DW_Q1_SITE\")][0] | .body == \"$M11_DW_UNKNOWN\" and .link == \"/drawers.html#names\"" \
  "the notice names it and links to the name list"
m11dw_notifs "$DPM" drawers.check "Drawers to check: $M11_DW_Q1_SITE"
expect_eq "$M11_DW_N" "1" "dpm is asked to check the drawers"
m11dw_notifs "$ADMIN" drawers.check "Drawers to check: $M11_DW_Q1_SITE"
expect_eq "$M11_DW_N" "0" "the actor (admin) is not told"
req GET /api/drawers/unmapped "$ORDR"
expect_status 200 "ordr GET /api/drawers/unmapped"
expect_jq "any(.unmapped[]; .name == \"$M11_DW_UNKNOWN\" and any(.jobs[]; .jobId == $M11_DW_J1 and .qty == 2))" "the unmapped name is listed with its job"
req GET /api/drawers/unmapped "$DPM"
expect_status 403 "dpm GET /api/drawers/unmapped"

M11_DW_I2=$(m11dw_intake "$M11_DW_Q2" id)
m11dw_release 2
req POST "/api/joinr/intake/$M11_DW_I2/accept" "$ADMIN" '{}'
expect_status 200 "admin accepts quote 2 (no drawer lines)"
M11_DW_J2=$(jqr '.job.id')
m11dw_lines "$M11_DW_J2"
expect_jq '(.lines | length) == 0 and .joinr.drawers == null and .joinr.changedSinceFill == false' "no drawer line; Joinr reported none"

echo "--- Joinr: changes to the drawer lines ---"
m11dw_quote "$M11_DW_Q2" "CI-M11-$M11_DW_TAG-2" "$M11_DW_Q2_SITE" \
  ". + {drawers: [{section: \"drawers\", name: \"$M11_DW_MID\", qty: 3}]}"
m11dw_import "quote 2 gains drawer lines"
expect_eq "$(m11dw_intake "$M11_DW_Q2" changed)" "0" "drawer lines first reported are not a change"
expect_eq "$(m11dw_sql "SELECT payload FROM joinr_intake WHERE root_quote_id = '$M11_DW_Q2'" | jq -c '.[0].payload | fromjson | .drawers | length')" \
  "1" "but they are kept"
m11dw_lines "$M11_DW_J2"
expect_jq '(.lines | length) == 0 and (.joinr.drawers | length) == 1' "the job still has no line (no refill by itself); the box shows the lines"
m11dw_quote "$M11_DW_Q2" "CI-M11-$M11_DW_TAG-2" "$M11_DW_Q2_SITE" \
  ". + {drawers: [{section: \"drawers\", name: \"$M11_DW_MID\", qty: 4}]}"
m11dw_import "quote 2's drawer quantity changes"
expect_eq "$(m11dw_intake "$M11_DW_Q2" changed)" "1" "a changed drawer quantity flags the record"
req GET "/api/notifications?limit=100" "$DPM"
expect_jq "[.rows[] | select(.kind == \"joinr.changed\" and .link == \"/intake.html?item=$M11_DW_I2\")][0] | .body | contains(\"drawers\")" \
  "the change alert names the drawers"

echo "--- Joinr: refill after mapping the second name ---"
req POST "/api/orders/$M11_DW_L1/drawers/check" "$DPM" '{}'
expect_status 200 "dpm checks the Joinr grid"
req POST /api/drawers/names "$ORDR" "{\"name\":\"$M11_DW_UNKNOWN\",\"brand\":\"edge\",\"height\":174,\"length\":450}"
expect_status 201 "ordr maps the second name"
m11dw_lines "$M11_DW_J1"
expect_jq '.joinr.unmapped == [] and .joinr.changedSinceFill == false' "nothing unmapped now; a new mapping isn't a change in Joinr"
m11dw_quote "$M11_DW_Q1" "CI-M11-$M11_DW_TAG-1" "$M11_DW_Q1_SITE" \
  ". + {drawers: [{section: \"drawers\", name: \"$M11_DW_MID\", qty: 7}, {section: \"innerDrawers\", name: \"$M11_DW_UNKNOWN\", qty: 2}]}"
m11dw_import "quote 1's drawer quantity changes"
expect_eq "$(m11dw_intake "$M11_DW_Q1" changed)" "1" "the accepted record is flagged changed"
m11dw_lines "$M11_DW_J1"
expect_jq '.joinr.changedSinceFill == true and .lines[0].counts == [{"height":126,"length":500,"qty":6}]' \
  "the job page says Joinr changed; the grid is not rewritten by itself"
req POST "/api/orders/$M11_DW_L1/drawers/refill" "$WSMGR" '{}'
expect_status 403 "wsmgr refills"
req POST "/api/orders/$M11_DW_L1/drawers/refill" "$ORDR" '{}'
expect_status 200 "ordr refills from Joinr"
expect_jq '.order.counts == [{"height":126,"length":500,"qty":7},{"height":174,"length":450,"qty":2}] and .order.drawers.checked == null and .order.drawers.source == "joinr"' \
  "the counts change (both names now) and the line is unchecked"
expect_jq '.order.description | test("^Drawers [(]EDGE[)]: 7 . Mid 126/500, 2 . High 174/450$")' "the description follows"
m11dw_lines "$M11_DW_J1"
expect_jq '.joinr.changedSinceFill == false' "the grid matches Joinr again"
req PATCH "/api/drawers/names/$(m11dw_sql "SELECT id FROM drawer_names WHERE name_key = lower('$M11_DW_UNKNOWN')" | jq -r '.[0].id')" "$ORDR" '{"brand":"dtc","height":178,"length":450}'
expect_status 200 "ordr remaps the second name to DTC"
m11dw_lines "$M11_DW_J1"
expect_jq '.joinr.changedSinceFill == false' "remapping a name on our side isn't a change in Joinr (review A-m5)"
req PATCH "/api/drawers/names/$(m11dw_sql "SELECT id FROM drawer_names WHERE name_key = lower('$M11_DW_UNKNOWN')" | jq -r '.[0].id')" "$ORDR" '{"brand":"edge","height":174,"length":450}'
expect_status 200 "ordr maps it back to EDGE"
m11dw_lines "$M11_DW_J1"
expect_jq '.joinr.changedSinceFill == false and .canFill == false' "still unchanged; a job with a live EDGE line can't be filled"
req POST "/api/job-records/$M11_DW_J1/drawers/fill" "$DPM" '{}'
expect_status 409 "Fill from Joinr on a job that has its EDGE line"
expect_jq '.error == "Nothing to fill from Joinr"' "and says so"
req POST "/api/orders/$M11_DW_LB/drawers/refill" "$ORDR" '{}'
expect_status 409 "refill on a job with no Joinr record"
expect_jq '.error == "No drawers from Joinr for this job"' "and says so"
req POST "/api/orders/$M11_DW_LA/drawers/refill" "$ORDR" '{}'
expect_status 409 "refill on an ordered line"
expect_jq '.error == "Only a drawer line still to order can be changed"' "and says so"

echo "--- Joinr: link fills a job too, skipping a brand it already has ---"
m11dw_job "M11 Drawer Job Link $M11_DW_TAG" "\"quoteNumber\":\"CI-M11-$M11_DW_TAG-3\""
M11_DW_J3=$M11_DW_JOB
req POST "/api/job-records/$M11_DW_J3/drawers" "$DPM" '{"brand":"dtc","counts":[{"height":95,"length":300,"qty":1}]}'
expect_status 201 "dpm types a DTC grid on the job first"
m11dw_hold 3
M11_DW_Q3=$(m11dw_root 3)
m11dw_quote "$M11_DW_Q3" "CI-M11-$M11_DW_TAG-3" "M11 Drawer Site Three $M11_DW_TAG" \
  ". + {drawers: [{section: \"drawers\", name: \"$M11_DW_MID\", qty: 2.5}, {section: \"innerDrawers\", name: \"$M11_DW_UNKNOWN\", qty: 1}]}"
m11dw_import "quote 3"
M11_DW_I3=$(m11dw_intake "$M11_DW_Q3" id)
m11dw_release 3
req POST "/api/joinr/intake/$M11_DW_I3/link" "$ADMIN" "{\"jobId\":$M11_DW_J3}"
expect_status 200 "admin links quote 3 to the job"
m11dw_lines "$M11_DW_J3"
expect_jq '(.lines | length) == 2 and any(.lines[]; .drawers.brand == "dtc" and .drawers.source == "manual")' "the typed DTC line stays"
expect_jq 'any(.lines[]; .drawers.brand == "edge" and .drawers.source == "joinr" and .counts == [{"height":126,"length":500,"qty":3},{"height":174,"length":450,"qty":1}])' \
  "link made the EDGE line from Joinr (2.5 rounds up to 3)"

echo "--- Fill from Joinr (section 15.18) ---"
m11dw_lines "$M11_DW_J2"
expect_jq '(.lines | length) == 0 and (.joinr.drawers | length) == 1 and .canFill == true' "job 2 has Joinr lines and no line: canFill"
req GET "/api/job-records/$M11_DW_J2/drawers" "$SHOW"
if [ "$STATUS" = 200 ]; then expect_jq '.canFill == false' "a viewer without orders.edit is not offered Fill"; else ok; fi
req POST "/api/job-records/$M11_DW_J2/drawers/fill" "$WSMGR" '{}'
expect_status 403 "wsmgr Fill from Joinr"
req POST "/api/job-records/$M11_DW_J2/drawers/fill" "$DPM" '{}'
expect_status 201 "dpm Fill from Joinr"
expect_jq '(.created | length) == 1 and (.lines | length) == 1 and .lines[0].drawers.source == "joinr" and .lines[0].drawers.checked == null and .lines[0].counts == [{"height":126,"length":500,"qty":4}] and .canFill == false' \
  "one unchecked EDGE line from Joinr; nothing left to fill"
expect_jq ".lines[0].notes == \"From Joinr CI-M11-$M11_DW_TAG-2.\" and .joinr.changedSinceFill == false" "its note names the quote; the grid matches Joinr"
M11_DW_L2=$(jqr '.lines[0].id')
req POST "/api/job-records/$M11_DW_J2/drawers/fill" "$DPM" '{}'
expect_status 409 "a second Fill from Joinr"
expect_jq '.error == "Nothing to fill from Joinr"' "and says so"
req POST "/api/orders/$M11_DW_L2/cancel" "$DPM" '{}'
expect_status 200 "dpm cancels the filled line"
m11dw_lines "$M11_DW_J2"
expect_jq '(.lines | length) == 0 and .canFill == true' "a cancelled line doesn't count as live: canFill again"
req POST "/api/job-records/$M11_DW_J2/drawers/fill" "$DPM" '{}'
expect_status 201 "Fill from Joinr again"
req POST "/api/job-records/99999999/drawers/fill" "$DPM" '{}'
expect_status 404 "Fill on a job that doesn't exist"

echo "--- linking skips a brand with an ordered line (review A-m4) ---"
m11dw_hold 7
M11_DW_Q7=$(m11dw_root 7)
m11dw_quote "$M11_DW_Q7" "CI-M11-$M11_DW_TAG-7" "M11 Drawer Site Seven $M11_DW_TAG" \
  ". + {drawers: [{section: \"drawers\", name: \"$M11_DW_MID\", qty: 1}]}"
m11dw_import "quote 7"
M11_DW_I7=$(m11dw_intake "$M11_DW_Q7" id)
req PATCH "/api/job-records/$M11_DW_JA" "$ADMIN" "{\"quoteNumber\":\"CI-M11-$M11_DW_TAG-7\"}"
expect_status 200 "admin gives job A the quote number"
m11dw_release 7
req POST "/api/joinr/intake/$M11_DW_I7/link" "$ADMIN" "{\"jobId\":$M11_DW_JA}"
expect_status 200 "admin links quote 7 to job A, whose EDGE line is already ordered"
m11dw_lines "$M11_DW_JA"
expect_jq '(.lines | length) == 1 and .canFill == false' "no second EDGE line was made; nothing to fill"

echo "--- Joinr: malformed drawer lines import without drawers (section 15.22) ---"
M11_DW_LOG_CURSORS=""
m11dw_bad() { # N DRAWERS-JSON
  local root
  root=$(m11dw_root "$1")
  m11dw_quote "$root" "CI-M11-$M11_DW_TAG-$1" "M11 Drawer Site Bad $1 $M11_DW_TAG" ". + {drawers: $2}"
  M11_DW_LOG_CURSORS="$M11_DW_LOG_CURSORS $1:$(printf '%s' "$M11_DW_OUT" | jq -r '.cursor')"
}
for n in 4 5 6 8; do m11dw_hold "$n"; done
m11dw_bad 4 '[{"section":"drawers","name":"M11 Drawer Bad","qty":-1}]'
m11dw_bad 5 "[{\"section\":\"drawers\",\"name\":\"$(printf 'x%.0s' $(seq 1 201))\",\"qty\":1}]"
m11dw_bad 6 '[{"section":"doors","name":"M11 Drawer Bad","qty":1}]'
m11dw_bad 8 '"not a list"'
m11dw_import "four malformed quotes"
M11_DW_LOGS=$(docker logs "$CONTAINER" 2>&1)
for entry in $M11_DW_LOG_CURSORS; do
  n=${entry%%:*}; cur=${entry#*:}
  expect_eq "$(m11dw_intake "$(m11dw_root "$n")" state)" "new" "malformed quote $n is imported"
  expect_eq "$(m11dw_sql "SELECT payload FROM joinr_intake WHERE root_quote_id = '$(m11dw_root "$n")'" | jq -c '.[0].payload | fromjson | .drawers')" \
    "null" "quote $n is stored with drawers not reported"
  grep -qF "[joinr] item $cur: drawers not read (drawers" <<<"$M11_DW_LOGS" \
    || fail "malformed quote $n is logged as drawers not read"
  ok
  m11dw_notifs "$ADMIN" joinr.drawers "Drawers not read from Joinr: CI-M11-$M11_DW_TAG-$n M11 Drawer Site Bad $n $M11_DW_TAG"
  expect_eq "$M11_DW_N" "1" "admin is told about quote $n's drawers"
done
case $M11_DW_LOGS in *"M11 Drawer Bad"*) fail "a refused drawer line's value appears in the logs" ;; *) ok ;; esac
m11dw_import "the same malformed quotes again"
m11dw_notifs "$ADMIN" joinr.drawers "Drawers not read from Joinr: CI-M11-$M11_DW_TAG-4 M11 Drawer Site Bad 4 $M11_DW_TAG"
expect_eq "$M11_DW_N" "1" "a repeat of the same item sends no second notice"
req GET "/api/notifications?limit=100" "$DPM"
expect_jq "[.rows[] | select(.kind == \"joinr.drawers\")] | length == 0" "dpm (no users.admin) isn't told"
M11_DW_I4=$(m11dw_intake "$(m11dw_root 4)" id)
m11dw_release 4
req POST "/api/joinr/intake/$M11_DW_I4/accept" "$ADMIN" '{}'
expect_status 200 "admin accepts a quote whose drawers were malformed"
M11_DW_J4=$(jqr '.job.id')
m11dw_lines "$M11_DW_J4"
expect_jq '(.lines | length) == 0 and .joinr.drawers == null and .canFill == false' "no drawer line, nothing reported"

echo "--- tidy up: stop the stand-in and remove the Joinr set-up ---"
m11dw_fake POST /_control/stop
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
req GET /api/joinr/status "$DPM"
expect_status 200 "status after the tidy-up"
expect_jq '.configured == false' "Joinr is no longer set up"
