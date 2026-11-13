# Overdue invoice reminder emails smoke (0.2.19, docs/plans/invoice-reminders-plan.md section 14):
# the settings and the switch-on date, the approval queue, the email itself (PDF, BCC, idempotency key),
# catch-up, manual sends, recovery after a restart, refusals, access, and the audit trail.
# Sourced by ci/smoke.sh straight after the invoice email suite, so it shares that script's helpers (step,
# req, expect_status, expect_jq, expect_eq, jqr, fail, ok), the create_user/login/own_password helpers of
# step d, and the cookie jars ($ADMIN $SCHED $ACCT $DPM). No shebang and no `set`: the caller owns both.
#
# A stand-in Resend (ci/fake-resend.js) runs inside the container on 127.0.0.1:4987 (the invoice email
# suite stopped its own, so the port is free) and Crosscuts is pointed at it through the file
# resend-base-url in /data/config, with a made-up key. No real email goes anywhere.
#
# The BCC rule (Todd): the default reminder BCC is a real mailbox, so the very first thing this suite does
# is set the BCC to a made-up address, and the last check is that no email the stand-in received has
# thcabinets.com.au in To, CC or BCC. The default is put back only after reminders are switched Off.
#
# The container runs with INVOICE_REMINDERS_SWEEP_DISABLED=1 (no timer) and INVOICE_REMINDERS_DRY_RUN
# unset (dry run is not exercised in CI), so every run here is a POST /api/invoice-reminders/run, and the
# suite moves the clock with its optional `today` (also accepted by POST /queue/send). Made-up names only.

# ============================================================================
step "invoice-reminders. overdue reminder emails"
# ============================================================================

RM_TAG=$(date +%s)
RM_PORT=4987
RM_KEY="re_smoke_rem_${RM_TAG}_abcdef"
RM_TODAY=$(TZ=Australia/Sydney date +%F)
RM_BCC="bcc-$RM_TAG@example.test"
RM_DEFAULT_BCC="chloe@thcabinets.com.au"

rm_date() { date -u -d "$RM_TODAY $1 days" +%F; } # rm_date +7 / rm_date -1
RM_YESTERDAY=$(rm_date -1)
RM_D7=$(rm_date +7)
RM_D13=$(rm_date +13)
RM_D31=$(rm_date +31)

rm_fake() { # METHOD PATH [json]: a call to the stand-in, answer on stdout
  docker exec "$CONTAINER" node -e '
fetch("http://127.0.0.1:" + process.argv[1] + process.argv[3], { method: process.argv[2], headers: { "content-type": "application/json" }, body: process.argv[4] || undefined })
  .then((r) => r.text()).then((t) => console.log(t), (e) => { console.error(String(e)); process.exit(1); })
' "$RM_PORT" "$1" "$2" "${3:-}"
}
rm_emails() { rm_fake GET /_control/emails; }
rm_count() { rm_emails | jq -r '.emails | length'; }
rm_key_count() { rm_emails | jq -r --arg k "$1" '[.emails[] | select(.idempotencyKey == $k)] | length'; }
rm_fake_of() { rm_emails | jq -c --arg k "$1" '[.emails[] | select(.idempotencyKey == $k)][0]'; } # the email for a key

rm_db() { # SQL [params...]: run SQL on the database in the container; selects print rows as JSON
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
const sql = process.argv[1], p = process.argv.slice(2);
const r = /^\s*select/i.test(sql) ? d.prepare(sql).all(...p) : d.prepare(sql).run(...p);
console.log(JSON.stringify(r));
' "$@"
}

rm_run() { req POST /api/invoice-reminders/run "$ACCT" "{\"today\":\"$1\"}"; expect_status 200 "run for $1"; }
rm_mode() { req PUT /api/invoice-reminders/settings "$ACCT" "{\"mode\":\"$1\"}"; expect_status 200 "mode $1"; }
rm_row() { # INVOICE_ID STEP FIELD: one column of the reminder row, straight from the database
  rm_db "SELECT $3 AS v FROM invoice_reminders WHERE invoice_id = ? AND step = ?" "$1" "$2" | jq -r '.[0].v // "none"'
}

# rm_invoice LABEL CLIENT_EMAIL DUE_OFFSET SENT(1|0): a job with a client and one issued deposit invoice
# due DUE_OFFSET days from today (the draft's due date is set before it is issued). Sets RM_ID and RM_NUM.
rm_invoice() {
  local label=$1 email=$2 off=$3 sent=$4 j
  req POST /api/jobs/backlog "$ADMIN" "{\"name\":\"RM $RM_TAG $label job\"}"
  expect_status 201 "job $label"
  j=$(jqr '.jobId')
  req PATCH "/api/job-records/$j" "$ADMIN" "$(jq -nc --arg c "RM $RM_TAG $label Client" --arg e "$email" \
    '{clientName:$c,valueCents:300000} + (if $e == "" then {} else {clientEmail:$e} end)')"
  expect_status 200 "client for $label"
  req POST /api/invoices "$ACCT" "{\"jobId\":$j,\"kind\":\"deposit\"}"
  expect_status 201 "invoice $label"
  RM_ID=$(jqr '.id')
  req PATCH "/api/invoices/$RM_ID" "$ACCT" "{\"dueDate\":\"$(rm_date "$off")\"}"
  expect_status 200 "due date for $label"
  req POST "/api/invoices/$RM_ID/issue" "$ACCT" '{}'
  expect_status 200 "issued $label"
  RM_NUM=$(jqr '.number')
  if [ "$sent" = 1 ]; then
    req POST "/api/invoices/$RM_ID/sent" "$ACCT" '{}'
    expect_status 200 "$label marked sent"
  fi
}
rm_qid() { req GET /api/invoice-reminders/queue "$ACCT"; jqr ".queued | map(select(.invoiceId == $1))[0].id // empty"; } # the queued row id of an invoice

