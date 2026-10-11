# M4 smoke, Wave 1 C: the report library and private files.
# Sourced by ci/smoke.sh after the M3 suites, so it shares that script's helpers
# (step, req, hdr, expect_*, jqr, create_user, login, new_jar), the cookie jars
# ($ADMIN $SCHED $ACCT $DPM $SHOW), $WORK, $BASE, $REQ_ORIGIN, $BODY_FILE, $HDR_FILE
# and $CONTAINER. Not run on its own. It does not assume a pristine database: it
# uploads its own reports and checks only those.

# ============================================================================
step "m4-c. report library and files"
# ============================================================================

# m4c_db SQL: first column of the first row from the live database (read-only).
m4c_db() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db", { readonly: true });
const row = d.prepare(process.argv[1]).get();
console.log(row ? String(Object.values(row)[0]) : "");
' "$1" | tr -d '\r'
}

# m4c_month N: the Sydney month N months before the current one, YYYY-MM.
m4c_month() {
  date -u -d "$(TZ=Australia/Sydney date +%Y-%m)-01 -$1 month" +%Y-%m
}

# m4c_month_ahead: the month after the current Sydney month (not allowed for a report).
m4c_month_ahead() {
  date -u -d "$(TZ=Australia/Sydney date +%Y-%m)-01 +1 month" +%Y-%m
}

# m4c_upload JAR FILE NAME PERIOD CATEGORY TITLE: multipart POST /api/reports of FILE sent
# under the file name NAME (the declared type is deliberately a lie). Sets STATUS and BODY.
m4c_upload() {
  local jar=$1 file=$2 name=$3 period=$4 category=$5 title=$6
  LAST_REQ="POST /api/reports ($name)"
  STATUS=$(curl -s -o "$BODY_FILE" -w '%{http_code}' -H "Origin: $REQ_ORIGIN" -b "$jar" \
    -F "period=$period" -F "category=$category" --form-string "title=$title" --form-string "notes=ci notes" \
    -F "file=@$file;filename=$name;type=image/png" "$BASE/api/reports")
  BODY=$(cat "$BODY_FILE")
}

# m4c_part_files: sets M4C_PARTS, the number of unfinished (.part) files in the private folder.
m4c_part_files() {
  M4C_PARTS=$(docker exec "$CONTAINER" sh -c 'ls /data/uploads/files | grep -c "\.part$"' | tr -d ' \r' || true)
  [ -n "$M4C_PARTS" ] || M4C_PARTS=0
}

# The test files. Each starts with the bytes its type needs.
printf '%%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%%%EOF\n' > "$WORK/m4c.pdf"
printf 'PK\003\004 ci spreadsheet bytes' > "$WORK/m4c.xlsx"
printf 'date,amount\n2026-01-01,10.00\n' > "$WORK/m4c.csv"
printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > "$WORK/m4c.svg"
printf '<html><body><script>alert(1)</script></body></html>' > "$WORK/m4c.html"
printf 'MZ\220\000\003\000\000\000 not really an exe' > "$WORK/m4c.exe"
printf '\211PNG\r\n\032\n ci png bytes' > "$WORK/m4c-fake.png"

M4C_THIS=$(m4c_month 0)
M4C_PREV=$(m4c_month 1)
M4C_PREV2=$(m4c_month 2)
M4C_PREV3=$(m4c_month 3)
M4C_NEXT=$(m4c_month_ahead)

echo "--- access ---"
for j in "$SCHED" "$DPM" "$SHOW"; do
  req GET /api/reports "$j"
  expect_status 403 "GET /api/reports without accounts.view"
done
req GET /api/reports "$ACCT"
expect_status 200 "acct GET /api/reports"
expect_jq 'has("rows") and has("years")' "the list has rows and years"
req GET /reports.html "$ACCT"
expect_status 200 "acct GET /reports.html"
req GET /reports.html "$SCHED"
expect_status 403 "sched GET /reports.html"
req GET /reports.html "$SHOW"
expect_status 403 "show GET /reports.html"
m4c_upload "$DPM" "$WORK/m4c.pdf" "m4c-dpm.pdf" "$M4C_PREV" bas "dpm report"
expect_status 403 "dpm POST /api/reports"
m4c_upload "$SHOW" "$WORK/m4c.pdf" "m4c-show.pdf" "$M4C_PREV" bas "show report"
expect_status 403 "show POST /api/reports"

