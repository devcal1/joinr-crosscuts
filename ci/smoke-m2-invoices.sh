# M2 smoke suite A: invoices backend. Sourced by ci/smoke.sh between steps j and
# k, so it shares that script's shell: the helpers (step, req, expect_status,
# expect_jq, expect_eq, jqr, fail, ok), the cookie jars ($ADMIN $SCHED $ACCT
# $DPM $SHOW) and $CONTAINER. No shebang and no `set`: the caller owns both.
# Contract: docs/plans/m2-contracts.md section 8.

# ============================================================================
step "m2-a. invoices"
# ============================================================================

M2A_WEEK_PRE=2033-02-28   # three Mondays far from every other test week
M2A_WEEK=2033-03-07
M2A_WEEK_NEXT=2033-03-14
M2A_TODAY=$(TZ=Australia/Sydney date +%F)
M2A_PAST=2020-01-02
M2A_DUE_DEFAULT=$(date -u -d "$M2A_TODAY + 10 days" +%F)

# The job's invoices (as the admin) -> BODY; M2A_INV = the live (not void)
# invoice of that kind, or empty.
m2a_job_invoices() { # JOB_ID
  req GET "/api/invoices/job/$1" "$ADMIN"
  expect_status 200 "GET /api/invoices/job/$1"
}
m2a_find() { # JOB_ID KIND
  m2a_job_invoices "$1"
  M2A_INV=$(jqr "[.[] | select(.kind == \"$2\" and .status != \"void\")] | .[0].id // \"\"")
}

# A job on the To start list, optionally with a value -> M2A_BL, M2A_JOB.
m2a_backlog_job() { # NAME [VALUE_CENTS]
  req POST /api/jobs/backlog "$ADMIN" "{\"name\":\"$1\"}"
  expect_status 201 "POST /api/jobs/backlog $1"
  M2A_BL=$(jqr '.id')
  M2A_JOB=$(jqr '.jobId')
  if [ -n "${2:-}" ]; then
    req PATCH "/api/job-records/$M2A_JOB" "$ADMIN" "{\"valueCents\":$2}"
    expect_status 200 "set the value of $1"
  fi
}

# Count the audit rows of an action on one invoice; fail if fewer than MIN.
m2a_audit_min() { # ACTION INVOICE_ID MIN
  req GET "/api/audit?action=$1&entityType=invoice&entityId=$2&limit=1" "$ADMIN"
  expect_status 200 "GET /api/audit?action=$1"
  local n
  n=$(jqr '.total')
  [ "$n" -ge "$3" ] || fail "expected at least $3 '$1' audit rows for invoice $2, got $n"
  ok
}

# Issue as accounts and check the number is the next one in the series.
m2a_issue() { # INVOICE_ID
  req POST "/api/invoices/$1/issue" "$ACCT" "${2:-}"
  expect_status 200 "issue invoice $1"
  expect_jq '.status == "issued"' "invoice $1 is issued"
  M2A_NUM=$(jqr '.number')
  expect_eq "$M2A_NUM" "$(printf 'CC-%04d' "$M2A_N")" "invoice $1 takes the next number"
  M2A_N=$((M2A_N + 1))
}

echo "--- who may call what ---"
for jar in "$SCHED" "$DPM" "$SHOW"; do
  for path in /api/invoices/table /api/invoices/overdue /api/invoices/summary /api/invoices/job/1 /api/invoices/1; do
    req GET "$path" "$jar"
    expect_status 403 "non-accounts GET $path"
  done
  req POST /api/invoices "$jar" '{"jobId":1,"kind":"deposit"}'
  expect_status 403 "non-accounts POST /api/invoices"
  for action in issue paid unpaid myob void waive unwaive; do
    req POST "/api/invoices/1/$action" "$jar" '{}'
    expect_status 403 "non-accounts POST /api/invoices/1/$action"
  done
  req PATCH /api/invoices/1 "$jar" '{"notes":"x"}'
  expect_status 403 "non-accounts PATCH /api/invoices/1"
done
for jar in "$ACCT" "$ADMIN"; do
  for path in /api/invoices/table /api/invoices/overdue /api/invoices/summary; do
    req GET "$path" "$jar"
    expect_status 200 "accounts GET $path"
  done
