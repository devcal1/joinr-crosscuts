# M16 smoke (task J3, Crosscuts side, 0.1.20): Joinr's open-quotes list in the Pipeline's Quoted
# column (docs/plans/m3-contracts.md section 13; the wire contract is version 3 of
# docs/integrations/joinr-crosscuts-intake.md). Sourced by ci/smoke.sh after the M15 suites, so it
# shares that script's helpers (step, req, expect_status, expect_jq, expect_eq, jqr, create_user,
# login, own_password, new_jar, fail, ok), the cookie jars ($ADMIN $SCHED $ACCT $DPM $SHOW), $WORK
# and $CONTAINER. No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: its quotes and intake rows carry fixed "c16..." ids and
# the quote number M16-INTAKE, and it removes them (and the cache) at the end.
#
# A stand-in Joinr (ci/fake-joinr.js) runs inside the container on 127.0.0.1:4999 (the M6 suite's,
# which has stopped by then; the M11 drawers suite uses 4996). Crosscuts is pointed at it through
# files in /data/config, removed at the end. The once-a-minute guard and the 429 back-off are
# stored in joinr_open_quotes_meta, so the suite clears them with SQL between steps instead of
# waiting a minute.

# ============================================================================
step "m16-openquotes. Joinr open-quotes list: cache, Pipeline lines, guard, fallback"
# ============================================================================

M16_KEY='ci-joinr-m16-openquotes-key-6d2b8e41'
M16_LAST4=${M16_KEY: -4}
M16_PORT=4999
M16_BASE_URL="http://127.0.0.1:$M16_PORT"
M16_OUT=""

