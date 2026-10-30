# M9 smoke, Wave 1 B: supplier accounts and the Friday round-up's "statements still waiting" line.
# Sourced by ci/smoke.sh after the M8 suites, so it shares that script's helpers (step, req, hdr,
# expect_status, expect_jq, expect_eq, jqr, fail, ok), the cookie jars ($ADMIN $SCHED $ACCT $DPM
# $SHOW $WSHOP), $BASE, $REQ_ORIGIN, $BODY_FILE, $HDR_FILE, $WORK and $CONTAINER. No shebang and no
# `set`: the caller owns both.
# It does not assume a pristine database: its suppliers carry a run tag in their names, it reads
# counts as differences, and it uses 2024 months (after HISTORY_START, before cutover) plus the
# previous month (for the round-up). Made-up names only (this repo is public).
# Contract: docs/plans/m9-contracts.md sections 7 and 10.3.

# ============================================================================
step "m9-suppliers. supplier accounts and the round-up line"
# ============================================================================

M9S_TAG=$(date +%s)
M9S_NAME_A="M9 Test Supplier A $M9S_TAG"
M9S_NAME_A2="M9 Test Supplier Alpha $M9S_TAG"
M9S_NAME_B="M9 Test Supplier B $M9S_TAG"
M9S_CUR=$(TZ=Australia/Sydney date +%Y-%m)
M9S_PREV=$(date -u -d "${M9S_CUR}-15 -1 month" +%Y-%m)
M9S_NEXT=$(date -u -d "${M9S_CUR}-15 +1 month" +%Y-%m)
M9S_PREV_NAME=$(LC_ALL=C date -u -d "${M9S_PREV}-15" +%B)
M9S_STALE="Someone else changed this line; reload it"
M9S_CLASH="A supplier with that name already exists"

# m9s_db_exec SQL: runs SQL against the live database through the container's own better-sqlite3
# (as smoke-m9-bas.sh), to make a past archive month. Only this suite's own rows are touched.
m9s_db_exec() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.exec(process.argv[1]);
d.close();
' "$1"
}

# m9s_file_removed FILE_ID: prints 1 when the file row is soft-removed (removed_at set), else 0.
# Read-only.
m9s_file_removed() {
  docker exec "$CONTAINER" node -e '
const d = new (require("better-sqlite3"))("/data/db/photos.db", { readonly: true });
const r = d.prepare("SELECT removed_at IS NOT NULL AS r FROM files WHERE id = ?").get(Number(process.argv[1]));
console.log(r ? r.r : "missing");
d.close();
' "$1" | tr -d '\r'
}

# m9s_month PERIOD [JAR]: GET the month as acct (200 expected).
m9s_month() {
  req GET "/api/suppliers/months/$1" "${2:-$ACCT}"
  expect_status 200 "GET /api/suppliers/months/$1"
}

# m9s_line SUPPLIER_ID FILTER WHAT: the filter must hold for that supplier's line in the last month.
m9s_line() {
  expect_jq "[.lines[] | select(.supplier.id == $1)] | length == 1 and (.[0] | $2)" "$3"
}

# m9s_absent SUPPLIER_ID WHAT: the supplier isn't listed in the last month.
m9s_absent() {
  expect_jq "[.lines[] | select(.supplier.id == $1)] | length == 0" "$2"
}

# m9s_upload JAR PERIOD SUPPLIER_ID FILE NAME TYPE: multipart POST of FILE as NAME; sets STATUS, BODY.
m9s_upload() {
  LAST_REQ="POST /api/suppliers/months/$2/$3/file ($5)"
  STATUS=$(curl -s -o "$BODY_FILE" -D "$HDR_FILE" -w '%{http_code}' -X POST -H "Origin: $REQ_ORIGIN" \
    -b "$1" -c "$1" -F "file=@$4;filename=$5;type=$6" "$BASE/api/suppliers/months/$2/$3/file")
  BODY=$(cat "$BODY_FILE")
}