# --- the BCC first, before anything else ------------------------------------------------------------
echo "--- the BCC is a made-up address before reminders go anywhere ---"
req PUT /api/invoice-reminders/settings "$ADMIN" "{\"bcc\":\"$RM_BCC\"}"
expect_status 200 "the BCC is set to a made-up address"
expect_jq ".bcc == \"$RM_BCC\"" "and it reads back"

echo "--- the container is not in dry run, and starts Off ---"
RM_DRY=$(docker exec "$CONTAINER" node -p 'process.env.INVOICE_REMINDERS_DRY_RUN || "unset"')
[ "$RM_DRY" != "1" ] || fail "INVOICE_REMINDERS_DRY_RUN is 1 in the container: the suite would not reach the stand-in Resend"
ok
req GET /api/invoice-reminders/settings "$ACCT"
expect_status 200 "settings"
expect_jq '.mode == "off" and .dryRun == false and .days == [7,14,30] and .hour == 10 and (.templates | length) == 3' "Off by default, no dry run, 7/14/30 at 10:00, three messages"
expect_jq '.placeholders | index("client") != null and index("amount") != null' "the placeholders are listed"

echo "--- business details (an earlier suite usually set them) ---"
req GET /api/settings "$ADMIN"
if [ "$(jqr '.business.tradingName // empty')" = "" ]; then
  req PUT /api/settings "$ADMIN" '{"business":{"tradingName":"Crosscuts CI Joinery","abn":"51824753556","address":"1 Workshop Rd, Sydney NSW 2000","phone":"0200000000","email":"accounts@example.test","bankAccountName":"Crosscuts CI","bsb":"062000","accountNumber":"12345678"},"invoice":{"termsText":"Payment within 10 days."}}'
  expect_status 200 "business details set"
fi

echo "--- the stand-in Resend, then the key (base URL first, so nothing can reach the real one) ---"
docker exec "$CONTAINER" rm -f /data/config/resend-api-key /data/config/resend-base-url
docker cp "$(dirname "$0")/fake-resend.js" "$CONTAINER":/tmp/fake-resend.js
docker exec -d "$CONTAINER" node /tmp/fake-resend.js "$RM_PORT" "$RM_KEY"
RM_UP=""
for _ in $(seq 1 30); do
  if rm_emails >/dev/null 2>&1; then RM_UP=1; break; fi
  sleep 0.5
done
[ -n "$RM_UP" ] || fail "the stand-in Resend did not start"
ok
docker exec "$CONTAINER" sh -c "printf '%s\n' 'http://127.0.0.1:$RM_PORT' > /data/config/resend-base-url"
req PUT /api/invoice-email/settings "$ADMIN" "{\"apiKey\":\"$RM_KEY\"}"
expect_status 200 "the key is saved"
req GET /api/invoice-email/settings "$ADMIN"
RM_FROM=$(jqr '.from')
RM_REPLY=$(printf '%s' "$RM_FROM" | sed -E 's/.*<([^>]*)>.*/\1/')
expect_eq "$(rm_count)" "0" "the stand-in starts empty"

# --- 1. Mode Off: nothing is prepared or sent ---------------------------------------------------------
echo "--- 1. mode Off: a run at due + 30 does nothing ---"
rm_invoice Y "y-$RM_TAG@example.com" -1 1 # due yesterday: overdue before reminders are switched on
RM_Y=$RM_ID
RM_Y_NUM=$RM_NUM
rm_run "$(rm_date +29)"
expect_jq '.ran == false and .mode == "off" and .queuedNow == 0 and .sent == 0 and (.queued | length) == 0' "Off: nothing prepared"
expect_eq "$(rm_count)" "0" "and nothing sent"
expect_eq "$(rm_db 'SELECT COUNT(*) AS n FROM invoice_reminders' | jq -r '.[0].n')" "0" "and no reminder row exists"

# --- 1b. Switch-on: only invoices that fall due from today on -----------------------------------------
echo "--- 1b. switching on: the switch-on date, and an invoice that was overdue before it ---"
rm_mode approval
expect_jq ".mode == \"approval\" and .onSince == \"$RM_TODAY\"" "Ready for approval: the switch-on date is today"
for RM_DAY in "$RM_D7" "$(rm_date +14)" "$(rm_date +30)"; do
  rm_run "$RM_DAY"
  expect_jq '.queuedNow == 0 and (.queued | length) == 0' "a run at $RM_DAY never queues the invoice that was overdue before switch-on"
done
req GET /api/invoices/overdue "$ACCT"
expect_jq "map(select(.invoice.id == $RM_Y))[0].reminder | .beforeSwitchOn == true and .reason == \"beforeSwitchOn\"" "the overdue list marks it Before reminders"
req GET "/api/invoices/$RM_Y/reminders" "$ACCT"
expect_jq '.manualAllowed == true and .beforeSwitchOn == true and .eligible == false and .why == "beforeSwitchOn"' "but a person may still send it a reminder by hand (N3)"