done
req GET /api/invoices/table "$ACCT"
expect_jq '(.rows | type) == "array" and (.totals | has("outstandingCents") and has("overdueCents") and has("dueCount") and has("overdueCount") and has("notInMyobCount"))' "table shape"
req GET /api/invoices/summary "$ACCT"
expect_jq 'has("dueCount") and has("overdueCount")' "summary shape"
req GET "/api/invoices/table?filter=bogus" "$ACCT"
expect_status 400 "table with a bad filter"
req GET /api/invoices/999999 "$ACCT"
expect_status 404 "GET a missing invoice"

echo "--- the first placement makes the deposit due (an awkward value) ---"
m2a_backlog_job "M2 Split Kitchen" 1000001   # $10,000.01
J1=$M2A_JOB
BL1=$M2A_BL
req PATCH "/api/job-records/$J1" "$ADMIN" \
  '{"clientName":"M2 Client","clientPhone":"0400 000 000","siteAddress":"12 Rose St","clientAbn":"51 824 753 556"}'
expect_status 200 "set the client details"
expect_jq '.clientAbn == "51 824 753 556"' "clientAbn is stored and returned"
m2a_job_invoices "$J1"
expect_jq 'length == 0' "no invoices before the job is placed"

req POST "/api/jobs/backlog/$BL1/place" "$ADMIN" "{\"weekStart\":\"$M2A_WEEK\",\"panel\":\"manufacturing\"}"
expect_status 201 "place the backlog job"
ROW1=$(jqr '.rowId')
m2a_job_invoices "$J1"
expect_jq 'length == 1' "one invoice after the first placement"
expect_jq '.[0].kind == "deposit" and .[0].status == "due" and .[0].dueReason == "scheduled"' "the deposit is due, reason scheduled"
expect_jq ".[0].becameDueDate == \"$M2A_TODAY\"" "the deposit became due today"
expect_jq '.[0].suggestedCents == 100000 and .[0].lines[0].amountCents == 100000 and .[0].totalCents == 100000' "deposit is 10% of the value"
expect_jq '.[0].lines[0].description == "Deposit (10%): M2 Split Kitchen, 12 Rose St"' "the standard line"
expect_jq '.[0].job.name == "M2 Split Kitchen" and .[0].job.clientAbn == "51 824 753 556" and .[0].job.valueCents == 1000001' "the job summary is embedded"
DEP=$(jqr '.[0].id')
req GET "/api/job-records/$J1" "$ADMIN"
expect_jq '.stage == "on_board"' "placing puts the job on the board"

echo "--- placing it again does not make a second deposit ---"
req POST "/api/rows/$ROW1/duplicate" "$ADMIN" '{}'
expect_status 201 "duplicate the row to next week"
req POST /api/rows "$ADMIN" "{\"weekStart\":\"$M2A_WEEK_NEXT\",\"panel\":\"installing\",\"jobId\":$J1}"
expect_status 201 "add the job to the board again"
m2a_job_invoices "$J1"
expect_jq 'length == 1 and .[0].id == '"$DEP" "still the one deposit"

echo "--- a job typed straight onto the board gets a deposit too ---"
req POST /api/rows "$ADMIN" "{\"weekStart\":\"$M2A_WEEK_NEXT\",\"panel\":\"manufacturing\",\"jobName\":\"M2 Quick Add\"}"
expect_status 201 "quick-add a job to the board"
JQA=$(jqr '.jobId')
m2a_job_invoices "$JQA"
# An invoice always has a value (Todd, 2026-10-11): with no job value the deposit waits as pending.
expect_jq 'length == 1 and .[0].kind == "deposit" and .[0].status == "pending" and .[0].dueReason == "scheduled"' \
  "quick-add job (no value): the deposit waits as pending"
JQA_DEP=$(jqr '.[0].id')
req POST "/api/invoices/$JQA_DEP/issue" "$ACCT" '{}'
expect_status 409 "a deposit waiting for a value cannot be issued"
m2a_audit_min invoice.waiting "$JQA_DEP" 1
req GET "/api/notifications?limit=100" "$ACCT"
expect_jq "[.rows[] | select(.kind == \"invoice.waiting\" and .link == \"/job.html?id=$JQA\")] | length == 1" \
  "accounts is told the deposit is waiting for a value"
req PATCH "/api/job-records/$JQA" "$ADMIN" '{"valueCents":250000}'
expect_status 200 "give the quick-add job a value"
m2a_job_invoices "$JQA"
expect_jq 'length == 1 and .[0].id == '"$JQA_DEP"' and .[0].status == "due" and .[0].suggestedCents == 25000' \
  "the value makes the waiting deposit due, 10% of the value"