# m9s_newest_roundup JAR: sets M9S_RU to the user's newest invoice.roundup notification as JSON
# ("null" if none). Not run in a subshell, so the helpers' counters and fail keep working.
m9s_newest_roundup() {
  req GET "/api/notifications?limit=100" "$1"
  expect_status 200 "GET /api/notifications"
  M9S_RU=$(jqr '[.rows[] | select(.kind == "invoice.roundup")][0]')
}

echo "--- access ---"
req GET /api/suppliers "$ACCT"
expect_status 200 "acct GET /api/suppliers"
expect_jq '.suppliers | type == "array"' "the list has suppliers"
for M9S_J in "$SCHED" "$DPM" "$SHOW" "$WSHOP"; do
  req GET /api/suppliers "$M9S_J"
  expect_status 403 "GET /api/suppliers without accounts.view"
done
req POST /api/suppliers "$SCHED" '{"name":"M9 Sched Supplier"}'
expect_status 403 "sched POST /api/suppliers"
req GET /suppliers.html "$ACCT"
expect_status 200 "acct GET /suppliers.html"
req GET /suppliers.html "$SCHED"
expect_status 403 "sched GET /suppliers.html"

echo "--- suppliers ---"
req POST /api/suppliers "$ACCT" "$(jq -nc --arg n "$M9S_NAME_A" '{name:$n, fromPeriod:"2024-03"}')"
expect_status 201 "create supplier A from 2024-03"
expect_jq ".name == \"$M9S_NAME_A\" and .fromPeriod == \"2024-03\" and .archivedFrom == null and .archived == false and (.id | type == \"number\")" "supplier A's shape"
M9S_A=$(jqr '.id')
req POST /api/suppliers "$ACCT" "$(jq -nc --arg n "  $M9S_NAME_B  " '{name:$n, fromPeriod:"2024-05"}')"
expect_status 201 "create supplier B from 2024-05"
expect_jq ".name == \"$M9S_NAME_B\" and .fromPeriod == \"2024-05\"" "supplier B's name is trimmed"
M9S_B=$(jqr '.id')
req POST /api/suppliers "$ACCT" "$(jq -nc --arg n "$M9S_NAME_A" '{name:($n | ascii_downcase), fromPeriod:"2024-03"}')"
expect_status 409 "the same name in other case"
expect_jq ".error == \"$M9S_CLASH\"" "the name-clash sentence"
# Case-blind beyond A-Z (the column's NOCASE folds only ASCII). The names go as JSON \u escapes,
# so the bytes on the wire are ASCII whatever the shell's locale.
req POST /api/suppliers "$ACCT" "{\"name\":\"M9 Test Supplier \\u00c9cru $M9S_TAG\"}"
expect_status 201 "create a supplier with an accented name"
expect_jq ".name == \"M9 Test Supplier \\u00c9cru $M9S_TAG\"" "the accented name is stored as sent"
M9S_E=$(jqr '.id')
req POST /api/suppliers "$ACCT" "{\"name\":\"m9 test supplier \\u00e9cru $M9S_TAG\"}"
expect_status 409 "the accented name in other case"
req PATCH "/api/suppliers/$M9S_E" "$ACCT" "{\"name\":\"M9 TEST SUPPLIER \\u00c9CRU $M9S_TAG\",\"archived\":true}"
expect_status 200 "a case-only rename of itself (and archive it: added and archived this month, so listed nowhere)"
req POST /api/suppliers "$ACCT" '{"name":"   "}'
expect_status 400 "a blank supplier name"
req POST /api/suppliers "$ACCT" "$(jq -nc '{name:("x" * 101)}')"
expect_status 400 "a supplier name over 100 characters"
req POST /api/suppliers "$ACCT" "$(jq -nc --arg n "M9 Early Supplier $M9S_TAG" '{name:$n, fromPeriod:"2023-05"}')"
expect_status 400 "a fromPeriod before Jun 2023"
req PATCH "/api/suppliers/$M9S_A" "$ACCT" "$(jq -nc --arg n "$M9S_NAME_A2" '{name:$n}')"
expect_status 200 "rename supplier A"
expect_jq ".id == $M9S_A and .name == \"$M9S_NAME_A2\" and .archived == false" "supplier A is renamed"
req PATCH "/api/suppliers/$M9S_A" "$ACCT" "$(jq -nc --arg n "$M9S_NAME_B" '{name:($n | ascii_upcase)}')"
expect_status 409 "rename A to B's name in other case"
expect_jq ".error == \"$M9S_CLASH\"" "the rename clash sentence"
req PATCH /api/suppliers/999999999 "$ACCT" '{"name":"M9 Nobody"}'
expect_status 404 "PATCH an unknown supplier"
m9s_month 2024-04
expect_jq '.period == "2024-04" and .label == "April 2024" and .prev == "2024-03" and .next == "2024-05"' "the month's period, label, prev and next"
m9s_line "$M9S_A" ".state == \"waiting\" and .supplier.name == \"$M9S_NAME_A2\"" "2024-04 lists A"
m9s_absent "$M9S_B" "2024-04 doesn't list B"
m9s_month 2024-05
m9s_line "$M9S_A" 'true' "2024-05 lists A"
m9s_line "$M9S_B" 'true' "2024-05 lists B"
req GET /api/suppliers/months/2023-05 "$ACCT"
expect_status 404 "a month before Jun 2023"
m9s_month "$M9S_NEXT"
expect_jq ".period == \"$M9S_NEXT\" and .prev == \"$M9S_CUR\"" "next month"
M9S_LAST=$(date -u -d "${M9S_CUR}-15 +36 month" +%Y-%m)
m9s_month "$M9S_LAST"
expect_jq ".period == \"$M9S_LAST\" and .next == null" "36 months ahead is the last there is (Todd 2026-10-30)"
M9S_PAST=$(date -u -d "${M9S_CUR}-15 +37 month" +%Y-%m)
req GET "/api/suppliers/months/$M9S_PAST" "$ACCT"
expect_status 404 "37 months ahead"
req GET "/api/suppliers/outstanding" "$ACCT"
expect_status 200 "GET /api/suppliers/outstanding"
expect_jq ".current == \"$M9S_CUR\" and (.before|type) == \"array\" and (.after|type) == \"array\"" "outstanding: before and after lists"
req GET "/audit.html?entityType=supplier_statement" "$ADMIN"
expect_status 200 "admin GET /audit.html (the supplier page's audit link)"
req GET /audit.js "$ADMIN"
expect_status 200 "GET /audit.js"
grep -q "entityType" "$BODY_FILE" || fail "audit.js reads its filters from the address"
ok "audit.js reads its filters from the address"
req GET /suppliers.js "$ACCT"
expect_status 200 "GET /suppliers.js"
grep -q "audit.html?entityType=" "$BODY_FILE" || fail "suppliers.js links to the audit log"
ok "suppliers.js links to the audit log"
req GET /api/suppliers/months/2024-13 "$ACCT"
expect_status 404 "an invalid month"
m9s_month 2023-06
expect_jq '.prev == null' "Jun 2023 has no previous month"
m9s_month "$M9S_CUR"
expect_jq ".next == \"$M9S_NEXT\"" "the current month's next is next month"

