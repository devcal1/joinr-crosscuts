# M6 smoke, Wave 1 A (and B in its marked block): the Joinr intake puller.
# Sourced by ci/smoke.sh after the M5 suites, so it shares that script's helpers
# (step, req, expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie jars
# ($ADMIN $SCHED $ACCT $DPM $SHOW). No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: every quote it sends has its own ids ("CI-M6-...").
# Contract: docs/plans/m6-contracts.md sections 2 to 4 and 8; the wire contract is
# docs/integrations/joinr-crosscuts-intake.md.
#
# A stand-in Joinr (ci/fake-joinr.js) runs inside the container on 127.0.0.1:4999, and
# Crosscuts is pointed at it through files in /data/config. Both files are removed at the
# end, so later suites and the cutover rehearsal (step k) see no Joinr set-up.
#
# The sync timer may fire during this suite (every 5 minutes once a key is set). It shares
# the run lock with POST /sync, so every check below looks at the stored state, not at how
# many items one particular call handled, and forced failures stay on until cleared.

# ============================================================================
step "m6-intake. Joinr puller: sync, status and import against a stand-in Joinr"
# ============================================================================

M6_KEY='ci-joinr-smoke-key-7f3a9c2e5b1d4a68'
M6_LAST4=${M6_KEY: -4}
M6_PORT=4999
M6_BASE_URL="http://127.0.0.1:$M6_PORT"
M6_OUT=""

# m6_fake METHOD PATH [json] -> M6_OUT (the fake's response body). Runs inside the container.
m6_fake() {
  M6_OUT=$(docker exec "$CONTAINER" node -e '
const [m, p, b] = process.argv.slice(1);
fetch("http://127.0.0.1:4999" + p, { method: m, headers: { "content-type": "application/json" }, body: b || undefined })
  .then(async (r) => { process.stdout.write(await r.text()); if (!r.ok) process.exit(1); })
  .catch((e) => { console.error(String(e)); process.exit(1); });' "$1" "$2" "${3:-}") \
    || fail "fake joinr $1 $2 failed: ${M6_OUT:0:300}"
}

# jq -e over M6_OUT must be truthy.
m6_expect_out() { # FILTER WHAT
  printf '%s' "$M6_OUT" | jq -e "$1" >/dev/null || fail "$2: jq '$1' is not true for: ${M6_OUT:0:600}"
  ok
}

# m6_sql SQL -> prints the rows as JSON (read-only connection).
m6_sql() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const db = new D("/data/db/photos.db", { readonly: true });
process.stdout.write(JSON.stringify(db.prepare(process.argv[1]).all()));' "$1"
}

# m6_event ROOT QUOTE EVENT STATUS [extra-json] -> appends an item to the fake (M6_OUT = the item).
m6_event() {
  local extra=${5:-}
  [ -n "$extra" ] || extra='{}'
  m6_fake POST /_control/event "$(jq -nc --arg r "$1" --arg q "$2" --arg e "$3" --arg s "$4" --argjson x "$extra" \
    '{rootQuoteId:$r, quoteId:$q, event:$e, status:$s} + $x')"
}

m6_set_fail() { # MODE-JSON (e.g. 500 or "\"hang\"" or null)
  m6_fake POST /_control/fail "{\"fail\":$1,\"count\":1000}"
}

# m6_sync JAR WHAT: POST /api/joinr/sync twice. If a timer run was in flight, the first call
# returns that run's result (the shared lock), which may predate the event just appended;
# the second call is then a fresh run. Leaves STATUS/BODY of the second call.
m6_sync() {
  req POST /api/joinr/sync "$1" '{}'
  expect_status 200 "$2 (first call)"
  req POST /api/joinr/sync "$1" '{}'
  expect_status 200 "$2"
}

m6_intake_field() { # ROOT FIELD -> the field of that intake record ("null" if none)
  m6_sql "SELECT $2 AS v FROM joinr_intake WHERE root_quote_id = '$1'" | jq -r '.[0].v // "null"'
}

m6_intake_count() { # ROOT
  m6_sql "SELECT COUNT(*) AS n FROM joinr_intake WHERE root_quote_id = '$1'" | jq -r '.[0].n'
}

