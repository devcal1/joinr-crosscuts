# M28 smoke: Accounts and vehicles (0.2.7, docs/plans/m28-contracts.md): the vehicles register
# (access, rego and insurance, bookings, the Planner, the 30- and 7-day bells, Waiting on you),
# individual invoices on Supplier accounts (Paid by users.admin only, also on supplier lines; files;
# making a supplier account), invoice Mark sent, follow-up intervals and the contact log, and the
# loans.maintain key. Sourced by ci/smoke.sh after the M27 suites, so it shares that script's helpers
# and cookie jars. No shebang and no `set`: the caller owns both. Made-up names only; it reads only
# its own rows.

# ============================================================================
step "m28. accounts and vehicles"
# ============================================================================

M28_TAG="m28a$(date +%s)"
M28_TODAY=$(TZ=Australia/Sydney date +%F)
M28_MONTH=${M28_TODAY:0:7}
M28_LASTMONTH=$(date -u -d "${M28_MONTH}-01 -1 month" +%Y-%m)
M28_PLUS5=$(date -u -d "$M28_TODAY +5 days" +%F)
M28_PLUS20=$(date -u -d "$M28_TODAY +20 days" +%F)
M28_PLUS30=$(date -u -d "$M28_TODAY +30 days" +%F)
M28_PLUS3=$(date -u -d "$M28_TODAY +3 days" +%F)

echo "--- vehicles: access ---"
req GET /api/vehicles ""
expect_status 401 "logged out"
req GET /api/vehicles "$ACCT"
expect_status 200 "accounts reads the register"
expect_jq '.canEdit == true and .canBook == false and (.vehicles | type) == "array"' "accounts edits rego and insurance, doesn't book"
req GET /api/vehicles "$WSMGR"
expect_status 200 "the workshop manager reads the register"
expect_jq '.canEdit == false and .canBook == true' "the workshop manager books, doesn't edit"
req GET /api/vehicles "$DPM"
expect_status 403 "design/PM doesn't (no accounts.view or maintenance.manage)"
req GET /api/vehicles "$WSHOP"
expect_status 403 "the workshop login doesn't"
req GET /vehicles.html "$ACCT"
case $BODY in *'vehicles.js'*) ok ;; *) fail "vehicles.html doesn't load vehicles.js" ;; esac
req GET /shell/shell.js "$ACCT"
case $BODY in *'"/vehicles.html", key: "accounts.view"'*) ok ;; *) fail "the menu has no Accounts > Vehicles" ;; esac
case $BODY in *'"/vehicles.html", key: "maintenance.manage"'*) ok ;; *) fail "the menu has no Workshop > Vehicles" ;; esac

echo "--- vehicles: the register ---"
req POST /api/vehicles "$WSMGR" "{\"name\":\"$M28_TAG ute\"}"
expect_status 403 "the workshop manager doesn't add vehicles"
req POST /api/vehicles "$ACCT" '{"rego":"ABC123"}'
expect_status 400 "a vehicle needs a name"
req POST /api/vehicles "$ACCT" "{\"name\":\"$M28_TAG ute\",\"regoExpiry\":\"2026-02-30\"}"
expect_status 400 "not a date"
req POST /api/vehicles "$ACCT" "{\"name\":\"$M28_TAG ute\",\"rego\":\"M28UTE\",\"makeModel\":\"Made-up Ute\",\"regoExpiry\":\"$M28_PLUS20\",\"insuranceExpiry\":\"$M28_PLUS5\",\"insurer\":\"Made-up Insurer\",\"policyNumber\":\"P-1\"}"
expect_status 201 "accounts adds a vehicle"
M28_V=$(jqr '.id')
expect_jq ".regoExpiry.date == \"$M28_PLUS20\" and .regoExpiry.days == 20 and .regoExpiry.soon == true and .insuranceExpiry.days == 5 and .active == true" "rego in 20 days, insurance in 5"
req PATCH "/api/vehicles/$M28_V" "$ACCT" '{"policyNumber":"P-2"}'
expect_status 200 "accounts edits the policy number"
expect_jq '.policyNumber == "P-2"' "saved"
req PATCH "/api/vehicles/$M28_V" "$WSMGR" '{"policyNumber":"P-3"}'
expect_status 403 "the workshop manager doesn't"

