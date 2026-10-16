# M13 smoke, Wave 1 D: loans (the balance calculated, the rate history, interest worked out once a
# month, repayments, archive and the statement).
# Sourced by ci/smoke.sh after the M12 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, hdr, fail, ok) and the cookie jars ($ADMIN $ACCT $DPM).
# No shebang and no `set`: the caller owns both. $ADMIN is the owner, so it holds loans.manage;
# Accounts and Design/PM don't (Accounts is granted it for one write, and the grant removed).
# It does not assume a pristine database: its loans carry a run tag and it checks only its own rows.
# Fixed past dates, so every figure is exact. Made-up names only (this repo is public).
# Contract: docs/plans/m13-contracts.md sections 6, 7.3, 8.2 and 11.5.

# ============================================================================
step "m13. loans"
# ============================================================================

M13_L_TAG=$(date +%s)
M13_L_NAME="M13 Lender $M13_L_TAG"
M13_L_FUTURE="2999-01-01"

# m13_l_rep_on DATE JQ WHAT: the one repayment on DATE in the last answer satisfies JQ.
m13_l_rep_on() {
  expect_jq "[.repayments[] | select(.paidDate == \"$1\")] | length == 1 and (.[0] | $2)" "$3"
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
req POST /api/loans "$ADMIN" "{\"name\":\"$M13_L_NAME\",\"direction\":\"lent_to_business\",\"otherParty\":\"M13 Other Party\",\"openingBalanceCents\":12000000,\"openingDate\":\"2025-01-01\"}"
expect_status 201 "create the loan"
expect_jq ".name == \"$M13_L_NAME\" and .direction == \"lent_to_business\" and .otherParty == \"M13 Other Party\" and .openingBalanceCents == 12000000 and .openingDate == \"2025-01-01\" and .archived == false" "the loan as created"
expect_jq '.balanceCents == 12000000 and .rateBp == null and .lastPaidDate == null and .rates == [] and .repayments == [] and (.fy.label | test("^[0-9]{4}-[0-9]{2}$"))' "balance 12000000, no rate, no repayments"
M13_L_ID=$(jqr '.id')
req POST /api/loans "$ADMIN" "{\"name\":\"$M13_L_NAME F\",\"direction\":\"lent_to_business\",\"openingBalanceCents\":100,\"openingDate\":\"$M13_L_FUTURE\"}"
expect_status 400 "a future opening date"
expect_jq '.error == "The opening date can'"'"'t be in the future"' "the future opening date sentence"
req POST /api/loans "$ADMIN" "{\"name\":\"$M13_L_NAME D\",\"direction\":\"sideways\",\"openingBalanceCents\":100,\"openingDate\":\"2025-01-01\"}"
expect_status 400 "a bad direction"
expect_jq '.error == "Direction must be lent_to_business or lent_by_business"' "the direction sentence"
req POST /api/loans "$ADMIN" '{"direction":"lent_to_business","openingBalanceCents":100,"openingDate":"2025-01-01"}'
expect_status 400 "no name"
expect_jq '.error == "Name is required"' "the name sentence"
req POST /api/loans "$ADMIN" "{\"name\":\"$M13_L_NAME X\",\"direction\":\"lent_to_business\",\"openingBalanceCents\":100,\"openingDate\":\"2025-01-01\",\"balanceCents\":5}"
expect_status 400 "a typed balance"
expect_jq '.error == "Unknown field: balanceCents"' "the balance is never typed"
req POST /api/loans "$ADMIN" "{\"name\":\"$M13_L_NAME M\",\"direction\":\"lent_to_business\",\"openingBalanceCents\":1.5,\"openingDate\":\"2025-01-01\"}"
expect_status 400 "an opening balance in part cents"
expect_jq '.error == "The opening balance must be whole cents from $0 to $100,000,000"' "the opening balance sentence"
req GET /api/loans "$ADMIN"
expect_jq "[.loans[] | select(.id == $M13_L_ID)] | length == 1" "the loan is listed"
for M13_L_GET in /api/loans "/api/loans/$M13_L_ID" "/api/loans/$M13_L_ID/interest?date=2025-01-10" "/api/loans/$M13_L_ID/statement" /api/loans/999999999; do
  req GET "$M13_L_GET" "$ADMIN"
  expect_eq "$(hdr Cache-Control)" "no-store" "GET $M13_L_GET is Cache-Control: no-store"
done

echo "--- rates ---"
req POST "/api/loans/$M13_L_ID/rates" "$ADMIN" '{"fromDate":"2025-01-01","rateBp":600}'
expect_status 201 "rate 600 from 1 Jan 2025"
req POST "/api/loans/$M13_L_ID/rates" "$ADMIN" '{"fromDate":"2025-03-01","rateBp":650,"note":"M13 rate rise"}'
expect_status 201 "rate 650 from 1 Mar 2025"
expect_jq '[.rates[] | [.fromDate, .rateBp]] == [["2025-01-01",600],["2025-03-01",650]] and .rateBp == 650' "the history oldest first; 650 in force today"
M13_L_RATE650=$(jqr '.rates[] | select(.fromDate == "2025-03-01") | .id')
req PATCH "/api/loans/$M13_L_ID/rates/$M13_L_RATE650" "$ADMIN" '{"fromDate":"2025-01-01"}'
expect_status 409 "move a rate onto another rate's from date"
expect_jq '.error == "There is already a rate from 1 Jan 2025"' "the same from date sentence (an edit)"
req POST "/api/loans/$M13_L_ID/rates" "$ADMIN" '{"fromDate":"2025-02-01","rateBp":5001}'
expect_status 400 "a rate of 5001"
expect_jq '.error == "The rate must be from 0 to 5000 basis points (0% to 50%)"' "the rate sentence"
req POST "/api/loans/$M13_L_ID/rates" "$ADMIN" '{"fromDate":"2025-01-01","rateBp":600}'
expect_status 409 "the same from date twice"
expect_jq '.error == "There is already a rate from 1 Jan 2025"' "the same from date sentence"

echo "--- repayments ---"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-01-10","principalCents":200000}'
expect_status 201 "repayment 10 Jan, interest left out"
m13_l_rep_on 2025-01-10 '.interestCents == 60000 and .workedOutInterestCents == 60000 and .balanceAfterCents == 11800000 and .totalCents == 260000 and .rateBp == 600' \
  "interest 60000 (12000000 x 600 / 120000), balance after 11800000"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-01-24","principalCents":200000}'
expect_status 201 "repayment 24 Jan, interest left out"
m13_l_rep_on 2025-01-24 '.interestCents == 0 and .workedOutInterestCents == 0 and .balanceAfterCents == 11600000' \
  "interest 0 (already charged this month), balance after 11600000"
M13_L_R2=$(jqr '.repayments[] | select(.paidDate == "2025-01-24") | .id')
req GET "/api/loans/$M13_L_ID/interest?date=2025-02-07" "$ADMIN"
expect_status 200 "the suggestion for 7 Feb"
expect_jq '.date == "2025-02-07" and .balanceCents == 11600000 and .rateBp == 600 and .interestCents == 58000 and .alreadyCharged == null' \
  "7 Feb: balance 11600000, rate 600, interest 58000"
req GET "/api/loans/$M13_L_ID/interest?date=2025-01-31" "$ADMIN"
expect_jq '.interestCents == 0 and .alreadyCharged.date == "2025-01-10"' "31 Jan: already charged on 10 Jan"
req GET "/api/loans/$M13_L_ID/interest" "$ADMIN"
expect_status 400 "the suggestion without a date"
expect_jq '.error == "date must be a date"' "the date sentence"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-02-07","principalCents":200000,"interestCents":57000,"reference":"M13 REF 1"}'
expect_status 201 "repayment 7 Feb with interest typed as a statement"
m13_l_rep_on 2025-02-07 '.interestCents == 57000 and .workedOutInterestCents == 58000 and .balanceAfterCents == 11400000 and .reference == "M13 REF 1"' \
  "the typed 57000 is stored, 58000 worked out beside it"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-03-07","principalCents":200000}'
expect_status 201 "repayment 7 Mar, interest left out"
m13_l_rep_on 2025-03-07 '.interestCents == 61750 and .rateBp == 650 and .balanceAfterCents == 11200000' \
  "interest 61750 (11400000 x 650 / 120000) at the new rate"
expect_jq '.balanceCents == 11200000 and .lastPaidDate == "2025-03-07" and ([.repayments[].paidDate] == ["2025-01-10","2025-01-24","2025-02-07","2025-03-07"])' \
  "balance 11200000, last paid 7 Mar, in date order"

# Half up, and no rate: a second loan.
req POST /api/loans "$ADMIN" "{\"name\":\"$M13_L_NAME B\",\"direction\":\"lent_by_business\",\"openingBalanceCents\":1000100,\"openingDate\":\"2025-01-01\"}"
expect_status 201 "the second loan"
M13_L_ID2=$(jqr '.id')
req POST "/api/loans/$M13_L_ID2/repayments" "$ADMIN" '{"paidDate":"2025-01-15","principalCents":1000}'
expect_status 400 "interest left out with no rate"
expect_jq '.error == "No rate covers 15 Jan 2025: type the interest or add a rate"' "the no-rate sentence"
req GET "/api/loans/$M13_L_ID2/interest?date=2025-01-15" "$ADMIN"
expect_jq '.rateBp == null and .interestCents == null and .balanceCents == 1000100' "no rate: no suggestion"
req POST "/api/loans/$M13_L_ID2/rates" "$ADMIN" '{"fromDate":"2025-01-01","rateBp":600}'
expect_status 201 "the second loan's rate"
M13_L_ID2_RATE=$(jqr '.rates[0].id')
req GET "/api/loans/$M13_L_ID2/interest?date=2025-01-15" "$ADMIN"
expect_jq '.interestCents == 5001' "5000.5 rounds half up to 5001"

echo "--- a rate changed and deleted ---"
req PATCH "/api/loans/$M13_L_ID2/rates/$M13_L_ID2_RATE" "$ADMIN" '{"rateBp":700,"note":"M13 rate edit"}'
expect_status 200 "change the second loan's rate to 700"
expect_jq '[.rates[] | [.fromDate, .rateBp, .note]] == [["2025-01-01",700,"M13 rate edit"]] and .rateBp == 700' "the rate is 700 from 1 Jan 2025"
req GET "/api/loans/$M13_L_ID2/interest?date=2025-01-15" "$ADMIN"
expect_jq '.rateBp == 700 and .interestCents == 5834' "the suggestion follows the new rate (1000100 x 700 / 120000 = 5833.9)"
req PATCH "/api/loans/$M13_L_ID2/rates/$M13_L_ID2_RATE" "$ADMIN" '{"rateBp":5001}'
expect_status 400 "change a rate to 5001"
expect_jq '.error == "The rate must be from 0 to 5000 basis points (0% to 50%)"' "the rate sentence (an edit)"
req PATCH "/api/loans/$M13_L_ID2/rates/$M13_L_ID2_RATE" "$ADMIN" '{"bogus":1}'
expect_status 400 "an unknown rate field"
expect_jq '.error == "Unknown field: bogus"' "the unknown field sentence (a rate)"
req PATCH "/api/loans/$M13_L_ID2/rates/999999999" "$ADMIN" '{"rateBp":700}'
expect_status 404 "change no such rate"
req PATCH "/api/loans/$M13_L_ID/rates/$M13_L_ID2_RATE" "$ADMIN" '{"rateBp":700}'
expect_status 404 "change another loan's rate"
req DELETE "/api/loans/$M13_L_ID2/rates/$M13_L_ID2_RATE" "$ADMIN"
expect_status 200 "delete the second loan's rate"
expect_jq '.rates == [] and .rateBp == null' "no rate left"
req GET "/api/loans/$M13_L_ID2/interest?date=2025-01-15" "$ADMIN"
expect_jq '.rateBp == null and .interestCents == null' "no rate: no suggestion again"
req DELETE "/api/loans/$M13_L_ID2/rates/$M13_L_ID2_RATE" "$ADMIN"
expect_status 404 "delete the deleted rate"
req GET "/api/audit?entityType=loan&entityId=$M13_L_ID2&limit=50" "$ADMIN"
expect_status 200 "the second loan's audit rows"
expect_jq '[.rows[] | select(.action == "loan.rate_update" and .before.rateBp == 600 and .after.rateBp == 700 and .after.note == "M13 rate edit")] | length == 1' \
  "a loan.rate_update row, before 600 and after 700"
expect_jq '[.rows[] | select(.action == "loan.rate_delete" and .before.rateBp == 700 and .before.fromDate == "2025-01-01")] | length == 1' \
  "a loan.rate_delete row with the rate in before"

echo "--- an Accounts login granted loans.manage writes ---"
req GET /api/auth/me "$ACCT"
expect_status 200 "acct GET /api/auth/me"
M13_L_ACCT_ID=$(jqr '.user.id')
req PUT "/api/users/$M13_L_ACCT_ID/overrides/loans.manage" "$ADMIN" '{"effect":"grant"}'
expect_status 200 "the owner grants acct loans.manage"
req POST "/api/loans/$M13_L_ID2/repayments" "$ACCT" '{"paidDate":"2025-01-15","principalCents":1000,"interestCents":0,"reference":"M13 ACCT"}'
expect_status 201 "acct adds a repayment"
expect_jq '.balanceCents == 999100 and ([.repayments[] | select(.reference == "M13 ACCT")] | length == 1)' "the repayment is kept; balance 999100"
req GET "/api/audit?entityType=loan&entityId=$M13_L_ID2&action=loan.repayment_add&limit=5" "$ADMIN"
expect_status 200 "the repayment's audit row"
expect_jq ".rows[0].actorUserId == $M13_L_ACCT_ID and .rows[0].after.reference == \"M13 ACCT\"" "the row names acct"
req DELETE "/api/users/$M13_L_ACCT_ID/overrides/loans.manage" "$ADMIN"
expect_status 200 "the owner removes acct's loans.manage"
req POST "/api/loans/$M13_L_ID2/repayments" "$ACCT" '{"paidDate":"2025-01-16","principalCents":1000,"interestCents":0}'
expect_status 403 "acct adds a repayment without the grant"

# Refusals on the first loan.
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2024-12-31","principalCents":100}'
expect_status 400 "a repayment before the opening date"
expect_jq '.error == "A repayment can'"'"'t be before the opening date (1 Jan 2025)"' "the before-opening sentence"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" "{\"paidDate\":\"$M13_L_FUTURE\",\"principalCents\":100}"
expect_status 400 "a future repayment"
expect_jq '.error == "The paid date can'"'"'t be in the future"' "the future repayment sentence"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-03-20","principalCents":0,"interestCents":0}'
expect_status 400 "both zero"
expect_jq '.error == "Enter the principal, the interest or both"' "the both-zero sentence"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-03-20","principalCents":11200001,"interestCents":0}'
expect_status 409 "a principal that takes the balance below zero"
expect_jq '.error == "That would take the balance below zero on 20 Mar 2025"' "the below-zero sentence names the date"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-03-20","principalCents":100,"interestCents":0,"balanceAfterCents":5}'
expect_status 400 "an unknown repayment field"
expect_jq '.error == "Unknown field: balanceAfterCents"' "the unknown field sentence"
req PATCH "/api/loans/$M13_L_ID" "$ADMIN" '{"openingDate":"2025-02-01"}'
expect_status 409 "an opening date after a repayment"
expect_jq '.error == "A repayment is dated before that (10 Jan 2025)"' "the opening date sentence"
req PATCH "/api/loans/$M13_L_ID" "$ADMIN" '{"openingBalanceCents":100000}'
expect_status 409 "an opening balance below the principal paid"
expect_jq '.error == "That would take the balance below zero on 10 Jan 2025"' "the opening balance below-zero sentence"

echo "--- edit and delete ---"
req PATCH "/api/loans/$M13_L_ID/repayments/$M13_L_R2" "$ADMIN" '{"principalCents":11500000}'
expect_status 409 "an edit that takes a later balance below zero"
expect_jq '.error == "That would take the balance below zero on 7 Mar 2025"' "the later date is named"
req PATCH "/api/loans/$M13_L_ID/repayments/$M13_L_R2" "$ADMIN" '{"reference":"M13 REF 2"}'
expect_status 200 "edit the 24 Jan reference"
m13_l_rep_on 2025-01-24 '.reference == "M13 REF 2" and .principalCents == 200000' "the reference changed, nothing else"
req DELETE "/api/loans/$M13_L_ID/repayments/$M13_L_R2" "$ADMIN"
expect_status 200 "delete the 24 Jan repayment"
expect_jq '[.repayments[] | [.paidDate, .balanceAfterCents]] == [["2025-01-10",11800000],["2025-02-07",11600000],["2025-03-07",11400000]] and .balanceCents == 11400000' \
  "the later balances rise by 200000"
m13_l_rep_on 2025-02-07 '.interestCents == 57000 and .workedOutInterestCents == 59000' "the stored interest stays; the worked-out one follows the balance"
req DELETE "/api/loans/$M13_L_ID/repayments/$M13_L_R2" "$ADMIN"
expect_status 404 "the deleted repayment is gone"

echo "--- statement ---"
req GET "/api/loans/$M13_L_ID/statement?from=2025-02-01&to=2025-03-31" "$ADMIN"
expect_status 200 "the statement for February and March"
expect_jq ".loan.id == $M13_L_ID and .loan.name == \"$M13_L_NAME\" and .loan.direction == \"lent_to_business\" and .from == \"2025-02-01\" and .to == \"2025-03-31\"" "the statement's loan and period"
expect_jq '.balanceAtStartCents == 11800000 and ([.rows[] | [.paidDate, .principalCents, .interestCents, .totalCents, .balanceAfterCents]] == [["2025-02-07",200000,57000,257000,11600000],["2025-03-07",200000,61750,261750,11400000]])' \
  "starts at the balance after January; two rows"
expect_jq '.totals == {"principalCents":400000,"interestCents":118750,"totalCents":518750} and .balanceAtEndCents == 11400000' "the totals and the end balance"
expect_jq '.rates == [{"fromDate":"2025-01-01","rateBp":600},{"fromDate":"2025-03-01","rateBp":650}]' "both rates were in force in the period"
req GET "/api/loans/$M13_L_ID/statement" "$ADMIN"
expect_status 200 "the statement with the default period"
expect_jq '.from == "2025-01-01" and .balanceAtStartCents == 12000000 and (.rows | length) == 3' "from the opening date"
req GET "/api/loans/$M13_L_ID/statement?from=2025-03-31&to=2025-02-01" "$ADMIN"
expect_status 400 "a statement that ends before it starts"
expect_jq '.error == "The statement can'"'"'t end before it starts"' "the period sentence"
req GET "/api/loans/$M13_L_ID/statement?from=soon" "$ADMIN"
expect_status 400 "a statement from a non-date"
expect_jq '.error == "from and to must be dates"' "the dates sentence"

echo "--- archive ---"
req PATCH "/api/loans/$M13_L_ID" "$ADMIN" '{"archived":true}'
expect_status 200 "archive the loan"
expect_jq '.archived == true' "archived"
req GET /api/loans "$ADMIN"
expect_jq "[.loans[] | select(.id == $M13_L_ID)] | length == 0" "not in the current list"
req GET "/api/loans?archived=1" "$ADMIN"
expect_jq "([.loans[] | select(.id == $M13_L_ID)] | length == 1) and ([.loans[] | .archived] | all)" "in the archived list"
req POST "/api/loans/$M13_L_ID/repayments" "$ADMIN" '{"paidDate":"2025-03-20","principalCents":100,"interestCents":0}'
expect_status 409 "a repayment on an archived loan"
expect_jq '.error == "This loan is archived; restore it to change it"' "the archived sentence"
req POST "/api/loans/$M13_L_ID/rates" "$ADMIN" '{"fromDate":"2025-06-01","rateBp":700}'
expect_status 409 "a rate on an archived loan"
req GET "/api/loans/$M13_L_ID/statement?from=2025-02-01&to=2025-03-31" "$ADMIN"
expect_status 200 "an archived loan's statement"
req PATCH "/api/loans/$M13_L_ID" "$ADMIN" '{"archived":false}'
expect_status 200 "restore the loan"
expect_jq '.archived == false and .balanceCents == 11400000' "restored, balance unchanged"

echo "--- audit ---"
req GET "/api/audit?entityType=loan&entityId=$M13_L_ID&limit=200" "$ADMIN"
expect_status 200 "the loan's audit rows, as the owner"
for M13_L_ACTION in loan.create loan.rate_add loan.repayment_add loan.repayment_update loan.repayment_delete loan.update; do
  expect_jq "[.rows[] | select(.action == \"$M13_L_ACTION\" and .entityType == \"loan\")] | length >= 1" "a $M13_L_ACTION row for the loan"
done
expect_jq '[.rows[] | select(.action == "loan.repayment_delete" and .before.paidDate == "2025-01-24" and .before.principalCents == 200000)] | length == 1' \
  "the delete row keeps the repayment in before"
expect_jq '[.rows[] | select(.action == "loan.update" and .after == {"archived": true})] | length == 1' "the archive row names the changed key only"

echo "--- clean-up ---"
for M13_L_X in "$M13_L_ID" "$M13_L_ID2"; do
  req PATCH "/api/loans/$M13_L_X" "$ADMIN" '{"archived":true}'
  expect_status 200 "archive loan $M13_L_X"
done

echo "M13 loans smoke test passed."