echo "--- lines ---"
m9s_month 2024-05
M9S_HAVE0=$(jqr '.counts.have')
M9S_TOTAL0=$(jqr '.totalCents')
m9s_line "$M9S_A" '.state == "waiting" and .saved == false and .updatedAt == null and .updatedBy == null and .totalCents == null and .note == "" and .reconciled == false and .file == null' "a fresh line is waiting and unsaved"
M9S_PUT='{"state":"have","totalCents":50000,"note":"M9","reconciled":true,"paid":false,"myob":false,"updatedAt":null}'
req PUT "/api/suppliers/months/2024-05/$M9S_A" "$ACCT" "$M9S_PUT"
expect_status 200 "save A's 2024-05 line"
expect_jq ".supplier.id == $M9S_A and .period == \"2024-05\" and .state == \"have\" and .totalCents == 50000 and .note == \"M9\" and .reconciled == true and .paid == false and .myob == false and .saved == true and (.updatedAt | type == \"string\") and (.updatedBy.id | type == \"number\")" "the saved line"
M9S_UPD=$(jqr '.updatedAt')
req PUT "/api/suppliers/months/2024-05/$M9S_A" "$ACCT" "$M9S_PUT"
expect_status 409 "the same body with the old updatedAt"
expect_jq ".error == \"$M9S_STALE\" and .line.updatedAt == \"$M9S_UPD\" and .line.state == \"have\"" "the stale sentence and the line"
req PUT "/api/suppliers/months/2024-05/$M9S_A" "$ACCT" "$(jq -nc --arg u "$M9S_UPD" '{state:"have",totalCents:50000,note:"M9",reconciled:true,paid:false,myob:false,updatedAt:$u}')"
expect_status 200 "the same values again"
expect_jq ".updatedAt == \"$M9S_UPD\"" "nothing is written when nothing changes"
req PUT "/api/suppliers/months/2024-05/$M9S_A" "$ACCT" "$(jq -nc --arg u "$M9S_UPD" '{state:"maybe",updatedAt:$u}')"
expect_status 400 "state maybe"
req PUT "/api/suppliers/months/2024-05/$M9S_A" "$ACCT" "$(jq -nc --arg u "$M9S_UPD" '{totalCents:1.5,updatedAt:$u}')"
expect_status 400 "a total that isn't whole cents"
req PUT "/api/suppliers/months/2024-05/$M9S_A" "$ACCT" "$(jq -nc --arg u "$M9S_UPD" '{note:("x" * 501),updatedAt:$u}')"
expect_status 400 "a note over 500 characters"
req PUT "/api/suppliers/months/2024-05/$M9S_A" "$SCHED" "$M9S_PUT"
expect_status 403 "sched PUT a line"
m9s_month 2024-05
expect_eq "$(jqr '.counts.have')" "$((M9S_HAVE0 + 1))" "the month's have count went up by one"
expect_eq "$(jqr '.totalCents')" "$((M9S_TOTAL0 + 50000))" "the month's total includes 50000"
expect_jq '.counts.listed == (.counts.have + .counts.waiting + .counts.na) and .ticks.reconciled >= 1' "the counts add up"
m9s_line "$M9S_A" ".updatedAt == \"$M9S_UPD\" and .saved == true" "the month shows the saved line"
req PUT "/api/suppliers/months/2024-04/$M9S_B" "$ACCT" '{"state":"have","updatedAt":null}'
expect_status 404 "PUT B in 2024-04 (not listed)"