echo "--- uploads: the allowed types ---"
m4c_upload "$ACCT" "$WORK/m4c.pdf" "bas-m4c.pdf" "$M4C_PREV" bas "M4C BAS"
expect_status 201 "acct uploads a PDF"
expect_jq ".period == \"$M4C_PREV\" and .category == \"bas\" and .title == \"M4C BAS\" and .notes == \"ci notes\"" "the report echoes its fields"
expect_jq '.canEdit == true and .uploadedBy.name == "CI Accounts" and .file.name == "bas-m4c.pdf"' "the uploader can edit; the file keeps its name"
expect_jq '.file.url == "/api/files/\(.file.id)" and (.file.size > 0)' "the file link points at /api/files/:id"
M4C_PDF=$(jqr '.id')
M4C_PDF_FILE=$(jqr '.file.id')
m4c_upload "$ACCT" "$WORK/m4c.xlsx" "payroll-m4c.xlsx" "$M4C_PREV2" payroll "M4C Payroll"
expect_status 201 "acct uploads an xlsx"
M4C_XLSX=$(jqr '.id')
M4C_XLSX_FILE=$(jqr '.file.id')
m4c_upload "$ACCT" "$WORK/m4c.csv" "bank-m4c.csv" "$M4C_PREV3" bank_reconciliation "M4C Bank"
expect_status 201 "acct uploads a csv"
M4C_CSV=$(jqr '.id')

echo "--- uploads: what is refused ---"
m4c_part_files
M4C_PARTS_BEFORE=$M4C_PARTS
m4c_upload "$ACCT" "$WORK/m4c.svg" "evil.svg" "$M4C_PREV" other "svg"
expect_status 400 "an .svg is refused"
m4c_upload "$ACCT" "$WORK/m4c.html" "evil.html" "$M4C_PREV" other "html"
expect_status 400 "an .html is refused"
m4c_upload "$ACCT" "$WORK/m4c.exe" "evil.exe" "$M4C_PREV" other "exe"
expect_status 400 "an .exe (MZ bytes) is refused"
m4c_upload "$ACCT" "$WORK/m4c.html" "evil.pdf" "$M4C_PREV" other "html as pdf"
expect_status 400 "html bytes named .pdf are refused"
m4c_upload "$ACCT" "$WORK/m4c-fake.png" "wrong.pdf" "$M4C_PREV" other "png as pdf"
expect_status 400 "png bytes named .pdf are refused"
m4c_upload "$ACCT" "$WORK/m4c.pdf" "future.pdf" "$M4C_NEXT" other "future"
expect_status 400 "a future month is refused"
m4c_upload "$ACCT" "$WORK/m4c.pdf" "badmonth.pdf" "2026-13" other "bad month"
expect_status 400 "month 13 is refused"
m4c_upload "$ACCT" "$WORK/m4c.pdf" "badcat.pdf" "$M4C_PREV" payslips "bad category"
expect_status 400 "an unknown category is refused"
m4c_upload "$ACCT" "$WORK/m4c.pdf" "notitle.pdf" "$M4C_PREV" other "   "
expect_status 400 "a blank title is refused"
# No file at all.
STATUS=$(curl -s -o "$BODY_FILE" -w '%{http_code}' -H "Origin: $REQ_ORIGIN" -b "$ACCT" \
  -F "period=$M4C_PREV" -F "category=other" -F "title=no file" "$BASE/api/reports")