echo "--- vehicles: bookings ---"
req POST "/api/vehicles/$M28_V/bookings" "$ACCT" "{\"kind\":\"service\",\"date\":\"$M28_TODAY\"}"
expect_status 403 "accounts doesn't book"
req POST "/api/vehicles/$M28_V/bookings" "$WSMGR" "{\"kind\":\"wash\",\"date\":\"$M28_TODAY\"}"
expect_status 400 "not a kind"
req POST "/api/vehicles/$M28_V/bookings" "$WSMGR" "{\"kind\":\"service\",\"date\":\"$M28_TODAY\",\"time\":\"25:00\"}"
expect_status 400 "not a time"
req POST "/api/vehicles/$M28_V/bookings" "$WSMGR" "{\"kind\":\"service\",\"date\":\"$M28_TODAY\",\"time\":\"09:30\",\"place\":\"Made-up Garage\"}"
expect_status 201 "the workshop manager books a service today"
M28_B1=$(jqr '.id')
expect_jq '.kind == "service" and .time == "09:30" and .done == false' "booked"
req POST "/api/vehicles/$M28_V/bookings" "$WSMGR" "{\"kind\":\"repair\",\"date\":\"$M28_PLUS3\"}"
expect_status 201 "and a repair in three days"
M28_B2=$(jqr '.id')
req PATCH "/api/vehicle-bookings/$M28_B2" "$WSMGR" '{"notes":"Made-up note"}'
expect_status 200 "the booking is edited"
req GET /api/my-work "$WSMGR"
expect_jq '[.items[] | select(.key == "vehicleBookings")][0].count >= 1' "Waiting on you: a vehicle booking due"
req GET "/api/planner/events?from=$M28_TODAY&to=$M28_PLUS30" "$ADMIN"
expect_status 200 "the planner"
expect_jq "[.events[] | select(.source == \"vehicle_expiry\" and (.title | contains(\"$M28_TAG ute\")))] | map(.layer) | sort == [\"company\", \"company\"]" "rego and insurance on the Company-wide layer"
expect_jq "[.events[] | select(.source == \"vehicle_booking\" and (.title | contains(\"$M28_TAG ute\")))] | length == 2 and all(.layer == \"workshop\")" "both bookings on the Workshop layer"
req POST "/api/vehicle-bookings/$M28_B1/done" "$ACCT" '{"done":true}'
expect_status 403 "accounts doesn't confirm a booking"
req POST "/api/vehicle-bookings/$M28_B1/done" "$WSMGR" '{"done":true}'
expect_status 200 "the workshop manager confirms it done"
expect_jq '.done == true and .doneBy != null' "done"
req POST "/api/vehicle-bookings/$M28_B1/done" "$WSMGR" '{"done":true}'
expect_status 409 "already done"
req DELETE "/api/vehicle-bookings/$M28_B1" "$WSMGR"
expect_status 409 "a done booking isn't cancelled"
req DELETE "/api/vehicle-bookings/$M28_B2" "$WSMGR"
expect_status 204 "the repair is cancelled"
req DELETE "/api/vehicle-bookings/$M28_B2" "$WSMGR"
expect_status 404 "and is gone"
req GET /api/vehicles "$WSMGR"
expect_jq "[.vehicles[] | select(.id == $M28_V)][0] | .bookings == [] and .lastDone.id == $M28_B1" "no open bookings; the service is the last done"

