# Invoice email smoke (0.2.13): sending an issued invoice through Resend, with its PDF, the email
# history, the delivery check and the bounce alert.
# Sourced by ci/smoke.sh after the AMEX suite, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie jars ($ADMIN $SCHED $ACCT $DPM).
# No shebang and no `set`: the caller owns both.
#
# A stand-in Resend (ci/fake-resend.js) runs inside the container on 127.0.0.1:4987 (the Joinr
# stand-ins use 4999 and 4996) and Crosscuts is pointed at it through the file resend-base-url in
# /data/config. No real email goes anywhere. The PDF is made by the real headless Chromium in the
# image (the fake's check that the attachment is a real PDF of more than a kilobyte proves it).
# The container runs with INVOICE_EMAIL_SWEEP_DISABLED=1, so the delivery check only runs when this
# suite asks (POST /api/invoices/:id/email/check, the Check now button). Made-up names only.

# ============================================================================
step "invoice-send. emailing an invoice through Resend"
# ============================================================================

IS_TAG=$(date +%s)
IS_PORT=4987
IS_KEY="re_smoke_${IS_TAG}_abcdef"
IS_TODAY=$(TZ=Australia/Sydney date +%F)

is_fake() { # METHOD PATH [json]: a call to the stand-in, answer on stdout
  docker exec "$CONTAINER" node -e '
fetch("http://127.0.0.1:" + process.argv[1] + process.argv[3], { method: process.argv[2], headers: { "content-type": "application/json" }, body: process.argv[4] || undefined })
  .then((r) => r.text()).then((t) => console.log(t), (e) => { console.error(String(e)); process.exit(1); })
' "$IS_PORT" "$1" "$2" "${3:-}"
}
is_emails() { is_fake GET /_control/emails; }
is_count() { is_emails | jq -r '.emails | length'; }

echo "--- the image has Chromium and the PDF is not faked ---"
docker exec "$CONTAINER" node -e 'process.exit(require("fs").existsSync(process.env.CHROMIUM_PATH || "/usr/bin/chromium") && process.env.PDF_FAKE !== "1" ? 0 : 1)' \
  || fail "Chromium is not in the image (or PDF_FAKE is set)"
ok

echo "--- business details (an earlier suite usually set them) ---"
req GET /api/settings "$ADMIN"
if [ "$(jqr '.business.tradingName // empty')" = "" ]; then
  req PUT /api/settings "$ADMIN" '{"business":{"tradingName":"Crosscuts CI Joinery","abn":"51824753556","address":"1 Workshop Rd, Sydney NSW 2000","phone":"0200000000","email":"accounts@example.test","bankAccountName":"Crosscuts CI","bsb":"062000","accountNumber":"12345678"},"invoice":{"termsText":"Payment within 10 days."}}'
  expect_status 200 "business details set"
fi

echo "--- a job with a client email, and invoices ---"
req POST /api/jobs/backlog "$ADMIN" "{\"name\":\"IS $IS_TAG job\"}"
expect_status 201 "a job"
IS_J=$(jqr '.jobId')
req PATCH "/api/job-records/$IS_J" "$ADMIN" "{\"clientName\":\"IS $IS_TAG Client\",\"clientEmail\":\"accounts-$IS_TAG@example.com\",\"valueCents\":400000}"
expect_status 200 "with a client, an email and a value"
IS_ID=()
for IS_KIND in deposit progress final; do
  req POST /api/invoices "$ACCT" "{\"jobId\":$IS_J,\"kind\":\"$IS_KIND\"}"
  expect_status 201 "a $IS_KIND invoice"
  IS_ID+=("$(jqr '.id')")
