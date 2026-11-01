# AMEX smoke (0.2.12): the company card ledger. Charges and repayments, a repayment covering the
# ticked charges, a running balance, the year figures and the range filter.
# Sourced by ci/smoke.sh after the Jobs-as-containers suite, so it shares that script's helpers
# (step, req, expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie jars
# ($ADMIN $SCHED $ACCT). No shebang and no `set`: the caller owns both.
# It does not assume a pristine database, and it does not depend on today's date: every row is
# dated 2001 (always before this year's window) or 2035 (never before it), the figures are checked
# as changes from the baseline read at the start, and the "this year" figures are checked unchanged.
# Made-up names only. Access is the same as Loans: loans.manage (the owner) or loans.maintain
# (the Accounts preset).

# ============================================================================
step "amex. company card ledger"
# ============================================================================

AX_TAG=$(date +%s)
AX_OLD="2001-03-05"
AX_D1="2035-02-01"
AX_D2="2035-02-10"

# --- access: loans.manage or loans.maintain, like Loans ---
for AX_P in /amex.html /amexprint.html; do
  req GET "$AX_P" "$ADMIN"
  expect_status 200 "admin GET $AX_P"
  req GET "$AX_P" "$ACCT"
  expect_status 200 "acct GET $AX_P"
  req GET "$AX_P" "$SCHED"
  expect_status 403 "sched GET $AX_P"
done
req GET /api/amex "$SCHED"
expect_status 403 "sched GET /api/amex"
req GET /api/amex "$ACCT"
expect_status 200 "acct GET /api/amex"
req GET "/api/amex?range=all" "$ADMIN"
expect_status 200 "admin GET /api/amex"
expect_jq '.statement | type == "array"' "the list carries a statement"
AX_OWING0=$(jqr '.owingCents')
AX_YCHG0=$(jqr '.chargedYearCents')
AX_YREP0=$(jqr '.repaidYearCents')
req POST /api/amex/transactions "$SCHED" '{"txnDate":"2035-02-01","supplier":"AX Refused","amountCents":100}'
expect_status 403 "sched POST a transaction"
req POST /api/amex/repayments "$SCHED" '{"paidDate":"2035-02-01","amountCents":100,"transactionIds":[1]}'
expect_status 403 "sched POST a repayment"

# --- validation ---
req GET "/api/amex?range=decade" "$ADMIN"
expect_status 400 "a bad range"
req POST /api/amex/transactions "$ADMIN" '{"txnDate":"2035-13-45","supplier":"AX Bad","amountCents":100}'
expect_status 400 "a bad date"
req POST /api/amex/transactions "$ADMIN" '{"txnDate":"2035-02-01","supplier":"AX Bad","amountCents":0}'
expect_status 400 "a zero amount"
req POST /api/amex/transactions "$ADMIN" '{"txnDate":"2035-02-01","supplier":"AX Bad","amountCents":-5}'
expect_status 400 "a negative amount"
req POST /api/amex/transactions "$ADMIN" '{"txnDate":"2035-02-01","supplier":"AX Bad","amountCents":10.5}'
expect_status 400 "a fractional amount"
req POST /api/amex/transactions "$ADMIN" '{"txnDate":"2035-02-01","supplier":"  ","amountCents":100}'
expect_status 400 "a blank supplier"
expect_jq '.error == "Supplier is required"' "the supplier sentence"
req POST /api/amex/transactions "$ADMIN" '{"txnDate":"2035-02-01","supplier":"AX Bad","amountCents":100,"interest":5}'
expect_status 400 "an unknown field"

# --- add three charges (the first long ago, two on one day) ---
req POST /api/amex/transactions "$ACCT" "{\"txnDate\":\"$AX_OLD\",\"supplier\":\"AX Old Supplier $AX_TAG\",\"note\":\"AX old\",\"amountCents\":10000}"
expect_status 201 "acct adds the old charge"
AX_A=$(jqr '.id')
expect_jq '.paid == false and .amountCents == 10000 and .supplier == "'"AX Old Supplier $AX_TAG"'"' "the old charge as saved"
req POST /api/amex/transactions "$ADMIN" "{\"txnDate\":\"$AX_D1\",\"supplier\":\"AX Supplier B $AX_TAG\",\"note\":\"AX b\",\"amountCents\":25050}"
expect_status 201 "add charge B"
AX_B=$(jqr '.id')
req POST /api/amex/transactions "$ADMIN" "{\"txnDate\":\"$AX_D1\",\"supplier\":\"AX Supplier C $AX_TAG\",\"amountCents\":7000}"
expect_status 201 "add charge C"
AX_C=$(jqr '.id')