echo "--- archive ---"
req PATCH "/api/suppliers/$M9S_A" "$ACCT" '{"archived":true}'
expect_status 200 "archive supplier A"
expect_jq ".archived == true and .archivedFrom == \"$M9S_CUR\"" "A is archived from this month"
m9s_month "$M9S_CUR"
m9s_absent "$M9S_A" "the current month doesn't list archived A"
m9s_month 2024-05
m9s_line "$M9S_A" '.state == "have"' "2024-05 still lists A (it has a line there)"
req GET /api/suppliers "$ACCT"
expect_jq "[.suppliers[] | select(.id == $M9S_A)] | length == 0" "the list leaves out archived A"
req GET "/api/suppliers?all=1" "$ACCT"
expect_jq "[.suppliers[] | select(.id == $M9S_A)][0].archived == true" "?all=1 has archived A"

echo "--- a line keeps an archived supplier listed; restore ---"
m9s_month "$M9S_PREV"
M9S_PREV_WAITING0=$(jqr '.counts.waiting')
req PUT "/api/suppliers/months/$M9S_CUR/$M9S_B" "$ACCT" '{"state":"na","updatedAt":null}'
expect_status 200 "save B's line for this month"
req PATCH "/api/suppliers/$M9S_B" "$ACCT" '{"archived":true}'
expect_status 200 "archive supplier B"
m9s_month "$M9S_CUR"
m9s_line "$M9S_B" '.state == "na"' "the current month still lists archived B (it has a line there)"
req PATCH "/api/suppliers/$M9S_B" "$ACCT" '{"archived":false}'
expect_status 200 "restore supplier B"
expect_jq ".archived == false and .archivedFrom == null and .fromPeriod == \"$M9S_CUR\"" "B is restored, listed from this month on"
m9s_month "$M9S_CUR"
m9s_line "$M9S_B" '.state == "na"' "B's line for this month is kept"
m9s_month "$M9S_PREV"
m9s_line "$M9S_B" '.state == "waiting" and .saved == true' "the month before the archive keeps listing B (a waiting line)"
expect_eq "$(jqr '.counts.waiting')" "$M9S_PREV_WAITING0" "the restore didn't change the previous month's waiting count"
m9s_month 2024-05
m9s_line "$M9S_B" '.state == "waiting" and .saved == true' "2024-05 keeps listing B"
# Restore skips the gap: as if A had been archived in 2024-07 (moved back with SQL).
m9s_db_exec "UPDATE suppliers SET archived_from = '2024-07' WHERE id = $M9S_A"
m9s_month 2024-08
m9s_absent "$M9S_A" "2024-08 doesn't list A (archived from 2024-07)"
req PATCH "/api/suppliers/$M9S_A" "$ACCT" '{"archived":false}'
expect_status 200 "restore supplier A"
expect_jq ".archived == false and .archivedFrom == null and .fromPeriod == \"$M9S_CUR\"" "A is restored, listed from this month on"
m9s_month 2024-04
m9s_line "$M9S_A" '.state == "waiting" and .saved == true' "2024-04 (before the archive) keeps listing A"
m9s_month 2024-05
m9s_line "$M9S_A" ".state == \"have\" and .updatedAt == \"$M9S_UPD\"" "2024-05 keeps A's own line, untouched"
m9s_month 2024-07
m9s_absent "$M9S_A" "the restore added no line to 2024-07 (archived)"
m9s_month 2024-08
m9s_absent "$M9S_A" "nor to 2024-08"
m9s_month "$M9S_PREV"
m9s_absent "$M9S_A" "nor to the previous month"
m9s_month "$M9S_CUR"
m9s_line "$M9S_A" '.state == "waiting" and .saved == false' "the current month lists A again (no line yet)"
req GET "/api/audit?entityType=supplier&entityId=$M9S_A&limit=100" "$ADMIN"
expect_status 200 "A's audit"
expect_jq "[.rows[] | select(.action == \"supplier.update\" and .after.fromPeriod != null)] | length == 1 and (.[0] | .before.fromPeriod == \"2024-03\" and .before.archivedFrom == \"2024-07\" and .after.fromPeriod == \"$M9S_CUR\" and .after.archivedFrom == null)" "the restore's audit has fromPeriod and archivedFrom before and after"

