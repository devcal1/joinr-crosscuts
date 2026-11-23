# Job page smoke, section B (0.2.26): the Joinr quote PDF on the Quote tab
# (docs/plans/jobpage-contracts.md sections B and D; migration 067 table joinr_quote_pdfs;
# GET .../joinr-quote/pdf-status, GET .../joinr-quote/pdf, POST .../joinr-quote/pdf/refresh).
# Sourced by ci/smoke.sh, so it shares that script's helpers (step, req, expect_status, expect_jq,
# expect_eq, jqr, fail, ok), the cookie jars ($ADMIN $SCHED $ACCT $DPM $SHOW), $WORK, $BASE and
# $CONTAINER. No shebang and no `set`: the caller owns both. It makes its own quote (number
# CI-JPQ-0001) and checks only that.
#
# A stand-in Joinr (ci/fake-joinr.js) runs inside the container on 127.0.0.1:4999 (the M19 suite's
# has stopped by then). Crosscuts is pointed at it through files in /data/config, removed at the end.
# The once-a-minute guard is the stored last_attempt_at, so the suite clears it with SQL between
# steps instead of waiting a minute; the 429 back-off is in memory and is tested for real.

# ============================================================================
step "jobpage-quotepdf. Joinr quote PDF: money permissions, fetch, cache, refetch, guard, 429, failure keeps the copy, bad files refused"
# ============================================================================

JPQ_KEY='ci-joinr-smoke-key-jpq-7a41c9e0b5d83f26'
JPQ_PORT=4999
JPQ_BASE_URL="http://127.0.0.1:$JPQ_PORT"
JPQ_OUT=""

jpq_fake() { # METHOD PATH [json] -> JPQ_OUT
  JPQ_OUT=$(docker exec "$CONTAINER" node -e '
const [m, p, b] = process.argv.slice(1);
fetch("http://127.0.0.1:4999" + p, { method: m, headers: { "content-type": "application/json" }, body: b || undefined })
  .then(async (r) => { process.stdout.write(await r.text()); if (!r.ok) process.exit(1); })
  .catch((e) => { console.error(String(e)); process.exit(1); });' "$1" "$2" "${3:-}") \
    || fail "fake joinr $1 $2 failed: ${JPQ_OUT:0:300}"
}

jpq_sql() { # read-only SQL on the live database -> rows as JSON
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const db = new D("/data/db/photos.db", { readonly: true });
process.stdout.write(JSON.stringify(db.prepare(process.argv[1]).all()));' "$1" | tr -d '\r'
}
jpq_exec() { # SQL (a write)
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.exec(process.argv[1]);
d.close();' "$1"
}
jpq_val() { jpq_sql "$1" | jq -r '.[0].v // "null"'; }
jpq_unguard() { jpq_exec "UPDATE joinr_quote_pdfs SET last_attempt_at = NULL WHERE intake_id = $1"; }

# How many times the stand-in has been asked for a quote PDF, and its raw request log.
jpq_asks() {
  jpq_fake GET /_control/requests
  printf '%s' "$JPQ_OUT" | jq '[.requests[] | select(.path == "/api/integrations/crosscuts/quote-pdf")] | length'
}

# The stored file's bytes as text (the stand-in puts the quote id and a tag in a comment line).
jpq_file_text() { # FILE-NAME
  docker exec "$CONTAINER" sh -c "cat '/data/uploads/files/$1'" | tr -d '\r'
}

# curl the PDF route with a jar: leaves the headers in $HDR_FILE and the body in $BODY_FILE.
jpq_get_pdf() { # JAR PATH
  STATUS=$(curl -s -o "$BODY_FILE" -D "$HDR_FILE" -w '%{http_code}' -H "Origin: $REQ_ORIGIN" -b "$1" "$BASE$2")
}

JPQ_Q1=c3100000-0000-4000-8000-000000000001
JPQ_Q2=c3100000-0000-4000-8000-000000000002

# --- the stand-in Joinr ----------------------------------------------------------------------------
echo "--- start the stand-in Joinr inside the container ---"
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
if docker exec "$CONTAINER" node -e 'fetch("http://127.0.0.1:4999/_control/requests").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' 2>/dev/null; then
  jpq_fake POST /_control/stop
  sleep 1
fi
docker cp "$(dirname "$0")/fake-joinr.js" "$CONTAINER":/tmp/fake-joinr.js
docker exec -d "$CONTAINER" node /tmp/fake-joinr.js "$JPQ_PORT" "$JPQ_KEY"
jpq_up=""
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" node -e 'fetch("http://127.0.0.1:4999/_control/requests").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' 2>/dev/null; then
    jpq_up=1
    break
  fi
  sleep 0.5
done
[ -n "$jpq_up" ] || fail "the stand-in Joinr did not start"
ok
docker exec "$CONTAINER" sh -c "printf '%s\n' '$JPQ_BASE_URL' > /data/config/joinr-base-url"
docker exec "$CONTAINER" sh -c "printf '%s\n' '$JPQ_KEY' > /data/config/joinr-api-key"
jpq_exec "UPDATE integration_sync SET cursor = NULL WHERE name = 'joinr'"
req POST /api/joinr/sync "$DPM" '{}'
expect_status 200 "first sync stores a position"

echo "--- migration 067's table ---"
JPQ_COLS=$(jpq_sql "SELECT group_concat(name) AS v FROM pragma_table_info('joinr_quote_pdfs')" | jq -r '.[0].v')
for c in intake_id quote_id file size sha256 fetched_at last_attempt_at last_error; do
  case ",$JPQ_COLS," in *",$c,"*) ok ;; *) fail "joinr_quote_pdfs has no column $c: $JPQ_COLS" ;; esac