echo "--- vehicles: the 30- and 7-day bells ---"
req POST /api/followup/sweep "$DPM" '{}'
expect_status 403 "design/PM doesn't run the sweep"
req POST /api/followup/sweep "$ACCT" '{"today":"2020-01-01"}'
expect_status 400 "not in the past"
req POST /api/followup/sweep "$ACCT" '{}'
expect_status 200 "accounts runs the sweep"
expect_jq '.vehicleBells >= 2' "rego (30 days) and insurance (7 days) belled"
req POST /api/followup/sweep "$ACCT" '{}'
req GET "/api/notifications?limit=100" "$ACCT"
expect_jq "[.rows[] | select(.title == \"Rego due: $M28_TAG ute (M28UTE)\")] | length == 1" "accounts belled once for the rego"
expect_jq "[.rows[] | select(.title == \"Insurance due: $M28_TAG ute (M28UTE)\")] | length == 1" "and once for the insurance"
req POST /api/followup/sweep "$ACCT" "{\"today\":\"$M28_PLUS20\"}"
req GET "/api/notifications?limit=100" "$ACCT"
expect_jq "[.rows[] | select(.title == \"Rego due: $M28_TAG ute (M28UTE)\")] | length == 2" "the rego bells again at 7 days"
req GET /api/my-work "$ACCT"
expect_jq '[.items[] | select(.key == "vehicleExpiry")][0].count >= 2' "Waiting on you: rego and insurance within 30 days"
req PATCH "/api/vehicles/$M28_V" "$ACCT" '{"active":false}'
expect_status 200 "the vehicle is made inactive"
req POST "/api/vehicles/$M28_V/bookings" "$WSMGR" "{\"kind\":\"service\",\"date\":\"$M28_PLUS3\"}"
expect_status 409 "an inactive vehicle isn't booked"
req GET /api/vehicles "$ACCT"
expect_jq "[.vehicles[] | select(.id == $M28_V)] | length == 0" "and isn't listed"
req GET "/api/vehicles?all=1" "$ACCT"
expect_jq "[.vehicles[] | select(.id == $M28_V)] | length == 1" "unless all"

echo "--- individual invoices ---"
req GET "/api/payables/months/$M28_MONTH" ""
expect_status 401 "logged out"
req GET "/api/payables/months/$M28_MONTH" "$DPM"
expect_status 403 "design/PM doesn't"
req GET "/api/payables/months/$M28_MONTH" "$ACCT"
expect_status 200 "accounts reads the month"
req GET "/api/payables/months/2019-01" "$ACCT"
expect_status 404 "before the lists start"
req POST /api/payables "$ACCT" '{"description":"no payee"}'
expect_status 400 "a payee is needed"
req POST /api/payables "$DPM" "{\"payee\":\"$M28_TAG plumber\"}"
expect_status 403 "design/PM doesn't add"
req POST /api/payables "$ACCT" "{\"payee\":\"$M28_TAG plumber\",\"description\":\"Made-up repair\"}"
expect_status 201 "accounts adds an individual invoice"
M28_P=$(jqr '.id')
expect_jq ".period == \"$M28_MONTH\" and .amountCents == null and .missing == true and .dueDate == null and .paid == false" "this month, figure missing, no due date"
req GET /api/my-work "$ACCT"
expect_jq '[.items[] | select(.key == "payableNoDue")][0].count >= 1' "Waiting on you: an individual invoice without a due date"
req GET "/api/payables/months/$M28_MONTH" "$ACCT"
expect_jq "([.lines[] | select(.id == $M28_P)] | length == 1) and .counts.missing >= 1" "listed, counted missing"
req GET /api/my-work "$ADMIN"
expect_jq '[.items[] | select(.key == "toPay")][0] | .noFigure >= 1 and (.text | test("without a figure\\)$"))' "admin: lines without a figure shown separately"
req GET /api/recurring "$ADMIN"
expect_jq '[.[]?, .rules[]?, .items[]? | select(type == "object" and .title == "Check loan balances against statements")] | length == 1' "the monthly loan check is seeded once"
req PATCH "/api/payables/$M28_P" "$ACCT" "{\"amountCents\":12345,\"dueDate\":\"$M28_TODAY\",\"myob\":true}"
expect_status 200 "the amount and due date"
expect_jq '.amountCents == 12345 and .missing == false and .myob == true' "saved"
req PATCH "/api/payables/$M28_P" "$ACCT" '{"amountCents":1.5}'
expect_status 400 "whole cents only"
req GET /api/my-work "$ADMIN"
expect_jq '[.items[] | select(.key == "toPay")][0] | .count >= 1 and (.text | startswith("To pay this month: ")) and (.noFigure | type) == "number"' "admin: To pay this month"
req POST "/api/payables/$M28_P/paid" "$ACCT" '{"paid":true}'
expect_status 403 "accounts doesn't tick paid"
req POST "/api/payables/$M28_P/paid" "$ADMIN" '{"paid":true}'
expect_status 200 "admin ticks paid"
expect_jq ".paid == true and .paidDate == \"$M28_TODAY\"" "paid today"
req POST "/api/payables/$M28_P/paid" "$ADMIN" '{"paid":true}'
expect_status 409 "already paid"
req DELETE "/api/payables/$M28_P" "$ACCT"
expect_status 409 "a paid one isn't removed"
req POST "/api/payables/$M28_P/paid" "$ADMIN" '{"paid":false}'
expect_status 200 "unticked"
printf '%s\n' '%PDF-1.4' '1 0 obj' '<< >>' 'endobj' 'trailer' '<< >>' '%%EOF' > "$WORK/m28-bill.pdf"
LAST_REQ="POST /api/payables/$M28_P/file"
STATUS=$(curl -s -o "$BODY_FILE" -D "$HDR_FILE" -w '%{http_code}' -X POST -H "Origin: $REQ_ORIGIN" \
  -b "$ACCT" -c "$ACCT" -F "file=@$WORK/m28-bill.pdf;filename=M28 bill.pdf;type=application/pdf" "$BASE/api/payables/$M28_P/file")