done
IS_DRAFT=${IS_ID[0]}   # stays a draft
IS_A=${IS_ID[1]}       # sent, re-sent, delivered, bounced
IS_B=${IS_ID[2]}       # the Resend failure
req POST "/api/invoices/$IS_A/issue" "$ACCT" '{}'
expect_status 200 "A issued"
IS_A_NUM=$(jqr '.number')
req POST "/api/invoices/$IS_B/issue" "$ACCT" '{}'
expect_status 200 "B issued"
req POST /api/jobs/backlog "$ADMIN" "{\"name\":\"IS $IS_TAG void job\"}"
expect_status 201 "a second job"
IS_J2=$(jqr '.jobId')
req PATCH "/api/job-records/$IS_J2" "$ADMIN" '{"clientName":"IS void client","valueCents":100000}'
expect_status 200 "with a value"
req POST /api/invoices "$ACCT" "{\"jobId\":$IS_J2,\"kind\":\"deposit\"}"
expect_status 201 "a deposit to void"
IS_V=$(jqr '.id')
req POST "/api/invoices/$IS_V/issue" "$ACCT" '{}'
expect_status 200 "issued"
req POST "/api/invoices/$IS_V/void" "$ACCT" '{"reason":"smoke"}'
expect_status 200 "and voided"

echo "--- access ---"
req GET "/api/invoices/$IS_A/email" "$SCHED"
expect_status 403 "sched GET email"
req POST "/api/invoices/$IS_A/email" "$SCHED" '{"to":"a@example.com","subject":"s","body":"b"}'
expect_status 403 "sched POST email"
req GET "/api/invoices/$IS_A/pdf" "$SCHED"
expect_status 403 "sched GET pdf"
req POST "/api/invoices/$IS_A/email/check" "$SCHED" '{}'
expect_status 403 "sched POST check"
req GET /api/invoice-email/settings "$ACCT"
expect_status 403 "accounts doesn't reach the email settings (users.admin)"
req PUT /api/invoice-email/settings "$ACCT" "{\"apiKey\":\"$IS_KEY\"}"
expect_status 403 "accounts doesn't set the key"
req GET "/api/invoices/$IS_A/email" "$ACCT"
expect_status 200 "accounts reads the email history (accounts.view)"
req GET "/invoice.html?id=$IS_A&pt=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
expect_status 302 "a guessed render token from outside gets the login redirect, not the invoice"

echo "--- the dialog's starting values ---"
req GET "/api/invoices/$IS_A/email" "$ACCT"
expect_jq ".sendable == true and .configured == false and .history == [] and .alert == null" "issued: sendable, email not set up, no history"
expect_jq ".defaults.to == \"accounts-$IS_TAG@example.com\" and .defaults.cc == \"\"" "To is the job's client email"
expect_jq ".defaults.subject | startswith(\"Invoice $IS_A_NUM: IS $IS_TAG job\")" "the subject names the invoice and job"
expect_jq ".defaults.body | contains(\"$IS_A_NUM\") and contains(\"\$\")" "the message names the invoice and the amount"
expect_jq ".defaults.filename == \"Invoice-$IS_A_NUM.pdf\"" "the attachment name"
expect_jq '.from | contains("accounts@thcabinets.com.au")' "the default From"
req GET "/api/invoices/$IS_DRAFT/email" "$ACCT"
expect_status 200 "a draft's email overview"
expect_jq '.sendable == false and .defaults == null' "a draft isn't sendable"

echo "--- refused sends ---"
IS_OK='"to":"sam@example.com","subject":"Invoice","body":"Hello"'
req POST "/api/invoices/$IS_DRAFT/email" "$ACCT" "{$IS_OK}"
expect_status 409 "a draft can't be sent"
req POST "/api/invoices/$IS_V/email" "$ACCT" "{$IS_OK}"
expect_status 409 "a void invoice can't be sent"
req POST "/api/invoices/$IS_A/email" "$ACCT" '{"to":"not-an-address","subject":"Invoice","body":"Hello"}'
expect_status 400 "a bad To"
req POST "/api/invoices/$IS_A/email" "$ACCT" '{"to":"","subject":"Invoice","body":"Hello"}'
expect_status 400 "no To"
req POST "/api/invoices/$IS_A/email" "$ACCT" '{"to":"a@example.com","cc":"fine@example.com, bad@","subject":"Invoice","body":"Hello"}'
expect_status 400 "a bad CC"
req POST "/api/invoices/$IS_A/email" "$ACCT" '{"to":"a@example.com, b@example..com","subject":"Invoice","body":"Hello"}'
expect_status 400 "a bad second To"
req POST "/api/invoices/$IS_A/email" "$ACCT" '{"to":"a@example.com","subject":"  ","body":"Hello"}'
expect_status 400 "no subject"
req POST "/api/invoices/$IS_A/email" "$ACCT" '{"to":"a@example.com","subject":"Invoice","body":""}'
expect_status 400 "no message"
req POST "/api/invoices/$IS_A/email" "$ACCT" '{"to":"a@example.com","subject":"Two\nlines","body":"Hello"}'
expect_status 400 "a subject with a line break"
req POST "/api/invoices/99999999/email" "$ACCT" "{$IS_OK}"
expect_status 404 "no such invoice"