# --- edit ---
req PATCH "/api/amex/transactions/$AX_C" "$ADMIN" '{"note":"AX c note","amountCents":7005}'
expect_status 200 "edit charge C"
expect_jq '.note == "AX c note" and .amountCents == 7005' "charge C as edited"
req PATCH "/api/amex/transactions/$AX_C" "$ADMIN" '{"amountCents":0}'
expect_status 400 "an edit to a zero amount"
req PATCH "/api/amex/transactions/999999999" "$ADMIN" '{"note":"x"}'
expect_status 404 "edit a missing charge"

# --- totals across the whole ledger ---
req GET "/api/amex?range=all" "$ADMIN"
expect_status 200 "the whole ledger"
expect_eq "$(jqr '.owingCents')" "$((AX_OWING0 + 10000 + 25050 + 7005))" "owing is the baseline plus the three charges"
expect_eq "$(jqr '.chargedYearCents')" "$AX_YCHG0" "the 2001 and 2035 charges are not in this year's figure"
expect_jq '.openingCents == null' "no opening balance on Everything"
expect_jq "[.unpaid[] | select(.id == $AX_A or .id == $AX_B or .id == $AX_C)] | length == 3" "all three are unpaid"
expect_jq "[.statement[] | select(.kind == \"charge\" and (.id == $AX_B or .id == $AX_C))] | length == 2" "both 2035 charges are on the statement"
expect_jq ".statement[-1].balanceCents == .owingCents" "the last balance is owing now"

# --- the year window starts from the balance before it ---
req GET "/api/amex?range=year" "$ADMIN"
expect_status 200 "this year"
expect_jq "[.statement[] | select(.id == $AX_A and .kind == \"charge\")] | length == 0" "the 2001 charge is outside this year"
expect_jq "[.statement[] | select(.id == $AX_B and .kind == \"charge\")] | length == 1" "the 2035 charge is inside"
expect_jq '.openingCents >= 10000' "the opening balance holds the 2001 charge"
expect_jq ".statement[-1].balanceCents == .owingCents" "the last balance is still owing now"
AX_OPEN=$(jqr '.openingCents')
AX_FIRST=$(jqr '.statement[0].balanceCents')
AX_FIRSTAMT=$(jqr '.statement[0].amountCents')
expect_eq "$((AX_OPEN + AX_FIRSTAMT))" "$AX_FIRST" "the first row's balance builds on the opening balance"
req GET "/api/amex?range=12m" "$ADMIN"
expect_status 200 "last 12 months"
expect_jq '.openingCents != null' "12 months has an opening balance"
expect_jq ".statement[-1].balanceCents == .owingCents" "12 months ends at owing now"

# --- a repayment: needs charges, all unpaid ---
req POST /api/amex/repayments "$ADMIN" "{\"paidDate\":\"$AX_D1\",\"amountCents\":32055}"
expect_status 400 "a repayment with no transactions"
req POST /api/amex/repayments "$ADMIN" "{\"paidDate\":\"$AX_D1\",\"amountCents\":32055,\"transactionIds\":[]}"
expect_status 400 "a repayment with an empty list"
req POST /api/amex/repayments "$ADMIN" "{\"paidDate\":\"$AX_D1\",\"amountCents\":32055,\"transactionIds\":[999999999]}"
expect_status 400 "a repayment for a missing charge"
req POST /api/amex/repayments "$ADMIN" "{\"paidDate\":\"nope\",\"amountCents\":32055,\"transactionIds\":[$AX_B]}"
expect_status 400 "a repayment with a bad date"
req POST /api/amex/repayments "$ADMIN" "{\"paidDate\":\"$AX_D1\",\"amountCents\":0,\"transactionIds\":[$AX_B]}"
expect_status 400 "a repayment of nothing"
req POST /api/amex/repayments "$ADMIN" "{\"paidDate\":\"$AX_D1\",\"amountCents\":100,\"transactionIds\":[$AX_B,$AX_B]}"
expect_status 400 "a charge ticked twice"

# B and C repaid on the same date as the charges (the repayment lists after them)
req POST /api/amex/repayments "$ACCT" "{\"paidDate\":\"$AX_D1\",\"amountCents\":32055,\"note\":\"AX rep\",\"transactionIds\":[$AX_B,$AX_C]}"
expect_status 201 "acct records the repayment"
AX_R=$(jqr '.id')
expect_jq '.coversCount == 2 and .coveredCents == 32055 and .coversFrom == "'"$AX_D1"'"' "the repayment covers both"

req GET "/api/amex?range=all" "$ADMIN"
expect_eq "$(jqr '.owingCents')" "$((AX_OWING0 + 10000))" "owing drops by the repayment"
expect_eq "$(jqr '.repaidYearCents')" "$AX_YREP0" "a 2035 repayment is not in this year's figure"
expect_jq "[.unpaid[] | select(.id == $AX_B or .id == $AX_C)] | length == 0" "B and C are no longer unpaid"
expect_jq "[.unpaid[] | select(.id == $AX_A)] | length == 1" "A is still unpaid"
expect_jq "[.statement[] | select(.kind == \"charge\" and .id == $AX_B)][0].paid == true" "B is marked paid"
expect_jq "[.statement[] | select(.kind == \"repayment\" and .id == $AX_R)][0].coversCount == 2" "the statement shows the repayment"
# same date: the repayment sits after both charges
expect_jq ".statement | map(select(.date == \"$AX_D1\")) | .[-1].kind == \"repayment\"" "on one date the repayment is listed after the charges"
expect_jq ".statement[-1].balanceCents == .owingCents" "the last balance is owing now after the repayment"

