# M9 smoke, Wave 1 A: BAS sales by month (cash basis), hand amounts, lodging, the comparison and
# the CSV. Sourced by ci/smoke.sh after the M8 suites, so it shares that script's helpers (step,
# req, hdr, expect_status, expect_jq, expect_eq, jqr, fail, ok), the cookie jars ($ADMIN $SCHED
# $ACCT $DPM $SHOW $WSHOP), $BASE and $CONTAINER. No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: it makes its own job and invoices, works in 2024 months
# (before cutover, after HISTORY_START, never touched by other suites) and the current month, and
# reads figures as differences from what was there before it started. Smoke invoices are issued
# and paid today, so past months are made by moving dates with SQL through the container's own
# better-sqlite3. Made-up names and amounts only (this repo is public). It clears the hand amounts
# it sets and reopens what it lodges. Contract: docs/plans/m9-contracts.md sections 3, 5, 6, 10.2.

# ============================================================================
step "m9-bas. BAS sales by month"
# ============================================================================

M9B_TODAY=$(TZ=Australia/Sydney date +%F)
M9B_CUR=${M9B_TODAY:0:7}
M9B_NEXT=$(date -u -d "$M9B_CUR-01 + 1 month" +%Y-%m)
M9B_TOMORROW=$(date -u -d "$M9B_TODAY + 1 day" +%F)
M9B_YESTERDAY=$(date -u -d "$M9B_TODAY - 1 day" +%F)
M9B_YEAR=$((10#${M9B_TODAY:0:4}))
M9B_MON=$((10#${M9B_TODAY:5:2}))
if [ "$M9B_MON" -ge 7 ]; then M9B_FY=$((M9B_YEAR + 1)); else M9B_FY=$M9B_YEAR; fi
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

# PUT a month's hand amount as acct (status not checked).
m9b_hand() { # PERIOD JSON
  req PUT "/api/bas/months/$1/hand" "$ACCT" "$2"
}

# Issue as acct; sets the business details first if no earlier suite has. -> M9B_NUM, M9B_GST
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
  M9B_GST=$(jqr '.gstCents')
}

# The number of audit rows of one action on one BAS month.
m9b_audits() { # ACTION PERIOD
  req GET "/api/audit?action=$1&entityType=bas_month&entityId=$2&limit=1" "$ADMIN"
  expect_status 200 "GET /api/audit?action=$1"
  jqr '.total'
}

echo "--- access ---"
req GET /api/bas "$ACCT"
expect_status 200 "acct GET /api/bas"
req GET /api/bas "$ADMIN"
expect_status 200 "admin GET /api/bas"
for j in "$SCHED" "$DPM" "$SHOW" "$WSHOP"; do
  req GET /api/bas "$j"
  expect_status 403 "GET /api/bas without accounts.view"
done
req PUT /api/bas/months/2024-09/hand "$SCHED" '{"handCents":100,"handGstCents":null,"handNote":""}'
expect_status 403 "sched PUT a hand amount"
req PUT /api/bas/months/2024-09/hand "$DPM" '{"handCents":100,"handGstCents":null,"handNote":""}'
expect_status 403 "dpm PUT a hand amount"
req GET /bas.html "$ACCT"
expect_status 200 "acct GET /bas.html"
req GET /bas.html "$SCHED"
expect_status 403 "sched GET /bas.html"
req POST /api/bas/months/2024-08/reopen "$ACCT" '{}'
expect_status 403 "acct reopens a month (admin only)"

echo "--- year shape ---"
req GET /api/bas "$ACCT"
expect_jq ".fy == $M9B_FY and .currentFy == $M9B_FY and .firstFy == 2023 and (.months | length == 12)" "the default year is the current FY"
req GET "/api/bas?fy=2025" "$ACCT"
expect_status 200 "GET /api/bas?fy=2025"
expect_jq '.fy == 2025 and .label == "FY 2025" and (.months | length == 12) and .months[0].period == "2024-07" and .months[11].period == "2025-06"' "FY 2025 runs 2024-07 to 2025-06"
expect_jq '(.quarters | length == 4) and ([.quarters[].q] == [1,2,3,4]) and (.total | has("salesCents") and has("gstCents") and has("exGstCents") and has("invoiceCount") and has("lodgedCount"))' "four quarters and a total"
expect_jq '.months[2] | .period == "2024-09" and .label == "Sep 2024" and .quarter == 1 and .future == false and (.figures | has("kind") and has("salesCents") and has("notInMyobCount")) and (.live | has("kind")) and has("lodged") and has("changed")' "the month row shape"
req GET "/api/bas?fy=2022" "$ACCT"
expect_status 400 "FY 2022 is before the history starts"
expect_jq '.error == "Choose a financial year from FY 2023"' "the from-FY-2023 sentence"
req GET "/api/bas?fy=$((M9B_FY + 1))" "$ACCT"
expect_status 400 "a FY after the current one"

echo "--- before: the figures already there ---"
m9b_month "$M9B_CUR"
M9B_C_CNT=$(jqr '.month.live.invoiceCount')
M9B_C_SALES=$(jqr '.month.live.salesCents')
M9B_C_GST=$(jqr '.month.live.gstCents')
m9b_month 2024-08
expect_jq '.month.lodged == null' "2024-08 is not lodged before the suite"
M9B_A_CNT=$(jqr '.month.live.invoiceCount')
M9B_A_SALES=$(jqr '.month.live.salesCents')
M9B_A_GST=$(jqr '.month.live.gstCents')
m9b_month 2024-09
M9B_S_SALES=$(jqr '.month.live.salesCents')
m9b_month 2024-10
M9B_O_CNT=$(jqr '.month.live.invoiceCount')

echo "--- cash basis: only paid invoices, by paid date ---"
req POST /api/job-records "$ADMIN" \
  "$(jq -nc --arg n "$M9B_JOBNAME" --arg c "$M9B_CLIENT" '{name:$n, clientName:$c, valueCents:1000000}')"
expect_status 201 "create the M9 BAS job"
M9B_JOB=$(jqr '.id')
req POST /api/invoices "$ACCT" "{\"jobId\":$M9B_JOB,\"kind\":\"deposit\"}"
expect_status 201 "a deposit for the M9 job"
M9B_I1=$(jqr '.id')
req POST /api/invoices "$ACCT" "{\"jobId\":$M9B_JOB,\"kind\":\"progress\"}"
expect_status 201 "a progress invoice for the M9 job"
M9B_I2=$(jqr '.id')
m9b_issue "$M9B_I1"
M9B_N1=$M9B_NUM
M9B_G1=$M9B_GST
m9b_issue "$M9B_I2"
M9B_N2=$M9B_NUM
req GET "/api/invoices/$M9B_I1" "$ACCT"
expect_jq '.invoice.totalCents == 100000' "the deposit is 10% of the value"

echo "--- the paid-date rule (section 3) ---"
req POST "/api/invoices/$M9B_I1/paid" "$ACCT" "{\"paidDate\":\"$M9B_TOMORROW\"}"
expect_status 400 "a paid date in the future"
expect_jq ".error == \"The paid date can't be in the future\"" "the future sentence"
req POST "/api/invoices/$M9B_I1/paid" "$ACCT" "{\"paidDate\":\"$M9B_YESTERDAY\"}"
expect_status 400 "a paid date before the issue date"
expect_jq ".error | startswith(\"The paid date can't be before the invoice was issued (\")" "the before-issue sentence"
req POST "/api/invoices/$M9B_I1/paid" "$ACCT" "{\"paidDate\":\"$M9B_TODAY\"}"
expect_status 200 "mark the deposit paid today"
expect_jq ".paidDate == \"$M9B_TODAY\"" "paid today"

m9b_month "$M9B_CUR"
expect_jq ".month.live.invoiceCount == ($M9B_C_CNT + 1)" "the current month has one more invoice"
expect_jq ".month.live.salesCents == ($M9B_C_SALES + 100000)" "and its total more in sales"
expect_jq ".month.live.gstCents == ($M9B_C_GST + $M9B_G1)" "and its GST more in GST"
expect_jq "([.invoices[] | select(.id == $M9B_I1)] | length == 1) and ([.invoices[] | select(.id == $M9B_I2)] | length == 0)" "the paid one is listed, the unpaid one isn't"
expect_jq "[.invoices[] | select(.id == $M9B_I1)][0] | .number == \"$M9B_N1\" and .kind == \"deposit\" and .client == \"$M9B_CLIENT\" and .job.id == $M9B_JOB and .job.name == \"$M9B_JOBNAME\" and .totalCents == 100000 and .gstCents == $M9B_G1 and .exGstCents == (100000 - $M9B_G1) and .myobEnteredDate == null" "the invoice row"
expect_jq '.month.future == false and .month.lodged == null and .lodgedInvoices == null and .changes == [] and .next == null' "the current month: not lodged, no next"

m9b_db_exec "UPDATE invoices SET issue_date = '2024-08-10', paid_date = '2024-08-10' WHERE id = $M9B_I1"
m9b_month 2024-08
expect_jq ".month.live.invoiceCount == ($M9B_A_CNT + 1) and ([.invoices[] | select(.id == $M9B_I1)] | length == 1)" "2024-08 shows the moved invoice"
expect_jq ".month.figures.kind == \"invoices\" and .prev == \"2024-07\" and .next == \"2024-09\"" "2024-08 is an invoices month with prev and next"
m9b_month "$M9B_CUR"
expect_jq ".month.live.invoiceCount == $M9B_C_CNT and ([.invoices[] | select(.id == $M9B_I1)] | length == 0)" "the current month no longer does"

echo "--- hand amounts ---"
m9b_hand 2024-09 '{"handCents":1234500,"handGstCents":null,"handNote":"M9 history"}'
expect_status 200 "an imported figure for 2024-09"
expect_jq ".month.figures.kind == \"imported\" and .month.figures.salesCents == ($M9B_S_SALES + 1234500) and .month.figures.gstCents == null and .month.figures.exGstCents == null" "2024-09 is imported, with no GST split"
expect_jq '.month.figures.handCents == 1234500 and .month.figures.handGstCents == null and .month.figures.handNote == "M9 history"' "the hand fields"
req GET "/api/bas?fy=2025" "$ACCT"
expect_jq '.quarters[0].gstCents == null and .quarters[0].exGstCents == null and .total.gstCents == null' "FY 2025 Q1 and the year have no GST sum"
m9b_hand 2024-09 '{"handCents":0,"handGstCents":null,"handNote":""}'
expect_status 400 "a hand amount of 0"
expect_jq '.error == "Enter an amount, or clear it"' "the zero sentence"
m9b_hand 2024-09 '{"handCents":110000,"handGstCents":10001,"handNote":""}'
expect_status 400 "GST more than a tenth"
expect_jq ".error == \"GST can't be more than a tenth of the amount before GST\"" "the GST sentence"
m9b_hand 2023-05 '{"handCents":100,"handGstCents":null,"handNote":""}'
expect_status 400 "a hand amount before Jun 2023"
expect_jq '.error == "Hand amounts go from Jun 2023 to this month"' "the range sentence"
req GET "/api/bas/months/$M9B_NEXT" "$ACCT"
expect_status 404 "GET next month"
req GET /api/bas/months/2023-05 "$ACCT"
expect_status 404 "GET a month before the history starts"
m9b_month 2024-09
expect_jq '.month.figures.handCents == 1234500' "the refused requests changed nothing"

m9b_hand 2024-08 '{"handCents":22000,"handGstCents":2000,"handNote":"M9 refund test"}'
expect_status 200 "a hand amount with GST on 2024-08"
expect_jq ".month.figures.kind == \"mixed\" and .month.figures.salesCents == ($M9B_A_SALES + 100000 + 22000) and .month.figures.gstCents == ($M9B_A_GST + $M9B_G1 + 2000) and .month.figures.exGstCents == (.month.figures.salesCents - .month.figures.gstCents)" "2024-08 is mixed: invoices' GST plus the hand GST"
m9b_hand 2024-08 '{"handCents":null,"handGstCents":null,"handNote":""}'
expect_status 200 "clear the 2024-08 hand amount"
expect_jq ".month.figures.kind == \"invoices\" and .month.figures.handCents == null and .month.figures.salesCents == ($M9B_A_SALES + 100000)" "2024-08 is back to invoices"
M9B_HANDS=$(m9b_audits bas.hand 2024-08)
m9b_hand 2024-08 '{"handCents":null,"handGstCents":null,"handNote":""}'
expect_status 200 "clear it again"
M9B_HANDS2=$(m9b_audits bas.hand 2024-08)
expect_eq "$M9B_HANDS2" "$M9B_HANDS" "nothing changed, so no audit row"

echo "--- lodging ---"
req POST "/api/bas/months/$M9B_CUR/lodge" "$ACCT" '{}'
expect_status 409 "lodge the current month"
expect_jq '.error == "A month can be lodged once it has ended"' "the ended sentence"
req POST /api/bas/months/2024-08/lodge "$ACCT" '{}'
expect_status 200 "lodge 2024-08"
expect_jq '.month.lodged != null and (.month.lodged.at | type == "string") and (.month.lodged.by.name | type == "string") and .month.changed == false and .changes == []' "2024-08 is lodged, unchanged"
expect_jq ".month.figures.salesCents == ($M9B_A_SALES + 100000) and (.lodgedInvoices | length) == ($M9B_A_CNT + 1) and ([.lodgedInvoices[] | select(.id == $M9B_I1)] | length == 1)" "the frozen figures and list"
req POST /api/bas/months/2024-08/lodge "$ACCT" '{}'
expect_status 409 "lodge 2024-08 again"
expect_jq '.error == "This month is already lodged"' "the already-lodged sentence"
m9b_hand 2024-08 '{"handCents":5000,"handGstCents":null,"handNote":""}'
expect_status 409 "a hand amount on a lodged month"
expect_jq '.error == "This month is lodged; an admin can reopen it"' "the lodged sentence"

m9b_db_exec "UPDATE invoices SET paid_date = '2024-10-02' WHERE id = $M9B_I1"
m9b_month 2024-08
expect_jq ".month.figures.salesCents == ($M9B_A_SALES + 100000) and .month.live.salesCents == $M9B_A_SALES" "2024-08 keeps its frozen figures, the live ones beside them"
expect_jq ".month.changed == true and ([.changes[] | select(contains(\"$M9B_N1\"))] | length >= 1)" "changed since lodged, naming the invoice"
expect_jq "([.lodgedInvoices[] | select(.id == $M9B_I1)] | length == 1) and ([.invoices[] | select(.id == $M9B_I1)] | length == 0)" "the frozen list still has it, the live one doesn't"
req GET "/api/bas?fy=2025" "$ACCT"
expect_jq ".months[1].changed == true and .months[1].figures.salesCents == ($M9B_A_SALES + 100000) and .quarters[0].lodgedCount >= 1" "the year shows the lodged month's frozen figures"
m9b_month 2024-10
expect_jq ".month.live.invoiceCount == ($M9B_O_CNT + 1) and ([.invoices[] | select(.id == $M9B_I1)] | length == 1)" "2024-10 shows it live"
req POST /api/bas/months/2024-08/reopen "$ACCT" '{}'
expect_status 403 "acct reopens 2024-08"
req POST /api/bas/months/2024-08/reopen "$ADMIN" '{}'
expect_status 200 "admin reopens 2024-08"
expect_jq ".month.lodged == null and .month.changed == false and .lodgedInvoices == null and .changes == [] and .month.figures.salesCents == $M9B_A_SALES" "reopened: figures live again"
req POST /api/bas/months/2024-08/reopen "$ADMIN" '{}'
expect_status 409 "reopen it again"
expect_jq ".error == \"This month isn't lodged\"" "the not-lodged sentence"

echo "--- compare ---"
m9b_month 2024-09
M9B_SEP=$(jqr '.month.figures.salesCents')
req GET /api/bas/compare "$ACCT"
expect_status 200 "GET /api/bas/compare"
expect_jq "(.fys | index(2025) != null) and .fys[0] == 2023 and .fys[-1] == $M9B_FY and (.rows | length == 12) and .rows[0].label == \"Jul\" and .rows[11].label == \"Jun\"" "the comparison's years and rows"
expect_jq ".rows[2].label == \"Sep\" and .rows[2].monthIndex == 2 and .rows[2].values[\"2025\"] == $M9B_SEP" "Sep FY 2025 is 2024-09's sales"
expect_jq '.rows[0].values["2023"] == null' "Jul 2022 is before the history starts"

echo "--- CSV ---"
req GET /api/bas/months/2024-10/invoices.csv "$ACCT"
expect_status 200 "GET the 2024-10 CSV"
case "$(hdr Content-Type)" in
  text/csv*) ok ;;
  *) fail "the CSV's Content-Type is '$(hdr Content-Type)'" ;;
esac
expect_eq "$(hdr Content-Disposition)" 'attachment; filename="BAS sales Oct 2024.csv"' "the CSV's file name"
[[ $BODY == $'\xEF\xBB\xBF'* ]] || fail "the CSV doesn't start with a UTF-8 BOM"
ok
M9B_LINE1=$(printf '%s' "$BODY" | head -n 1 | tr -d '\r')
M9B_LINE1=${M9B_LINE1#$'\xEF\xBB\xBF'}
expect_eq "$M9B_LINE1" "Invoice,Client,Job,Kind,Issued,Paid,Total inc GST,GST,Ex GST,Entered in MYOB" "the CSV header"
[[ $BODY == *$'\r\n'* ]] || fail "the CSV lines don't end with CRLF"
ok
M9B_ROWS=$(printf '%s' "$BODY" | { grep -c "^$M9B_N1," || true; })
expect_eq "$M9B_ROWS" 1 "one CSV row for $M9B_N1"
M9B_ROW=$(printf '%s' "$BODY" | { grep "^$M9B_N1," || true; } | tr -d '\r')
[[ $M9B_ROW == "$M9B_N1,'=M9 Formula Client,$M9B_JOBNAME,Deposit,2024-08-10,2024-10-02,1000.00,"* ]] \
  || fail "the CSV row is '$M9B_ROW'"
ok

echo "--- audit ---"
req GET "/api/audit?entityType=bas_month&entityId=2024-08&limit=100" "$ADMIN"
expect_status 200 "GET 2024-08's audit"
for a in bas.hand bas.lodge bas.reopen; do
  expect_jq "[.rows[] | .action] | index(\"$a\") != null" "audit has $a"
done

echo "--- tidy ---"
m9b_hand 2024-09 '{"handCents":null,"handGstCents":null,"handNote":""}'
expect_status 200 "clear the 2024-09 hand amount"
m9b_month 2024-09
expect_jq ".month.figures.handCents == null and .month.figures.salesCents == $M9B_S_SALES" "2024-09 is as it was"
m9b_month 2024-08
expect_jq '.month.lodged == null and .month.figures.handCents == null' "2024-08 is not lodged and has no hand amount"
