# M9 smoke, Wave 1 A: BAS sales by month, typed in by hand (Todd, 2026-10-16: invoices no longer
# count), the blank months, the sums, lodging, the comparison and the CSV. Sourced by ci/smoke.sh
# after the M8 suites, so it shares that script's helpers (step, req, hdr, expect_status,
# expect_jq, expect_eq, jqr, fail, ok), the cookie jars ($ADMIN $SCHED $ACCT $DPM $SHOW $WSHOP),
# $BASE and $CONTAINER. No shebang and no `set`: the caller owns both. It works in 2024 months
# (before cutover, after HISTORY_START, never touched by other suites) and the current month, and
# starts by clearing the 2024 months it uses. Made-up names and amounts only (this repo is
# public). It clears what it enters and reopens what it lodges. Contract: docs/plans/m9-contracts.md
# sections 3, 5, 6, 10.2 and the 2026-10-16 note at its end.

# ============================================================================
step "m9-bas. BAS sales by month"
# ============================================================================

M9B_TODAY=$(TZ=Australia/Sydney date +%F)
M9B_CUR=${M9B_TODAY:0:7}
M9B_NEXT=$(date -u -d "$M9B_CUR-01 + 1 month" +%Y-%m)
M9B_YEAR=$((10#${M9B_TODAY:0:4}))
M9B_MON=$((10#${M9B_TODAY:5:2}))
if [ "$M9B_MON" -ge 7 ]; then M9B_FY=$((M9B_YEAR + 1)); else M9B_FY=$M9B_YEAR; fi
# months of the current financial year up to and including this one
M9B_ELAPSED=$(((M9B_MON + 5) % 12 + 1))
M9B_CLIENT="=M9 Formula Client"
M9B_JOBNAME="M9 BAS Test Job"

# Run SQL against the live database through the container's own better-sqlite3.
m9b_db_exec() { # SQL
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.exec(process.argv[1]);
d.close();
' "$1"
}

# GET a month's detail as acct -> BODY.
m9b_month() { # PERIOD
  req GET "/api/bas/months/$1" "$ACCT"
  expect_status 200 "GET /api/bas/months/$1"
}

# PUT a month's sales as acct (status not checked).
m9b_sales() { # PERIOD JSON
  req PUT "/api/bas/months/$1/sales" "$ACCT" "$2"
}

# Issue as acct; sets the business details first if no earlier suite has. -> M9B_NUM
m9b_issue() { # INVOICE_ID
  req POST "/api/invoices/$1/issue" "$ACCT" '{}'
  if [ "$STATUS" = 409 ] && [[ $BODY == *"Business details"* ]]; then
    req PUT /api/settings "$ADMIN" \
      '{"business":{"tradingName":"Crosscuts CI Joinery","abn":"51824753556","address":"1 Workshop Rd, Sydney NSW 2000","phone":"0200000000","email":"accounts@example.test","bankAccountName":"Crosscuts CI","bsb":"062000","accountNumber":"12345678"},"invoice":{"termsText":"Payment within 10 days."}}'
    expect_status 200 "admin sets the business details"
    req POST "/api/invoices/$1/issue" "$ACCT" '{}'
  fi
  expect_status 200 "issue invoice $1"
  M9B_NUM=$(jqr '.number')
  M9B_ISSUED=$(jqr '.issueDate')
}

# The number of audit rows of one action on one BAS month -> M9B_AUDITS. Not run in a subshell,
# so the helpers' counters and fail keep working.
m9b_audits() { # ACTION PERIOD
  req GET "/api/audit?action=$1&entityType=bas_month&entityId=$2&limit=1" "$ADMIN"
  expect_status 200 "GET /api/audit?action=$1"
  M9B_AUDITS=$(jqr '.total')
}

# Start clean: none of the 2024 months this suite uses has a figure or is lodged.
m9b_db_exec "DELETE FROM bas_months WHERE period IN ('2024-08','2024-09','2024-10')"

echo "--- access ---"
req GET /api/bas "$ACCT"
expect_status 200 "acct GET /api/bas"
req GET /api/bas "$ADMIN"
expect_status 200 "admin GET /api/bas"
for M9B_J in "$SCHED" "$DPM" "$SHOW" "$WSHOP"; do
  req GET /api/bas "$M9B_J"
  expect_status 403 "GET /api/bas without accounts.view"
  req GET "/api/bas/sales.csv?fy=2025" "$M9B_J"
  expect_status 403 "GET the CSV without accounts.view"
done
req PUT /api/bas/months/2024-09/sales "$SCHED" '{"salesCents":100,"gstCents":null,"note":""}'
expect_status 403 "sched PUT a month's sales"
req PUT /api/bas/months/2024-09/sales "$DPM" '{"salesCents":100,"gstCents":null,"note":""}'
expect_status 403 "dpm PUT a month's sales"
req GET /bas.html "$ACCT"
expect_status 200 "acct GET /bas.html"
req GET /bas.html "$SCHED"
expect_status 403 "sched GET /bas.html"
req POST /api/bas/months/2024-08/reopen "$ACCT" '{}'
expect_status 403 "acct reopens a month (admin only)"
req PUT /api/bas/months/2024-09/hand "$ACCT" '{"handCents":100}'
expect_status 404 "the old hand route is gone"
req GET /api/bas/months/2024-09/invoices.csv "$ACCT"
expect_status 404 "the old per-invoice CSV route is gone"

echo "--- year shape: every month up to now is listed, blank until entered ---"
req GET /api/bas "$ACCT"
expect_jq ".fy == $M9B_FY and .currentFy == $M9B_FY and .firstFy == 2023 and (.months | length == 12)" "the default year is the current FY"
expect_jq "([.months[] | select(.future == false)] | length) == $M9B_ELAPSED and ([.months[] | select(.future == true)] | length) == (12 - $M9B_ELAPSED)" "the months up to the current one are listed, the rest are future"
expect_jq ".months | all(.figures | has(\"entered\") and has(\"salesCents\") and has(\"gstCents\") and has(\"exGstCents\") and has(\"note\"))" "every month row carries the figures"
expect_jq "[.months[] | select(.period == \"$M9B_CUR\")][0] | .future == false and .figures.entered == false and .figures.salesCents == null" "the current month is there, blank, with no entry"
expect_jq '[.months[] | select(.future == true)] | all(.figures.entered == false and .figures.salesCents == null)' "future months are blank"
req GET "/api/bas?fy=2025" "$ACCT"
expect_status 200 "GET /api/bas?fy=2025"
expect_jq '.fy == 2025 and .label == "FY 2025" and (.months | length == 12) and .months[0].period == "2024-07" and .months[11].period == "2025-06"' "FY 2025 runs 2024-07 to 2025-06"
expect_jq '(.quarters | length == 4) and ([.quarters[].q] == [1,2,3,4]) and (.total | has("salesCents") and has("gstCents") and has("exGstCents") and has("enteredCount") and has("lodgedCount"))' "four quarters and a total"
expect_jq '.months[2] | .period == "2024-09" and .label == "Sep 2024" and .quarter == 1 and .future == false and .figures.entered == false and .figures.salesCents == null and has("lodged")' "the month row shape"
expect_jq '(.months[2] | has("invoiceCount") | not) and (.months[2].figures | has("invoiceCount") | not) and (.months[2] | has("live") | not) and (.months[2] | has("changed") | not)' "no invoice, live or changed fields"
expect_jq '.quarters[0].salesCents == null and .quarters[0].enteredCount == 0 and .total.salesCents == null and .total.enteredCount == 0' "nothing entered: the sums are blank"
# A row before HISTORY_START can't be made through the API; made with SQL, then removed.
m9b_db_exec "DELETE FROM bas_months WHERE period = '2023-02'; INSERT INTO bas_months (period, hand_cents, hand_gst_cents, hand_note) VALUES ('2023-02', 77700, NULL, 'M9 pre-history')"
req GET "/api/bas?fy=2023" "$ACCT"
expect_status 200 "GET /api/bas?fy=2023"
expect_jq '([.months[] | select(.period < "2023-06")] | length == 11 and all(.future == false and .figures.entered == false and .figures.salesCents == null)) and .quarters[2].enteredCount == 0 and .total.enteredCount == ([.months[] | select(.figures.entered)] | length)' "FY 2023: the months before Jun 2023 are blank and left out of the sums"
m9b_db_exec "DELETE FROM bas_months WHERE period = '2023-02'"
req GET "/api/bas?fy=2022" "$ACCT"
expect_status 400 "FY 2022 is before the history starts"
expect_jq '.error == "Choose a financial year from FY 2023"' "the from-FY-2023 sentence"
req GET "/api/bas?fy=$((M9B_FY + 1))" "$ACCT"
expect_status 400 "a FY after the current one"

echo "--- invoices no longer count ---"
m9b_month "$M9B_CUR"
expect_jq '.month.figures.entered == false and .month.figures.salesCents == null and (.month | has("live") | not) and (has("invoices") | not) and (has("lodgedInvoices") | not) and (has("changes") | not)' "the current month before: blank, no invoice list"
req POST /api/job-records "$ADMIN" \
  "$(jq -nc --arg n "$M9B_JOBNAME" --arg c "$M9B_CLIENT" '{name:$n, clientName:$c, valueCents:1000000}')"
expect_status 201 "create the M9 BAS job"
M9B_JOB=$(jqr '.id')
req POST /api/invoices "$ACCT" "{\"jobId\":$M9B_JOB,\"kind\":\"deposit\"}"
expect_status 201 "a deposit for the M9 job"
M9B_I1=$(jqr '.id')
m9b_issue "$M9B_I1"
M9B_ISSUED1=$M9B_ISSUED
req POST "/api/invoices/$M9B_I1/paid" "$ACCT" "{\"paidDate\":\"$M9B_ISSUED1\"}"
expect_status 200 "mark the deposit paid today"
m9b_month "$M9B_CUR"
expect_jq '.month.figures.entered == false and .month.figures.salesCents == null and .month.figures.gstCents == null' "a paid invoice adds nothing to its month"
req GET /api/bas "$ACCT"
expect_jq "[.months[] | select(.period == \"$M9B_CUR\")][0].figures.salesCents == null and .total.enteredCount == 0" "nor to the year"
m9b_db_exec "UPDATE invoices SET issue_date = '2024-08-10', paid_date = '2024-08-10' WHERE id = $M9B_I1"
m9b_month 2024-08
expect_jq '.month.figures.entered == false and .month.figures.salesCents == null' "nor when its paid date is moved into a past month"

echo "--- typing a month's sales ---"
m9b_sales 2024-09 '{"salesCents":1234500,"gstCents":null,"note":"M9 history"}'
expect_status 200 "type 2024-09's sales with no GST"
expect_jq '.month.figures.entered == true and .month.figures.salesCents == 1234500 and .month.figures.gstCents == null and .month.figures.exGstCents == null and .month.figures.note == "M9 history"' "2024-09 has its figures; GST and Ex GST are unknown"
req GET "/api/bas?fy=2025" "$ACCT"
expect_jq '.months[2].figures.salesCents == 1234500 and .months[2].figures.entered == true and .months[1].figures.entered == false' "the year table shows it, and the month before stays blank"
expect_jq '.quarters[0].salesCents == 1234500 and .quarters[0].gstCents == null and .quarters[0].exGstCents == null and .quarters[0].enteredCount == 1 and .total.salesCents == 1234500 and .total.gstCents == null' "FY 2025 Q1 and the year have no GST sum while one month has no GST"
m9b_sales 2024-09 '{"salesCents":1234500,"gstCents":112227,"note":"M9 history"}'
expect_status 200 "add the GST to 2024-09"
expect_jq '.month.figures.gstCents == 112227 and .month.figures.exGstCents == 1122273' "Ex GST is the difference"
m9b_audits bas.sales 2024-09
M9B_SALES_AUDITS=$M9B_AUDITS
m9b_sales 2024-09 '{"salesCents":1234500,"gstCents":112227,"note":"M9 history"}'
expect_status 200 "type the same again"
m9b_audits bas.sales 2024-09
expect_eq "$M9B_AUDITS" "$M9B_SALES_AUDITS" "nothing changed, so no audit row"

m9b_sales 2024-08 '{"salesCents":22000,"gstCents":2000,"note":"=M9 Formula Note"}'
expect_status 200 "type 2024-08's sales with GST"
expect_jq '.month.figures.salesCents == 22000 and .month.figures.gstCents == 2000 and .month.figures.exGstCents == 20000 and .prev == "2024-07" and .next == "2024-09"' "2024-08's figures, with prev and next"
req GET "/api/bas?fy=2025" "$ACCT"
expect_jq '.quarters[0].salesCents == 1256500 and .quarters[0].gstCents == 114227 and .quarters[0].exGstCents == 1142273 and .quarters[0].enteredCount == 2 and .total.salesCents == 1256500 and .total.enteredCount == 2' "Q1 and the year add the typed months"

m9b_sales 2024-10 '{"salesCents":0,"gstCents":0,"note":""}'
expect_status 200 "a month with no sales is a real entry of 0"
expect_jq '.month.figures.entered == true and .month.figures.salesCents == 0 and .month.figures.gstCents == 0' "2024-10 is entered at 0"
m9b_sales 2024-10 '{"salesCents":-55000,"gstCents":-5000,"note":"net refunds"}'
expect_status 200 "a negative month (net refunds)"
expect_jq '.month.figures.salesCents == -55000 and .month.figures.exGstCents == -50000' "2024-10 is negative"
m9b_sales 2024-10 '{"salesCents":null,"gstCents":null,"note":""}'
expect_status 200 "clear 2024-10"
expect_jq '.month.figures.entered == false and .month.figures.salesCents == null and .month.figures.note == ""' "2024-10 is blank again"

echo "--- refused entries ---"
m9b_sales 2024-09 '{"salesCents":110000,"gstCents":10001,"note":""}'
expect_status 400 "GST more than a tenth"
expect_jq ".error == \"GST can't be more than a tenth of the sales before GST\"" "the GST sentence"
m9b_sales 2024-09 '{"salesCents":-110000,"gstCents":10000,"note":""}'
expect_status 400 "a negative month with positive GST"
expect_jq '.error == "GST must have the same sign as the sales"' "the GST sign sentence"
m9b_sales 2024-09 '{"salesCents":null,"gstCents":500,"note":""}'
expect_status 400 "GST with no sales"
expect_jq '.error == "Enter the sales for the GST to go with"' "the GST-needs-sales sentence"
m9b_sales 2024-09 '{"salesCents":12.5,"gstCents":null,"note":""}'
expect_status 400 "sales that aren't whole cents"
m9b_sales 2023-05 '{"salesCents":100,"gstCents":null,"note":""}'
expect_status 400 "sales before Jun 2023"
expect_jq '.error == "Sales go from Jun 2023 to this month"' "the range sentence"
m9b_sales "$M9B_NEXT" '{"salesCents":100,"gstCents":null,"note":""}'
expect_status 400 "sales for next month"
req GET "/api/bas/months/$M9B_NEXT" "$ACCT"
expect_status 404 "GET next month"
req GET /api/bas/months/2023-05 "$ACCT"
expect_status 404 "GET a month before the history starts"
m9b_month 2024-09
expect_jq '.month.figures.salesCents == 1234500 and .month.figures.gstCents == 112227' "the refused requests changed nothing"

echo "--- lodging ---"
req POST "/api/bas/months/$M9B_CUR/lodge" "$ACCT" '{}'
expect_status 409 "lodge the current month"
expect_jq '.error == "A month can be lodged once it has ended"' "the ended sentence"
req POST /api/bas/months/2024-10/lodge "$ACCT" '{}'
expect_status 409 "lodge a month with nothing entered"
expect_jq ".error == \"Enter this month's sales before lodging it\"" "the not-entered sentence"
req POST /api/bas/months/2024-08/lodge "$ACCT" '{}'
expect_status 200 "lodge 2024-08"
expect_jq '.month.lodged != null and (.month.lodged.at | type == "string") and (.month.lodged.by.name | type == "string") and .month.figures.salesCents == 22000' "2024-08 is lodged with its figures"
req POST /api/bas/months/2024-08/lodge "$ACCT" '{}'
expect_status 409 "lodge 2024-08 again"
expect_jq '.error == "This month is already lodged"' "the already-lodged sentence"
m9b_sales 2024-08 '{"salesCents":5000,"gstCents":null,"note":""}'
expect_status 409 "type sales for a lodged month"
expect_jq '.error == "This month is lodged; an admin can reopen it"' "the lodged sentence"
m9b_sales 2024-08 '{"salesCents":null,"gstCents":null,"note":""}'
expect_status 409 "clear a lodged month"
m9b_month 2024-08
expect_jq '.month.figures.salesCents == 22000 and .month.lodged != null' "2024-08 is untouched"
req GET "/api/bas?fy=2025" "$ACCT"
expect_jq '.months[1].lodged != null and .months[1].figures.salesCents == 22000 and .quarters[0].lodgedCount == 1 and .total.lodgedCount == 1' "the year shows the lodged month"
req GET /api/bas/compare "$ACCT"
expect_status 200 "GET /api/bas/compare with 2024-08 lodged"
expect_jq '.rows[1].label == "Aug" and .rows[1].values["2025"] == 22000' "the comparison shows 2024-08's figure"
req POST /api/bas/months/2024-08/reopen "$ACCT" '{}'
expect_status 403 "acct reopens 2024-08"
req POST /api/bas/months/2024-08/reopen "$ADMIN" '{}'
expect_status 200 "admin reopens 2024-08"
expect_jq '.month.lodged == null and .month.figures.salesCents == 22000' "reopened: the figure stays, no longer lodged"
req POST /api/bas/months/2024-08/reopen "$ADMIN" '{}'
expect_status 409 "reopen it again"
expect_jq ".error == \"This month isn't lodged\"" "the not-lodged sentence"
m9b_sales 2024-08 '{"salesCents":22000,"gstCents":2000,"note":"=M9 Formula Note"}'
expect_status 200 "a reopened month can be typed again"

echo "--- compare ---"
req GET /api/bas/compare "$ACCT"
expect_status 200 "GET /api/bas/compare"
expect_jq "(.fys | index(2025) != null) and .fys[0] == 2023 and .fys[-1] == $M9B_FY and (.rows | length == 12) and .rows[0].label == \"Jul\" and .rows[11].label == \"Jun\"" "the comparison's years and rows"
expect_jq '.rows[2].label == "Sep" and .rows[2].monthIndex == 2 and .rows[2].values["2025"] == 1234500' "Sep FY 2025 is 2024-09's sales"
expect_jq '.rows[3].label == "Oct" and .rows[3].values["2025"] == null' "a month with nothing entered is blank, not 0"
expect_jq '.rows[0].values["2023"] == null' "Jul 2022 is before the history starts"

echo "--- CSV ---"
req GET "/api/bas/sales.csv?fy=2025" "$ACCT"
expect_status 200 "GET the FY 2025 CSV"
case "$(hdr Content-Type)" in
  text/csv*) ok ;;
  *) fail "the CSV's Content-Type is '$(hdr Content-Type)'" ;;
esac
expect_eq "$(hdr Content-Disposition)" 'attachment; filename="BAS sales FY 2025.csv"' "the CSV's file name"
[[ $BODY == $'\xEF\xBB\xBF'* ]] || fail "the CSV doesn't start with a UTF-8 BOM"
ok
M9B_LINE1=$(printf '%s' "$BODY" | head -n 1 | tr -d '\r')
M9B_LINE1=${M9B_LINE1#$'\xEF\xBB\xBF'}
expect_eq "$M9B_LINE1" "Month,Sales inc GST,GST,Ex GST,Note" "the CSV header"
[[ $BODY == *$'\r\n'* ]] || fail "the CSV lines don't end with CRLF"
ok
M9B_LINES=$(printf '%s' "$BODY" | grep -c $'\r$' || true)
expect_eq "$M9B_LINES" 13 "a header and twelve months"
M9B_ROW=$(printf '%s' "$BODY" | { grep "^Sep 2024," || true; } | tr -d '\r')
expect_eq "$M9B_ROW" "Sep 2024,12345.00,1122.27,11222.73,M9 history" "the Sep 2024 row"
M9B_ROW=$(printf '%s' "$BODY" | { grep "^Aug 2024," || true; } | tr -d '\r')
expect_eq "$M9B_ROW" "Aug 2024,220.00,20.00,200.00,'=M9 Formula Note" "the Aug 2024 row (a formula note is guarded)"
M9B_ROW=$(printf '%s' "$BODY" | { grep "^Oct 2024," || true; } | tr -d '\r')
expect_eq "$M9B_ROW" "Oct 2024,,,," "a month with nothing entered is a blank row"
req GET "/api/bas/sales.csv?fy=2022" "$ACCT"
expect_status 400 "the CSV for a year before the history"

echo "--- audit ---"
req GET "/api/audit?entityType=bas_month&entityId=2024-08&limit=100" "$ADMIN"
expect_status 200 "GET 2024-08's audit"
for M9B_ACT in bas.sales bas.lodge bas.reopen; do
  expect_jq "[.rows[] | .action] | index(\"$M9B_ACT\") != null" "audit has $M9B_ACT"
done

echo "--- tidy ---"
m9b_sales 2024-08 '{"salesCents":null,"gstCents":null,"note":""}'
expect_status 200 "clear the 2024-08 sales"
m9b_sales 2024-09 '{"salesCents":null,"gstCents":null,"note":""}'
expect_status 200 "clear the 2024-09 sales"
m9b_month 2024-09
expect_jq '.month.figures.entered == false and .month.lodged == null' "2024-09 is as it was"
m9b_month 2024-08
expect_jq '.month.lodged == null and .month.figures.entered == false' "2024-08 is not lodged and has no sales"
