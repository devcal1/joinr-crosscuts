# M2 smoke, Wave 1 B: notifications, settings and the Friday round-up.
# Sourced by ci/smoke.sh between steps j and k, so it shares that script's
# helpers (step, req, expect_*, jqr, wait_healthy, sydney_monday), the cookie
# jars ($ADMIN $SCHED $ACCT $DPM $SHOW) and $CONTAINER. Not run on its own.
# It runs after smoke-m2-invoices.sh, so it must not assume a pristine
# invoices table or settings: it sets what it needs and checks only its own rows.

# ============================================================================
step "m2-b. notifications and settings"
# ============================================================================

# Runs the round-up's pure shouldRun(now, lastRun) inside the container and
# prints the Friday it returns, or "null". args: ISO instant, last_run or "null".
should_run() {
  docker exec "$CONTAINER" node -e '
const r = require("/app/lib/roundup.js");
const last = process.argv[2] === "null" ? null : process.argv[2];
const v = r.shouldRun(new Date(process.argv[1]), last);
console.log(v === null ? "null" : v);
' "$1" "$2"
}

# One value from the live database (read-only), first column of the first row.
db_value() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db", { readonly: true });
const row = d.prepare(process.argv[1]).get();
console.log(row ? String(Object.values(row)[0]) : "");
' "$1"
}

roundup_count() { # jar -> number of invoice.roundup notifications that user has
  req GET "/api/notifications?limit=100" "$1"
  expect_status 200 "GET /api/notifications"
  jqr '[.rows[] | select(.kind == "invoice.roundup")] | length'
}

echo "--- a due event notifies the accounts user ---"
req GET /api/notifications/unread-count "$ACCT"
expect_status 200 "acct unread-count"
expect_jq '.unread | type == "number"' "unread-count shape"
N_UNREAD_BEFORE=$(jqr '.unread')

req POST /api/jobs/backlog "$ADMIN" '{"name":"CI Notify Job"}'
expect_status 201 "add the notify job to the backlog"
N_BACKLOG_ID=$(jqr '.id')
N_JOB_ID=$(jqr '.jobId')
req PATCH "/api/job-records/$N_JOB_ID" "$ADMIN" '{"valueCents":1000000}'
expect_status 200 "set the notify job's value"
# A week no other test uses, with no earlier week row for this job: the first
# placement makes the deposit due, and invoices.edit holders are notified.
req POST "/api/jobs/backlog/$N_BACKLOG_ID/place" "$ADMIN" \
  '{"weekStart":"2034-05-01","panel":"manufacturing"}'
expect_status 201 "place the notify job on the board"

req GET "/api/notifications?limit=100" "$ACCT"
expect_status 200 "acct GET /api/notifications"
expect_jq '.rows | map(select(.kind == "invoice.due" and (.title | contains("CI Notify Job")))) | length == 1' \
  "acct has one invoice.due notification for the notify job"
expect_jq '.rows[0] | has("id") and has("kind") and has("title") and has("body") and has("link") and has("createdAt") and has("readAt")' \
  "notification rows have the contract shape"
expect_jq '.rows[0].createdAt >= (.rows[-1].createdAt)' "notifications are newest first"
expect_jq '.rows | map(select(.kind == "invoice.due" and (.title | contains("CI Notify Job")))) | .[0].link | startswith("/accounts.html")' \
  "the due notification links to the accounts page"
N_NOTIF_ID=$(jqr '[.rows[] | select(.kind == "invoice.due" and (.title | contains("CI Notify Job")))][0].id')
expect_jq ".unread >= $((N_UNREAD_BEFORE + 1))" "acct unread count went up"

req GET "/api/notifications?limit=1" "$ACCT"
expect_status 200 "limit=1"
expect_jq '.rows | length == 1' "limit=1 returns one row"
req GET "/api/notifications?limit=0" "$ACCT"
expect_status 400 "limit=0"
req GET "/api/notifications?limit=101" "$ACCT"
expect_status 400 "limit=101"

