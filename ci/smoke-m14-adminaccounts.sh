# M14 smoke: admin accounts (docs/plans/m9-contracts.md section 13), the accounts that aren't
# regular suppliers (BAS, Workcover, insurance) on their own page with the same monthly lines.
# Sourced by ci/smoke.sh after the M13 suites, so it shares that script's helpers (step, req, hdr,
# expect_status, expect_jq, expect_eq, jqr, fail, ok), the cookie jars ($ADMIN $SCHED $ACCT $DPM
# $SHOW $WSHOP), $BASE, $REQ_ORIGIN, $BODY_FILE, $HDR_FILE, $WORK and $CONTAINER. No shebang and no
# `set`: the caller owns both.
# It does not assume a pristine database: its accounts carry a run tag in their names, it reads
# counts as differences, and it uses 2024 months (after HISTORY_START, before cutover). Made-up
# names only (this repo is public). Modelled on smoke-m9-suppliers.sh.

# ============================================================================
step "m14-adminaccounts. admin accounts, apart from supplier accounts"
# ============================================================================

M14A_TAG=$(date +%s)
M14A_NAME_A="M14 Test Admin Account A $M14A_TAG"
M14A_NAME_A2="M14 Test Admin Account Alpha $M14A_TAG"
M14A_NAME_B="M14 Test Admin Account B $M14A_TAG"
M14A_SUP="M14 Test Supplier $M14A_TAG"
M14A_CUR=$(TZ=Australia/Sydney date +%Y-%m)
M14A_NEXT=$(date -u -d "${M14A_CUR}-15 +1 month" +%Y-%m)
M14A_STALE="Someone else changed this line; reload it"
M14A_CLASH="An account with that name already exists"

# m14a_month PERIOD [JAR]: GET the admin accounts' month as acct (200 expected).
m14a_month() {
  req GET "/api/admin-accounts/months/$1" "${2:-$ACCT}"
  expect_status 200 "GET /api/admin-accounts/months/$1"
}

# m14a_line ID FILTER WHAT: the filter must hold for that account's line in the last month.
m14a_line() {
  expect_jq "[.lines[] | select(.supplier.id == $1)] | length == 1 and (.[0] | $2)" "$3"
}

# m14a_absent ID WHAT: the account isn't listed in the last month.
m14a_absent() {
  expect_jq "[.lines[] | select(.supplier.id == $1)] | length == 0" "$2"
}

# m14a_upload JAR PERIOD ID FILE NAME TYPE: multipart POST of FILE as NAME; sets STATUS, BODY.
m14a_upload() {
  LAST_REQ="POST /api/admin-accounts/months/$2/$3/file ($5)"
  STATUS=$(curl -s -o "$BODY_FILE" -D "$HDR_FILE" -w '%{http_code}' -X POST -H "Origin: $REQ_ORIGIN" \
    -b "$1" -c "$1" -F "file=@$4;filename=$5;type=$6" "$BASE/api/admin-accounts/months/$2/$3/file")
  BODY=$(cat "$BODY_FILE")
}

echo "--- access ---"
req GET /api/admin-accounts "$ACCT"
expect_status 200 "acct GET /api/admin-accounts"
expect_jq '.suppliers | type == "array"' "the list is an array"
for M14A_J in "$SCHED" "$DPM" "$SHOW" "$WSHOP"; do
  req GET /api/admin-accounts "$M14A_J"
  expect_status 403 "GET /api/admin-accounts without accounts.view"
done
req POST /api/admin-accounts "$SCHED" '{"name":"M14 Sched Account"}'
expect_status 403 "sched POST /api/admin-accounts"
req GET /adminaccounts.html "$ACCT"
expect_status 200 "acct GET /adminaccounts.html"
req GET /adminaccounts.html "$SCHED"
expect_status 403 "sched GET /adminaccounts.html"
req GET /api/admin-accounts
expect_status 401 "logged out GET /api/admin-accounts"