done

# --- a won quote becomes a job ---------------------------------------------------------------------
jpq_fake POST /_control/pdf '{"enabled":true,"tag":"v1","mode":"pdf"}'
jpq_fake POST /_control/event "$(jq -nc --arg r "$JPQ_Q1" '{rootQuoteId:$r, quoteId:$r, event:"won", status:"won", quoteNumber:"CI-JPQ-0001", clientName:"JPQ Client", siteAddress:"1 Quote Pdf St", wonAt:"2099-08-01T01:00:00Z", valueIncGstCents:500000, spec:{sheetCount:5}}')"
req POST /api/joinr/sync "$DPM" '{}'
expect_status 200 "sync the won quote"
req POST /api/joinr/sync "$DPM" '{}'
expect_status 200 "sync again"
JPQ_I=$(jpq_val "SELECT id AS v FROM joinr_intake WHERE root_quote_id = '$JPQ_Q1'")
JPQ_J=$(jpq_val "SELECT job_id AS v FROM joinr_intake WHERE root_quote_id = '$JPQ_Q1'")
[ "$JPQ_J" != "null" ] || fail "the won quote did not become a job"
ok
JPQ_P="/api/job-records/$JPQ_J/joinr-quote"

# --- money permission: jobs.view AND jobs.value --------------------------------------------------------
echo "--- permissions ---"
for path in /pdf-status /pdf; do
  req GET "$JPQ_P$path" "$SCHED"
  expect_status 403 "scheduling (jobs.view only) GET $path"
  req GET "$JPQ_P$path" "$SHOW"
  expect_status 403 "showroom GET $path"
  req GET "$JPQ_P$path" ""
  expect_status 401 "logged out GET $path"
done
req POST "$JPQ_P/pdf/refresh" "$SCHED" '{}'
expect_status 403 "scheduling POST refresh"
req POST "$JPQ_P/pdf/refresh" "$SHOW" '{}'
expect_status 403 "showroom POST refresh"
req GET "/api/job-records/999999/joinr-quote/pdf-status" "$DPM"
expect_status 404 "a job that does not exist"
req POST /api/job-records "$DPM" '{"name":"JPQ plain job"}'
expect_status 201 "create a job with no Joinr record"
req GET "/api/job-records/$(jqr '.id')/joinr-quote/pdf-status" "$DPM"
expect_status 404 "a job not tied to Joinr has no PDF status"
expect_eq "$(jpq_asks)" "0" "none of that asked Joinr for a PDF"
req GET "$JPQ_P/pdf" "$DPM"
expect_status 404 "no copy yet: the PDF route never fetches"
expect_eq "$(jpq_asks)" "0" "and still no ask"