# --- the invoices of the main run ----------------------------------------------------------------------
echo "--- invoices due today, after switch-on: sent, never sent, paused, client paused, bounced, no email, to-be-paid ---"
rm_invoice S "s-$RM_TAG@example.com" 0 1
RM_S=$RM_ID
RM_S_NUM=$RM_NUM
RM_S_JOB=$(rm_db "SELECT job_id AS v FROM invoices WHERE id = ?" "$RM_S" | jq -r '.[0].v')
rm_invoice Q "q-$RM_TAG@example.com" 0 1
RM_Q=$RM_ID
rm_invoice N "n-$RM_TAG@example.com" 0 0
RM_N=$RM_ID
rm_invoice P "p-$RM_TAG@example.com" 0 1
RM_P=$RM_ID
req PUT "/api/invoices/$RM_P/reminders/pause" "$ACCT" '{"paused":true,"note":"promised to pay"}'
expect_status 200 "pause reminders on P"
expect_jq '.paused == true and .pausedNow == true' "P is paused"
rm_invoice C "c-$RM_TAG@example.com" 0 1
RM_C=$RM_ID
req PUT /api/invoice-reminders/clients "$ACCT" "{\"clientName\":\"rm $RM_TAG c client\",\"paused\":true,\"note\":\"in dispute\"}"
expect_status 200 "pause a client (name folded: case does not matter)"
expect_jq '.clients | length >= 1' "the paused client is listed"
rm_invoice B "bounce-$RM_TAG@example.test" 0 0
RM_B=$RM_ID
req POST "/api/invoices/$RM_B/email" "$ACCT" "{\"to\":\"bounce-$RM_TAG@example.test\",\"subject\":\"Invoice\",\"body\":\"Hello\"}"
expect_status 201 "the invoice is emailed to a client whose address will bounce (marks it sent)"
RM_B_FAKE=$(rm_emails | jq -r --arg t "bounce-$RM_TAG@example.test" '.emails | map(select(.to[0] == $t))[0].id')
rm_fake POST /_control/event "{\"id\":\"$RM_B_FAKE\",\"last_event\":\"bounced\"}" >/dev/null
req POST "/api/invoices/$RM_B/email/check" "$ACCT" '{}'
expect_jq '.alert != null' "and it bounced"
rm_invoice E "" 0 1
RM_E=$RM_ID
RM_BASE=$(rm_count)
expect_eq "$RM_BASE" "1" "only the bounce test's invoice email has reached the stand-in"

# --- 2. Ready for approval -----------------------------------------------------------------------------
echo "--- 2. Ready for approval: a run at due + 7 queues the sent invoice only ---"
rm_run "$RM_D7"
expect_jq '.mode == "approval" and .queuedNow == 2 and .sent == 0 and (.queued | length) == 2' "two reminders queued (S and Q), none sent"
expect_jq "[.queued[].invoiceId] | sort == ([$RM_S, $RM_Q] | sort)" "they are S and Q"
expect_jq '.queued | map(select(.invoiceId == '"$RM_S"'))[0] | .step == 1 and .state == "queued" and (.email.bcc == "'"$RM_BCC"'") and (.email.subject | startswith("Reminder: invoice"))' "the queue shows the exact email: step 1, with the test BCC"
for RM_X in "$RM_N" "$RM_P" "$RM_C" "$RM_B" "$RM_E" "$RM_Y"; do
  expect_eq "$(rm_db 'SELECT COUNT(*) AS n FROM invoice_reminders WHERE invoice_id = ?' "$RM_X" | jq -r '.[0].n')" "0" "invoice $RM_X (never sent, paused, client paused, bounced, no email, or before switch-on) has no reminder row"
done
expect_eq "$(rm_count)" "$RM_BASE" "the stand-in received nothing"
req GET "/api/notifications?limit=100" "$ACCT"
expect_jq '[.rows[] | select(.kind == "invoice.reminders_ready")] | length >= 1' "a bell went to invoices.edit holders: reminders are ready"
req GET "/api/audit?action=invoice.reminder_queued&entityType=invoice&entityId=$RM_S&limit=5" "$ADMIN"
expect_jq '.total == 1' "queuing is audited"

echo "--- why each other invoice is skipped (their due dates moved a day back so the overdue list shows them) ---"
rm_db "UPDATE invoices SET due_date = ? WHERE id IN (?, ?, ?, ?, ?)" "$RM_YESTERDAY" "$RM_N" "$RM_P" "$RM_C" "$RM_B" "$RM_E" >/dev/null
req GET /api/invoices/overdue "$ACCT"
expect_jq "map(select(.invoice.id == $RM_N))[0].reminder | .notSent == true and .reason == \"notSent\"" "never sent: Not sent yet"
expect_jq "map(select(.invoice.id == $RM_P))[0].reminder | .paused == true and .reason == \"paused\"" "paused invoice"
expect_jq "map(select(.invoice.id == $RM_C))[0].reminder | .clientPaused == true and .reason == \"clientPaused\"" "paused client"
expect_jq "map(select(.invoice.id == $RM_B))[0].reminder | .bounced == true and .reason == \"bounced\"" "bounced email"
expect_jq "map(select(.invoice.id == $RM_E))[0].reminder | .noEmail == true and .reason == \"noEmail\"" "no email on file"
req POST "/api/invoices/$RM_N/reminders" "$ACCT" '{"to":"a@example.com","subject":"x","body":"x"}'
expect_status 409 "a manual reminder on a never-sent invoice is refused"
expect_jq '.error | contains("hasn'"'"'t been sent")' "saying so"
req POST "/api/invoices/$RM_B/reminders" "$ACCT" '{"to":"a@example.com","subject":"x","body":"x"}'
expect_status 409 "and on one whose email bounced"
expect_jq '.error | contains("bounced")' "saying so"
rm_db "UPDATE invoices SET due_date = ? WHERE id IN (?, ?, ?, ?, ?)" "$RM_TODAY" "$RM_N" "$RM_P" "$RM_C" "$RM_B" "$RM_E" >/dev/null

# --- 1b (cont.). Re-enable: Off drops the queue; On again keeps the day ----------------------------------
echo "--- Off drops what is queued; switching back on starts afresh ---"
rm_mode off
req GET /api/invoice-reminders/queue "$ACCT"
expect_jq "(.queued | length) == 0 and ([.recent[] | select(.state == \"cancelled\")] | length) == 2" "switching Off cancelled both queued reminders"
expect_eq "$(rm_row "$RM_S" 1 state)" "cancelled" "S step 1 is cancelled"
rm_run "$RM_D7"
expect_jq '.ran == false and (.queued | length) == 0' "a run while Off still does nothing"
rm_mode approval
expect_jq ".onSince == \"$RM_TODAY\"" "the switch-on date is re-stamped (the same day here)"
rm_run "$RM_D7"
expect_jq '.queuedNow == 2' "a run prepares them again (a cancelled step can be prepared again)"