echo "--- no key yet ---"
docker exec "$CONTAINER" rm -f /data/config/resend-api-key /data/config/resend-base-url
req POST "/api/invoices/$IS_A/email" "$ACCT" "{$IS_OK}"
expect_status 409 "no key: refused"
expect_jq '.error | contains("isn'"'"'t set up")' "with a clear sentence"
req GET "/api/invoices/$IS_A" "$ACCT"
expect_jq '.invoice.sentDate == null' "not marked sent"
req GET "/api/invoices/$IS_A/email" "$ACCT"
expect_jq '.history == []' "nothing recorded"

echo "--- the key: admin only, never returned ---"
req GET /api/invoice-email/settings "$ADMIN"
expect_status 200 "admin reads the settings"
expect_jq '.key.configured == false and (.from | contains("thcabinets.com.au"))' "no key, the default From"
req PUT /api/invoice-email/settings "$ADMIN" '{"apiKey":"short"}'
expect_status 400 "a short key"
req PUT /api/invoice-email/settings "$ADMIN" '{"from":"not an address"}'
expect_status 400 "a bad From"
req PUT /api/invoice-email/settings "$ADMIN" "{\"apiKey\":\"$IS_KEY\"}"
expect_status 200 "the key is saved"
expect_jq '.key.configured == true and .key.last4 == "cdef"' "configured, last four only"
[ "${BODY#*"$IS_KEY"}" = "$BODY" ] || fail "the settings answer contains the API key"
ok
req GET /api/invoice-email/settings "$ADMIN"
[ "${BODY#*"$IS_KEY"}" = "$BODY" ] || fail "the settings answer contains the API key"
ok
req GET "/api/invoices/$IS_A/email" "$ACCT"
expect_jq '.configured == true' "the dialog now sees email as set up"
[ "${BODY#*"$IS_KEY"}" = "$BODY" ] || fail "the email overview contains the API key"
ok
req GET "/api/audit?action=invoice-email.settings&limit=5" "$ADMIN"
expect_jq '.total >= 1' "setting the key is audited"
printf '%s' "$BODY" | grep -q "$IS_KEY" && fail "the audit log contains the API key"
ok
IS_KEYFILE=$(docker exec "$CONTAINER" sh -c 'ls /data/config/resend-api-key')
[ -n "$IS_KEYFILE" ] || fail "the key file is not in /data/config"
ok
req PUT /api/invoice-email/settings "$ADMIN" '{"from":"TH Cabinets Accounts <accounts@thcabinets.com.au>"}'
expect_status 200 "the From is kept"

echo "--- start the stand-in Resend ---"
docker cp "$(dirname "$0")/fake-resend.js" "$CONTAINER":/tmp/fake-resend.js
docker exec -d "$CONTAINER" node /tmp/fake-resend.js "$IS_PORT" "$IS_KEY"
IS_UP=""
for _ in $(seq 1 30); do
  if is_emails >/dev/null 2>&1; then IS_UP=1; break; fi
  sleep 0.5
done
[ -n "$IS_UP" ] || fail "the stand-in Resend did not start"
ok
docker exec "$CONTAINER" sh -c "printf '%s\n' 'http://127.0.0.1:$IS_PORT' > /data/config/resend-base-url"