BODY=$(cat "$BODY_FILE")
expect_status 400 "a request with no file is refused"
# Over 25 MB (exactly 25 MB is allowed: multer refuses only beyond the limit).
head -c 26214401 /dev/zero > "$WORK/m4c-big.bin"
printf '%%PDF-' | dd of="$WORK/m4c-big.bin" conv=notrunc 2>/dev/null
m4c_upload "$ACCT" "$WORK/m4c-big.bin" "big.pdf" "$M4C_PREV" other "too big"
expect_status 400 "a file over 25 MB is refused"
expect_jq '.error | test("too big")' "the refusal says the file is too big"
rm -f "$WORK/m4c-big.bin"
m4c_part_files
expect_eq "$M4C_PARTS" "$M4C_PARTS_BEFORE" "the refusals left no .part files behind"
expect_eq "$(m4c_db "SELECT COUNT(*) FROM reports WHERE title IN ('svg','html','exe','html as pdf','png as pdf','future','bad month','bad category','no file','too big')")" "0" \
  "no report was created by a refused upload"

echo "--- the list ---"
req GET /api/reports "$ACCT"
expect_status 200 "acct lists the reports"
expect_jq "[.rows[].id] as \$ids | (\$ids | index($M4C_PDF)) as \$a | (\$ids | index($M4C_XLSX)) as \$b | (\$ids | index($M4C_CSV)) as \$c | \$a != null and \$b != null and \$c != null and \$a < \$b and \$b < \$c" \
  "newest period first"
expect_jq "(.years | length > 0) and (.years == (.years | sort | reverse)) and (.years | index(\"${M4C_PREV:0:4}\") != null)" "years lists the report years, newest first"
expect_jq ".rows[] | select(.id == $M4C_PDF) | .canEdit == true" "acct can edit their own report"
req GET /api/reports "$ADMIN"
expect_status 200 "admin lists the reports"
expect_jq ".rows[] | select(.id == $M4C_PDF) | .canEdit == true" "admin can edit any report"
req GET "/api/reports?year=${M4C_PREV:0:4}&category=bas" "$ACCT"
expect_status 200 "year and category filter"
expect_jq "(.rows | map(.id) | index($M4C_PDF)) != null and (.rows | all(.category == \"bas\" and (.period | startswith(\"${M4C_PREV:0:4}\")))) and ((.rows | map(.id) | index($M4C_XLSX)) == null)" \
  "the filter keeps only that year and category"
req GET "/api/reports?year=abcd" "$ACCT"
expect_status 400 "a bad year is refused"
req GET "/api/reports?category=nope" "$ACCT"
expect_status 400 "a bad category is refused"

echo "--- downloads ---"
req GET "/api/files/$M4C_PDF_FILE" "$ADMIN"
expect_status 200 "admin downloads the PDF"
expect_eq "$(hdr content-type)" "application/pdf" "the PDF is served as application/pdf"
case "$(hdr content-disposition)" in inline*) ok ;; *) fail "the PDF should be inline, got: $(hdr content-disposition)" ;; esac
expect_eq "$(hdr x-content-type-options)" "nosniff" "nosniff on the PDF"
expect_eq "$(hdr cache-control)" "private, no-store" "no caching of the PDF"
req GET "/api/files/$M4C_XLSX_FILE" "$ADMIN"
expect_status 200 "admin downloads the xlsx"
case "$(hdr content-disposition)" in attachment*payroll-m4c.xlsx*) ok ;; *) fail "the xlsx should be an attachment named payroll-m4c.xlsx, got: $(hdr content-disposition)" ;; esac
expect_eq "$(hdr content-security-policy)" "sandbox" "sandbox CSP on the xlsx"
expect_eq "$(hdr x-content-type-options)" "nosniff" "nosniff on the xlsx"
req GET "/api/files/$M4C_PDF_FILE" "$ACCT"
expect_status 200 "acct downloads the PDF"
for fid in "$M4C_PDF_FILE" "$M4C_XLSX_FILE"; do
  req GET "/api/files/$fid" "$SCHED"
  expect_status 404 "sched GET /api/files/$fid"
  req GET "/api/files/$fid" "$SHOW"
  expect_status 404 "show GET /api/files/$fid"
done
req GET "/api/files/999999" "$ADMIN"
expect_status 404 "an unknown file is 404"