BODY=$(cat "$BODY_FILE")
expect_status 201 "the invoice file is attached"
M28_F=$(jqr '.file.id')
req GET "/api/files/$M28_F" "$ACCT"
expect_status 200 "accounts downloads it"
req GET "/api/files/$M28_F" "$DPM"
expect_status 404 "design/PM can't"
req POST "/api/payables/$M28_P/convert" "$ACCT" '{}'
expect_status 201 "the payee is made a supplier account"
expect_jq ".supplier.name == \"$M28_TAG plumber\" and .payable.supplier.id == .supplier.id" "linked"
M28_S=$(jqr '.supplier.id')
req POST "/api/payables/$M28_P/convert" "$ACCT" '{}'
expect_status 409 "only once"
req GET "/api/suppliers/months/$M28_MONTH" "$ACCT"
expect_jq "[.lines[] | select(.supplier.id == $M28_S)] | length == 1" "listed on Supplier accounts this month"

echo "--- Paid on a supplier line is admin's ---"
req PUT "/api/suppliers/months/$M28_MONTH/$M28_S" "$ACCT" '{"state":"have","totalCents":5000,"paid":true,"updatedAt":null}'
expect_status 403 "accounts doesn't tick a supplier line paid"
req PUT "/api/suppliers/months/$M28_MONTH/$M28_S" "$ACCT" '{"state":"have","totalCents":5000,"updatedAt":null}'
expect_status 200 "accounts still saves the line"
M28_SU=$(jqr '.updatedAt')
req PUT "/api/suppliers/months/$M28_MONTH/$M28_S" "$ADMIN" "$(jq -nc --arg u "$M28_SU" '{paid:true,updatedAt:$u}')"
expect_status 200 "admin ticks it paid"
expect_jq '.paid == true' "paid"

req POST /api/payables "$ACCT" "{\"payee\":\"$M28_TAG electrician\",\"amountCents\":100}"
M28_P2=$(jqr '.id')
req DELETE "/api/payables/$M28_P2" "$ACCT"
expect_status 204 "an unpaid one is removed"
req GET "/api/payables/$M28_P2" "$ACCT"
expect_status 404 "and is gone"