m2a_audit_min invoice.due "$JQA_DEP" 1

echo "--- a job with another week row gets no deposit, and no final ---"
req POST /api/job-records "$ADMIN" '{"name":"M2 Legacy"}'
expect_status 201 "create the legacy job"
J2=$(jqr '.id')
# Finish week -> manufacturing puts a row on the next week without the stage or
# invoice hooks: it stands in for a row that predates tracking.
req POST /api/rows/finish-week "$ADMIN" \
  "{\"weekStart\":\"$M2A_WEEK_PRE\",\"results\":[{\"jobId\":$J2,\"outcome\":\"manufacturing\"}]}"
expect_status 200 "carry the legacy job to $M2A_WEEK"
# A second row in the SAME week (the old rule only looked at earlier weeks).
req POST /api/rows "$ADMIN" "{\"weekStart\":\"$M2A_WEEK\",\"panel\":\"installing\",\"jobId\":$J2}"
expect_status 201 "give the legacy job a second row in the same week"
m2a_job_invoices "$J2"
expect_jq 'length == 0' "no deposit for a legacy job given a second row in the same week"
req POST /api/rows "$ADMIN" "{\"weekStart\":\"$M2A_WEEK_NEXT\",\"panel\":\"installing\",\"jobId\":$J2}"
expect_status 201 "place the legacy job a week later"
m2a_job_invoices "$J2"
expect_jq 'length == 0' "no deposit for a job that already had other week rows"
req POST /api/rows/finish-week "$ADMIN" \
  "{\"weekStart\":\"$M2A_WEEK_NEXT\",\"results\":[{\"jobId\":$J2,\"outcome\":\"complete\"}]}"
expect_status 200 "complete the legacy job"
req GET "/api/job-records/$J2" "$ADMIN"
expect_jq '.stage == "complete"' "the legacy job is complete"
m2a_job_invoices "$J2"
expect_jq 'length == 0' "no final for a job that has no invoices"

echo "--- manual invoices and the table ---"
req POST /api/invoices "$ACCT" "{\"jobId\":$J1,\"kind\":\"deposit\"}"
expect_status 409 "a second live deposit"
req POST /api/invoices "$ACCT" '{"jobId":999999,"kind":"deposit"}'
expect_status 404 "an invoice for a missing job"
req POST /api/invoices "$ACCT" "{\"jobId\":$J1,\"kind\":\"bogus\"}"
expect_status 400 "an unknown kind"
req POST /api/invoices "$ACCT" "{\"jobId\":$J1,\"kind\":\"extra\",\"description\":\"No amount\"}"
expect_status 400 "an extra without an amount"
req POST /api/invoices "$ACCT" \
  "{\"jobId\":$J1,\"kind\":\"extra\",\"description\":\"Extra: wall oven cut-out\",\"amountCents\":40000}"
expect_status 201 "an extra before completion"
expect_jq '.kind == "extra" and .status == "pending" and .linesCustom == 1 and .totalCents == 40000' "the extra waits as pending"
EX1=$(jqr '.id')
m2a_audit_min invoice.create "$EX1" 1

req GET "/api/invoices/table?q=m2%20split" "$ACCT"
expect_status 200 "table search"
expect_jq ".rows | length == 1 and .[0].job.id == $J1" "the search finds the job"
expect_jq ".rows[0].deposit.id == $DEP and .rows[0].deposit.status == \"due\" and .rows[0].progress == null and .rows[0].final == null" "the deposit cell"
expect_jq '.rows[0].extras | length == 1 and .[0].status == "pending"' "the extra cell"
expect_jq '.rows[0].deposit | has("totalCents") and has("overdue") and has("myobEntered") and has("description") and has("number")' "cell shape"
req GET "/api/invoices/table?filter=due" "$ACCT"
expect_jq "[.rows[].job.id] | index($J1) != null" "the due filter lists the job"
expect_jq '.totals.dueCount >= 1' "the totals count due invoices"