# Notifications are per user: sched does not hold invoices.edit.
req GET "/api/notifications?limit=100" "$SCHED"
expect_status 200 "sched GET /api/notifications"
expect_jq '[.rows[] | select(.kind == "invoice.due" and (.title | contains("CI Notify Job")))] | length == 0' \
  "sched sees none of the accounts notifications"

echo "--- read, read-all, and other users' rows ---"
req POST "/api/notifications/$N_NOTIF_ID/read" "$SCHED"
expect_status 404 "sched marks acct's notification read"
req POST "/api/notifications/$N_NOTIF_ID/read" "$SHOW"
expect_status 404 "show marks acct's notification read"
req POST /api/notifications/999999999/read "$ACCT"
expect_status 404 "read an unknown notification"
req GET "/api/notifications?limit=100" "$ACCT"
expect_jq "[.rows[] | select(.id == $N_NOTIF_ID)][0].readAt == null" "the 404s did not mark it read"

req POST "/api/notifications/$N_NOTIF_ID/read" "$ACCT"
expect_status 204 "acct marks its own notification read"
req GET "/api/notifications?limit=100" "$ACCT"
expect_jq "[.rows[] | select(.id == $N_NOTIF_ID)][0].readAt != null" "readAt is set"
req POST "/api/notifications/$N_NOTIF_ID/read" "$ACCT"
expect_status 204 "marking read twice is fine"

echo "--- the round-up trigger ---"
req POST /api/notifications/roundup/run "$ACCT" '{}'
expect_status 403 "acct runs the round-up"
req POST /api/notifications/roundup/run "$SCHED" '{}'
expect_status 403 "sched runs the round-up"
N_ROUNDUP_ADMIN_BEFORE=$(roundup_count "$ADMIN")
req POST /api/notifications/roundup/run "$ADMIN" '{}'
expect_status 200 "admin runs the round-up"
expect_jq '.sent > 0' "the round-up sent notifications"
expect_jq '.summary.dueCount >= 1 and (.summary.oldest | length >= 1 and length <= 5)' "the summary counts the due deposit"
expect_jq '.summary | has("dueCents") and has("overdueCount") and has("overdueCents") and has("notMyobCount")' "the summary has every count"

req GET "/api/notifications?limit=100" "$ACCT"
expect_jq '[.rows[] | select(.kind == "invoice.roundup")][0] | (.title | startswith("Friday round-up:")) and .link == "/accounts.html" and .readAt == null' \
  "acct got an unread round-up with the accounts link"
expect_eq "$(roundup_count "$ADMIN")" "$((N_ROUNDUP_ADMIN_BEFORE + 1))" "admin got one round-up"
req GET "/api/notifications?limit=100" "$SHOW"
expect_jq '[.rows[] | select(.kind == "invoice.roundup")] | length == 0' "show (no invoices.edit) got no round-up"

req POST /api/notifications/read-all "$ACCT"
expect_status 204 "acct read-all"
req GET /api/notifications/unread-count "$ACCT"
expect_jq '.unread == 0' "acct has nothing unread"
req GET /api/notifications/unread-count "$ADMIN"
expect_jq '.unread > 0' "read-all left admin's notifications alone"

echo "--- settings: access and validation ---"
req GET /api/settings "$ACCT"
expect_status 403 "acct GET /api/settings"
req PUT /api/settings "$ACCT" '{"business":{"tradingName":"Nope"}}'
expect_status 403 "acct PUT /api/settings"
req GET /api/settings "$SCHED"
expect_status 403 "sched GET /api/settings"

req GET /api/settings "$ADMIN"
expect_status 200 "admin GET /api/settings"
expect_jq '(.business | has("tradingName") and has("abn") and has("address") and has("bsb") and has("accountNumber") and has("termsText")) and (.invoice | has("prefix") and has("nextNumber") and has("pad") and has("defaultDays") and has("termsText") and has("numberLocked"))' \
  "settings have the contract shape"
expect_jq '(.invoice.defaultDays | type == "number") and (.invoice.nextNumber | type == "number") and (.invoice.numberLocked | type == "boolean")' \
  "numbering settings have the right types"