echo "--- file ---"
printf '%s\n' '%PDF-1.4' '1 0 obj' '<< >>' 'endobj' 'trailer' '<< >>' '%%EOF' > "$WORK/m9s-statement.pdf"
printf 'M9 plain text\n' > "$WORK/m9s-note.txt"
m9s_upload "$ACCT" 2024-05 "$M9S_A" "$WORK/m9s-statement.pdf" "M9 statement.pdf" application/pdf
expect_status 201 "attach a PDF to A's 2024-05 line"
expect_jq '.file.name == "M9 statement.pdf" and .file.mime == "application/pdf" and (.file.url | startswith("/api/files/")) and .state == "have"' "the line has the file"
M9S_F1=$(jqr '.file.id')
req GET "/api/files/$M9S_F1" "$ACCT"
expect_status 200 "acct downloads the statement"
expect_eq "$(hdr content-type)" "application/pdf" "the statement's Content-Type"
req GET "/api/files/$M9S_F1" "$SCHED"
expect_status 404 "sched can't download the statement (404)"
m9s_upload "$ACCT" 2024-05 "$M9S_A" "$WORK/m9s-statement.pdf" "M9 statement 2.pdf" application/pdf
expect_status 201 "attach a second PDF (replaces the first)"
expect_jq ".file.name == \"M9 statement 2.pdf\" and .file.id != $M9S_F1" "the line has the second file"
M9S_F2=$(jqr '.file.id')
req GET "/api/files/$M9S_F1" "$ACCT"
expect_status 404 "the replaced file is gone"
expect_eq "$(m9s_file_removed "$M9S_F1")" 1 "the replaced file is soft-removed (removed_at set)"
m9s_upload "$ACCT" 2024-05 "$M9S_A" "$WORK/m9s-note.txt" "M9 note.txt" text/plain
expect_status 400 "a .txt statement"
m9s_upload "$SCHED" 2024-05 "$M9S_A" "$WORK/m9s-statement.pdf" "M9 sched.pdf" application/pdf
expect_status 403 "sched attaches a statement"
m9s_upload "$ACCT" 2024-04 "$M9S_B" "$WORK/m9s-statement.pdf" "M9 unlisted.pdf" application/pdf
expect_status 404 "attach to a supplier not listed that month"
# Remove names the file the caller saw (?fileId): the replaced one is refused and nothing goes.
req DELETE "/api/suppliers/months/2024-05/$M9S_A/file?fileId=$M9S_F1" "$ACCT"
expect_status 409 "remove the statement that was replaced meanwhile"
expect_jq ".error == \"This statement was replaced meanwhile; reload the line\" and .line.file.id == $M9S_F2" "the replaced sentence and the line with the current file"
req GET "/api/files/$M9S_F2" "$ACCT"
expect_status 200 "the current statement is still there"
expect_eq "$(m9s_file_removed "$M9S_F2")" 0 "the current statement isn't removed"
req DELETE "/api/suppliers/months/2024-05/$M9S_A/file?fileId=x1" "$ACCT"
expect_status 400 "a fileId that isn't a positive whole number"
req DELETE "/api/suppliers/months/2024-05/$M9S_A/file?fileId=$M9S_F2" "$ACCT"
expect_status 200 "remove the statement (with its fileId)"
expect_jq '.file == null and .state == "have"' "the line has no file"
req GET "/api/files/$M9S_F2" "$ACCT"
expect_status 404 "the removed file is gone"
expect_eq "$(m9s_file_removed "$M9S_F2")" 1 "the removed file is soft-removed (removed_at set)"
req DELETE "/api/suppliers/months/2024-05/$M9S_A/file?fileId=$M9S_F2" "$ACCT"
expect_status 404 "remove with a fileId when there is no file"
# Without ?fileId, Remove removes whatever is there (as before).
m9s_upload "$ACCT" 2024-05 "$M9S_A" "$WORK/m9s-statement.pdf" "M9 statement 3.pdf" application/pdf
expect_status 201 "attach a third PDF"
M9S_F3=$(jqr '.file.id')
req DELETE "/api/suppliers/months/2024-05/$M9S_A/file" "$ACCT"
expect_status 200 "remove the statement without a fileId"
expect_jq '.file == null' "the line has no file"
expect_eq "$(m9s_file_removed "$M9S_F3")" 1 "the third file is soft-removed"
req DELETE "/api/suppliers/months/2024-05/$M9S_A/file" "$ACCT"
expect_status 404 "remove when there is no file"