echo "--- Materials ordered makes the progress invoice due ---"
req POST "/api/job-records/$J1/materials-ordered" "$DPM" '{}'
expect_status 403 "dpm POST materials-ordered"
req POST "/api/job-records/$J1/materials-ordered" "$ACCT" '{}'
expect_status 403 "accounts POST materials-ordered"
req PATCH "/api/job-records/$J1" "$ADMIN" "{\"materialsOrderedDate\":\"$M2A_TODAY\"}"
expect_status 400 "materialsOrderedDate is no longer a plain field"
expect_jq '.error == "Use Materials ordered"' "the 400 says what to use"
req POST "/api/job-records/$J1/materials-ordered" "$ADMIN" '{"date":"2033-02-31"}'
expect_status 400 "materials-ordered with a bad date"
req POST /api/job-records/999999/materials-ordered "$ADMIN" '{}'
expect_status 404 "materials-ordered for a missing job"
m2a_find "$J1" progress
[ -z "$M2A_INV" ] || fail "a progress invoice exists before materials are ordered"
ok
req POST "/api/job-records/$J1/materials-ordered" "$ADMIN" '{}'
expect_status 200 "admin POST materials-ordered"
expect_jq ".materialsOrderedDate == \"$M2A_TODAY\"" "the date is today (Sydney)"
req POST "/api/job-records/$J1/materials-ordered" "$ADMIN" '{}'
expect_status 409 "materials-ordered twice"
m2a_job_invoices "$J1"
expect_jq '[.[] | select(.kind == "progress")] | length == 1' "one progress invoice"
expect_jq '.[] | select(.kind == "progress") | .status == "due" and .dueReason == "materials_ordered" and .suggestedCents == 500001' "progress is due, 50% rounded"
PROG=$(jqr '[.[] | select(.kind == "progress")] | .[0].id')
req GET "/api/audit?action=job.update&entityType=job&entityId=$J1&limit=1" "$ADMIN"
expect_jq '.total >= 1' "the materials date is audited as job.update"

echo "--- Finish week -> Complete makes the final due ---"
req POST /api/rows/finish-week "$ADMIN" \
  "{\"weekStart\":\"$M2A_WEEK\",\"results\":[{\"jobId\":$J1,\"outcome\":\"complete\"}]}"
expect_status 200 "Finish week, complete"
req GET "/api/job-records/$J1" "$ADMIN"
expect_jq ".stage == \"complete\" and .completedDate == \"$M2A_TODAY\"" "the job is complete"
m2a_job_invoices "$J1"
expect_jq '.[] | select(.kind == "final") | .status == "due" and .dueReason == "completed" and .suggestedCents == 400000' "the final is due: value less deposit and progress"
expect_jq '.[] | select(.id == '"$EX1"') | .status == "due" and .dueReason == "completed"' "the pending extra became due"
FIN=$(jqr '[.[] | select(.kind == "final")] | .[0].id')
expect_jq '[.[] | select(.kind != "extra") | .suggestedCents] | add == 1000001' "the split adds up to the value exactly"

echo "--- a hand-set complete goes through the same hook ---"
m2a_backlog_job "M2 Hand Complete" 330000
J3=$M2A_JOB
req POST /api/invoices "$ACCT" "{\"jobId\":$J3,\"kind\":\"deposit\"}"
expect_status 201 "a manual deposit"
expect_jq '.status == "due" and .dueReason == "manual"' "manual: due, reason manual"
req PATCH "/api/job-records/$J3" "$ADMIN" '{"stage":"complete"}'
expect_status 200 "admin hand-sets complete"
expect_jq ".stage == \"complete\" and .completedDate == \"$M2A_TODAY\"" "completed_date is set"
m2a_find "$J3" final
[ -n "$M2A_INV" ] || fail "no final invoice after a hand-set complete"
ok

# A completedDate sent in the same PATCH is kept, not overwritten with today.
m2a_backlog_job "M2 Hand Complete Dated" 120000
J4=$M2A_JOB
req POST /api/invoices "$ACCT" "{\"jobId\":$J4,\"kind\":\"deposit\"}"
expect_status 201 "a manual deposit for the dated job"
req PATCH "/api/job-records/$J4" "$ADMIN" '{"stage":"complete","completedDate":"2033-01-04"}'
expect_status 200 "admin hand-sets complete with a completedDate"
expect_jq '.stage == "complete" and .completedDate == "2033-01-04"' "the given completedDate is kept"
m2a_find "$J4" final
[ -n "$M2A_INV" ] || fail "no final invoice after a dated hand-set complete"
ok

echo "--- issuing needs the business details ---"
req POST "/api/invoices/$DEP/issue" "$ACCT"
expect_status 409 "issue before the business details are set"
req PUT /api/settings "$ADMIN" \
  '{"business":{"tradingName":"Crosscuts CI Joinery","abn":"51824753556","address":"1 Workshop Rd, Sydney NSW 2000","phone":"0200000000","email":"accounts@example.test","bankAccountName":"Crosscuts CI","bsb":"062000","accountNumber":"12345678"},"invoice":{"termsText":"Payment within 10 days."}}'