req PUT /api/settings "$ADMIN" '{"business":{"abn":"1234567890"}}'
expect_status 400 "ABN with 10 digits"
req PUT /api/settings "$ADMIN" '{"business":{"abn":"12 345 678 90A"}}'
expect_status 400 "ABN with a letter"
req PUT /api/settings "$ADMIN" '{"business":{"abn":12345678901}}'
expect_status 400 "ABN as a number"
req PUT /api/settings "$ADMIN" '{"business":{"bsb":"0620"}}'
expect_status 400 "BSB with 4 digits"
req PUT /api/settings "$ADMIN" '{"invoice":{"nextNumber":0}}'
expect_status 400 "next number 0"
req PUT /api/settings "$ADMIN" '{"invoice":{"defaultDays":"ten"}}'
expect_status 400 "default days as text"
req PUT /api/settings "$ADMIN" '{"business":{"colour":"red"}}'
expect_status 400 "unknown field"

# A bad field anywhere writes nothing.
req PUT /api/settings "$ADMIN" '{"business":{"tradingName":"Should Not Stick","abn":"nope"}}'
expect_status 400 "good and bad fields together"
req GET /api/settings "$ADMIN"
expect_jq '.business.tradingName != "Should Not Stick"' "a rejected PUT wrote nothing"

echo "--- settings: partial PUT, normalisation, audit ---"
req PUT /api/settings "$ADMIN" \
  '{"business":{"tradingName":"CI Cabinets","abn":"12345678901","address":"1 Test St, Sydney NSW 2000","bsb":"062000","accountNumber":"12345678","bankAccountName":"CI Cabinets Pty Ltd"}}'
expect_status 200 "admin sets the business details"
expect_jq '.business.abn == "12 345 678 901" and .business.bsb == "062-000" and .business.tradingName == "CI Cabinets"' \
  "ABN and BSB come back normalised"
req PUT /api/settings "$ADMIN" '{"invoice":{"defaultDays":14}}'
expect_status 200 "partial PUT of one invoice field"
expect_jq '.invoice.defaultDays == 14 and .business.tradingName == "CI Cabinets" and .business.abn == "12 345 678 901"' \
  "a partial PUT leaves the other fields alone"
req PUT /api/settings "$ADMIN" '{"invoice":{"defaultDays":10}}'
expect_status 200 "defaultDays back to 10"
audit_total settings.update
[ "$AUDIT_TOTAL" -ge 2 ] || fail "expected at least 2 settings.update audit rows, got $AUDIT_TOTAL"
ok

echo "--- settings: the number lock after an issue ---"
req GET "/api/invoices/job/$N_JOB_ID" "$ADMIN"
expect_status 200 "GET the notify job's invoices"
N_INV_ID=$(jqr '[.[] | select(.kind == "deposit")][0].id')
req POST "/api/invoices/$N_INV_ID/issue" "$ADMIN" '{}'
expect_status 200 "admin issues the notify job's deposit"
expect_jq '.status == "issued" and .number != null' "the deposit is issued with a number"
req GET /api/settings "$ADMIN"
expect_jq '.invoice.numberLocked == true' "numbering is locked once an invoice has a number"
N_PREFIX=$(jqr '.invoice.prefix')
N_NEXT=$(jqr '.invoice.nextNumber')
req PUT /api/settings "$ADMIN" '{"invoice":{"prefix":"ZZ-"}}'
expect_status 409 "change the prefix while locked"
req PUT /api/settings "$ADMIN" '{"invoice":{"pad":9}}'
expect_status 409 "change the padding while locked"
req PUT /api/settings "$ADMIN" "{\"invoice\":{\"nextNumber\":$((N_NEXT + 100))}}"
expect_status 409 "change the next number while locked"
req PUT /api/settings "$ADMIN" "$(jq -nc --arg p "$N_PREFIX" --argjson n "$N_NEXT" '{invoice:{prefix:$p,nextNumber:$n,numberLocked:true}}')"
expect_status 200 "sending the current numbering back is not a change"
req GET /api/settings "$ADMIN"
expect_jq ".invoice.prefix == \"$N_PREFIX\" and .invoice.nextNumber == $N_NEXT" "the 409s changed nothing"
req PUT /api/settings "$ADMIN" '{"invoice":{"defaultDays":12},"business":{"phone":"02 5550 0000"}}'
expect_status 200 "non-numbering fields stay editable while locked"
req PUT /api/settings "$ADMIN" '{"invoice":{"defaultDays":10}}'
expect_status 200 "defaultDays back to 10 again"