echo "--- accounts ---"
req POST /api/admin-accounts "$ACCT" "$(jq -nc --arg n "$M14A_NAME_A" '{name:$n, fromPeriod:"2024-03"}')"
expect_status 201 "create admin account A from 2024-03"
expect_jq ".name == \"$M14A_NAME_A\" and .fromPeriod == \"2024-03\" and .archivedFrom == null and .archived == false and (.id | type == \"number\")" "account A's shape"
M14A_A=$(jqr '.id')
req POST /api/admin-accounts "$ACCT" "$(jq -nc --arg n "  $M14A_NAME_B  " '{name:$n, fromPeriod:"2024-05"}')"
expect_status 201 "create admin account B from 2024-05"
expect_jq ".name == \"$M14A_NAME_B\" and .fromPeriod == \"2024-05\"" "account B's name is trimmed"
M14A_B=$(jqr '.id')
req POST /api/admin-accounts "$ACCT" "$(jq -nc --arg n "$M14A_NAME_A" '{name:($n | ascii_downcase), fromPeriod:"2024-03"}')"
expect_status 409 "the same name in other case"
expect_jq ".error == \"$M14A_CLASH\"" "the name-clash sentence"
req POST /api/admin-accounts "$ACCT" '{"name":"   "}'
expect_status 400 "a blank account name"
req PATCH "/api/admin-accounts/$M14A_A" "$ACCT" "$(jq -nc --arg n "$M14A_NAME_A2" '{name:$n}')"
expect_status 200 "rename account A"
expect_jq ".id == $M14A_A and .name == \"$M14A_NAME_A2\" and .archived == false" "account A is renamed"
req PATCH /api/admin-accounts/999999999 "$ACCT" '{"name":"M14 Nobody"}'
expect_status 404 "PATCH an unknown account"

echo "--- months ---"
m14a_month 2024-04
expect_jq '.period == "2024-04" and .label == "April 2024" and .prev == "2024-03" and .next == "2024-05"' "the month's period, label, prev and next"
m14a_line "$M14A_A" ".state == \"waiting\" and .supplier.name == \"$M14A_NAME_A2\"" "2024-04 lists A"
m14a_absent "$M14A_B" "2024-04 doesn't list B"
m14a_month 2024-05
m14a_line "$M14A_A" 'true' "2024-05 lists A"
m14a_line "$M14A_B" 'true' "2024-05 lists B"
req GET /api/admin-accounts/months/2023-05 "$ACCT"
expect_status 404 "a month before Jun 2023"
req GET "/api/admin-accounts/months/$M14A_NEXT" "$ACCT"
expect_status 404 "next month"

echo "--- lines ---"
m14a_month 2024-05
M14A_HAVE0=$(jqr '.counts.have')
M14A_TOTAL0=$(jqr '.totalCents')
m14a_line "$M14A_A" '.state == "waiting" and .saved == false and .updatedAt == null and .totalCents == null and .file == null' "a fresh line is waiting and unsaved"
M14A_PUT='{"state":"have","totalCents":123400,"note":"M14 BAS-like","reconciled":true,"paid":true,"myob":false,"updatedAt":null}'
req PUT "/api/admin-accounts/months/2024-05/$M14A_A" "$ACCT" "$M14A_PUT"
expect_status 200 "save A's 2024-05 line"
expect_jq ".supplier.id == $M14A_A and .period == \"2024-05\" and .state == \"have\" and .totalCents == 123400 and .note == \"M14 BAS-like\" and .reconciled == true and .paid == true and .myob == false and .saved == true and (.updatedAt | type == \"string\")" "the saved line"
M14A_UPD=$(jqr '.updatedAt')
req PUT "/api/admin-accounts/months/2024-05/$M14A_A" "$ACCT" "$M14A_PUT"
expect_status 409 "the same body with the old updatedAt"
expect_jq ".error == \"$M14A_STALE\" and .line.updatedAt == \"$M14A_UPD\"" "the stale sentence and the line"
req PUT "/api/admin-accounts/months/2024-05/$M14A_A" "$ACCT" "$(jq -nc --arg u "$M14A_UPD" '{state:"maybe",updatedAt:$u}')"
expect_status 400 "state maybe"
req PUT "/api/admin-accounts/months/2024-05/$M14A_A" "$SCHED" "$M14A_PUT"
expect_status 403 "sched PUT a line"
m14a_month 2024-05
expect_eq "$(jqr '.counts.have')" "$((M14A_HAVE0 + 1))" "the month's have count went up by one"
expect_eq "$(jqr '.totalCents')" "$((M14A_TOTAL0 + 123400))" "the month's total includes 123400"
req PUT "/api/admin-accounts/months/2024-04/$M14A_B" "$ACCT" '{"state":"have","updatedAt":null}'
expect_status 404 "PUT B in 2024-04 (not listed)"