expect_status 200 "admin sets the business details"

echo "--- editing a draft ---"
req PATCH "/api/invoices/$DEP" "$ACCT" '{}'
expect_status 400 "PATCH with nothing to change"
req PATCH "/api/invoices/$DEP" "$ACCT" '{"dueDate":"2033-02-31"}'
expect_status 400 "PATCH with a bad due date"
req PATCH "/api/invoices/$DEP" "$ACCT" '{"lines":"nope"}'
expect_status 400 "PATCH with lines that are not an array"
req PATCH "/api/invoices/$DEP" "$ACCT" '{"billToName":"M2 Client Pty Ltd"}'
expect_status 200 "PATCH the bill-to name"
expect_jq '.billToName == "M2 Client Pty Ltd" and .linesCustom == 0' "editing the bill-to leaves the standard line live"
m2a_audit_min invoice.update "$DEP" 1
req PATCH "/api/invoices/$PROG" "$ACCT" "{\"dueDate\":\"$M2A_PAST\"}"
expect_status 200 "PATCH the progress due date into the past"
req PATCH "/api/invoices/$EX1" "$ACCT" \
  '{"lines":[{"description":"Extra: wall oven cut-out","amountCents":40000},{"description":"Discount","amountCents":-5000}]}'
expect_status 200 "PATCH the extra's lines"
expect_jq '.linesCustom == 1 and (.lines | length) == 2 and .totalCents == 35000' "custom lines, with a negative discount line"

