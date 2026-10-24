# M13 smoke: loans, the monthly rules of 2026-10-24 (Todd): interest charged once a calendar month on
# the balance at the start of the month and added to it; payments typed as a total and split
# automatically (interest first); a month's interest or a payment's interest part typed to match a
# lender; the plan (a fixed amount, or paid off by a month); archive, statement and access.
# Sourced by ci/smoke.sh after the M12 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, hdr, fail, ok) and the cookie jars ($ADMIN $ACCT $DPM).
# No shebang and no `set`: the caller owns both. $ADMIN is the owner, so it holds loans.manage;
# Accounts and Projects don't (Accounts is granted it for one write, and the grant removed).
# It does not assume a pristine database: its loans carry a run tag and it checks only its own rows.
# Fixed past dates for the months checked, so every figure is exact. Made-up names only.
# Contract: docs/plans/m13-contracts.md section 6 (changed 2026-10-24), 7.3 and 8.2.

# ============================================================================
step "m13. loans"
# ============================================================================

M13_L_TAG=$(date +%s)
M13_L_NAME="M13 Lender $M13_L_TAG"
M13_L_FUTURE="2999-01-01"

# m13_l_month PERIOD JQ WHAT: the month PERIOD of the last answer satisfies JQ.
m13_l_month() {
  expect_jq "[.months[] | select(.period == \"$1\")] | length == 1 and (.[0] | $2)" "$3"
}

# --- access: loans.manage (the owner; an Accounts login only by the owner's grant) ---
req GET /loans.html "$ADMIN"
expect_status 200 "admin GET /loans.html"
req GET /loanprint.html "$ADMIN"
expect_status 200 "admin GET /loanprint.html"
req GET /loans.html "$ACCT"
expect_status 403 "acct GET /loans.html"
req GET /loanprint.html "$ACCT"
expect_status 403 "acct GET /loanprint.html"
req GET /api/loans "$ADMIN"
expect_status 200 "admin GET /api/loans"
expect_jq '.loans | type == "array"' "the list is {loans: [...]}"
req GET /api/loans "$ACCT"
expect_status 403 "acct GET /api/loans"
req GET /api/loans "$DPM"
expect_status 403 "dpm GET /api/loans"
req POST /api/loans "$ACCT" '{"name":"M13 Refused","direction":"lent_to_business","openingBalanceCents":100,"openingDate":"2025-01-01"}'
expect_status 403 "acct POST /api/loans"
req GET /api/loans/abc "$ADMIN"
expect_status 404 "a loan id that isn't a number"
req GET /api/loans/999999999 "$ADMIN"
expect_status 404 "no such loan"

echo "--- create ---"
req POST /api/loans "$ADMIN" "{\"name\":\"$M13_L_NAME\",\"direction\":\"lent_to_business\",\"otherParty\":\"M13 Other Party\",\"openingBalanceCents\":6900000,\"openingDate\":\"2025-01-01\"}"
expect_status 201 "create the loan (69,000 from 1 Jan 2025)"
expect_jq ".name == \"$M13_L_NAME\" and .direction == \"lent_to_business\" and .openingBalanceCents == 6900000 and .openingDate == \"2025-01-01\" and .archived == false and .plan == null" "the loan as created"
expect_jq '.rateBp == null and .rates == [] and .repayments == [] and .months[0].period == "2025-01" and .months[0].charged == true and .balanceCents == 6900000' \
  "no rate: no interest yet, balance 6900000; months start at the opening month"