echo "--- kinds stay apart ---"
req POST /api/suppliers "$ACCT" "$(jq -nc --arg n "$M14A_SUP" '{name:$n, fromPeriod:"2024-03"}')"
expect_status 201 "create a supplier"
M14A_S=$(jqr '.id')
req POST /api/suppliers "$ACCT" "$(jq -nc --arg n "$M14A_NAME_B" '{name:$n}')"
expect_status 409 "a supplier can't take an admin account's name"
req POST /api/admin-accounts "$ACCT" "$(jq -nc --arg n "$M14A_SUP" '{name:$n}')"
expect_status 409 "an admin account can't take a supplier's name"
req GET "/api/suppliers?all=1" "$ACCT"
expect_jq "([.suppliers[] | select(.id == $M14A_A or .id == $M14A_B)] | length == 0) and ([.suppliers[] | select(.id == $M14A_S)] | length == 1)" "the supplier list has the supplier and no admin account"
req GET "/api/admin-accounts?all=1" "$ACCT"
expect_jq "([.suppliers[] | select(.id == $M14A_A or .id == $M14A_B)] | length == 2) and ([.suppliers[] | select(.id == $M14A_S)] | length == 0)" "the admin list has the accounts and no supplier"
req GET /api/suppliers/months/2024-05 "$ACCT"
expect_status 200 "GET the supplier month"
expect_jq "[.lines[] | select(.supplier.id == $M14A_A or .supplier.id == $M14A_B)] | length == 0" "the supplier month lists no admin account"
expect_jq "[.lines[] | select(.supplier.id == $M14A_S)] | length == 1" "the supplier month lists the supplier"
m14a_month 2024-05
m14a_absent "$M14A_S" "the admin month lists no supplier"
# An id of the other kind is a 404 on every route.
req PUT "/api/suppliers/months/2024-05/$M14A_A" "$ACCT" '{"state":"have","updatedAt":null}'
expect_status 404 "PUT an admin account through the supplier route"
req PATCH "/api/suppliers/$M14A_A" "$ACCT" '{"name":"M14 Wrong Door"}'
expect_status 404 "PATCH an admin account through the supplier route"
req PUT "/api/admin-accounts/months/2024-05/$M14A_S" "$ACCT" '{"state":"have","updatedAt":null}'
expect_status 404 "PUT a supplier through the admin route"
req PATCH "/api/admin-accounts/$M14A_S" "$ACCT" '{"archived":true}'
expect_status 404 "PATCH a supplier through the admin route"

echo "--- archive and restore ---"
req PATCH "/api/admin-accounts/$M14A_A" "$ACCT" '{"archived":true}'
expect_status 200 "archive account A"
expect_jq ".archived == true and .archivedFrom == \"$M14A_CUR\"" "A is archived from this month"
m14a_month "$M14A_CUR"
m14a_absent "$M14A_A" "the current month doesn't list archived A"
m14a_month 2024-05
m14a_line "$M14A_A" '.state == "have"' "2024-05 still lists A (it has a line there)"
req GET /api/admin-accounts "$ACCT"
expect_jq "[.suppliers[] | select(.id == $M14A_A)] | length == 0" "the list leaves out archived A"
req GET "/api/admin-accounts?all=1" "$ACCT"
expect_jq "[.suppliers[] | select(.id == $M14A_A)][0].archived == true" "?all=1 has archived A"
req PATCH "/api/admin-accounts/$M14A_A" "$ACCT" '{"archived":false}'
expect_status 200 "restore account A"
expect_jq ".archived == false and .archivedFrom == null and .fromPeriod == \"$M14A_CUR\"" "A is restored, listed from this month on"
m14a_month 2024-04
m14a_line "$M14A_A" '.state == "waiting" and .saved == true' "2024-04 (before the archive) keeps listing A"
m14a_month 2024-05
m14a_line "$M14A_A" ".state == \"have\" and .updatedAt == \"$M14A_UPD\"" "2024-05 keeps A's own line, untouched"
m14a_month "$M14A_CUR"
m14a_line "$M14A_A" '.state == "waiting" and .saved == false' "the current month lists A again (no line yet)"