# --- 10. Paid between queue and send -----------------------------------------------------------------------
echo "--- 10. paid between queue and send: the queued row is dropped ---"
RM_QROW=$(rm_qid "$RM_Q")
[ -n "$RM_QROW" ] || fail "Q has no queued row"
ok
req POST "/api/invoices/$RM_Q/paid" "$ACCT" '{}'
expect_status 200 "Q is paid"
req POST /api/invoice-reminders/queue/send "$ACCT" "{\"ids\":[$RM_QROW],\"today\":\"$RM_D7\"}"
expect_status 200 "send"
expect_jq '.results[0].ok == false and (.results[0].error | contains("no longer issued"))' "refused: no longer issued"
expect_eq "$(rm_row "$RM_Q" 1 state)" "cancelled" "the row is cancelled"
expect_eq "$(rm_count)" "$RM_BASE" "nothing reached the stand-in"

# --- 3 and 4. Run again, concurrent approve, the email itself -------------------------------------------------
echo "--- 3. a second run the same day adds nothing; two approvals at once send one email ---"
RM_SROW=$(rm_qid "$RM_S")
rm_run "$RM_D7"
expect_jq '.queuedNow == 0 and (.queued | length) == 1' "a second run queues nothing new"
expect_eq "$(rm_qid "$RM_S")" "$RM_SROW" "S keeps the same queued row"
RM_PAYLOAD="{\"ids\":[$RM_SROW],\"today\":\"$RM_D7\"}"
curl -s -o "$WORK/rm-c1.json" -b "$ACCT" -H "Origin: $REQ_ORIGIN" -H 'Content-Type: application/json' --data "$RM_PAYLOAD" "$BASE/api/invoice-reminders/queue/send" &
RM_P1=$!
curl -s -o "$WORK/rm-c2.json" -b "$ACCT" -H "Origin: $REQ_ORIGIN" -H 'Content-Type: application/json' --data "$RM_PAYLOAD" "$BASE/api/invoice-reminders/queue/send" &
RM_P2=$!
wait "$RM_P1" "$RM_P2"
RM_OKS=$(( $(jq -r '[.results[] | select(.ok == true)] | length' "$WORK/rm-c1.json") + $(jq -r '[.results[] | select(.ok == true)] | length' "$WORK/rm-c2.json") ))
RM_NOS=$(( $(jq -r '[.results[] | select(.ok == false)] | length' "$WORK/rm-c1.json") + $(jq -r '[.results[] | select(.ok == false)] | length' "$WORK/rm-c2.json") ))
expect_eq "$RM_OKS" "1" "two simultaneous approvals: exactly one succeeds"
expect_eq "$RM_NOS" "1" "and the other is refused as no longer waiting"
expect_eq "$(rm_count)" "$((RM_BASE + 1))" "exactly one email reached the stand-in"
expect_eq "$(rm_key_count "crosscuts-reminder-$RM_S-1")" "1" "with the fixed idempotency key"

echo "--- 4. the email at the stand-in ---"
rm_fake_of "crosscuts-reminder-$RM_S-1" >"$WORK/rm-s1.json"
expect_eq "$(jq -r '.from' "$WORK/rm-s1.json")" "$RM_FROM" "From is the invoice From"
expect_eq "$(jq -r '.reply_to' "$WORK/rm-s1.json")" "$RM_REPLY" "Reply-To is the same address"
expect_eq "$(jq -r '.to | join(",")' "$WORK/rm-s1.json")" "s-$RM_TAG@example.com" "To is the client's email"
expect_eq "$(jq -r '.cc | length' "$WORK/rm-s1.json")" "0" "no CC"
expect_eq "$(jq -r '.bcc | join(",")' "$WORK/rm-s1.json")" "$RM_BCC" "BCC is the made-up test address"
expect_eq "$(jq -r '.subject' "$WORK/rm-s1.json")" "Reminder: invoice $RM_S_NUM is overdue" "subject is step 1's"
RM_S_TEXT=$(jq -r '.text' "$WORK/rm-s1.json")
case "$RM_S_TEXT" in *"invoice $RM_S_NUM for RM $RM_TAG S job"*"was due on"*"${RM_TODAY%%-*}"*) ok ;; *) fail "the body is not step 1 filled in: $RM_S_TEXT" ;; esac
case "$RM_S_TEXT" in *"Hi RM $RM_TAG S Client,"*) ok ;; *) fail "the body does not greet the client: $RM_S_TEXT" ;; esac
case "$RM_S_TEXT" in *"{"*"}"*) fail "an unfilled placeholder is left in the body: $RM_S_TEXT" ;; *) ok ;; esac
expect_eq "$(jq -r '.attachments[0].filename' "$WORK/rm-s1.json")" "Invoice-$RM_S_NUM.pdf" "the PDF is attached again"
expect_eq "$(jq -r '.attachments[0].magic' "$WORK/rm-s1.json")" "%PDF-" "and it is a PDF"
RM_BYTES=$(jq -r '.attachments[0].bytes' "$WORK/rm-s1.json")
[ "$RM_BYTES" -gt 1000 ] || fail "the reminder's PDF is only $RM_BYTES bytes"
ok