# --- first view fetches --------------------------------------------------------------------------------
echo "--- first view ---"
req GET "$JPQ_P/pdf-status" "$DPM"
expect_status 200 "pdf-status on first view"
expect_jq '.fetch == "ok" and .has == true and .outdated == false and .error == null and .quoteNumber == "CI-JPQ-0001" and (.joinrUrl | startswith("http"))' "fetched, current, with the quote number and Joinr link"
if printf '%s' "$BODY" | grep -q "$JPQ_KEY"; then fail "the API key is in the status answer"; fi
ok
jpq_get_pdf "$DPM" "$JPQ_P/pdf"
expect_eq "$STATUS" "200" "GET the PDF"
grep -qi '^content-type: application/pdf' "$HDR_FILE" || fail "PDF content type: $(cat "$HDR_FILE")"
grep -qi '^x-content-type-options: nosniff' "$HDR_FILE" || fail "PDF has no nosniff"
grep -qi '^cache-control:.*no-store' "$HDR_FILE" || fail "PDF is not no-store"
grep -qi '^content-disposition: inline' "$HDR_FILE" || fail "PDF is not inline"
# Chrome's viewer fails under a sandbox CSP, and a frame needs no X-Frame-Options / frame-ancestors.
if grep -qi '^content-security-policy:\|^x-frame-options:' "$HDR_FILE"; then fail "PDF carries a CSP or X-Frame-Options (the iframe would not render): $(cat "$HDR_FILE")"; fi
ok
head -c 5 "$BODY_FILE" | grep -q '%PDF-' || fail "the body is not a PDF"
grep -q "quoteId=$JPQ_Q1" "$BODY_FILE" || fail "the PDF is not for this quote"
grep -q 'tag=v1' "$BODY_FILE" || fail "unexpected PDF tag"
ok
jpq_get_pdf "$DPM" "$JPQ_P/pdf?download=1"
grep -qi '^content-disposition: attachment; filename="Quote CI-JPQ-0001.pdf"' "$HDR_FILE" || fail "download disposition: $(cat "$HDR_FILE")"
ok
JPQ_F1=$(jpq_val "SELECT file AS v FROM joinr_quote_pdfs WHERE intake_id = $JPQ_I")
case $JPQ_F1 in joinr-quote-$JPQ_I-????????????.pdf) ok ;; *) fail "stored file name: $JPQ_F1" ;; esac
expect_eq "$(jpq_val "SELECT (size > 0 AND length(sha256) = 64 AND fetched_at IS NOT NULL AND last_error IS NULL AND quote_id = '$JPQ_Q1') AS v FROM joinr_quote_pdfs WHERE intake_id = $JPQ_I")" "1" "the row: size, sha256, fetched_at, quote_id, no error"
expect_eq "$(docker exec "$CONTAINER" sh -c "ls /data/uploads/files | grep -c '\.part$' || true" | tr -d '\r')" "0" "no .part file is left"
# The NAS backup copies top-level files whose names match FILE_NAME_RE.
docker exec "$CONTAINER" node -e 'process.exit(require("/app/lib/backup/names").FILE_NAME_RE.test(process.argv[1]) ? 0 : 1)' "$JPQ_F1" || fail "the stored name would not be backed up"
ok

# --- the request carried the key only in the header, and one parameter -----------------------------------------
jpq_fake GET /_control/requests
expect_eq "$(printf '%s' "$JPQ_OUT" | jq -r '[.requests[] | select(.path == "/api/integrations/crosscuts/quote-pdf")] | map(.query | keys | join(",")) | unique | join(";")')" "quoteId" "exactly one parameter, quoteId"
expect_eq "$(printf '%s' "$JPQ_OUT" | jq -r '[.requests[] | select(.path == "/api/integrations/crosscuts/quote-pdf")][0].query.quoteId')" "$JPQ_Q1" "for this quote's id"

# --- cache: a second view does not ask ---------------------------------------------------------------------------
echo "--- cache and the refresh guard ---"
JPQ_N=$(jpq_asks)
req GET "$JPQ_P/pdf-status" "$DPM"
expect_jq '.fetch == "fresh" and .has == true' "second view: the copy is current"
expect_eq "$(jpq_asks)" "$JPQ_N" "no new request to Joinr"
req POST "$JPQ_P/pdf/refresh" "$DPM" '{}'
expect_status 200 "Refresh within a minute"
expect_jq '.fetch == "recent" and .retryAfterSeconds > 0 and .has == true' "the minute guard holds (and the copy is still there)"
expect_eq "$(jpq_asks)" "$JPQ_N" "the guarded Refresh made no request"
jpq_unguard "$JPQ_I"
jpq_fake POST /_control/pdf '{"tag":"v2"}'
req POST "$JPQ_P/pdf/refresh" "$DPM" '{}'
expect_jq '.fetch == "ok"' "Refresh after the guard clears fetches"
jpq_get_pdf "$DPM" "$JPQ_P/pdf"
grep -q 'tag=v2' "$BODY_FILE" || fail "Refresh did not bring the new bytes"
ok
JPQ_F2=$(jpq_val "SELECT file AS v FROM joinr_quote_pdfs WHERE intake_id = $JPQ_I")
[ "$JPQ_F2" != "$JPQ_F1" ] || fail "the file was not replaced"
ok
expect_eq "$(docker exec "$CONTAINER" sh -c "test -e '/data/uploads/files/$JPQ_F1' && echo yes || echo no" | tr -d '\r')" "no" "the replaced copy's file is removed"