echo "--- issuing: consecutive numbers, frozen amounts ---"
req POST "/api/invoices/$DEP/issue" "$ACCT"
expect_status 200 "issue the deposit"
expect_jq '.status == "issued" and (.number | test("^CC-[0-9]{4}$"))' "the first number"
DEP_NUM=$(jqr '.number')
M2A_N=$((10#${DEP_NUM#CC-} + 1))
expect_jq '.totalCents == 100000 and .gstCents == 9091' "total frozen; GST is total/11 rounded"
expect_jq ".issueDate == \"$M2A_TODAY\" and .dueDate == \"$M2A_DUE_DEFAULT\"" "issue date today; due 10 days on"
expect_jq '.billToName == "M2 Client Pty Ltd" and .billToAddress == "12 Rose St" and .billToAbn == "51 824 753 556" and .siteAddress == "12 Rose St"' "bill-to snapshot: edited value, else the job's"
expect_jq '(.lines | length) == 1 and .lines[0].id != null' "the standard line is now stored"
m2a_audit_min invoice.issue "$DEP" 1
m2a_audit_min invoice.due "$DEP" 1

req POST "/api/invoices/$DEP/issue" "$ACCT"
expect_status 409 "issuing an issued invoice"
req PATCH "/api/invoices/$DEP" "$ACCT" '{"billToName":"Someone Else"}'
expect_status 409 "a draft-only field on an issued invoice"
req PATCH "/api/invoices/$DEP" "$ACCT" '{"lines":[{"description":"x","amountCents":1}]}'
expect_status 409 "lines on an issued invoice"
req PATCH "/api/invoices/$DEP" "$ACCT" '{"notes":"Emailed to the client","followUpNotes":"Call Friday"}'
expect_status 200 "notes on an issued invoice"
expect_jq '.notes == "Emailed to the client" and .followUpNotes == "Call Friday"' "the notes stick"

m2a_issue "$PROG"
expect_jq '.totalCents == 500001 and .gstCents == 45455' "progress: 50% and its GST"
expect_jq ".dueDate == \"$M2A_PAST\" and .overdue == true" "an edited past due date makes it overdue"
expect_jq '.billToName == "M2 Client" and (.lines[0].description | startswith("Progress payment (50%)"))' "snapshot from the job; standard progress line"

# Changing the job afterwards must not touch an issued invoice.
req PATCH "/api/job-records/$J1" "$ADMIN" '{"clientName":"Changed Name","valueCents":2000000}'
expect_status 200 "change the client name and value after issuing"
req GET "/api/invoices/$PROG" "$ACCT"
expect_jq '.invoice.billToName == "M2 Client" and .invoice.totalCents == 500001 and .invoice.lines[0].amountCents == 500001' "issued invoices do not follow the job"
req PATCH "/api/job-records/$J1" "$ADMIN" '{"clientName":"M2 Client","valueCents":1000001}'
expect_status 200 "restore the client name and value"

echo "--- the overdue list and the table totals ---"
req GET /api/invoices/overdue "$ACCT"
expect_status 200 "GET /api/invoices/overdue"
expect_jq "[.[] | select(.invoice.id == $PROG) | .daysOverdue] | .[0] > 0" "the overdue invoice has days overdue"
expect_jq "[.[] | select(.invoice.id == $PROG) | .invoice.job.clientPhone] | .[0] == \"0400 000 000\"" "the overdue list carries the client phone"
expect_jq "[.[].invoice.id] | index($DEP) == null" "a not-yet-due invoice is not listed"
req GET /api/invoices/summary "$ACCT"
expect_jq '.overdueCount >= 1 and .dueCount >= 1' "the summary counts"
req GET "/api/invoices/table?filter=overdue" "$ACCT"
expect_jq ".rows[] | select(.job.id == $J1) | .progress.overdue == true" "the overdue filter shows the overdue cell"
expect_jq '.totals.overdueCount >= 1 and .totals.overdueCents >= 500001 and .totals.outstandingCents >= 600001' "the totals"
req GET "/api/invoices/table?filter=unpaid" "$ACCT"
expect_jq "[.rows[].job.id] | index($J1) != null" "the unpaid filter lists the job"
req GET "/api/invoices/table?filter=month" "$ACCT"
expect_jq "[.rows[].job.id] | index($J1) != null" "the this-month filter lists the job"
req GET "/api/invoices/table?filter=notmyob" "$ACCT"
expect_jq "[.rows[].job.id] | index($J1) != null" "the not-in-MYOB filter lists the job"
expect_jq '.totals.notInMyobCount >= 2' "the not-in-MYOB count"

echo "--- void: a replacement, and the number is never reused ---"
req POST "/api/invoices/$DEP/void" "$ACCT" '{}'
expect_status 400 "void needs a reason"
req POST "/api/invoices/$FIN/void" "$ACCT" '{"reason":"Not issued yet"}'
expect_status 409 "void a draft"
req POST "/api/invoices/$DEP/void" "$ACCT" '{"reason":"Wrong client name"}'
expect_status 200 "void the deposit"
expect_jq '.voided.status == "void" and .voided.voidReason == "Wrong client name" and .voided.number == "'"$DEP_NUM"'"' "the void keeps its number"
expect_jq '.replacement.status == "due" and .replacement.kind == "deposit" and .replacement.number == null' "a due copy"
expect_jq ".replacement.replacesId == $DEP and .replacement.dueReason == \"manual\" and .replacement.linesCustom == 1 and .replacement.totalCents == 100000" "the copy points back and has the same lines"
DEP2=$(jqr '.replacement.id')
m2a_audit_min invoice.void "$DEP" 1
req POST "/api/invoices/$DEP/void" "$ACCT" '{"reason":"Again"}'
expect_status 409 "void a voided invoice"
m2a_job_invoices "$J1"
expect_jq ".[] | select(.id == $DEP) | .replacedById == $DEP2" "the void points to its replacement"
req GET "/api/invoices/table?q=m2%20split" "$ACCT"
expect_jq ".rows[0].deposit.id == $DEP2 and .rows[0].deposit.status == \"due\"" "the table shows the live replacement, not the void"

m2a_issue "$DEP2"
[ "$M2A_NUM" != "$DEP_NUM" ] || fail "the voided number $DEP_NUM was reused"
ok

echo "--- a draft's contract summary is live ---"
req GET "/api/invoices/$FIN" "$ACCT"
expect_jq '.invoice.status == "due" and .contract.valueCents == 1000001 and .contract.invoicedToDateCents == 600001' "a draft's contract summary is live: deposit and progress issued, excluding itself"

echo "--- issue guards: the amount shown, and a bill-to name ---"
req POST "/api/invoices/$FIN/issue" "$ACCT" '{"expectedTotalCents":123}'
expect_status 409 "issue with a wrong expectedTotalCents"
expect_jq '.error == "The amount changed; check and issue again"' "the 409 says the amount changed"
req GET "/api/invoices/$FIN" "$ACCT"
expect_jq '.invoice.status == "due" and .invoice.number == null' "the refused issue left it due and unnumbered"
req POST "/api/invoices/$FIN/issue" "$ACCT" '{"expectedTotalCents":"400000"}'
expect_status 400 "issue with a non-integer expectedTotalCents"

m2a_backlog_job "M2 No Client" 100000
J5=$M2A_JOB
req POST /api/invoices "$ACCT" "{\"jobId\":$J5,\"kind\":\"deposit\"}"
expect_status 201 "a manual deposit for a job with no client name"
NOCLI=$(jqr '.id')
req POST "/api/invoices/$NOCLI/issue" "$ACCT" '{}'
expect_status 409 "issue with no bill-to name and no client name"
expect_jq '.error == "Bill-to name required"' "the 409 asks for a bill-to name"
req PATCH "/api/invoices/$NOCLI" "$ACCT" '{"billToName":"M2 Bill To Only"}'
expect_status 200 "type a bill-to name"
m2a_issue "$NOCLI" '{"expectedTotalCents":10000}'
expect_jq '.billToName == "M2 Bill To Only"' "issued with the typed bill-to name"

echo "--- issuing the final moves the job to invoiced ---"
m2a_issue "$FIN" '{"expectedTotalCents":400000}'
expect_jq '.totalCents == 400000 and .gstCents == 36364' "final: value less deposit and progress"
req GET "/api/job-records/$J1" "$ADMIN"
expect_jq '.stage == "invoiced"' "the job is invoiced"
req GET "/api/audit?action=job.stage&entityType=job&entityId=$J1&limit=1" "$ADMIN"
expect_jq '.total >= 3' "stage changes are audited (on_board, complete, invoiced)"
req GET "/api/invoices/$FIN" "$ACCT"
expect_status 200 "GET the final invoice"
expect_jq '.contract.valueCents == 1000001 and .contract.invoicedToDateCents == 600001' "contract summary: issued and paid, excluding this one"
expect_jq '.business.abn == "51 824 753 556" and .business.tradingName == "Crosscuts CI Joinery" and .business.bsb == "062-000"' "the business details are embedded (ABN and BSB as stored, formatted)"
expect_jq '(.invoice.totalCents / 11 | round) == .invoice.gstCents' "GST is total/11 rounded"

echo "--- an issued invoice's contract summary never changes ---"
# DEP (void) was issued first, so only 0 had been invoiced; PROG was issued with the
# first deposit counted; DEP2 had the progress counted. Live sums would now differ.
req GET "/api/invoices/$DEP" "$ACCT"
expect_jq '.invoice.status == "void" and .contract.valueCents == 1000001 and .contract.invoicedToDateCents == 0' "the voided deposit keeps its frozen summary after a later progress and final"
req GET "/api/invoices/$PROG" "$ACCT"
expect_jq '.contract.valueCents == 1000001 and .contract.invoicedToDateCents == 100000' "the progress summary is as at its issue"
req GET "/api/invoices/$DEP2" "$ACCT"
expect_jq '.contract.valueCents == 1000001 and .contract.invoicedToDateCents == 500001' "the replacement deposit summary is as at its issue"
req PATCH "/api/job-records/$J1" "$ADMIN" '{"valueCents":2000000}'
expect_status 200 "change the job value after the invoices were issued"
for inv_id in "$DEP2" "$PROG" "$FIN"; do
  req GET "/api/invoices/$inv_id" "$ACCT"
  expect_jq '.contract.valueCents == 1000001' "invoice $inv_id still shows the value at issue"
done
req GET "/api/invoices/$DEP2" "$ACCT"
expect_jq '.contract.invoicedToDateCents == 500001' "the deposit's invoiced-to-date is unchanged by the value change"
req PATCH "/api/job-records/$J1" "$ADMIN" '{"valueCents":1000001}'
expect_status 200 "restore the job value"

echo "--- extras: issue one, waive another ---"
m2a_issue "$EX1"
expect_jq '.totalCents == 35000 and .gstCents == 3182 and .kind == "extra"' "extra: custom lines frozen, GST rounded"
req POST /api/invoices "$ACCT" "{\"jobId\":$J1,\"kind\":\"extra\",\"description\":\"Extra: not needed\",\"amountCents\":10000}"
expect_status 201 "an extra after completion"
expect_jq '.status == "due" and .dueReason == "manual"' "an extra on a complete job is due at once"
EX2=$(jqr '.id')
req POST "/api/invoices/$EX2/waive" "$ACCT" '{}'
expect_status 400 "waive needs a reason"
req POST "/api/invoices/$EX2/waive" "$ACCT" '{"reason":"Warranty visit, no charge"}'
expect_status 200 "waive the extra"
expect_jq '.status == "waived" and .waiveReason == "Warranty visit, no charge"' "waived with its reason"
m2a_audit_min invoice.waive "$EX2" 1
req POST "/api/invoices/$EX2/waive" "$ACCT" '{"reason":"Again"}'
expect_status 409 "waive a waived invoice"
req POST "/api/invoices/$EX2/issue" "$ACCT"
expect_status 409 "issue a waived invoice"
req POST "/api/invoices/$DEP2/waive" "$ACCT" '{"reason":"Too late"}'
expect_status 409 "waive an issued invoice"
req PATCH "/api/invoices/$EX2" "$ACCT" '{"siteAddress":"Elsewhere"}'
expect_status 409 "a draft field on a waived invoice"

echo "--- un-waive: back to due, then waive it again ---"
req POST "/api/invoices/$DEP2/unwaive" "$ACCT" '{}'
expect_status 409 "un-waive an invoice that is not waived"
req POST "/api/invoices/$EX2/unwaive" "$ACCT" '{}'
expect_status 200 "un-waive the extra"
expect_jq '.status == "due" and .waiveReason == null' "back to due with the reason cleared"
m2a_audit_min invoice.waive "$EX2" 2
req POST "/api/invoices/$EX2/unwaive" "$ACCT" '{}'
expect_status 409 "un-waive twice"
req POST "/api/invoices/$EX2/waive" "$ACCT" '{"reason":"Warranty visit, no charge"}'
expect_status 200 "waive the extra again"

echo "--- paid, unpaid, Entered in MYOB ---"
req POST "/api/invoices/$FIN/paid" "$ACCT" '{"paidDate":"2033-02-31"}'
expect_status 400 "paid with a bad date"
req POST "/api/invoices/$EX2/paid" "$ACCT" '{}'
expect_status 409 "paid on a waived invoice"
req POST "/api/invoices/$DEP2/paid" "$ACCT" '{}'
expect_status 200 "mark the deposit paid"
expect_jq ".status == \"paid\" and .paidDate == \"$M2A_TODAY\" and .overdue == false" "paid today"
req POST "/api/invoices/$DEP2/paid" "$ACCT" '{}'
expect_status 409 "paid twice"
req POST "/api/invoices/$DEP2/void" "$ACCT" '{"reason":"Paid already"}'
expect_status 409 "a paid invoice can't be voided"
req POST "/api/invoices/$DEP2/unpaid" "$ACCT" '{}'
expect_status 200 "mark the deposit unpaid"
expect_jq '.status == "issued" and .paidDate == null' "back to issued"
req POST "/api/invoices/$DEP2/unpaid" "$ACCT" '{}'
expect_status 409 "unpaid on an unpaid invoice"
m2a_audit_min invoice.paid "$DEP2" 2
req POST "/api/invoices/$FIN/paid" "$ACCT" '{"paidDate":"2033-01-05"}'
expect_status 200 "mark the final paid with a date"
expect_jq '.status == "paid" and .paidDate == "2033-01-05"' "the given paid date"

req POST "/api/invoices/$FIN/myob" "$ACCT" '{"entered":"yes"}'
expect_status 400 "myob needs a boolean"
req POST "/api/invoices/$EX2/myob" "$ACCT" '{"entered":true}'
expect_status 409 "myob on a waived invoice"
req POST "/api/invoices/$FIN/myob" "$ACCT" '{"entered":true}'
expect_status 200 "tick Entered in MYOB"
expect_jq ".myobEnteredDate == \"$M2A_TODAY\"" "the MYOB date is today"
req POST "/api/invoices/$FIN/myob" "$ACCT" '{"entered":false}'
expect_status 200 "untick Entered in MYOB"
expect_jq '.myobEnteredDate == null' "the MYOB date is cleared"
m2a_audit_min invoice.myob "$FIN" 2

echo "--- the invoice pages ---"
req GET "/invoice.html?id=$FIN" "$SCHED"
expect_status 403 "sched GET /invoice.html"
req GET "/invoice.html?id=$FIN" "$ACCT"
expect_status 200 "accounts GET /invoice.html"
req GET /accounts.html "$SCHED"
expect_status 403 "sched GET /accounts.html"
req GET /accounts.html "$ACCT"
expect_status 200 "accounts GET /accounts.html"