echo "--- 5. history, delivery, contact ---"
req GET "/api/invoices/$RM_S/email" "$ACCT"
expect_jq '(.history | length) == 1 and .history[0].kind == "reminder" and .history[0].reminderStep == 1 and .history[0].status == "sent"' "the email history has the reminder (kind reminder, step 1)"
expect_jq ".history[0].bcc == \"$RM_BCC\"" "with its BCC recorded"
RM_S_FAKE=$(jq -r '.id' "$WORK/rm-s1.json")
rm_fake POST /_control/event "{\"id\":\"$RM_S_FAKE\",\"last_event\":\"delivered\"}" >/dev/null
req POST "/api/invoices/$RM_S/email/check" "$ACCT" '{}'
expect_status 200 "check now"
expect_jq '.history[0].status == "delivered" and .alert == null' "Delivered"
req GET "/api/invoices/$RM_S/contacts" "$ACCT"
expect_jq "([.contacts[] | select(.note | startswith(\"Reminder 1 emailed\"))] | length) == 1 and .contacts[0].date == \"$RM_TODAY\"" "a contact row was added today, so Needs follow-up resets"
req GET "/api/invoices/$RM_S" "$ACCT"
expect_jq ".invoice.lastContactedDate == \"$RM_TODAY\" and .invoice.needsFollowUp == false" "the invoice's last contact moved"
req GET "/api/invoices/$RM_S/reminders" "$ACCT"
expect_jq '.steps[0] | .state == "sent" and .how == "approved" and .emailStatus == "delivered"' "the invoice overview shows step 1 sent and delivered"
req GET /api/invoice-reminders/queue "$ACCT"
expect_jq "(.queued | length) == 0 and ([.recent[] | select(.invoiceId == $RM_S and .state == \"sent\")] | length) == 1" "the queue's recent list has it as sent"
req GET "/api/audit?action=invoice.reminder_sent&entityType=invoice&entityId=$RM_S&limit=5" "$ADMIN"
expect_jq '.total == 1' "the send is audited"
printf '%s' "$BODY" | grep -q "$RM_KEY" && fail "the audit log contains the API key"
ok
req POST "/api/invoices/$RM_S/paid" "$ACCT" '{}'
expect_status 200 "S is paid (out of the way)"

# --- 9. Refusals ----------------------------------------------------------------------------------------
echo "--- 9. Resend refuses (422): failed and audited; Resend is down (500): queued again, tries counted ---"
rm_invoice R1 "r1-$RM_TAG@example.com" 0 1
RM_R1=$RM_ID
rm_invoice R2 "r2-$RM_TAG@example.com" 0 1
RM_R2=$RM_ID
rm_run "$RM_D7"
expect_jq '.queuedNow == 2' "two new reminders queued"
RM_R1ROW=$(rm_qid "$RM_R1")
RM_R2ROW=$(rm_qid "$RM_R2")
RM_BEFORE=$(rm_count)
rm_fake POST /_control/fail '{"status":422,"message":"The recipient is not allowed."}' >/dev/null
req POST /api/invoice-reminders/queue/send "$ACCT" "{\"ids\":[$RM_R1ROW],\"today\":\"$RM_D7\"}"
expect_status 200 "send R1"
expect_jq '.results[0].ok == false and (.results[0].error | contains("recipient is not allowed"))' "Resend's reason comes back"
expect_eq "$(rm_row "$RM_R1" 1 state)" "failed" "the row is failed"
case "$(rm_row "$RM_R1" 1 note)" in *"The recipient is not allowed."*) ok ;; *) fail "the row does not carry Resend's message: $(rm_row "$RM_R1" 1 note)" ;; esac
req GET "/api/invoices/$RM_R1/email" "$ACCT"
expect_jq '.history == []' "nothing is marked sent: no history row"
req GET "/api/audit?action=invoice.reminder_failed&entityType=invoice&entityId=$RM_R1&limit=5" "$ADMIN"
expect_jq '.total == 1' "the failure is audited"
req GET "/api/notifications?limit=100" "$ACCT"
expect_jq '[.rows[] | select(.kind == "invoice.reminder_failed")] | length >= 1' "accounts is belled"
expect_eq "$(rm_count)" "$RM_BEFORE" "nothing reached the stand-in"
rm_fake POST /_control/fail '{"status":500,"message":"boom"}' >/dev/null
req POST /api/invoice-reminders/queue/send "$ACCT" "{\"ids\":[$RM_R2ROW],\"today\":\"$RM_D7\"}"
expect_status 200 "send R2"
expect_jq '.results[0].ok == false' "a 500 is not a success"
expect_eq "$(rm_row "$RM_R2" 1 state)" "queued" "the row is back to queued"
expect_eq "$(rm_row "$RM_R2" 1 tries)" "1" "with tries 1"
expect_eq "$(rm_count)" "$RM_BEFORE" "still nothing at the stand-in"
req POST /api/invoice-reminders/queue/send "$ACCT" "{\"ids\":[$RM_R2ROW],\"today\":\"$RM_D7\"}"
expect_jq '.results[0].ok == true' "the retry works"
expect_eq "$(rm_row "$RM_R2" 1 tries)" "2" "tries 2"
expect_eq "$(rm_key_count "crosscuts-reminder-$RM_R2-1")" "1" "one email, with the same key"
expect_eq "$(rm_count)" "$((RM_BEFORE + 1))" "one more email in all"