# --- a new quoteId (a revision) refetches on view -----------------------------------------------------------------------
echo "--- a new revision ---"
jpq_unguard "$JPQ_I"
jpq_exec "UPDATE joinr_intake SET quote_id = '$JPQ_Q2' WHERE id = $JPQ_I"
req GET "$JPQ_P/pdf-status" "$DPM"
expect_jq '.fetch == "ok" and .outdated == false' "a new quoteId is fetched on the next view"
jpq_get_pdf "$DPM" "$JPQ_P/pdf"
grep -q "quoteId=$JPQ_Q2" "$BODY_FILE" || fail "the copy is not for the new quoteId"
ok
expect_eq "$(jpq_val "SELECT quote_id AS v FROM joinr_quote_pdfs WHERE intake_id = $JPQ_I")" "$JPQ_Q2" "the row follows the revision"

# --- a failure keeps the old copy ---------------------------------------------------------------------------------------------
echo "--- failures keep the old copy ---"
JPQ_KEEP=$(jpq_val "SELECT file || '|' || fetched_at AS v FROM joinr_quote_pdfs WHERE intake_id = $JPQ_I")
for code in 500 404 401 503 redirect; do
  jpq_unguard "$JPQ_I"
  case $code in redirect) JPQ_FAILARG='"redirect"' ;; *) JPQ_FAILARG=$code ;; esac
  jpq_fake POST /_control/pdffail "{\"fail\":$JPQ_FAILARG,\"count\":1}"
  req POST "$JPQ_P/pdf/refresh" "$DPM" '{}'
  expect_status 200 "Refresh while Joinr answers $code"
  case $code in
    500) expect_jq '.fetch == "failed" and .has == true and (.error | test("HTTP 500")) and .unavailable == false' "a 500 is a failure, and says so" ;;
    404) expect_jq '.fetch == "unavailable" and .has == true and .unavailable == true and .error == "Joinr says this quote isn'"'"'t available (not won, or deleted)."' "404: not won or deleted, in plain words" ;;
    401) expect_jq '.fetch == "unavailable" and .has == true and .error == "Joinr didn'"'"'t accept the API key."' "401: the key was not accepted" ;;
    503) expect_jq '.fetch == "unavailable" and .has == true and .error == "Joinr couldn'"'"'t make the PDF just now."' "503: Joinr could not make it" ;;
    redirect) expect_jq '.fetch == "unavailable" and .has == true and .error == "Joinr doesn'"'"'t offer the PDF yet."' "a 3xx (a Joinr before version 5): doesn't offer the PDF yet" ;;
  esac
  expect_eq "$(jpq_val "SELECT file || '|' || fetched_at AS v FROM joinr_quote_pdfs WHERE intake_id = $JPQ_I")" "$JPQ_KEEP" "the old copy is untouched after $code"
  jpq_get_pdf "$DPM" "$JPQ_P/pdf"
  expect_eq "$STATUS" "200" "and is still served after $code"
done
# A redirect is never followed (the key must not go anywhere else): nothing ever asked the stand-in for /login.
jpq_fake GET /_control/requests
expect_eq "$(printf '%s' "$JPQ_OUT" | jq '[.requests[] | select(.path == "/login")] | length')" "0" "the redirect to sign-in was not followed"
# The same, as a whole Joinr (mode redirect: every answer is the redirect, whatever the key).
jpq_unguard "$JPQ_I"
jpq_fake POST /_control/pdf '{"mode":"redirect"}'
req POST "$JPQ_P/pdf/refresh" "$DPM" '{}'
expect_jq '.fetch == "unavailable" and .has == true and .error == "Joinr doesn'"'"'t offer the PDF yet."' "a Joinr that redirects every answer"
jpq_fake GET /_control/requests
expect_eq "$(printf '%s' "$JPQ_OUT" | jq '[.requests[] | select(.path == "/login")] | length')" "0" "still not followed"
jpq_fake POST /_control/pdf '{"mode":"pdf"}'