echo "--- a send that works ---"
req POST "/api/invoices/$IS_A/email" "$ACCT" "{\"to\":\"Sam@Example.com, sam@example.com ; two@example.com\",\"cc\":\"cc1@example.com,two@example.com\",\"subject\":\"Invoice $IS_A_NUM: IS $IS_TAG\",\"body\":\"Hello,\r\n\r\nSmoke body line.\"}"
expect_status 201 "the send"
expect_jq '.markedSent == true and .email.status == "sent" and .email.to == "Sam@Example.com, two@example.com" and .email.cc == "cc1@example.com"' "recorded as sent; To de-duplicated; CC drops an address already in To"
expect_jq ".invoice.sentDate == \"$IS_TODAY\" and .history[0].id == .email.id and (.history | length) == 1" "marked sent today; the history has it"
IS_E1=$(jqr '.email.id')
expect_eq "$(is_count)" "1" "one email reached Resend"
is_emails >"$WORK/is-emails.json"
expect_eq "$(jq -r '.emails[0].from' "$WORK/is-emails.json")" "TH Cabinets Accounts <accounts@thcabinets.com.au>" "From"
expect_eq "$(jq -r '.emails[0].reply_to' "$WORK/is-emails.json")" "accounts@thcabinets.com.au" "reply-to is the same address"
expect_eq "$(jq -r '.emails[0].to | join(",")' "$WORK/is-emails.json")" "Sam@Example.com,two@example.com" "To"
expect_eq "$(jq -r '.emails[0].cc | join(",")' "$WORK/is-emails.json")" "cc1@example.com" "CC"
expect_eq "$(jq -r '.emails[0].subject' "$WORK/is-emails.json")" "Invoice $IS_A_NUM: IS $IS_TAG" "subject"
expect_eq "$(jq -r '.emails[0].attachments[0].filename' "$WORK/is-emails.json")" "Invoice-$IS_A_NUM.pdf" "attachment name"
expect_eq "$(jq -r '.emails[0].attachments[0].magic' "$WORK/is-emails.json")" "%PDF-" "the attachment is a PDF"
expect_eq "$(jq -r '.emails[0].attachments[0].base64Ok' "$WORK/is-emails.json")" "true" "sent as base64"
IS_BYTES=$(jq -r '.emails[0].attachments[0].bytes' "$WORK/is-emails.json")
[ "$IS_BYTES" -gt 1000 ] || fail "the PDF is only $IS_BYTES bytes: Chromium did not print the invoice page"
ok
case "$(jq -r '.emails[0].text' "$WORK/is-emails.json")" in *"Smoke body line."*) ok ;; *) fail "the message text did not arrive" ;; esac
case "$(jq -r '.emails[0].text' "$WORK/is-emails.json")" in *$'\r'*) fail "a carriage return reached the message" ;; *) ok ;; esac
[ -n "$(jq -r '.emails[0].idempotencyKey' "$WORK/is-emails.json")" ] || fail "no idempotency key was sent"
ok
req GET "/api/audit?action=invoice.email_sent&entityType=invoice&entityId=$IS_A&limit=5" "$ADMIN"
expect_jq '.total >= 1' "the send is audited"
printf '%s' "$BODY" | grep -q "$IS_KEY" && fail "the audit log contains the API key"
ok
req GET "/api/audit?action=invoice.sent&entityType=invoice&entityId=$IS_A&limit=5" "$ADMIN"
expect_jq '.total >= 1' "and so is marking it sent"

echo "--- the PDF preview serves the same document ---"
curl -s -o "$WORK/is-preview.pdf" -D "$WORK/is-preview.hdr" -b "$ACCT" "$BASE/api/invoices/$IS_A/pdf"
grep -qi '^content-type: application/pdf' "$WORK/is-preview.hdr" || fail "the preview is not application/pdf"
ok
[ "$(head -c 5 "$WORK/is-preview.pdf")" = "%PDF-" ] || fail "the preview is not a PDF"
ok
req GET "/api/invoices/$IS_DRAFT/pdf" "$ACCT"
expect_status 409 "a draft has no PDF"