# --- 7. Manual sends, and the BCC left blank ---------------------------------------------------------------
echo "--- 7. manual: Y (overdue before switch-on) gets step 1 then step 2 by hand; BCC blank means no bcc field ---"
req PUT /api/invoice-reminders/settings "$ACCT" '{"bcc":""}'
expect_status 200 "BCC blank"
expect_jq '.bcc == ""' "no BCC"
req GET "/api/invoices/$RM_Y/reminders" "$ACCT"
expect_jq '.draft.step == 1 and (.draft.to | length > 0) and .draft.bcc == ""' "the dialog's draft is step 1 and shows no BCC"
req POST "/api/invoices/$RM_Y/reminders" "$ACCT" "$(printf '%s' "$BODY" | jq -c '{to:.draft.to,cc:"",subject:.draft.subject,body:.draft.body}')"
expect_status 201 "a manual reminder on an invoice that was overdue before the switch-on"
expect_jq '.step == 1 and .email.kind == "reminder" and .email.reminderStep == 1' "recorded as reminder step 1"
rm_fake_of "crosscuts-reminder-$RM_Y-1" >"$WORK/rm-y1.json"
expect_eq "$(jq -r '.hasBcc' "$WORK/rm-y1.json")" "false" "no bcc field at all reached Resend"
expect_eq "$(jq -r '.to | join(",")' "$WORK/rm-y1.json")" "y-$RM_TAG@example.com" "To is the client"
req PUT /api/invoice-reminders/settings "$ACCT" "{\"bcc\":\"$RM_BCC\"}"
expect_status 200 "the test BCC is back"
req GET "/api/invoices/$RM_Y/reminders" "$ACCT"
expect_jq '.draft.step == 2 and .draft.bcc == "'"$RM_BCC"'"' "the next draft is step 2, and shows the BCC"
req POST "/api/invoices/$RM_Y/reminders" "$ACCT" "$(printf '%s' "$BODY" | jq -c '{to:.draft.to,cc:"",subject:.draft.subject,body:.draft.body}')"
expect_status 201 "step 2 by hand"
expect_jq '.step == 2 and .email.reminderStep == 2' "recorded as step 2"
expect_eq "$(rm_row "$RM_Y" 2 how)" "manual" "the row says by hand"
expect_eq "$(rm_key_count "crosscuts-reminder-$RM_Y-2")" "1" "one email for step 2"
rm_fake_of "crosscuts-reminder-$RM_Y-2" >"$WORK/rm-y2.json"
expect_eq "$(jq -r '.bcc | join(",")' "$WORK/rm-y2.json")" "$RM_BCC" "step 2 carries the test BCC"
RM_AFTER_MANUAL=$(rm_count)
echo "--- ... and a later run at due + 14 does not send step 2 again (the switch-on date is moved back so Y qualifies) ---"
rm_db "UPDATE app_settings SET value = ? WHERE key = 'invoices.reminders_on_since'" "$(rm_date -60)" >/dev/null
rm_run "$RM_D13"
expect_jq '.queuedNow == 0 and (.queued | length) == 0 and .sent == 0' "nothing is queued or sent"
expect_eq "$(rm_count)" "$RM_AFTER_MANUAL" "the stand-in received nothing more"
expect_eq "$(rm_key_count "crosscuts-reminder-$RM_Y-2")" "1" "step 2 still has one email"
req POST "/api/invoices/$RM_Y/reminders" "$ACCT" '{"to":"","subject":"x","body":"x"}'
expect_status 400 "a manual send with no To is refused"
req POST "/api/invoices/$RM_P/reminders" "$ACCT" '{"to":"a@example.com","subject":"x","body":"x"}'
expect_status 409 "and on one that is not overdue yet (P is due today)"

# --- 8. Recovery -----------------------------------------------------------------------------------------------
echo "--- 8. recovery: a reminder stuck in 'sending' is retried with the same key, and Resend holds one email ---"
rm_invoice W "w-$RM_TAG@example.com" -1 1 # due yesterday: the recovery runs on the real day, so it must be overdue by the real clock
RM_W=$RM_ID
rm_invoice W2 "w2-$RM_TAG@example.com" -1 1
RM_W2=$RM_ID
rm_run "$RM_D7"
expect_jq '.queuedNow == 2' "two reminders queued (W and W2)"
RM_WROW=$(rm_qid "$RM_W")
RM_W2ROW=$(rm_qid "$RM_W2")
# W: the process "died" after Resend took the email but before Crosscuts recorded it.
docker exec "$CONTAINER" node -e '
fetch("http://127.0.0.1:" + process.argv[1] + "/emails", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.argv[2], "idempotency-key": process.argv[3] },
  body: JSON.stringify({ from: "A <a@example.test>", to: ["w-" + process.argv[4] + "@example.com"], subject: "pre-sent", text: "pre-sent" }) })
  .then((r) => r.text()).then((t) => console.log(t), (e) => { console.error(String(e)); process.exit(1); })
' "$RM_PORT" "$RM_KEY" "crosscuts-reminder-$RM_W-1" "$RM_TAG" >/dev/null
RM_PRE=$(rm_count)
RM_NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
rm_db "UPDATE invoice_reminders SET state = 'sending', how = 'approved', tries = 1, updated_at = ? WHERE id = ?" "$RM_NOW_ISO" "$RM_WROW" >/dev/null
# W2: stuck for 21 hours, too old to retry (Resend forgets the key after 24 hours).
RM_OLD_ISO=$(date -u -d '21 hours ago' +%Y-%m-%dT%H:%M:%S.000Z)
rm_db "UPDATE invoice_reminders SET state = 'sending', how = 'approved', tries = 1, updated_at = ? WHERE id = ?" "$RM_OLD_ISO" "$RM_W2ROW" >/dev/null
rm_run "$RM_D7"
expect_jq '.recovered == 2' "the run recovered both stuck rows"
expect_eq "$(rm_row "$RM_W" 1 state)" "sent" "W: retried and recorded as sent"
expect_eq "$(rm_key_count "crosscuts-reminder-$RM_W-1")" "1" "W: the stand-in still holds exactly one email for that key"
expect_eq "$(rm_count)" "$RM_PRE" "and no new email was added"
req GET "/api/invoices/$RM_W/email" "$ACCT"
expect_jq '(.history | length) == 1 and .history[0].kind == "reminder" and .history[0].reminderStep == 1' "W: the history has one reminder row"
expect_eq "$(rm_row "$RM_W2" 1 state)" "failed" "W2: too old, so failed rather than re-sent"
expect_eq "$(rm_key_count "crosscuts-reminder-$RM_W2-1")" "0" "W2: nothing was sent"
case "$(rm_row "$RM_W2" 1 note)" in *"restarted while sending"*) ok ;; *) fail "W2's note does not explain the restart: $(rm_row "$RM_W2" 1 note)" ;; esac
req GET "/api/notifications?limit=100" "$ACCT"
expect_jq '[.rows[] | select(.kind == "invoice.reminder_failed" and (.body | contains("restarted")))] | length >= 1' "accounts is belled about W2"