echo "--- the /photos hole stays closed ---"
M4C_STORED=$(m4c_db "SELECT stored_name FROM files WHERE id = $M4C_PDF_FILE")
case "$M4C_STORED" in *.pdf) ok ;; *) fail "the stored name should end in .pdf, got '$M4C_STORED'" ;; esac
req GET "/photos/files/$M4C_STORED" "$ADMIN"
expect_status 404 "admin GET /photos/files/<stored name>"
req GET "/photos/$M4C_STORED" "$ADMIN"
expect_status 404 "admin GET /photos/<stored name>"

echo "--- edit and remove ---"
create_user m4c2 "CI Accounts Two" 'M4c2-Passw0rd-1' accounts
M4C_ACCT2="$WORK/jar-m4c2"
new_jar "$M4C_ACCT2"
login "$M4C_ACCT2" m4c2 'M4c2-Passw0rd-1'
expect_status 200 "login the second accounts user"
req GET /api/reports "$M4C_ACCT2"
expect_status 200 "the second accounts user sees every report (decision 3)"
expect_jq ".rows[] | select(.id == $M4C_PDF) | .canEdit == false" "the second user can't edit someone else's report"
req PATCH "/api/reports/$M4C_PDF" "$M4C_ACCT2" '{"title":"hijacked"}'
expect_status 403 "another accounts user PATCHes the report"
req DELETE "/api/reports/$M4C_PDF" "$M4C_ACCT2"
expect_status 403 "another accounts user DELETEs the report"
req PATCH "/api/reports/$M4C_PDF" "$DPM" '{"title":"hijacked"}'
expect_status 403 "dpm PATCH"
req PATCH "/api/reports/$M4C_PDF" "$ACCT" "{\"title\":\"M4C BAS edited\",\"category\":\"other\",\"period\":\"$M4C_PREV2\"}"
expect_status 200 "the uploader PATCHes their report"
expect_jq ".title == \"M4C BAS edited\" and .category == \"other\" and .period == \"$M4C_PREV2\"" "the edit shows"
req PATCH "/api/reports/$M4C_PDF" "$ACCT" "{\"period\":\"$M4C_NEXT\"}"
expect_status 400 "a PATCH to a future month is refused"
req PATCH "/api/reports/$M4C_PDF" "$ACCT" '{"title":""}'
expect_status 400 "a PATCH to a blank title is refused"
req PATCH "/api/reports/999999" "$ACCT" '{"title":"x"}'
expect_status 404 "PATCH of an unknown report"
expect_eq "$(m4c_db "SELECT COUNT(*) FROM audit_log WHERE action = 'report.create' AND entity_id = '$M4C_PDF'")" "1" "the upload is audited"
expect_eq "$(m4c_db "SELECT COUNT(*) FROM audit_log WHERE action = 'report.update' AND entity_id = '$M4C_PDF'")" "1" "the edit is audited"

req DELETE "/api/reports/$M4C_PDF" "$ADMIN"
expect_status 204 "admin removes the report"
req GET /api/reports "$ACCT"
expect_status 200 "list after the removal"
expect_jq "(.rows | map(.id) | index($M4C_PDF)) == null" "the removed report is gone from the list"
req GET "/api/files/$M4C_PDF_FILE" "$ADMIN"
expect_status 404 "the removed report's file is 404, even for admin"
req DELETE "/api/reports/$M4C_PDF" "$ADMIN"
expect_status 404 "removing it again is 404"
req PATCH "/api/reports/$M4C_PDF" "$ADMIN" '{"title":"back"}'
expect_status 404 "editing a removed report is 404"
expect_eq "$(m4c_db "SELECT COUNT(*) FROM audit_log WHERE action = 'report.remove' AND entity_id = '$M4C_PDF'")" "1" "the removal is audited"
expect_eq "$(m4c_db "SELECT COUNT(*) FROM files WHERE id = $M4C_PDF_FILE AND removed_at IS NOT NULL")" "1" "the file row is soft-removed"

echo "--- the other reports are untouched ---"
req GET "/api/files/$M4C_XLSX_FILE" "$ACCT"
expect_status 200 "the xlsx still downloads after the PDF was removed"
req DELETE "/api/reports/$M4C_XLSX" "$ACCT"
expect_status 204 "the uploader removes their own report"
req DELETE "/api/reports/$M4C_CSV" "$ACCT"
expect_status 204 "the uploader removes the csv report"