# The PDF is not byte-stable: a different tag gives different bytes, and that never makes the copy stale.
jpq_unguard "$JPQ_I"
JPQ_SHA1=$(jpq_val "SELECT sha256 AS v FROM joinr_quote_pdfs WHERE intake_id = $JPQ_I")
jpq_fake POST /_control/pdf '{"tag":"v3"}'
req POST "$JPQ_P/pdf/refresh" "$DPM" '{}'
expect_jq '.fetch == "ok"' "Refresh with different bytes"
[ "$(jpq_val "SELECT sha256 AS v FROM joinr_quote_pdfs WHERE intake_id = $JPQ_I")" != "$JPQ_SHA1" ] || fail "sha256 did not change"
ok
req GET "$JPQ_P/pdf-status" "$DPM"
expect_jq '.fetch == "fresh" and .outdated == false' "different bytes never make the copy stale (sha256 is a record, not a change signal)"
JPQ_KEEP=$(jpq_val "SELECT file || '|' || fetched_at AS v FROM joinr_quote_pdfs WHERE intake_id = $JPQ_I")

# --- a non-PDF answer and an oversize one are refused -----------------------------------------------------------------------
echo "--- not a PDF / too big ---"
for mode in html nonpdf big bigheader; do
  jpq_unguard "$JPQ_I"
  jpq_fake POST /_control/pdf "{\"mode\":\"$mode\"}"
  req POST "$JPQ_P/pdf/refresh" "$DPM" '{}'
  expect_status 200 "Refresh while Joinr sends mode $mode"
  expect_jq '.fetch == "failed" and .has == true and (.error | length > 0)' "mode $mode is refused"
  expect_eq "$(jpq_val "SELECT file AS v FROM joinr_quote_pdfs WHERE intake_id = $JPQ_I")" "${JPQ_KEEP%%|*}" "the old copy is kept after $mode"
done
expect_eq "$(docker exec "$CONTAINER" sh -c "ls /data/uploads/files | grep -c '\.part$' || true" | tr -d '\r')" "0" "no .part file is left after the refusals"
jpq_fake POST /_control/pdf '{"mode":"pdf"}'

# --- 429 honours Retry-After ----------------------------------------------------------------------------------------------------------
echo "--- 429 ---"
jpq_unguard "$JPQ_I"
jpq_fake POST /_control/pdffail '{"fail":429,"count":1,"retryAfter":120}'
req POST "$JPQ_P/pdf/refresh" "$DPM" '{}'
expect_jq '.fetch == "limited" and .retryAfterSeconds == 120 and .has == true' "a 429 reports its Retry-After"
jpq_unguard "$JPQ_I"
JPQ_N=$(jpq_asks)
req POST "$JPQ_P/pdf/refresh" "$DPM" '{}'
expect_jq '.fetch == "limited" and .retryAfterSeconds > 100 and .retryAfterSeconds <= 120' "still limited, even with the minute guard cleared"
expect_eq "$(jpq_asks)" "$JPQ_N" "no request was made during Retry-After"

# --- the key is never logged or stored --------------------------------------------------------------------------------------------------
echo "--- the key is nowhere it should not be ---"
if docker logs "$CONTAINER" 2>&1 | grep -q "$JPQ_KEY"; then fail "the API key is in the container log"; fi
ok
JPQ_HITS=$(docker exec "$CONTAINER" sh -c "grep -c '$JPQ_KEY' /data/db/photos.db /data/db/photos.db-wal 2>/dev/null | tr '\n' ' '" | tr -d '\r')
case $JPQ_HITS in *:[1-9]*) fail "the API key is in the database: $JPQ_HITS" ;; *) ok ;; esac
jpq_fake GET /_control/requests
expect_eq "$(printf '%s' "$JPQ_OUT" | jq -r '[.requests[] | select(.path == "/api/integrations/crosscuts/quote-pdf") | .auth | select(. != null and (length > 6))] | length')" "0" "the stand-in's log holds only a redacted tail of the key"

# --- tidy up ---------------------------------------------------------------------------------------------------------------------------------
echo "--- tidy up: stop the stand-in and remove the Joinr set-up ---"
jpq_fake POST /_control/stop
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
req GET /api/joinr/status "$DPM"
expect_jq '.configured == false' "Joinr is no longer set up"