m6_cursor() {
  m6_sql "SELECT cursor FROM integration_sync WHERE name = 'joinr'" | jq -r '.[0].cursor // "null"'
}

# Joinr quote ids (fixed uuids; one root per quote).
M6_Q0=c6000000-0000-4000-8000-000000000000
M6_Q1=c6000000-0000-4000-8000-000000000001
M6_Q2=c6000000-0000-4000-8000-000000000002
M6_Q3=c6000000-0000-4000-8000-000000000003
M6_Q1B=c6000000-0000-4000-8000-0000000001b1

echo "--- start the stand-in Joinr inside the container ---"
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
docker cp "$(dirname "$0")/fake-joinr.js" "$CONTAINER":/tmp/fake-joinr.js
docker exec -d "$CONTAINER" node /tmp/fake-joinr.js "$M6_PORT" "$M6_KEY"
m6_up=""
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" node -e 'fetch("http://127.0.0.1:4999/_control/requests").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' 2>/dev/null; then
    m6_up=1
    break
  fi
  sleep 0.5
done
[ -n "$m6_up" ] || fail "the stand-in Joinr did not start"
ok

echo "--- access ---"
req GET /api/joinr/status "$SHOW"
expect_status 403 "show GET /api/joinr/status"
req GET /api/joinr/status "$SCHED"
expect_status 403 "sched GET /api/joinr/status"
req GET /api/joinr/status "$ACCT"
expect_status 403 "acct GET /api/joinr/status"
req POST /api/joinr/sync "$SHOW" '{}'
expect_status 403 "show POST /api/joinr/sync"
req POST /api/joinr/sync "$SCHED" '{}'
expect_status 403 "sched POST /api/joinr/sync"
req POST /api/joinr/sync "$ACCT" '{}'
expect_status 403 "acct POST /api/joinr/sync"
req POST /api/joinr/import "$DPM" '{}'
expect_status 403 "dpm POST /api/joinr/import"
req POST /api/joinr/import "$SCHED" '{}'
expect_status 403 "sched POST /api/joinr/import"

echo "--- no key: 409 and no requests to Joinr ---"
req GET /api/joinr/status "$DPM"
expect_status 200 "dpm GET /api/joinr/status"
expect_jq '.configured == false and .running == false and (.lastItems | type) == "number"' "status without a key"
expect_jq 'has("baseUrl") and has("lastRunAt") and has("lastOkAt") and has("lastError") and has("lastErrorAt")' "status has its fields"
docker exec "$CONTAINER" sh -c "printf '%s\n' '$M6_BASE_URL' > /data/config/joinr-base-url"
req POST /api/joinr/sync "$DPM" '{}'
expect_status 409 "dpm POST /api/joinr/sync without a key"
expect_jq '.error == "Joinr is not set up"' "the 409 says Joinr is not set up"
req POST /api/joinr/import "$ADMIN" '{}'
expect_status 409 "admin POST /api/joinr/import without a key"
m6_fake GET /_control/requests
m6_expect_out '.requests | length == 0' "no requests reach Joinr without a key"

# A quote that was already won before Crosscuts was connected: the first sync must not
# bring it in (start from now); the import does.
m6_event "$M6_Q0" "$M6_Q0" won won '{"quoteNumber":"CI-M6-0000","siteAddress":"0 Before St","clientName":"M6 Client Zero"}'

echo "--- with the key: the first sync stores a cursor and creates nothing ---"
docker exec "$CONTAINER" sh -c "printf '%s\n' '$M6_KEY' > /data/config/joinr-api-key"
req GET /api/joinr/status "$DPM"
expect_status 200 "status with a key"
expect_jq ".configured == true and .baseUrl == \"$M6_BASE_URL\"" "status: configured, pointing at the stand-in"
req POST /api/joinr/sync "$DPM" '{}'
expect_status 200 "dpm POST /api/joinr/sync (first)"
expect_jq '.ok == true and .error == null' "the first sync is ok"
m6_fake GET /_control/requests
m6_expect_out '.requests | length >= 1' "the first sync asked Joinr"
m6_expect_out '.requests[0].path == "/api/integrations/crosscuts/won-quotes" and (.requests[0].query | has("after") | not) and (.requests[0].query | has("backfill") | not)' "the first request has no after and no backfill"
m6_expect_out "all(.requests[]; .auth == \"…$M6_LAST4\")" "every request carried the key as a Bearer header"
expect_eq "$(m6_cursor)" "1" "the first sync stored Joinr's current cursor"
expect_eq "$(m6_intake_count "$M6_Q0")" "0" "the quote won before the first sync is not brought in"
req GET /api/joinr/status "$DPM"
expect_jq '.lastOkAt != null and .lastRunAt != null and .lastError == null' "status after the first sync"