# m16_fake METHOD PATH [json] -> M16_OUT (the stand-in's response body). Runs inside the container.
m16_fake() {
  M16_OUT=$(docker exec "$CONTAINER" node -e '
const [m, p, b] = process.argv.slice(1);
fetch("http://127.0.0.1:4999" + p, { method: m, headers: { "content-type": "application/json" }, body: b || undefined })
  .then(async (r) => { process.stdout.write(await r.text()); if (!r.ok) process.exit(1); })
  .catch((e) => { console.error(String(e)); process.exit(1); });' "$1" "$2" "${3:-}") \
    || fail "fake joinr $1 $2 failed: ${M16_OUT:0:300}"
}

# SQL against the live database through the container's own better-sqlite3.
m16_exec() { # SQL
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.exec(process.argv[1]);
d.close();
' "$1"
}
m16_q() { # SQL -> rows as JSON
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const db = new D("/data/db/photos.db", { readonly: true });
process.stdout.write(JSON.stringify(db.prepare(process.argv[1]).all()));' "$1"
}
# One value: m16_val SQL (a query with a single column "v").
m16_val() { m16_q "$1" | jq -r '.[0].v // "null"'; }

# Clears the once-a-minute guard and any 429 back-off (the real wait is a minute or more).
m16_unguard() {
  m16_exec "UPDATE joinr_open_quotes_meta SET last_attempt_at = NULL, retry_after_until = NULL"
}

# How many times the stand-in has been asked for the open-quotes list.
m16_asks() {
  m16_fake GET /_control/requests
  printf '%s' "$M16_OUT" | jq '[.requests[] | select(.path == "/api/integrations/crosscuts/open-quotes")] | length'
}

# Seeds an intake record: m16_intake ROOT QUOTE_ID STATE
m16_intake() {
  m16_exec "INSERT INTO joinr_intake (root_quote_id, quote_id, quote_number, joinr_status, last_event, payload, state)
            VALUES ('$1', '$2', 'M16-INTAKE', 'won', 'won', '{\"clientName\":\"M16 Intake Client\"}', '$3')"
}
m16_intake_state() { # ROOT STATE
  m16_exec "UPDATE joinr_intake SET state = '$2' WHERE root_quote_id = '$1'"
}

# Fixed uuids: one root per quote.
M16_S1=c1600000-0000-4000-8000-000000000001   # sent, listed
M16_S2=c1600000-0000-4000-8000-000000000002   # sent, listed
M16_S3=c1600000-0000-4000-8000-000000000003   # sent, but its root is accepted in intake (Crosscuts holds the job as won): not listed
M16_S3B=c1600000-0000-4000-8000-0000000000c3  # the intake record's own (different) revision id for S3
M16_S4=c1600000-0000-4000-8000-000000000004   # sent, matches an ignored intake record by quote id only: not listed
M16_S4B=c1600000-0000-4000-8000-0000000000c4  # the intake record's own (different) root for S4
M16_W1=c1600000-0000-4000-8000-0000000000a1   # won, no intake record: listed
M16_W2=c1600000-0000-4000-8000-0000000000a2   # won, intake accepted: not listed
M16_W3=c1600000-0000-4000-8000-0000000000a3   # won, intake ignored: not listed
M16_W4=c1600000-0000-4000-8000-0000000000a4   # won, intake new: listed
M16_W5=c1600000-0000-4000-8000-0000000000a5   # won, intake withdrawn: not listed
M16_W6=c1600000-0000-4000-8000-0000000000a6   # won, intake linked: not listed
M16_W7=c1600000-0000-4000-8000-0000000000a7   # won, intake matches by quote id only: not listed
M16_W7B=c1600000-0000-4000-8000-0000000000b7  # the intake record's own (different) root for W7

# The list the stand-in serves. Dates are in 2099 so they sort above anything else.
M16_QUOTES=$(jq -nc \
  --arg s1 "$M16_S1" --arg s2 "$M16_S2" --arg s3 "$M16_S3" --arg s4 "$M16_S4" --arg w1 "$M16_W1" --arg w2 "$M16_W2" --arg w3 "$M16_W3" \
  --arg w4 "$M16_W4" --arg w5 "$M16_W5" --arg w6 "$M16_W6" --arg w7 "$M16_W7" '[
  {quoteId:$s1, quoteNumber:"M16-S1", status:"sent", clientName:"M16 Sent One", siteAddress:"1 Sent St, Balmain", valueIncGstCents:1843500, sentAt:"2099-01-03T00:00:00.000Z", updatedAt:"2099-01-03T00:00:00.000Z"},
  {quoteId:$s2, quoteNumber:"M16-S2", status:"sent", clientName:"M16 Sent Two", label:"Kitchen", sentAt:null, updatedAt:"2099-01-01T00:00:00.000Z"},
  {quoteId:$s3, rootQuoteId:$s3, quoteNumber:"M16-S3", status:"sent", clientName:"M16 Sent Held As Won", updatedAt:"2099-01-06T00:00:00.000Z"},
  {quoteId:$s4, rootQuoteId:$s4, quoteNumber:"M16-S4", status:"sent", clientName:"M16 Sent By Id", updatedAt:"2099-01-06T00:00:00.000Z"},
  {quoteId:$w1, quoteNumber:"M16-W1", status:"won", clientName:"M16 Won One", siteAddress:"2 Won St, Manly", wonAt:"2099-01-04T00:00:00.000Z", updatedAt:"2099-01-04T00:00:00.000Z", valueIncGstCents:500000},
  {quoteId:$w2, quoteNumber:"M16-W2", status:"won", clientName:"M16 Won Accepted", wonAt:"2099-01-05T00:00:00.000Z", updatedAt:"2099-01-05T00:00:00.000Z"},
  {quoteId:$w3, quoteNumber:"M16-W3", status:"won", clientName:"M16 Won Ignored", wonAt:"2099-01-05T00:00:00.000Z", updatedAt:"2099-01-05T00:00:00.000Z"},
  {quoteId:$w4, quoteNumber:"M16-W4", status:"won", clientName:"M16 Won New", wonAt:"2099-01-02T00:00:00.000Z", updatedAt:"2099-01-02T00:00:00.000Z"},
  {quoteId:$w5, quoteNumber:"M16-W5", status:"won", clientName:"M16 Won Withdrawn", wonAt:"2099-01-05T00:00:00.000Z", updatedAt:"2099-01-05T00:00:00.000Z"},
  {quoteId:$w6, quoteNumber:"M16-W6", status:"won", clientName:"M16 Won Linked", wonAt:"2099-01-05T00:00:00.000Z", updatedAt:"2099-01-05T00:00:00.000Z"},
  {quoteId:$w7, quoteNumber:"M16-W7", status:"won", clientName:"M16 Won By Id", wonAt:"2099-01-05T00:00:00.000Z", updatedAt:"2099-01-05T00:00:00.000Z"},
  {quoteId:"c1600000-0000-4000-8000-0000000000e1", quoteNumber:"M16-BAD1", status:"sent", clientName:"M16 Bad Url", url:"javascript:alert(1)"},
  {quoteId:"c1600000-0000-4000-8000-0000000000e2", quoteNumber:"M16-BAD2", status:"lost", clientName:"M16 Bad Status"},
  {quoteId:"not-a-uuid", quoteNumber:"M16-BAD3", status:"sent", clientName:"M16 Bad Id"},
  {quoteId:"c1600000-0000-4000-8000-0000000000e4", quoteNumber:"M16-BAD4", status:"sent", clientName:"M16 Bad Value", valueIncGstCents:12.5},
  {quoteId:"c1600000-0000-4000-8000-0000000000e5", quoteNumber:"M16-BAD5", status:"sent", clientName:"M16 Bad Date", updatedAt:"yesterday"}
]')

echo "--- start the stand-in Joinr inside the container ---"
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
docker cp "$(dirname "$0")/fake-joinr.js" "$CONTAINER":/tmp/fake-joinr.js
docker exec -d "$CONTAINER" node /tmp/fake-joinr.js "$M16_PORT" "$M16_KEY"
m16_up=""
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" node -e 'fetch("http://127.0.0.1:4999/_control/requests").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' 2>/dev/null; then
    m16_up=1
    break
  fi
  sleep 0.5
done
[ -n "$m16_up" ] || fail "the stand-in Joinr did not start"
ok
m16_exec "DELETE FROM joinr_open_quotes; DELETE FROM joinr_open_quotes_meta"

echo "--- the user who may view jobs but not see values ---"
create_user m16nv "CI M16 No Value" 'M16-Passw0rd-1' design_pm
M16_NV_ID=$CREATED_ID
req PUT "/api/users/$M16_NV_ID/overrides/jobs.value" "$ADMIN" '{"effect":"revoke"}'
expect_status 200 "admin revokes jobs.value from the m16nv user"
M16_NV="$WORK/jar-m16nv"
new_jar "$M16_NV"
login "$M16_NV" m16nv 'M16-Passw0rd-1'
expect_status 200 "login m16nv"
own_password "$M16_NV" 'M16-Passw0rd-1' 'M16-Passw0rd-2'

echo "--- access ---"
req GET /api/pipeline/joinr-quotes "$SHOW"
expect_status 403 "show GET /api/pipeline/joinr-quotes"
req POST /api/pipeline/joinr-quotes/refresh "$SHOW" '{}'
expect_status 403 "show POST /api/pipeline/joinr-quotes/refresh"
req POST /api/pipeline/joinr-quotes/refresh "" '{}'
expect_status 401 "logged out POST /api/pipeline/joinr-quotes/refresh"
req GET /api/pipeline/joinr-quotes "$SCHED"
expect_status 200 "sched (jobs.view) GET /api/pipeline/joinr-quotes"

echo "--- no key: nothing is asked of Joinr ---"
docker exec "$CONTAINER" sh -c "printf '%s\n' '$M16_BASE_URL' > /data/config/joinr-base-url"
req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
expect_status 200 "dpm POST refresh without a key"
expect_jq '.refresh.status == "not-set-up" and .source == "intake" and .configured == false' "not set up: nothing fetched, the intake list, no Refresh offered"
expect_eq "$(m16_asks)" "0" "no request reaches Joinr without a key"
expect_eq "$(m16_val "SELECT COUNT(*) AS v FROM joinr_open_quotes_meta")" "0" "and nothing is recorded"

echo "--- Joinr without the list (404): quiet, and today's intake list stays ---"
docker exec "$CONTAINER" sh -c "printf '%s\n' '$M16_KEY' > /data/config/joinr-api-key"
m16_intake "$M16_W4" "$M16_W4" new
m16_intake "$M16_W2" "$M16_W2" accepted
req GET /api/pipeline/joinr-quotes "$DPM"
expect_status 200 "dpm GET /api/pipeline/joinr-quotes before any fetch"
expect_jq '.source == "intake" and .configured == true and .fetchedAt == null and .truncated == false and .unreachable == false' "never fetched: source is the intake list"
expect_jq '[.quotes[] | select(.quoteNumber == "M16-INTAKE")] | length == 1' "the waiting (new) intake quote is listed, the accepted one is not"
m16_unguard
req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
expect_status 200 "dpm POST refresh while Joinr answers 404"
expect_jq '.refresh.status == "unavailable" and .source == "intake" and (.quotes | length) >= 1' "404 is 'not available yet': still the intake list, the page works"
expect_eq "$(m16_asks)" "1" "Joinr was asked once"
m16_fake GET /_control/requests
M16_REQ=$M16_OUT
printf '%s' "$M16_REQ" | jq -e '[.requests[] | select(.path == "/api/integrations/crosscuts/open-quotes") | select((.query | length) > 0 or .auth != ("…" + "'"$M16_LAST4"'"))] | length == 0' >/dev/null \
  || fail "the open-quotes request carried a query parameter or the wrong key: ${M16_REQ:0:400}"
ok
expect_eq "$(m16_val "SELECT COUNT(*) AS v FROM joinr_open_quotes")" "0" "nothing cached"
expect_eq "$(m16_val "SELECT fetched_at IS NULL AS v FROM joinr_open_quotes_meta")" "1" "the record says never filled"
req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
expect_status 200 "a second press straight away"
expect_jq '.refresh.status == "recent" and .refresh.retryAfterSeconds > 0 and .refresh.retryAfterSeconds <= 60' "the once-a-minute guard answers 'recent'"
expect_eq "$(m16_asks)" "1" "and Joinr was not asked again"
for code in 400 401 503; do
  m16_unguard
  m16_fake POST /_control/oqfail "{\"fail\":$code,\"count\":1}"
  req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
  expect_status 200 "refresh while Joinr answers $code"
  expect_jq '.refresh.status == "unavailable" and .source == "intake"' "$code is 'not available yet', quietly"
done

echo "--- the first good fetch fills the cache ---"
m16_intake "$M16_W3" "$M16_W3" ignored
m16_intake "$M16_W5" "$M16_W5" withdrawn
m16_intake "$M16_W6" "$M16_W6" linked
m16_intake "$M16_W7B" "$M16_W7" accepted   # the root differs: matched by the quote id alone
# A SENT line is held back too when Crosscuts already holds its job: the intake record is matched
# by root id (S3, whose revision id differs) or by quote id (S4, whose root differs).
m16_intake "$M16_S3" "$M16_S3B" accepted
m16_intake "$M16_S4B" "$M16_S4" ignored
m16_fake POST /_control/openquotes "$(jq -nc --argjson q "$M16_QUOTES" '{enabled:true, truncated:false, quotes:$q}')"
m16_unguard
req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
expect_status 200 "dpm POST refresh with the list served"
expect_jq '.refresh.status == "ok" and .source == "cache" and .truncated == false and .unreachable == false and (.fetchedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))' "fetched: source is the cache, with a fetch time"
expect_jq '[.quotes[].quoteNumber] == ["M16-W1","M16-S1","M16-W4","M16-S2"]' "sent quotes and unhandled won quotes, newest updatedAt first; won lines whose job is accepted, ignored, withdrawn or linked (by root or quote id), and sent lines whose job is accepted (S3) or ignored (S4), are not listed"
expect_jq '[.quotes[] | select(.quoteNumber | startswith("M16-BAD"))] | length == 0' "the lines with a bad url, status, id, value or date are dropped"
expect_jq '.quotes[] | select(.quoteNumber == "M16-S1") | .joinrStatus == "sent" and .clientName == "M16 Sent One" and .siteAddress == "1 Sent St, Balmain" and .valueCents == 1843500 and .sentAt == "2099-01-03T00:00:00.000Z" and .wonAt == null and (.url | startswith("'"$M16_BASE_URL"'/org/")) and (.url | endswith("/quotes/'"$M16_S1"'"))' "a sent line: status, client, site, value, sent time, link"
expect_jq '.quotes[] | select(.quoteNumber == "M16-W1") | .joinrStatus == "won" and .wonAt == "2099-01-04T00:00:00.000Z" and .valueCents == 500000' "a won line"
expect_jq '.quotes[] | select(.quoteNumber == "M16-S2") | .label == "Kitchen" and .sentAt == null and .valueCents == null' "a sent line with no site, a label, no sent time and no value"
expect_jq '.quotes[0] | (keys | sort) == ["clientName","id","joinrStatus","label","quoteNumber","sentAt","siteAddress","updatedAt","url","valueCents","wonAt"]' "a line carries exactly these fields for a user who sees values"
expect_eq "$(m16_val "SELECT COUNT(*) AS v FROM joinr_open_quotes")" "11" "eleven valid lines are cached (four sent, seven won), the five bad ones are not"
expect_eq "$(m16_val "SELECT last_error IS NULL AS v FROM joinr_open_quotes_meta")" "1" "the record has no error"
expect_eq "$(m16_asks)" "5" "Joinr has been asked five times in all"

echo "--- no value without jobs.value ---"
req GET /api/pipeline/joinr-quotes "$M16_NV"
expect_status 200 "a user without jobs.value GET /api/pipeline/joinr-quotes"
expect_jq '(.quotes | length) == 4 and all(.quotes[]; has("valueCents") | not)' "the lines carry no value"
m16_unguard
req POST /api/pipeline/joinr-quotes/refresh "$M16_NV" '{}'
expect_status 200 "and the refresh answer carries none either"
expect_jq '.refresh.status == "ok" and all(.quotes[]; has("valueCents") | not)' "refresh as a user without jobs.value"

echo "--- a won quote shows only until it is accepted or ignored (no refetch needed) ---"
m16_intake_state "$M16_W4" accepted
req GET /api/pipeline/joinr-quotes "$DPM"
expect_jq '[.quotes[].quoteNumber] == ["M16-W1","M16-S1","M16-S2"]' "accepting W4 takes it off the list"
m16_intake_state "$M16_W4" ignored
req GET /api/pipeline/joinr-quotes "$DPM"
expect_jq '[.quotes[].quoteNumber] == ["M16-W1","M16-S1","M16-S2"]' "ignoring it keeps it off"
m16_intake_state "$M16_W4" new
req GET /api/pipeline/joinr-quotes "$DPM"
expect_jq '[.quotes[].quoteNumber] == ["M16-W1","M16-S1","M16-W4","M16-S2"]' "a record that is new again lists it again"
m16_exec "INSERT INTO joinr_intake (root_quote_id, quote_id, quote_number, joinr_status, last_event, payload, state) VALUES ('$M16_W1', '$M16_W1', 'M16-W1', 'won', 'won', '{}', 'ignored')"
req GET /api/pipeline/joinr-quotes "$DPM"
expect_jq '[.quotes[].quoteNumber] == ["M16-S1","M16-W4","M16-S2"]' "an ignored record also takes the won quote W1 off (matched by root id)"
m16_exec "DELETE FROM joinr_intake WHERE root_quote_id = '$M16_W1'"

echo "--- a 429 is honoured ---"
m16_unguard
m16_fake POST /_control/oqfail '{"fail":429,"count":1,"retryAfter":90}'
M16_ASKS=$(m16_asks)
req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
expect_status 200 "refresh while Joinr answers 429"
expect_jq '.refresh.status == "limited" and .refresh.retryAfterSeconds > 60 and .refresh.retryAfterSeconds <= 90 and .source == "cache" and (.quotes | length) == 4' "limited, with Joinr's wait, and the cached list stays"
expect_eq "$(m16_asks)" "$((M16_ASKS + 1))" "Joinr was asked once"
m16_exec "UPDATE joinr_open_quotes_meta SET last_attempt_at = NULL"
req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
expect_jq '.refresh.status == "limited" and .refresh.retryAfterSeconds > 0' "still limited after the once-a-minute guard has passed"
expect_eq "$(m16_asks)" "$((M16_ASKS + 1))" "Joinr was not asked while Retry-After runs"
m16_unguard
req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
expect_jq '.refresh.status == "ok"' "after Retry-After the next press fetches"

echo "--- Joinr failing after the cache is filled: the list stays, 'not reachable' shows once it is old ---"
for mode in 500 404 '"garbage"' '"badcontract"'; do
  m16_unguard
  m16_fake POST /_control/oqfail "{\"fail\":$mode,\"count\":1}"
  req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
  expect_status 200 "refresh while Joinr answers $mode"
  expect_jq '(.refresh.status == "failed" or .refresh.status == "unavailable") and .source == "cache" and (.quotes | length) == 4 and .unreachable == false' "$mode: the cached list stays and a fresh one is not 'unreachable'"
done
expect_eq "$(m16_val "SELECT last_error IS NOT NULL AS v FROM joinr_open_quotes_meta")" "1" "the failure is recorded"
m16_exec "UPDATE joinr_open_quotes_meta SET fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 minutes')"
req GET /api/pipeline/joinr-quotes "$DPM"
expect_jq '.source == "cache" and .unreachable == true and (.quotes | length) == 4' "the last fetch failed and the cache is 20 minutes old: not reachable"
m16_exec "UPDATE joinr_open_quotes_meta SET last_error = NULL"
req GET /api/pipeline/joinr-quotes "$DPM"
expect_jq '.unreachable == false' "an old cache with no failed fetch is not 'not reachable'"
m16_unguard
req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
expect_jq '.refresh.status == "ok" and .unreachable == false' "a good fetch clears it"

echo "--- truncated, replaced whole, and an empty list is a real answer ---"
m16_unguard
m16_fake POST /_control/openquotes '{"truncated":true}'
req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
expect_jq '.refresh.status == "ok" and .truncated == true' "truncated: true is passed on (the page says 'Showing the newest quotes only')"
m16_unguard
m16_fake POST /_control/openquotes "$(jq -nc --arg s1 "$M16_S1" '{truncated:false, quotes:[{quoteId:$s1, quoteNumber:"M16-S1", status:"sent", clientName:"M16 Sent Renamed", updatedAt:"2099-02-01T00:00:00.000Z"}]}')"
req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
expect_jq '.truncated == false and (.quotes | length) == 1 and .quotes[0].clientName == "M16 Sent Renamed"' "the new answer replaces the whole list"
expect_eq "$(m16_val "SELECT COUNT(*) AS v FROM joinr_open_quotes")" "1" "one row cached"
m16_unguard
m16_fake POST /_control/openquotes '{"quotes":[]}'
req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
expect_jq '.refresh.status == "ok" and .source == "cache" and .quotes == []' "an empty list from Joinr is a real answer: no fallback to the intake list"

echo "--- Crosscuts' own cap of 500 lines ---"
m16_exec "
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 505)
INSERT INTO joinr_open_quotes (quote_id, root_quote_id, quote_number, status, client_name, updated_at, url, fetched_at)
SELECT printf('c1600000-0000-4000-8000-%012d', 100000 + i), printf('c1600000-0000-4000-8000-%012d', 100000 + i),
       'M16-MANY', 'sent', 'M16 Many', '2098-01-01T00:00:00.000Z', 'https://example.com/q', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM n"