M13_L_ID=$(jqr '.id')
req POST /api/loans "$ADMIN" "{\"name\":\"$M13_L_NAME F\",\"direction\":\"lent_to_business\",\"openingBalanceCents\":100,\"openingDate\":\"$M13_L_FUTURE\"}"
expect_status 400 "a future opening date"
expect_jq '.error == "The opening date can'"'"'t be in the future"' "the future opening date sentence"
req POST /api/loans "$ADMIN" "{\"name\":\"$M13_L_NAME D\",\"direction\":\"sideways\",\"openingBalanceCents\":100,\"openingDate\":\"2025-01-01\"}"
expect_status 400 "a bad direction"
req POST /api/loans "$ADMIN" '{"direction":"lent_to_business","openingBalanceCents":100,"openingDate":"2025-01-01"}'
expect_status 400 "no name"
expect_jq '.error == "Name is required"' "the name sentence"
req POST /api/loans "$ADMIN" "{\"name\":\"$M13_L_NAME X\",\"direction\":\"lent_to_business\",\"openingBalanceCents\":100,\"openingDate\":\"2025-01-01\",\"balanceCents\":5}"
expect_status 400 "a typed balance"
expect_jq '.error == "Unknown field: balanceCents"' "the balance is never typed"
for M13_L_GET in /api/loans "/api/loans/$M13_L_ID" "/api/loans/$M13_L_ID/interest?date=2025-01-10" "/api/loans/$M13_L_ID/statement" "/api/loans/$M13_L_ID/plan?kind=amount&amountCents=100000" /api/loans/999999999; do
  req GET "$M13_L_GET" "$ADMIN"
  expect_eq "$(hdr Cache-Control)" "no-store" "GET $M13_L_GET is Cache-Control: no-store"
done

echo "--- the rate and a month with no payment ---"
req POST "/api/loans/$M13_L_ID/rates" "$ADMIN" '{"fromDate":"2025-01-01","rateBp":1035}'
expect_status 201 "rate 10.35% from 1 Jan 2025"
m13_l_month 2025-01 '.startBalanceCents == 6900000 and .interestCents == 59513 and .workedOutInterestCents == 59513 and .payments == [] and .endBalanceCents == 6959513' \
  "January, no payment: 595.13 interest (69,000 x 10.35% / 12) added: balance 69,595.13"
m13_l_month 2025-02 '.startBalanceCents == 6959513 and .interestCents == 60026' "February: interest on the raised balance (600.26)"
req POST "/api/loans/$M13_L_ID/rates" "$ADMIN" '{"fromDate":"2025-01-01","rateBp":600}'
expect_status 409 "the same from date twice"
req POST "/api/loans/$M13_L_ID/rates" "$ADMIN" '{"fromDate":"2025-02-01","rateBp":5001}'
expect_status 400 "a rate of 5001"

echo "--- two payments in one month: interest only once, split automatically ---"
req GET "/api/loans/$M13_L_ID/interest?date=2025-02-05" "$ADMIN"
expect_status 200 "what a 5 Feb payment meets"
expect_jq '.period == "2025-02" and .monthInterestCents == 60026 and .paidBeforeCents == 0 and .outstandingCents == 60026 and .balanceCents == 7019539' \
  "5 Feb: 600.26 still to pay; balance 70,195.39 with February's interest"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-02-05","totalCents":100000,"reference":"M13 REF 1"}'
expect_status 201 "pay 1,000.00 on 5 Feb"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-02-20","totalCents":50000}'
expect_status 201 "pay 500.00 on 20 Feb"
m13_l_month 2025-02 '(.payments | map([.paidDate, .totalCents, .interestCents, .principalCents, .balanceAfterCents])) == [["2025-02-05",100000,60026,39974,6919539],["2025-02-20",50000,0,50000,6869539]] and .interestCents == 60026 and .endBalanceCents == 6869539' \
  "the first payment carries the month's interest (600.26 + 399.74); the second is all principal"
req GET "/api/loans/$M13_L_ID/interest?date=2025-02-25" "$ADMIN"
expect_jq '.paidBeforeCents == 60026 and .outstandingCents == 0 and .interestCents == 0' "25 Feb: the month's interest is already paid"
req GET "/api/loans/$M13_L_ID" "$ADMIN"
M13_L_R2=$(jqr '.repayments[] | select(.paidDate == "2025-02-20") | .id')
m13_l_month 2025-03 '.startBalanceCents == 6869539 and .interestCents == 59250' "March: interest on 68,695.39 (592.50)"

echo "--- typed figures to match a lender ---"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-03-10","totalCents":100000,"interestCents":30000}'
expect_status 201 "pay 1,000.00 on 10 Mar with the interest part typed as 300.00"
m13_l_month 2025-03 '(.payments[0] | .interestCents == 30000 and .principalCents == 70000 and .interestOverride == true and .workedOutInterestCents == 59250 and .balanceAfterCents == 6828789)' \
  "the typed split is kept; the worked-out 592.50 beside it; the balance falls by the total"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-03-11","totalCents":100,"interestCents":200}'