echo "--- a won quote: one new record and a joinr.new alert for Design/PM ---"
M6_Q1_ITEM='{"quoteNumber":"CI-M6-0001","siteAddress":"1 Far Future St, Sydney","clientName":"M6 Client One","clientPhone":"0400 000 001","quoteDate":"2099-03-01","wonAt":"2099-03-02T01:00:00Z","valueIncGstCents":1234567,"estimatedHours":{"office":2,"factory":30,"site":12,"travel":3},"spec":{"sheetCount":24,"twoPac":true,"benchtop":"stone","jobType":"Kitchen"},"raw":{"doorsPanels":["2pac (S4)"],"benchtops":["Caesarstone"],"jobTypes":["Kitchen"]}}'
m6_event "$M6_Q1" "$M6_Q1" won won "$M6_Q1_ITEM"
m6_sync "$DPM" "sync after a won event"
expect_jq '.ok == true' "the sync is ok"
m6_fake GET /_control/requests
m6_expect_out '.requests[-1].query.after != null' "later syncs ask with after"
expect_eq "$(m6_intake_count "$M6_Q1")" "1" "one intake record for the won quote"
expect_eq "$(m6_intake_field "$M6_Q1" state)" "new" "the record is new"
expect_eq "$(m6_intake_field "$M6_Q1" quote_number)" "CI-M6-0001" "the record has the quote number"
expect_eq "$(m6_intake_field "$M6_Q1" joinr_status)" "won" "the record has the Joinr status"
expect_eq "$(m6_intake_field "$M6_Q1" changed)" "0" "the record is not flagged"
expect_eq "$(m6_sql "SELECT payload FROM joinr_intake WHERE root_quote_id = '$M6_Q1'" | jq -r '.[0].payload | fromjson | .valueIncGstCents')" "1234567" "the payload keeps the value"
M6_Q1_ID=$(m6_intake_field "$M6_Q1" id)
expect_eq "$(m6_cursor)" "2" "the cursor moved past the item"

req GET "/api/notifications?limit=100" "$DPM"
expect_status 200 "dpm notifications"
expect_jq "[.rows[] | select(.kind == \"joinr.new\" and .link == \"/intake.html?item=$M6_Q1_ID\")] | length == 1" "dpm has one joinr.new alert for the record"
expect_jq "(.rows[] | select(.kind == \"joinr.new\" and .link == \"/intake.html?item=$M6_Q1_ID\") | .title) | startswith(\"New from Joinr: CI-M6-0001\")" "the alert title names the quote"
req GET "/api/notifications?limit=100" "$SCHED"
expect_jq '[.rows[] | select(.kind | startswith("joinr."))] | length == 0' "sched gets no Joinr alert"
req GET "/api/notifications?limit=100" "$SHOW"
expect_jq '[.rows[] | select(.kind | startswith("joinr."))] | length == 0' "show gets no Joinr alert"

echo "--- the same event again: still one record, no second alert ---"
m6_event "$M6_Q1" "$M6_Q1" won won "$M6_Q1_ITEM"
m6_sync "$DPM" "sync"
expect_jq '.ok == true' "sync of a repeated item"
expect_eq "$(m6_intake_count "$M6_Q1")" "1" "still one record for the quote"
expect_eq "$(m6_intake_field "$M6_Q1" state)" "new" "still new"
req GET "/api/notifications?limit=100" "$DPM"
expect_jq "[.rows[] | select(.kind == \"joinr.new\" and .link == \"/intake.html?item=$M6_Q1_ID\")] | length == 1" "still one joinr.new alert"