echo "--- the round-up line ---"
m9s_month "$M9S_PREV"
m9s_line "$M9S_B" '.state == "waiting"' "B is listed and waiting in the previous month"
m9s_newest_roundup "$ACCT"
M9S_RU0=$(printf '%s' "$M9S_RU" | jq -r '.id // 0')
req POST /api/notifications/roundup/run "$ADMIN" '{}'
expect_status 200 "admin runs the round-up"
expect_jq ".summary.statementsPeriod == \"$M9S_PREV\" and .summary.statementsWaitingCount >= 1 and .sent > 0" "the summary counts the waiting statements"
M9S_OTHERS=$(jqr '.summary.dueCount + .summary.overdueCount + .summary.notMyobCount + .summary.needsValueCount')
if [ "$M9S_OTHERS" = 0 ]; then M9S_LINK="/suppliers.html?period=$M9S_PREV"; else M9S_LINK="/accounts.html"; fi
m9s_newest_roundup "$ACCT"
M9S_RU1=$M9S_RU
printf '%s' "$M9S_RU1" | jq -e --arg m "$M9S_PREV_NAME" --arg l "$M9S_LINK" --argjson old "$M9S_RU0" \
  '.id > $old and (.body | contains("still waiting for " + $m + ".")) and (.title | test("[0-9]+ statements? waiting")) and .link == $l' >/dev/null \
  || fail "acct's newest round-up has the statements line: $M9S_RU1"