echo "--- file ---"
printf '%s\n' '%PDF-1.4' '1 0 obj' '<< >>' 'endobj' 'trailer' '<< >>' '%%EOF' > "$WORK/m14a-policy.pdf"
printf 'M14 plain text\n' > "$WORK/m14a-note.txt"
m14a_upload "$ACCT" 2024-05 "$M14A_A" "$WORK/m14a-policy.pdf" "M14 policy.pdf" application/pdf
expect_status 201 "attach a PDF to A's 2024-05 line"
expect_jq '.file.name == "M14 policy.pdf" and .file.mime == "application/pdf" and (.file.url | startswith("/api/files/")) and .state == "have"' "the line has the file"
M14A_F1=$(jqr '.file.id')
req GET "/api/files/$M14A_F1" "$ACCT"
expect_status 200 "acct downloads the file"
req GET "/api/files/$M14A_F1" "$SCHED"
expect_status 404 "sched can't download the file (404)"
m14a_upload "$ACCT" 2024-05 "$M14A_A" "$WORK/m14a-policy.pdf" "M14 policy 2.pdf" application/pdf
expect_status 201 "attach a second PDF (replaces the first)"
M14A_F2=$(jqr '.file.id')
req GET "/api/files/$M14A_F1" "$ACCT"
expect_status 404 "the replaced file is gone"
m14a_upload "$ACCT" 2024-05 "$M14A_A" "$WORK/m14a-note.txt" "M14 note.txt" text/plain
expect_status 400 "a .txt file"
m14a_upload "$SCHED" 2024-05 "$M14A_A" "$WORK/m14a-policy.pdf" "M14 sched.pdf" application/pdf
expect_status 403 "sched attaches a file"
m14a_upload "$ACCT" 2024-04 "$M14A_B" "$WORK/m14a-policy.pdf" "M14 unlisted.pdf" application/pdf
expect_status 404 "attach to an account not listed that month"
m14a_upload "$ACCT" 2024-05 "$M14A_S" "$WORK/m14a-policy.pdf" "M14 supplier.pdf" application/pdf
expect_status 404 "attach to a supplier through the admin route"
req DELETE "/api/admin-accounts/months/2024-05/$M14A_A/file?fileId=$M14A_F1" "$ACCT"
expect_status 409 "remove the file that was replaced meanwhile"
req DELETE "/api/admin-accounts/months/2024-05/$M14A_A/file?fileId=$M14A_F2" "$ACCT"
expect_status 200 "remove the file (with its fileId)"
expect_jq '.file == null and .state == "have"' "the line has no file"
req GET "/api/files/$M14A_F2" "$ACCT"
expect_status 404 "the removed file is gone"

echo "--- not an order supplier, not in the round-up ---"
req GET "/api/orders/suppliers?q=M14%20Test" "$ADMIN"
expect_status 200 "GET /api/orders/suppliers"
expect_jq "([.[] | select(startswith(\"M14 Test Admin Account\"))] | length) == 0" "no admin account is offered as an order supplier"

echo "--- audit ---"
req GET "/api/audit?entityType=admin_account_statement&entityId=$M14A_A:2024-05&limit=100" "$ADMIN"
expect_status 200 "the line's audit"
expect_jq '[.rows[].action] | (index("admin_account_statement.update") != null) and (index("admin_account_statement.file") != null)' "admin_account_statement.update and .file"
expect_jq '[.rows[] | select(.action == "admin_account_statement.update")] | last | .before.state == "waiting" and .after.state == "have" and .after.totalCents == 123400' "the update holds the changed fields"
req GET "/api/audit?entityType=admin_account&entityId=$M14A_A&limit=100" "$ADMIN"
expect_jq '[.rows[].action] | (index("admin_account.create") != null) and (index("admin_account.update") != null)' "admin_account.create and admin_account.update"
req GET "/api/audit?entityType=supplier_statement&entityId=$M14A_A:2024-05&limit=100" "$ADMIN"
expect_jq '.rows | length == 0' "nothing is audited as a supplier statement"

echo "Admin accounts smoke test passed."