echo "--- the round-up schedule (shouldRun) ---"
# A Friday in winter (AEST, UTC+10): 12:00 Sydney is 02:00Z.
expect_eq "$(should_run 2033-06-10T01:59:00Z 2033-06-03)" "null" "Friday 11:59: last Friday already ran"
expect_eq "$(should_run 2033-06-10T01:59:00Z 2033-05-27)" "2033-06-03" "Friday 11:59: a missed Friday runs for the previous one"
expect_eq "$(should_run 2033-06-10T02:00:00Z 2033-06-03)" "2033-06-10" "Friday 12:00 Sydney runs"
expect_eq "$(should_run 2033-06-10T02:00:00Z 2033-06-10)" "null" "the same Friday twice runs once"
expect_eq "$(should_run 2033-06-11T00:00:00Z 2033-06-10)" "null" "Saturday after a run"
expect_eq "$(should_run 2033-06-11T00:00:00Z 2033-06-03)" "2033-06-10" "Saturday catches up the missed Friday"
# DST ends Sunday 2033-04-03: Friday 04-01 is AEDT (12:00 = 01:00Z), 04-08 is AEST (12:00 = 02:00Z).
expect_eq "$(should_run 2033-04-01T00:59:00Z 2033-03-25)" "null" "pre-DST-change Friday 11:59 AEDT"
expect_eq "$(should_run 2033-04-01T01:00:00Z 2033-03-25)" "2033-04-01" "pre-DST-change Friday 12:00 AEDT"
expect_eq "$(should_run 2033-04-03T10:00:00Z 2033-04-01)" "null" "the DST-change Sunday after a run"
expect_eq "$(should_run 2033-04-08T01:59:00Z 2033-04-01)" "null" "post-DST-change Friday 11:59 AEST"
expect_eq "$(should_run 2033-04-08T02:00:00Z 2033-04-01)" "2033-04-08" "post-DST-change Friday 12:00 AEST"
# DST starts Sunday 2033-10-02: Friday 09-30 is AEST, 10-07 is AEDT (12:00 = 01:00Z).
expect_eq "$(should_run 2033-10-07T00:59:00Z 2033-09-30)" "null" "post-DST-start Friday 11:59 AEDT"
expect_eq "$(should_run 2033-10-07T01:00:00Z 2033-09-30)" "2033-10-07" "post-DST-start Friday 12:00 AEDT"
expect_eq "$(should_run 2033-10-07T01:00:00Z 2033-10-07)" "null" "the same Friday twice across DST"

echo "--- a restart does not re-run the round-up ---"
# The first boot seeded last_run (no stale round-up on a fresh install), so the
# current Friday is already counted as run.
N_LAST_RUN=$(db_value "SELECT value FROM app_settings WHERE key = 'roundup.last_run'")
[ -n "$N_LAST_RUN" ] || fail "roundup.last_run was not seeded on first start"
ok
expect_eq "$(should_run "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$N_LAST_RUN")" "null" "last_run covers the current Friday"

N_ROUNDUP_ADMIN_BEFORE=$(roundup_count "$ADMIN")
N_ROUNDUP_ACCT_BEFORE=$(roundup_count "$ACCT")
docker restart "$CONTAINER" >/dev/null
wait_healthy "$CONTAINER"
expect_eq "$(db_value "SELECT value FROM app_settings WHERE key = 'roundup.last_run'")" "$N_LAST_RUN" \
  "the restart left last_run alone"
expect_eq "$(should_run "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$N_LAST_RUN")" "null" "nothing is due after the restart"
expect_eq "$(roundup_count "$ADMIN")" "$N_ROUNDUP_ADMIN_BEFORE" "no new round-up for admin after the restart"
expect_eq "$(roundup_count "$ACCT")" "$N_ROUNDUP_ACCT_BEFORE" "no new round-up for acct after the restart"