# --- 6. Automatic: catch-up ---------------------------------------------------------------------------------
echo "--- 6. Automatic: an invoice never reminded sends only step 3, and records steps 1 and 2 as caught up ---"
# Pay off everything still eligible so only K is in play.
for RM_X in "$RM_Y" "$RM_W" "$RM_W2" "$RM_R1" "$RM_R2"; do
  req POST "/api/invoices/$RM_X/paid" "$ACCT" '{}'
  expect_status 200 "paid $RM_X"
done
rm_invoice K "k-$RM_TAG@example.com" 1 1 # due tomorrow: 30 days overdue on the 31st
RM_K=$RM_ID
RM_K_NUM=$RM_NUM
req GET /api/invoice-reminders/queue "$ACCT"
expect_jq '.queued | length == 0' "nothing is waiting"
rm_mode auto
expect_jq ".mode == \"auto\" and .onSince != null" "Automatic"
RM_BEFORE=$(rm_count)
rm_run "$RM_D31"
expect_jq '.mode == "auto" and .sent == 1 and .skipped == 2 and .queuedNow == 1' "one reminder prepared and sent, two steps skipped"
expect_eq "$(rm_row "$RM_K" 1 state)" "skipped" "K step 1: skipped"
expect_eq "$(rm_row "$RM_K" 1 note)" "caught up" "(caught up)"
expect_eq "$(rm_row "$RM_K" 2 state)" "skipped" "K step 2: skipped"
expect_eq "$(rm_row "$RM_K" 3 state)" "sent" "K step 3: sent"
expect_eq "$(rm_row "$RM_K" 3 how)" "auto" "by the automatic run"
expect_eq "$(rm_count)" "$((RM_BEFORE + 1))" "exactly one email reached the stand-in"
rm_fake_of "crosscuts-reminder-$RM_K-3" >"$WORK/rm-k3.json"
expect_eq "$(jq -r '.subject' "$WORK/rm-k3.json")" "Second reminder: invoice $RM_K_NUM is 30 days overdue" "step 3's wording"
expect_eq "$(jq -r '.bcc | join(",")' "$WORK/rm-k3.json")" "$RM_BCC" "with the test BCC"
req GET "/api/invoices/$RM_K/email" "$ACCT"
expect_jq '(.history | length) == 1 and .history[0].reminderStep == 3' "the history has only step 3"
req GET "/api/invoices/$RM_K/contacts" "$ACCT"
expect_jq '[.contacts[] | select(.note | startswith("Automatic reminder 3 emailed"))] | length == 1' "the automatic contact row names it"
rm_run "$RM_D31"
expect_jq '.queuedNow == 0 and .sent == 0' "running again the same day sends nothing more"
req GET "/api/audit?action=invoice.reminder_skipped&entityType=invoice&entityId=$RM_K&limit=10" "$ADMIN"
expect_jq '.total == 2' "the two caught-up steps are audited"

# --- settings and run validation ---------------------------------------------------------------------------
echo "--- settings are checked in full before anything is written ---"
req PUT /api/invoice-reminders/settings "$ACCT" '{"hour":9,"days":[7,7]}'
expect_status 400 "days must rise"
req PUT /api/invoice-reminders/settings "$ACCT" '{"days":[0,14]}'
expect_status 400 "days from 1"
req PUT /api/invoice-reminders/settings "$ACCT" '{"days":[1,2,3,4]}'
expect_status 400 "at most three days"
req PUT /api/invoice-reminders/settings "$ACCT" '{"bcc":"not an address"}'
expect_status 400 "a bad BCC"
req PUT /api/invoice-reminders/settings "$ACCT" '{"mode":"sometimes"}'
expect_status 400 "a bad mode"
req PUT /api/invoice-reminders/settings "$ACCT" '{"hour":24}'
expect_status 400 "a bad hour"
req PUT /api/invoice-reminders/settings "$ACCT" '{"templates":[{"subject":"a {nope}","body":"b"},{"subject":"a","body":"b"},{"subject":"a","body":"b"}]}'
expect_status 400 "an unknown placeholder"
req GET /api/invoice-reminders/settings "$ACCT"
expect_jq ".hour == 10 and .days == [7,14,30] and .bcc == \"$RM_BCC\"" "nothing was written by the refused saves"
req POST /api/invoice-reminders/run "$ACCT" "{\"today\":\"$RM_YESTERDAY\"}"
expect_status 400 "run: today can't be before today"
req POST /api/invoice-reminders/run "$ACCT" '{"today":"2026-02-30"}'
expect_status 400 "run: a bad date"
req POST /api/invoice-reminders/queue/send "$ACCT" "{\"ids\":[999999],\"today\":\"$RM_YESTERDAY\"}"
expect_status 400 "send: today can't be before today"
req POST /api/invoice-reminders/queue/send "$ACCT" '{"ids":[]}'
expect_status 400 "send: needs ids"
req POST /api/invoice-reminders/queue/send "$ACCT" '{"ids":[999999]}'
expect_status 200 "send: an unknown id is reported per id"
expect_jq '.results[0].ok == false' "not ok"
req PUT /api/invoice-reminders/clients "$ACCT" '{"clientName":"","paused":true}'
expect_status 400 "a client pause needs a name"
req PUT /api/invoice-reminders/clients "$ACCT" "{\"clientName\":\"RM $RM_TAG C Client\",\"paused\":false}"
expect_status 200 "resume the paused client"
expect_jq '[.clients[] | select(.clientName | test("C Client"))] | length == 0' "no longer listed"
req PUT "/api/invoices/$RM_P/reminders/pause" "$ACCT" '{"paused":false}'
expect_status 200 "resume P"
expect_jq '.paused == false' "resumed"