req GET /api/pipeline/joinr-quotes "$DPM"
expect_jq '(.quotes | length) == 500' "505 cached lines: the route returns 500"

echo "--- the page script asks the server to refresh ---"
req GET /pipeline.js "$DPM"
expect_status 200 "GET /pipeline.js"
case $BODY in *"/api/pipeline/joinr-quotes/refresh"*) ok ;; *) fail "pipeline.js does not call the refresh route" ;; esac
case $BODY in *"Showing the newest quotes only"*) ok ;; *) fail "pipeline.js lacks the truncated note" ;; esac

echo "--- migration 031 CHECKs ---"
m16_refused() { # SQL WHAT
  local out
  out=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
try { d.exec(process.argv[1]); console.log("ACCEPTED"); } catch (e) { console.log("REFUSED"); }
d.close();' "$1" | tr -d '\r')
  [ "$out" = "REFUSED" ] || fail "$2 was accepted by the database"
  ok
}
m16_refused "INSERT INTO joinr_open_quotes (quote_id, root_quote_id, status, updated_at, url, fetched_at) VALUES ('x1','x1','lost','2099-01-01T00:00:00.000Z','https://e.com','2099-01-01T00:00:00.000Z')" "a status other than sent or won"
m16_refused "INSERT INTO joinr_open_quotes (quote_id, root_quote_id, status, updated_at, url, fetched_at) VALUES ('x2','x2','sent','2099-01-01T00:00:00.000Z','javascript:alert(1)','2099-01-01T00:00:00.000Z')" "a url that is not http(s)"
m16_refused "INSERT INTO joinr_open_quotes (quote_id, root_quote_id, status, value_inc_gst_cents, updated_at, url, fetched_at) VALUES ('x3','x3','sent',-1,'2099-01-01T00:00:00.000Z','https://e.com','2099-01-01T00:00:00.000Z')" "a negative value"
m16_refused "INSERT INTO joinr_open_quotes (quote_id, root_quote_id, status, updated_at, url, fetched_at) VALUES ('c1600000-0000-4000-8000-000000100001','x4','sent','2099-01-01T00:00:00.000Z','https://e.com','2099-01-01T00:00:00.000Z')" "a repeated quote id"
m16_refused "INSERT INTO joinr_open_quotes_meta (id) VALUES (2)" "a second meta record"
m16_refused "UPDATE joinr_open_quotes_meta SET truncated = 2" "truncated other than 0 or 1"