echo "--- invoices: sent and follow-up ---"
req GET /api/followup "$ACCT"
expect_status 200 "the follow-up settings"
expect_jq '.defaultDays >= 1' "a default interval"
req PUT /api/followup/default "$ACCT" '{"days":0}'
expect_status 400 "not zero days"
req PUT /api/followup/default "$ACCT" '{"days":7}'
expect_status 200 "the default is 7"
req PUT /api/followup/default "$DPM" '{"days":7}'
expect_status 403 "design/PM doesn't"
req POST /api/jobs/backlog "$ADMIN" "{\"name\":\"$M28_TAG job\"}"
expect_status 201 "a job"
M28_J=$(jqr '.jobId')
req PATCH "/api/job-records/$M28_J" "$ADMIN" "{\"clientName\":\"$M28_TAG Client\",\"valueCents\":200000}"
expect_status 200 "with a client and a value"
req POST /api/invoices "$ACCT" "{\"jobId\":$M28_J,\"kind\":\"deposit\"}"
expect_status 201 "a deposit"
M28_I=$(jqr '.id')
req POST "/api/invoices/$M28_I/sent" "$ACCT" '{}'
expect_status 409 "a due invoice isn't sent"
req PATCH "/api/invoices/$M28_I" "$ACCT" '{"dueDate":"2020-01-02"}'
expect_status 200 "due long ago"
req POST "/api/invoices/$M28_I/issue" "$ACCT" '{}'
expect_status 200 "issued"
expect_jq '.sentDate == null and .followUpDays == null and .followUpDaysEffective == 7 and .followUpDaysFrom == "default" and .needsFollowUp == true' "not sent; 7 days from the default; needs follow-up"
req GET /api/my-work "$ACCT"
expect_jq '([.items[] | select(.key == "notSent")][0].count >= 1) and ([.items[] | select(.key == "followUp")][0].count >= 1)' "Waiting on you: issued not sent, and needs follow-up"
req PUT /api/followup/clients "$ACCT" "{\"clientName\":\"  $M28_TAG.   client, \",\"followUpDays\":14}"
expect_status 200 "accounts sets the client's terms (matched loosely: case, spaces, punctuation)"
expect_jq "[.clients[] | select(.clientName == \"$M28_TAG. client,\")][0].followUpDays == 14" "14 days"
req PUT /api/followup/clients "$DPM" "{\"clientName\":\"$M28_TAG Client\",\"followUpDays\":14}"
expect_status 403 "design/PM doesn't"
req POST "/api/invoices/$M28_I/sent" "$ACCT" "{\"date\":\"$M28_PLUS3\"}"
expect_status 400 "not in the future"
req POST "/api/invoices/$M28_I/sent" "$ACCT" '{}'
expect_status 200 "Mark sent"
expect_jq ".sentDate == \"$M28_TODAY\" and .followUpDays == 14 and .followUpDaysFrom == \"invoice\" and .clientFollowUpDays == 14" "sent today; the interval filled from the client's terms"
req PATCH "/api/invoices/$M28_I" "$ACCT" '{"followUpDays":0}'
expect_status 400 "at least a day"
req PATCH "/api/invoices/$M28_I" "$ACCT" '{"followUpDays":30}'
expect_status 200 "changed for this invoice"
expect_jq '.followUpDaysEffective == 30' "30 days"
req POST "/api/invoices/$M28_I/contacts" "$DPM" '{}'
expect_status 403 "design/PM doesn't log a contact"
req POST "/api/invoices/$M28_I/contacts" "$ACCT" '{"note":"Made-up call: paying Friday"}'
expect_status 201 "Contacted today"
expect_jq ".invoice.lastContactedDate == \"$M28_TODAY\" and .invoice.needsFollowUp == false and (.contacts | length) == 1 and .contacts[0].note == \"Made-up call: paying Friday\"" "logged; last contacted today; no longer needs follow-up"
req GET "/api/invoices/$M28_I/contacts" "$ACCT"
expect_jq '.contacts | length == 1' "the contact log"
req POST /api/followup/sweep "$ACCT" '{}'
expect_jq 'has("followUp") and has("belled")' "the sweep counts what needs follow-up"
req POST "/api/invoices/$M28_I/sent" "$ACCT" '{"sent":false}'
expect_status 200 "sent cleared"
expect_jq '.sentDate == null' "cleared"