expect_status 400 "an interest part above the total"
expect_jq '.error == "The interest part can'"'"'t be more than the total paid"' "the interest part sentence"
req PUT "/api/loans/$M13_L_ID/months/2025-04" "$ADMIN" '{"interestCents":12345,"note":"M13 statement"}'
expect_status 200 "type April's interest as 123.45"
m13_l_month 2025-04 '.interestCents == 12345 and .interestOverridden == true and .overrideNote == "M13 statement" and .workedOutInterestCents == 58898 and .endBalanceCents == 6841134' \
  "April charged 123.45 as typed (588.98 worked out)"
req PUT "/api/loans/$M13_L_ID/months/2025-04" "$ADMIN" '{"interestCents":null}'
expect_status 200 "April back to worked out"
m13_l_month 2025-04 '.interestCents == 58898 and .interestOverridden == false' "April worked out again"
req PUT "/api/loans/$M13_L_ID/months/2024-12" "$ADMIN" '{"interestCents":100}'
expect_status 400 "a month before the loan"
req PUT "/api/loans/$M13_L_ID/months/soon" "$ADMIN" '{"interestCents":100}'
expect_status 404 "a month that isn't a month"

echo "--- refusals ---"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2024-12-31","totalCents":100}'
expect_status 400 "a payment before the opening date"
expect_jq '.error == "A payment can'"'"'t be before the opening date (1 Jan 2025)"' "the before-opening sentence"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" "{\"paidDate\":\"$M13_L_FUTURE\",\"totalCents\":100}"
expect_status 400 "a future payment"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-03-20"}'
expect_status 400 "no total"
expect_jq '.error == "Enter the total paid"' "the total sentence"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-03-20","totalCents":0}'
expect_status 400 "a zero total"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-03-20","totalCents":7000000}'
expect_status 409 "a total that takes the balance below zero"
expect_jq '.error == "That would take the balance below zero on 20 Mar 2025"' "the below-zero sentence names the date"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-03-20","totalCents":100,"principalCents":100}'
expect_status 400 "the old principal field"
expect_jq '.error == "Unknown field: principalCents"' "a payment is typed as its total"
req PATCH "/api/loans/$M13_L_ID" "$ADMIN" '{"openingDate":"2025-02-10"}'
expect_status 409 "an opening date after a payment"
expect_jq '.error == "A payment is dated before that (5 Feb 2025)"' "the opening date sentence"
req PATCH "/api/loans/$M13_L_ID" "$ADMIN" '{"openingBalanceCents":100000}'
expect_status 409 "an opening balance below what was paid"

echo "--- edit and delete ---"
req PATCH "/api/loans/$M13_L_ID/repayments/$M13_L_R2" "$ADMIN" '{"reference":"M13 REF 2"}'
expect_status 200 "edit the 20 Feb reference"
expect_jq '.repayments[] | select(.paidDate == "2025-02-20") | .reference == "M13 REF 2" and .totalCents == 50000' "the reference changed, nothing else"
req DELETE "/api/loans/$M13_L_ID/repayments/$M13_L_R2" "$ADMIN"
expect_status 200 "delete the 20 Feb payment"
m13_l_month 2025-02 '(.payments | length) == 1 and .endBalanceCents == 6919539' "February's balance rises by 500.00"
m13_l_month 2025-03 '.interestCents == 59681' "March's interest follows the higher balance (596.81)"
req DELETE "/api/loans/$M13_L_ID/repayments/$M13_L_R2" "$ADMIN"
expect_status 404 "the deleted payment is gone"

echo "--- opened after the 1st: the first month charged is the next ---"
req POST /api/loans "$ADMIN" "{\"name\":\"$M13_L_NAME B\",\"direction\":\"lent_by_business\",\"openingBalanceCents\":100000,\"openingDate\":\"2025-01-15\"}"
expect_status 201 "the second loan, opened 15 Jan 2025"
M13_L_ID2=$(jqr '.id')
req POST "/api/loans/$M13_L_ID2/rates" "$ADMIN" '{"fromDate":"2025-01-15","rateBp":1035}'
expect_status 201 "the second loan's rate"
m13_l_month 2025-01 '.charged == false and .interestCents == 0 and .endBalanceCents == 100000' "January is not charged"
m13_l_month 2025-02 '.charged == true and .interestCents == 863 and .endBalanceCents == 100863' "February is charged 8.63"

echo "--- an Accounts login granted loans.manage writes ---"
req GET /api/auth/me "$ACCT"
M13_L_ACCT_ID=$(jqr '.user.id')
req PUT "/api/users/$M13_L_ACCT_ID/overrides/loans.manage" "$ADMIN" '{"effect":"grant"}'
expect_status 200 "the owner grants acct loans.manage"
req POST "/api/loans/$M13_L_ID2/repayments" "$ACCT" '{"paidDate":"2025-02-15","totalCents":1000,"reference":"M13 ACCT"}'
expect_status 201 "acct adds a payment"
req GET "/api/audit?entityType=loan&entityId=$M13_L_ID2&action=loan.repayment_add&limit=5" "$ADMIN"
expect_jq ".rows[0].actorUserId == $M13_L_ACCT_ID and .rows[0].after.reference == \"M13 ACCT\" and .rows[0].after.totalCents == 1000" "the row names acct"
req DELETE "/api/users/$M13_L_ACCT_ID/overrides/loans.manage" "$ADMIN"
expect_status 200 "the owner removes acct's loans.manage"
req POST "/api/loans/$M13_L_ID2/repayments" "$ACCT" '{"paidDate":"2025-02-16","totalCents":1000}'
expect_status 403 "acct adds a payment without the grant"
req PUT "/api/loans/$M13_L_ID2/plan" "$ACCT" '{"kind":"amount","amountCents":1000}'
expect_status 403 "acct sets a plan without the grant"

echo "--- the plan ---"
req PUT "/api/loans/$M13_L_ID/plan" "$ADMIN" '{"kind":"amount","amountCents":150000}'
expect_status 200 "plan 1,500.00 a month"
expect_jq '.plan.kind == "amount" and .plan.amountCents == 150000 and .plan.paymentCents == 150000 and .plan.coversInterest == true and (.plan.rows | length) > 0 and (.plan.rows | length) <= 120' "the plan is laid out"
expect_jq '((.plan.rows | length) as $n | [limit($n - 1; .plan.rows[])] | all(.totalCents == 150000)) and (.plan.rows[-1].balanceAfterCents == 0) and .plan.paidOffPeriod == .plan.rows[-1].period' \
  "1,500.00 each month until the balance reaches zero"
expect_jq '(.plan.rows[0] | .interestCents + .principalCents == .totalCents)' "each planned line splits into interest and principal"
req GET "/api/loans/$M13_L_ID/plan?kind=amount&amountCents=10000" "$ADMIN"
expect_status 200 "preview 100.00 a month"
expect_jq '.plan.coversInterest == false and .plan.paidOffPeriod == null and (.plan.rows | length) == 120' "100.00 doesn't cover the interest: the balance grows, 120 months"
M13_L_PAYOFF=$(( $(date +%Y) + 3 ))-06
req PUT "/api/loans/$M13_L_ID/plan" "$ADMIN" "{\"kind\":\"payoff\",\"payoffPeriod\":\"$M13_L_PAYOFF\"}"
expect_status 200 "plan paid off by $M13_L_PAYOFF"
expect_jq ".plan.kind == \"payoff\" and .plan.payoffPeriod == \"$M13_L_PAYOFF\"" "the payoff plan is kept"
expect_jq ".plan.rows[-1].period == \"$M13_L_PAYOFF\" and .plan.rows[-1].balanceAfterCents == 0 and .plan.rows[-1].totalCents <= .plan.paymentCents and (.plan.paymentCents as \$p | (.plan.rows | length) as \$n | [limit(\$n - 1; .plan.rows[])] | all(.totalCents == \$p))" \
  "an even payment each month; the last month clears the balance"
# The even payment: B r (1+r)^n / ((1+r)^n - 1), r = 10.35% / 12, rounded up to the cent; when the
# plan starts this month (nothing paid yet) this month's interest is already in B, so (1+r)^(n-1).
M13_L_B=$(jqr '.balanceCents')
M13_L_N=$(jqr '(.plan.startPeriod | split("-") | map(tonumber)) as $s | (.plan.payoffPeriod | split("-") | map(tonumber)) as $p | ($p[0] - $s[0]) * 12 + $p[1] - $s[1] + 1')
M13_L_IN=$(jqr 'if .months[-1].period == .plan.startPeriod then 1 else 0 end')
M13_L_WANT=$(awk -v b="$M13_L_B" -v n="$M13_L_N" -v inf="$M13_L_IN" 'BEGIN { r = 1035 / 120000; f = exp(n * log(1 + r)); k = inf ? exp((n - 1) * log(1 + r)) : f; t = b * r * k / (f - 1) - 0.000001; c = int(t); if (c < t) c++; print c }')
expect_eq "$(jqr '.plan.paymentCents')" "$M13_L_WANT" "the payment is the even amortised amount"
req PUT "/api/loans/$M13_L_ID/plan" "$ADMIN" '{"kind":"payoff","payoffPeriod":"2025-01"}'
expect_status 400 "a payoff month in the past"
expect_jq '.error == "The payoff month must be next month or later"' "the payoff sentence"
req PUT "/api/loans/$M13_L_ID/plan" "$ADMIN" '{"kind":"amount","amountCents":0}'
expect_status 400 "a zero amount"
req PUT "/api/loans/$M13_L_ID/plan" "$ADMIN" '{"kind":"sometimes"}'
expect_status 400 "a bad plan kind"

echo "--- statement ---"
req GET "/api/loans/$M13_L_ID/statement?from=2025-01-10&to=2025-03-31" "$ADMIN"
expect_status 200 "the statement for January to March"
expect_jq '.fromPeriod == "2025-01" and .toPeriod == "2025-03" and .balanceAtStartCents == 6900000' "whole months, from the opening balance"
expect_jq '([.rows[] | [.period, .first, .paidDate, .totalCents, .interestCents]] == [["2025-01",true,null,null,59513],["2025-02",true,"2025-02-05",100000,60026],["2025-03",true,"2025-03-10",100000,30000]])' \
  "January interest only; a line per payment"
expect_jq '.totals == {"interestChargedCents":179220,"principalCents":109974,"interestCents":90026,"totalCents":200000} and .balanceAtEndCents == .rows[-1].balanceAfterCents' "the totals and the end balance"
req GET "/api/loans/$M13_L_ID/statement?from=2025-03-31&to=2025-02-01" "$ADMIN"
expect_status 400 "a statement that ends before it starts"

echo "--- archive ---"
req PATCH "/api/loans/$M13_L_ID" "$ADMIN" '{"archived":true}'
expect_status 200 "archive the loan"
req GET /api/loans "$ADMIN"
expect_jq "[.loans[] | select(.id == $M13_L_ID)] | length == 0" "not in the current list"
req GET "/api/loans?archived=1" "$ADMIN"
expect_jq "[.loans[] | select(.id == $M13_L_ID)] | length == 1" "in the archived list"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-03-20","totalCents":100}'
expect_status 409 "a payment on an archived loan"
expect_jq '.error == "This loan is archived; restore it to change it"' "the archived sentence"
req PUT "/api/loans/$M13_L_ID/plan" "$ADMIN" '{"kind":null}'
expect_status 409 "a plan on an archived loan"
req PATCH "/api/loans/$M13_L_ID" "$ADMIN" '{"archived":false}'
expect_status 200 "restore the loan"

echo "--- audit ---"
req GET "/api/audit?entityType=loan&entityId=$M13_L_ID&limit=200" "$ADMIN"
expect_status 200 "the loan's audit rows, as the owner"
for M13_L_ACTION in loan.create loan.rate_add loan.repayment_add loan.repayment_update loan.repayment_delete loan.update loan.month_interest loan.plan; do
  expect_jq "[.rows[] | select(.action == \"$M13_L_ACTION\" and .entityType == \"loan\")] | length >= 1" "a $M13_L_ACTION row for the loan"
done
expect_jq '[.rows[] | select(.action == "loan.month_interest" and .after.period == "2025-04" and .after.interestCents == 12345)] | length == 1' "the month interest row"

echo "--- clean-up ---"
for M13_L_X in "$M13_L_ID" "$M13_L_ID2"; do
  req PATCH "/api/loans/$M13_L_X" "$ADMIN" '{"archived":true}'
  expect_status 200 "archive loan $M13_L_X"
done

echo "M13 loans smoke test passed."