echo "--- removing the key clears the cache: back to the intake list ---"
m16_unguard
req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
expect_jq '.source == "cache"' "the cache is filled before the key goes"
req DELETE /api/joinr/settings/key "$ADMIN"
expect_status 200 "admin DELETE the key"
req GET /api/pipeline/joinr-quotes "$DPM"
expect_jq '.source == "intake" and .configured == false and .fetchedAt == null' "no key: the cache is forgotten and the intake list is back"
expect_eq "$(m16_val "SELECT COUNT(*) AS v FROM joinr_open_quotes")" "0" "no cached rows"
expect_eq "$(m16_val "SELECT COUNT(*) AS v FROM joinr_open_quotes_meta")" "0" "no meta record"
req POST /api/pipeline/joinr-quotes/refresh "$DPM" '{}'
expect_jq '.refresh.status == "not-set-up"' "and Refresh does nothing without a key"

echo "--- tidy up: stop the stand-in, remove the Joinr set-up and this suite's rows ---"
m16_fake POST /_control/stop
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
m16_exec "DELETE FROM joinr_open_quotes; DELETE FROM joinr_open_quotes_meta; DELETE FROM joinr_intake WHERE quote_number = 'M16-INTAKE'"
req GET /api/pipeline/joinr-quotes "$DPM"
expect_jq '.source == "intake" and ([.quotes[] | select(.quoteNumber == "M16-INTAKE")] | length) == 0' "the list is back to what it was before this suite"