# --- a paid charge can't be deleted or have its amount changed ---
req DELETE "/api/amex/transactions/$AX_B" "$ADMIN"
expect_status 409 "delete a paid charge"
expect_jq '.error == "This transaction has been paid back, so it can'"'"'t be deleted. Delete the repayment first."' "the paid-back sentence"
req PATCH "/api/amex/transactions/$AX_B" "$ADMIN" '{"amountCents":1}'
expect_status 409 "change a paid charge's amount"
req PATCH "/api/amex/transactions/$AX_B" "$ADMIN" '{"note":"AX b paid note"}'
expect_status 200 "a paid charge's note can change"
req POST /api/amex/repayments "$ADMIN" "{\"paidDate\":\"$AX_D2\",\"amountCents\":100,\"transactionIds\":[$AX_B]}"
expect_status 400 "a paid charge can't be ticked again"
expect_jq '.error | test("already been paid back")' "the already-paid sentence"

# --- the repayment's own edit, then delete: the charges are owing again ---
req PATCH "/api/amex/repayments/$AX_R" "$ADMIN" "{\"paidDate\":\"$AX_D2\",\"note\":\"AX rep moved\"}"
expect_status 200 "move the repayment's date"
expect_jq '.coversCount == 2' "it still covers both"
req DELETE "/api/amex/repayments/$AX_R" "$ACCT"
expect_status 200 "acct deletes the repayment"
req DELETE "/api/amex/repayments/$AX_R" "$ADMIN"
expect_status 404 "the repayment is gone"
req GET "/api/amex?range=all" "$ADMIN"
expect_eq "$(jqr '.owingCents')" "$((AX_OWING0 + 10000 + 25050 + 7005))" "owing is back up"
expect_jq "[.unpaid[] | select(.id == $AX_B or .id == $AX_C)] | length == 2" "B and C are owing again"
expect_jq "[.statement[] | select(.kind == \"repayment\" and .id == $AX_R)] | length == 0" "the repayment is off the statement"

# --- a repayment whose amount differs from the ticked total is allowed ---
req POST /api/amex/repayments "$ADMIN" "{\"paidDate\":\"$AX_D2\",\"amountCents\":30000,\"transactionIds\":[$AX_B,$AX_C]}"
expect_status 201 "a repayment that differs from the ticked total"
AX_R2=$(jqr '.id')
expect_jq '.amountCents == 30000 and .coveredCents == 32055' "the amount and the covered total are both kept"
req GET "/api/amex?range=all" "$ADMIN"
expect_eq "$(jqr '.owingCents')" "$((AX_OWING0 + 10000 + 32055 - 30000))" "owing follows the repayment's amount"

# --- delete: an unpaid charge goes; a repayment's delete frees its charges ---
req DELETE "/api/amex/repayments/$AX_R2" "$ADMIN"
expect_status 200 "delete the second repayment"
for AX_X in "$AX_A" "$AX_B" "$AX_C"; do
  req DELETE "/api/amex/transactions/$AX_X" "$ADMIN"
  expect_status 200 "delete charge $AX_X"
done
req DELETE "/api/amex/transactions/$AX_A" "$ADMIN"
expect_status 404 "a deleted charge is gone"
req GET "/api/amex?range=all" "$ADMIN"
expect_eq "$(jqr '.owingCents')" "$AX_OWING0" "owing is back to the baseline"
expect_eq "$(jqr '.chargedYearCents')" "$AX_YCHG0" "this year's charged figure is unchanged"
expect_eq "$(jqr '.repaidYearCents')" "$AX_YREP0" "this year's repaid figure is unchanged"

# --- audit ---
req GET "/api/audit?entityType=amex_transaction&entityId=$AX_B&limit=50" "$ADMIN"
expect_status 200 "the charge's audit rows"
for AX_ACT in amex.transaction_add amex.transaction_update amex.transaction_delete; do
  expect_jq "[.rows[] | select(.action == \"$AX_ACT\")] | length >= 1" "a $AX_ACT row"
done
req GET "/api/audit?entityType=amex_repayment&entityId=$AX_R&limit=50" "$ADMIN"
expect_status 200 "the repayment's audit rows"
for AX_ACT in amex.repayment_add amex.repayment_update amex.repayment_delete; do
  expect_jq "[.rows[] | select(.action == \"$AX_ACT\")] | length >= 1" "a $AX_ACT row"
done

echo "AMEX smoke test passed."