echo "--- a Resend failure leaves the invoice as it was ---"
is_fake POST /_control/fail '{"status":422,"message":"The thcabinets.com.au domain is not verified."}' >/dev/null
req POST "/api/invoices/$IS_B/email" "$ACCT" "{$IS_OK}"
expect_status 502 "Resend refuses"
expect_jq '.error | contains("domain is not verified")' "Resend's reason is shown to the sender"
req GET "/api/invoices/$IS_B" "$ACCT"
expect_jq '.invoice.sentDate == null and .invoice.status == "issued"' "not marked sent, status unchanged"
req GET "/api/invoices/$IS_B/email" "$ACCT"
expect_jq '.history == [] and .alert == null' "no row recorded"
expect_eq "$(is_count)" "1" "nothing more reached Resend"
req GET "/api/audit?action=invoice.email_failed&entityType=invoice&entityId=$IS_B&limit=5" "$ADMIN"
expect_jq '.total == 1' "the failure is audited"
is_fake POST /_control/fail '{"status":401,"message":"API key is invalid"}' >/dev/null
req POST "/api/invoices/$IS_B/email" "$ACCT" "{$IS_OK}"
expect_status 502 "a refused key"
expect_jq '.error | contains("API key")' "says the key was refused"
is_fake POST /_control/fail '{"status":500,"message":"boom"}' >/dev/null
req POST "/api/invoices/$IS_B/email" "$ACCT" "{$IS_OK}"
expect_status 502 "Resend is down"
req GET "/api/invoices/$IS_B" "$ACCT"
expect_jq '.invoice.sentDate == null' "still not marked sent"
is_fake POST /_control/fail '{"status":0}' >/dev/null
req POST "/api/invoices/$IS_B/email" "$ACCT" "{$IS_OK}"
expect_status 502 "a dropped connection"
expect_jq '.error | length > 10' "with a sentence"
req GET "/api/invoices/$IS_B/email" "$ACCT"
expect_jq '.history == []' "still no row"
req POST "/api/invoices/$IS_B/email" "$ACCT" "{$IS_OK}"
expect_status 201 "and a retry works"
IS_EB=$(jqr '.email.id')

echo "--- re-send, and a paid invoice can be re-sent ---"
req POST "/api/invoices/$IS_A/email" "$ACCT" '{"to":"old-address@example.com","subject":"Invoice again","body":"Again."}'
expect_status 201 "re-send"
IS_E2=$(jqr '.email.id')
expect_jq '(.history | length) == 2 and .history[0].id == .email.id and .email.id != '"$IS_E1" "a second row; newest first"
req POST "/api/invoices/$IS_A/paid" "$ACCT" '{}'
expect_status 200 "paid"
req POST "/api/invoices/$IS_A/email" "$ACCT" '{"to":"sam@example.com","subject":"Paid receipt","body":"Thanks."}'
expect_status 201 "a paid invoice can be re-sent"
IS_E3=$(jqr '.email.id')
expect_jq '(.history | length) == 3' "three rows"
expect_eq "$(is_count)" "4" "four emails reached Resend (A three times, B once)"