# --- 11. Access ------------------------------------------------------------------------------------------------
echo "--- 11. access: scheduling and design/PM are refused everywhere; accounts.view alone may read ---"
for RM_J in "$SCHED" "$DPM"; do
  req GET /api/invoice-reminders/settings "$RM_J"
  expect_status 403 "GET settings"
  req PUT /api/invoice-reminders/settings "$RM_J" '{"hour":9}'
  expect_status 403 "PUT settings"
  req GET /api/invoice-reminders/queue "$RM_J"
  expect_status 403 "GET queue"
  req POST /api/invoice-reminders/queue/send "$RM_J" '{"ids":[1]}'
  expect_status 403 "POST queue/send"
  req POST /api/invoice-reminders/queue/1/skip "$RM_J" '{}'
  expect_status 403 "POST queue/skip"
  req POST /api/invoice-reminders/run "$RM_J" '{}'
  expect_status 403 "POST run"
  req PUT /api/invoice-reminders/clients "$RM_J" '{"clientName":"x","paused":true}'
  expect_status 403 "PUT clients"
  req GET "/api/invoices/$RM_K/reminders" "$RM_J"
  expect_status 403 "GET invoice reminders"
  req POST "/api/invoices/$RM_K/reminders" "$RM_J" '{"to":"a@example.com","subject":"x","body":"x"}'
  expect_status 403 "POST manual reminder"
  req PUT "/api/invoices/$RM_K/reminders/pause" "$RM_J" '{"paused":true}'
  expect_status 403 "PUT pause"
done
RMV_PW='Remv-Passw0rd-1'
create_user remview "Rem ViewOnly" "Tmp-$RMV_PW" accounts
RMV_ID=$CREATED_ID
RMV="$WORK/jar-remview"
new_jar "$RMV"
login "$RMV" remview "Tmp-$RMV_PW"
expect_status 200 "the view-only user signs in"
own_password "$RMV" "Tmp-$RMV_PW" "$RMV_PW"
req PUT "/api/users/$RMV_ID/overrides/invoices.edit" "$ADMIN" '{"effect":"revoke"}'
expect_status 200 "invoices.edit is revoked from them (accounts.view stays)"
req GET /api/invoice-reminders/settings "$RMV"
expect_status 200 "accounts.view: GET settings"
req GET /api/invoice-reminders/queue "$RMV"
expect_status 200 "accounts.view: GET queue"
req GET "/api/invoices/$RM_K/reminders" "$RMV"
expect_status 200 "accounts.view: GET invoice reminders"
req GET /api/invoices/overdue "$RMV"
expect_status 200 "accounts.view: the overdue list"
req PUT /api/invoice-reminders/settings "$RMV" '{"hour":9}'
expect_status 403 "without invoices.edit: PUT settings"
req POST /api/invoice-reminders/run "$RMV" '{}'
expect_status 403 "without invoices.edit: POST run"
req POST /api/invoice-reminders/queue/send "$RMV" '{"ids":[1]}'
expect_status 403 "without invoices.edit: POST queue/send"
req PUT "/api/invoices/$RM_K/reminders/pause" "$RMV" '{"paused":true}'
expect_status 403 "without invoices.edit: PUT pause"
req POST "/api/invoices/$RM_K/reminders" "$RMV" '{"to":"a@example.com","subject":"x","body":"x"}'
expect_status 403 "without invoices.edit: POST manual reminder"
req GET /api/invoice-reminders/settings
expect_status 401 "logged out: settings"
req POST /api/invoice-reminders/run "" '{}'
expect_status 401 "logged out: run"

# --- 12. No dry run in CI -------------------------------------------------------------------------------------------
echo "--- 12. the image never sets INVOICE_REMINDERS_DRY_RUN ---"
RM_DRY=$(docker exec "$CONTAINER" node -p 'process.env.INVOICE_REMINDERS_DRY_RUN || "unset"')
[ "$RM_DRY" != "1" ] || fail "INVOICE_REMINDERS_DRY_RUN is 1 in the container"
ok

# --- the BCC rule: nothing went to the real mailbox -----------------------------------------------------------------
echo "--- no email at the stand-in went to, or was copied to, a thcabinets.com.au address ---"
rm_emails >"$WORK/rm-all.json"
RM_TOTAL=$(jq -r '.emails | length' "$WORK/rm-all.json")
[ "$RM_TOTAL" -ge 6 ] || fail "only $RM_TOTAL emails reached the stand-in: the suite did not do its work"
ok
jq -e '[.emails[] | (.to + .cc + .bcc)[] | select(ascii_downcase | contains("thcabinets.com.au"))] | length == 0' "$WORK/rm-all.json" >/dev/null \
  || fail "an email reached a thcabinets.com.au address: $(jq -c '[.emails[] | {to, cc, bcc}]' "$WORK/rm-all.json")"
ok
jq -e '[.emails[] | select((.bcc | length) > 0) | select((.bcc | join(",")) != "'"$RM_BCC"'")] | length == 0' "$WORK/rm-all.json" >/dev/null \
  || fail "a reminder carried a BCC other than the test address"
ok

# --- 13. Clean up ------------------------------------------------------------------------------------------------------
echo "--- tidy up: Off first, then the default BCC is put back ---"
rm_mode off
expect_jq '.mode == "off"' "reminders are Off"
req PUT /api/invoice-reminders/settings "$ACCT" "{\"bcc\":\"$RM_DEFAULT_BCC\"}"
expect_status 200 "the default BCC is restored (only now that reminders are Off)"
expect_jq ".bcc == \"$RM_DEFAULT_BCC\" and .mode == \"off\"" "Off, with the default BCC"
rm_fake POST /_control/exit >/dev/null || true
docker exec "$CONTAINER" rm -f /data/config/resend-base-url
req DELETE /api/invoice-email/settings/key "$ADMIN"
expect_status 200 "the key is removed"
expect_jq '.key.configured == false' "no key again"
docker exec "$CONTAINER" sh -c 'test ! -e /data/config/resend-api-key && test ! -e /data/config/resend-base-url' || fail "the key file or the base URL file is still there"
ok