ok
M9S_RU1_ID=$(printf '%s' "$M9S_RU1" | jq -r '.id')
# Every line still waiting in the previous month becomes Have, so the count is 0.
m9s_month "$M9S_PREV"
M9S_WAITING=$(jqr '.lines[] | select(.state == "waiting") | "\(.supplier.id) \(.updatedAt // "null")"')
while read -r M9S_SID M9S_SUPD; do
  [ -n "$M9S_SID" ] || continue
  if [ "$M9S_SUPD" = null ]; then M9S_U=null; else M9S_U="\"$M9S_SUPD\""; fi
  req PUT "/api/suppliers/months/$M9S_PREV/$M9S_SID" "$ACCT" "{\"state\":\"have\",\"updatedAt\":$M9S_U}"
  expect_status 200 "mark supplier $M9S_SID Have for $M9S_PREV"
done <<<"$M9S_WAITING"
m9s_month "$M9S_PREV"
expect_jq '.counts.waiting == 0' "nothing waiting in the previous month"
req POST /api/notifications/roundup/run "$ADMIN" '{}'
expect_status 200 "admin runs the round-up again"
expect_jq '.summary.statementsWaitingCount == 0' "no statements waiting"
M9S_SENT2=$(jqr '.sent')
m9s_newest_roundup "$ACCT"
M9S_RU2=$M9S_RU
if [ "$M9S_SENT2" -gt 0 ]; then
  printf '%s' "$M9S_RU2" | jq -e --argjson old "$M9S_RU1_ID" \
    '.id > $old and (.body | contains("still waiting for") | not) and (.title | contains("waiting") | not)' >/dev/null \
    || fail "the new round-up has no statements line: $M9S_RU2"
else
  printf '%s' "$M9S_RU2" | jq -e --argjson old "$M9S_RU1_ID" '.id == $old' >/dev/null \
    || fail "no new round-up when every count is 0: $M9S_RU2"
fi
ok

echo "--- audit ---"
req GET "/api/audit?entityType=supplier_statement&entityId=$M9S_A:2024-05&limit=100" "$ADMIN"
expect_status 200 "the line's audit"
expect_jq '[.rows[].action] | (index("supplier_statement.update") != null) and (index("supplier_statement.file") != null)' "supplier_statement.update and supplier_statement.file"
expect_jq '[.rows[] | select(.action == "supplier_statement.update")] | last | .before.state == "waiting" and .after.state == "have" and .after.totalCents == 50000 and (.after | has("paid") | not)' "the update holds only the changed fields"
req GET "/api/audit?entityType=supplier&entityId=$M9S_A&limit=100" "$ADMIN"
expect_jq '[.rows[].action] | (index("supplier.create") != null) and (index("supplier.update") != null)' "supplier.create and supplier.update"

echo "Supplier accounts smoke test passed."