echo "--- a revision that wins: the same record, the latest quote id ---"
m6_event "$M6_Q1" "$M6_Q1B" won won "$(printf '%s' "$M6_Q1_ITEM" | jq -c '. + {revision: 1, valueIncGstCents: 1300000}')"
m6_sync "$DPM" "sync"
expect_jq '.ok == true' "sync of a revision"
expect_eq "$(m6_intake_count "$M6_Q1")" "1" "a revision does not make a second record"
expect_eq "$(m6_intake_field "$M6_Q1" quote_id)" "$M6_Q1B" "the record holds the latest revision"

echo "--- un-won before a decision: withdrawn; won again: back to new; deleted: withdrawn ---"
m6_event "$M6_Q2" "$M6_Q2" won won '{"quoteNumber":"CI-M6-0002","siteAddress":"2 Far Future St","clientName":"M6 Client Two"}'
m6_sync "$DPM" "sync"
expect_eq "$(m6_intake_field "$M6_Q2" state)" "new" "quote 2 is new"
m6_event "$M6_Q2" "$M6_Q2" unwon lost '{"quoteNumber":"CI-M6-0002","siteAddress":"2 Far Future St","clientName":"M6 Client Two","wonAt":null}'
m6_sync "$DPM" "sync"
expect_jq '.ok == true' "sync of an unwon item"
expect_eq "$(m6_intake_field "$M6_Q2" state)" "withdrawn" "an unwon undecided quote is withdrawn"
expect_eq "$(m6_intake_field "$M6_Q2" joinr_status)" "lost" "the record shows the status in Joinr"
expect_eq "$(m6_intake_count "$M6_Q2")" "1" "still one record for quote 2"
m6_event "$M6_Q2" "$M6_Q2" won won '{"quoteNumber":"CI-M6-0002","siteAddress":"2 Far Future St","clientName":"M6 Client Two"}'
m6_sync "$DPM" "sync"
expect_eq "$(m6_intake_field "$M6_Q2" state)" "new" "won again: back to new"
m6_event "$M6_Q2" "$M6_Q2" deleted won '{"quoteNumber":"CI-M6-0002","siteAddress":"2 Far Future St","clientName":"M6 Client Two","deletedAt":"2099-04-01T00:00:00Z"}'
m6_sync "$DPM" "sync"
expect_eq "$(m6_intake_field "$M6_Q2" state)" "withdrawn" "deleted in Joinr: withdrawn"

echo "--- an item that fails validation is skipped, logged and passed by the cursor ---"
m6_fake POST /_control/event '{"_verbatim":true,"event":"won","rootQuoteId":"not-a-uuid","status":"won"}'
M6_BAD_CURSOR=$(printf '%s' "$M6_OUT" | jq -r '.cursor')
m6_event "$M6_Q3" "$M6_Q3" won won '{"quoteNumber":"CI-M6-0003","siteAddress":"3 Far Future St","clientName":"M6 Client Three"}'
M6_Q3_CURSOR=$(printf '%s' "$M6_OUT" | jq -r '.cursor')
m6_sync "$DPM" "sync with an invalid item"
expect_jq '.ok == true and .error == null' "an invalid item does not fail the sync"
expect_eq "$(m6_intake_count "$M6_Q3")" "1" "the valid item after it is applied"
expect_eq "$(m6_intake_count not-a-uuid)" "0" "the invalid item made no record"
expect_eq "$(m6_cursor)" "$M6_Q3_CURSOR" "the cursor moved past both items"
M6_LOGS=$(docker logs "$CONTAINER" 2>&1)
grep -qF "[joinr] skipped item $M6_BAD_CURSOR:" <<<"$M6_LOGS" || fail "the invalid item is logged as skipped"
ok

echo "--- import currently won quotes (admin) ---"
M6_CURSOR_BEFORE=$(m6_cursor)
req POST /api/joinr/import "$ADMIN" '{}'
expect_status 200 "admin POST /api/joinr/import"
expect_jq '.ok == true and .error == null' "the import is ok"
m6_fake GET /_control/requests
m6_expect_out '[.requests[] | select(.query.backfill == "won")] | length >= 1' "the import asked with backfill=won"
expect_eq "$(m6_intake_count "$M6_Q0")" "1" "the quote won before the first sync is imported"
expect_eq "$(m6_intake_field "$M6_Q0" state)" "new" "the imported quote is new"
expect_eq "$(m6_intake_count "$M6_Q1")" "1" "the import does not duplicate quote 1"
expect_eq "$(m6_intake_field "$M6_Q2" state)" "withdrawn" "the import leaves the withdrawn quote alone"
expect_eq "$(m6_cursor)" "$M6_CURSOR_BEFORE" "the import keeps the stored cursor"