echo "--- the delivery check ---"
# fake ids are fake-1.. in send order: A=1, B=2 (the retry), A again=3, A paid=4
req POST "/api/invoices/$IS_A/email/check" "$ACCT" '{}'
expect_status 200 "check now"
expect_jq '[.history[] | select(.status == "sent")] | length == 3' "still in flight: Resend says only 'sent'"
is_fake POST /_control/event '{"id":"fake-1","last_event":"delivered"}' >/dev/null
is_fake POST /_control/event '{"id":"fake-3","last_event":"bounced"}' >/dev/null
req POST "/api/invoices/$IS_A/email/check" "$ACCT" '{}'
expect_status 200 "check now again"
expect_jq ".history | map(select(.id == $IS_E1))[0].status == \"delivered\"" "the first one is delivered"
expect_jq ".history | map(select(.id == $IS_E2))[0].status == \"bounced\"" "the second bounced"
expect_jq ".history | map(select(.id == $IS_E3))[0].status == \"sent\"" "the third is still checking"
expect_jq '.alert != null and (.alert.message | contains("old-address@example.com")) and (.alert.message | contains("bounced"))' "the orange alert names the bounced address"
req GET /api/notifications?limit=100 "$ACCT"
expect_jq '[.rows[] | select(.kind == "invoice.email_bounced")] | length >= 1' "accounts is told in the bell"
req GET "/api/audit?action=invoice.email_bounced&entityType=invoice&entityId=$IS_A&limit=5" "$ADMIN"
expect_jq '.total == 1' "the bounce is audited"
req POST "/api/invoices/$IS_A/email/check" "$ACCT" '{}'
req GET /api/notifications?limit=100 "$ACCT"
expect_jq '[.rows[] | select(.kind == "invoice.email_bounced" and (.title | contains("'"$IS_A_NUM"'")))] | length == 1' "polling again doesn't bell it twice"
is_fake POST /_control/event '{"id":"fake-4","last_event":"delivered"}' >/dev/null
req POST "/api/invoices/$IS_A/email/check" "$ACCT" '{}'
expect_jq '.alert == null' "a later delivered email clears the alert"
expect_jq '[.history[] | select(.status == "sent")] | length == 0' "nothing left checking"
is_fake POST /_control/event '{"id":"fake-2","last_event":"failed"}' >/dev/null
req POST "/api/invoices/$IS_B/email/check" "$ACCT" '{}'
expect_jq ".history[0].status == \"failed\" and .alert != null" "a failed email shows as not delivered with the alert"

echo "--- mapping, and a row older than 7 days is left alone ---"
docker exec "$CONTAINER" node -e '
const m = require("/app/lib/invoiceemail").mapEvent;
const want = { delivered: "delivered", opened: "delivered", clicked: "delivered", complained: "delivered", bounced: "bounced", failed: "failed", canceled: "failed", suppressed: "failed", sent: null, queued: null, scheduled: null, delivery_delayed: null };
for (const k of Object.keys(want)) if (m(k) !== want[k]) { console.error("mapEvent(" + k + ") = " + m(k)); process.exit(1); }
process.exit(0);
' || fail "mapEvent maps a Resend event wrongly"
ok
req POST "/api/invoices/$IS_A/email" "$ACCT" '{"to":"stale@example.com","subject":"Stale","body":"Old."}'
expect_status 201 "one more send to age"
IS_E5=$(jqr '.email.id')
IS_OLD=$(date -u -d '8 days ago' +%Y-%m-%dT%H:%M:%S.000Z)
docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.prepare("UPDATE invoice_emails SET sent_at = ? WHERE id = ?").run(process.argv[1], Number(process.argv[2]));
' "$IS_OLD" "$IS_E5"
is_fake POST /_control/event '{"id":"fake-5","last_event":"delivered"}' >/dev/null
req POST "/api/invoices/$IS_A/email/check" "$ACCT" '{}'
expect_jq ".history | map(select(.id == $IS_E5))[0] | .status == \"sent\" and .stale == true" "past 7 days it stops being checked and shows plain 'Sent'"

echo "--- the page and the pdf route need a login ---"
req GET "/api/invoices/$IS_A/pdf"
expect_status 401 "logged out GET pdf"
req GET "/api/invoices/$IS_A/email"
expect_status 401 "logged out GET email"
req POST "/api/invoices/$IS_A/email" "" "{$IS_OK}"
expect_status 401 "logged out POST email"
for IS_P in /invoicesend.js /invoicesend.css; do
  req GET "$IS_P" "$ACCT"
  expect_status 200 "GET $IS_P"
done

echo "--- tidy up ---"
is_fake POST /_control/exit >/dev/null || true
docker exec "$CONTAINER" rm -f /data/config/resend-base-url
req DELETE /api/invoice-email/settings/key "$ADMIN"
expect_status 200 "the key is removed"
expect_jq '.key.configured == false' "no key again"
req GET "/api/invoices/$IS_A/email" "$ACCT"
expect_jq '.configured == false' "the dialog says email isn't set up again"