echo "--- loans.maintain ---"
req GET /api/users/meta "$ADMIN"
expect_jq '(.keys | index("loans.maintain")) != null and (.adminExcludedKeys | index("loans.maintain")) != null and (.presets.accounts | index("loans.maintain")) != null and (.presets.admin | index("loans.maintain")) == null' "the 39th key: in the accounts preset, not admin's"
req POST /api/loans "$ADMIN" "{\"name\":\"$M28_TAG loan\",\"direction\":\"lent_to_business\",\"openingBalanceCents\":500000,\"openingDate\":\"2025-01-01\"}"
expect_status 201 "the owner opens a loan"
M28_L=$(jqr '.id')
req GET /api/loans "$DPM"
expect_status 403 "design/PM can't"
req GET /api/loans "$ACCT2"
expect_status 200 "acct2 sees the loans"
req GET /loans.html "$ACCT2"
expect_status 200 "and the page"
req GET /api/loans "$ACCT"
expect_status 200 "acct too (the accounts preset)"
req POST /api/loans "$ACCT2" "{\"name\":\"$M28_TAG refused\",\"direction\":\"lent_to_business\",\"openingBalanceCents\":100,\"openingDate\":\"2025-01-01\"}"
expect_status 403 "openings stay owner-only"
req PATCH "/api/loans/$M28_L" "$ACCT2" '{"note":"x"}'
expect_status 403 "editing the loan stays owner-only"
req POST "/api/loans/$M28_L/rates" "$ACCT2" '{"fromDate":"2025-01-01","rateBp":500}'
expect_status 403 "rates stay owner-only"
req PUT "/api/loans/$M28_L/plan" "$ACCT2" '{"kind":null}'
expect_status 403 "plans stay owner-only"
req POST "/api/loans/$M28_L/repayments" "$ACCT2" '{"paidDate":"2025-02-05","totalCents":10000}'
expect_status 201 "acct2 records a payment"
M28_R=$(jqr '.repayments[0].id')
req DELETE "/api/loans/$M28_L/repayments/$M28_R" "$ACCT2"
expect_status 403 "deletes stay owner-only"
req PUT "/api/loans/$M28_L/checked/2024-12" "$ACCT2" '{"checked":true}'
expect_status 400 "before the loan opened"
req PUT "/api/loans/$M28_L/checked/$M28_LASTMONTH" "$ACCT2" '{"checked":"yes"}'
expect_status 400 "true or false"
req GET "/api/loans/$M28_L" "$ACCT2"
M28_UNCH=$(jqr '.uncheckedMonths')
req PUT "/api/loans/$M28_L/checked/$M28_LASTMONTH" "$ACCT2" '{"checked":true}'
expect_status 200 "acct2 ticks last month Statement checked"
expect_jq "([.months[] | select(.period == \"$M28_LASTMONTH\")][0].checked.by.id == $ACCT2_ID) and .uncheckedMonths == $((M28_UNCH - 1))" "checked, by acct2; one fewer unchecked"
req GET /api/my-work "$ACCT2"
expect_jq '[.items[] | select(.key == "loanMonths")][0].count >= 1' "Waiting on you: loan months not checked"
req DELETE "/api/loans/$M28_L/repayments/$M28_R" "$ADMIN"
expect_status 200 "the owner deletes the payment"
req PUT "/api/users/$ACCT2_ID/overrides/loans.maintain" "$ADMIN" '{"effect":"revoke"}'
expect_status 200 "an admin revokes acct2's loans.maintain"
req GET /api/loans "$ACCT2"
expect_status 403 "acct2 can't then"
req DELETE "/api/users/$ACCT2_ID/overrides/loans.maintain" "$ADMIN"
expect_status 200 "the override removed"