echo "--- Joinr misbehaving: the error shows in /status and the app carries on ---"
m6_check_failure() { # MODE-JSON WHAT [ERROR-SUBSTRING]
  m6_set_fail "$1"
  if [ "$1" = '"hang"' ]; then
    # One call: each one waits out the 15 s timeout.
    req POST /api/joinr/sync "$DPM" '{}'
    expect_status 200 "sync while Joinr sends $2"
  else
    m6_sync "$DPM" "sync while Joinr sends $2"
  fi
  expect_jq '.ok == false and (.error | type) == "string" and (.error | length) > 0' "the sync reports $2"
  if [ -n "${3:-}" ]; then expect_jq ".error | contains(\"$3\")" "the error for $2 says \"$3\""; fi
  req GET /api/joinr/status "$DPM"
  expect_status 200 "status after $2"
  expect_jq '.lastError != null and .lastErrorAt != null and .running == false' "status shows the error after $2"
  req GET /api/schedule "$ADMIN"
  expect_status 200 "the board still loads after $2"
  m6_fake POST /_control/fail '{"fail":null}'
}
m6_check_failure '"garbage"' "a garbage page" "not valid JSON"
m6_check_failure '"html"' "an HTML page" "not JSON"
m6_check_failure 500 "a 500" "HTTP 500"
m6_check_failure '"hang"' "nothing (a hang)" "15 seconds"

# A wrong key: Joinr's 401 is reported, and the right key works again.
docker exec "$CONTAINER" sh -c "printf '%s\n' 'ci-wrong-key-0000000000' > /data/config/joinr-api-key"
m6_sync "$DPM" "sync with a wrong key"
expect_jq '.ok == false and (.error | contains("401"))' "a wrong key is reported as a 401"
docker exec "$CONTAINER" sh -c "printf '%s\n' '$M6_KEY' > /data/config/joinr-api-key"

m6_sync "$DPM" "sync with Joinr back"
expect_jq '.ok == true and .error == null' "Joinr back: the sync is ok again"
req GET /api/joinr/status "$DPM"
expect_jq '.lastError == null and .lastOkAt != null' "status is clear after a good sync"

echo "--- the key never leaves the server ---"
req GET /api/joinr/status "$ADMIN"
case $BODY in *"$M6_KEY"*) fail "the key appears in /api/joinr/status" ;; *) ok ;; esac
req GET "/api/audit?limit=500" "$ADMIN"
expect_status 200 "admin GET /api/audit"
case $BODY in *"$M6_KEY"*) fail "the key appears in /api/audit" ;; *) ok ;; esac
M6_LOGS=$(docker logs "$CONTAINER" 2>&1)
if grep -qF "$M6_KEY" <<<"$M6_LOGS"; then fail "the key appears in docker logs"; fi
ok
m6_fake GET /_control/requests
case $M6_OUT in *"$M6_KEY"*) fail "the key appears in a request URL" ;; *) ok ;; esac

# ---- Block B (inbox) ----------------------------------------------------------
# Wave 1 B adds its assertions here (Accept, Link, Ignore, acknowledge, the intake
# routes and page). The stand-in Joinr is still running and Crosscuts still points
# at it; quotes 0 to 3 above exist ($M6_Q0 new, $M6_Q1 new, $M6_Q2 withdrawn,
# $M6_Q3 new). Use new root ids for anything you decide on.
# ---- end block B ----------------------------------------------------------------

echo "--- tidy up: stop the stand-in and remove the Joinr set-up ---"
m6_fake POST /_control/stop
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
req GET /api/joinr/status "$DPM"
expect_status 200 "status after the tidy-up"
expect_jq '.configured == false' "Joinr is no longer set up"
req POST /api/joinr/sync "$DPM" '{}'
expect_status 409 "sync after the tidy-up"
