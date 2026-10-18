# M19 smoke: the whole Joinr quote (task J4, contract version 4; migration 035;
# GET /api/job-records/:id/joinr-quote; materials prefilled from the quote's lines).
# Sourced by ci/smoke.sh after the M18 suite, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok), the cookie jars ($ADMIN $SCHED $ACCT $DPM $SHOW),
# $WORK and $CONTAINER. No shebang and no `set`: the caller owns both. It does not assume a pristine
# database: it makes its own jobs and quotes (names and numbers tagged M19 / CI-M19-) and checks only
# those.
#
# A stand-in Joinr (ci/fake-joinr.js) runs inside the container on 127.0.0.1:4999 (the M18 suite has
# stopped its own by now). Crosscuts is pointed at it through files in /data/config, removed at the end.

# ============================================================================
step "m19-fullquote. the whole Joinr quote: snapshot, no false 'changed', money for jobs.value only, materials from its lines"
# ============================================================================

M19_KEY='ci-joinr-smoke-key-m19-3b8d1f6a9e2c4075'
M19_PORT=4999
M19_BASE_URL="http://127.0.0.1:$M19_PORT"
M19_OUT=""

m19_fake() { # METHOD PATH [json] -> M19_OUT
  M19_OUT=$(docker exec "$CONTAINER" node -e '
const [m, p, b] = process.argv.slice(1);
fetch("http://127.0.0.1:4999" + p, { method: m, headers: { "content-type": "application/json" }, body: b || undefined })
  .then(async (r) => { process.stdout.write(await r.text()); if (!r.ok) process.exit(1); })
  .catch((e) => { console.error(String(e)); process.exit(1); });' "$1" "$2" "${3:-}") \
    || fail "fake joinr $1 $2 failed: ${M19_OUT:0:300}"
}

m19_sql() { # read-only SQL on the live database -> rows as JSON
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const db = new D("/data/db/photos.db", { readonly: true });
process.stdout.write(JSON.stringify(db.prepare(process.argv[1]).all()));' "$1" | tr -d '\r'
}

m19_try() { # a write through the database's own constraints: prints "ok" or the error's message
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.pragma("foreign_keys = ON");
try { d.exec(process.argv[1]); process.stdout.write("ok"); }
catch (e) { process.stdout.write(String(e.message)); }
d.close();' "$1" | tr -d '\r'
}

m19_event() { # ROOT EVENT STATUS ITEM-JSON
  m19_fake POST /_control/event "$(jq -nc --arg r "$1" --arg e "$2" --arg s "$3" --argjson x "$4" \
    '{rootQuoteId:$r, quoteId:$r, event:$e, status:$s} + $x')"
}

m19_sync() {
  req POST /api/joinr/sync "$DPM" '{}'
  expect_status 200 "$1 (first call)"
  req POST /api/joinr/sync "$DPM" '{}'
  expect_status 200 "$1"
  expect_jq '.ok == true' "$1 is ok"
}

m19_intake() { # ROOT FIELD
  m19_sql "SELECT $2 AS v FROM joinr_intake WHERE root_quote_id = '$1'" | jq -r '.[0].v // "null"'
}

# One snapshot column for a quote's intake record ("none" when it has no snapshot row).
m19_snap() { # ROOT EXPR
  m19_sql "SELECT $2 AS v FROM joinr_quote_snapshots s JOIN joinr_intake i ON i.id = s.intake_id WHERE i.root_quote_id = '$1'" | jq -r 'if length == 0 then "none" else (.[0].v // "null") end'
}

M19_Q1=c1900000-0000-4000-8000-000000000001
M19_Q2=c1900000-0000-4000-8000-000000000002
M19_Q3=c1900000-0000-4000-8000-000000000003
M19_Q4=c1900000-0000-4000-8000-000000000004
M19_Q5=c1900000-0000-4000-8000-000000000005

# --- the stand-in Joinr ----------------------------------------------------------------------------
echo "--- start the stand-in Joinr inside the container ---"
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
if docker exec "$CONTAINER" node -e 'fetch("http://127.0.0.1:4999/_control/requests").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' 2>/dev/null; then
  m19_fake POST /_control/stop
  sleep 1
fi
docker cp "$(dirname "$0")/fake-joinr.js" "$CONTAINER":/tmp/fake-joinr.js
docker exec -d "$CONTAINER" node /tmp/fake-joinr.js "$M19_PORT" "$M19_KEY"
m19_up=""
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" node -e 'fetch("http://127.0.0.1:4999/_control/requests").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' 2>/dev/null; then
    m19_up=1
    break
  fi
  sleep 0.5
done
[ -n "$m19_up" ] || fail "the stand-in Joinr did not start"
ok
docker exec "$CONTAINER" sh -c "printf '%s\n' '$M19_BASE_URL' > /data/config/joinr-base-url"
docker exec "$CONTAINER" sh -c "printf '%s\n' '$M19_KEY' > /data/config/joinr-api-key"
m19_try "UPDATE integration_sync SET cursor = NULL WHERE name = 'joinr'" >/dev/null
m19_sync "the first sync stores a position"

# --- migration 035 ---------------------------------------------------------------------------------
echo "--- the snapshot table ---"
M19_COLS=$(m19_sql "SELECT group_concat(name) AS v FROM pragma_table_info('joinr_quote_snapshots')" | jq -r '.[0].v')
for c in intake_id quote_id quote_json rate_card received_at; do
  case ",$M19_COLS," in *",$c,"*) ok ;; *) fail "joinr_quote_snapshots has no column $c: $M19_COLS" ;; esac
done
expect_eq "$(m19_sql "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 35" | jq -r '.[0].n')" "1" "migration 035 is recorded"

# --- an older Joinr: no quote at all -> a record with no snapshot ------------------------------------
echo "--- a quote with no 'quote' field (an older Joinr) ---"
m19_event "$M19_Q4" won won '{"quoteNumber":"CI-M19-0004","siteAddress":"4 Old Joinr Rd","clientName":"M19 Client Four","wonAt":"2099-07-04T01:00:00Z","valueIncGstCents":900000,"spec":{"sheetCount":9,"twoPac":null,"benchtop":null,"jobType":"Vanity"}}'
m19_sync "sync the quote without a quote"
expect_eq "$(m19_intake "$M19_Q4" state)" "accepted" "it was accepted by itself, as before"
expect_eq "$(m19_snap "$M19_Q4" "s.quote_id")" "none" "no snapshot row"
M19_I4=$(m19_intake "$M19_Q4" id)
M19_J4=$(m19_intake "$M19_Q4" job_id)
req GET "/api/job-records/$M19_J4/joinr-quote" "$DPM"
expect_status 200 "GET the job's quote"
expect_jq '.status == "none" and .quoteNumber == "CI-M19-0004"' "status none"
req GET "/api/job-records/$M19_J4/materials" "$DPM"
expect_jq '[.lines[] | select(.name == "Board sheets" and .qty == 9)] | length == 1' "its materials use the thin mapping: Board sheets 9"

echo "--- the table's own constraints (on the record that has no snapshot) ---"
M19_INS="INSERT INTO joinr_quote_snapshots (intake_id, quote_id, quote_json, rate_card, received_at)"
M19_NOW="'2099-01-01T00:00:00Z'"
M19_R=$(m19_try "$M19_INS VALUES ($M19_I4, 'q', '{not json', 'snapshot', $M19_NOW)")
case $M19_R in *CHECK*) ok ;; *) fail "quote_json that is not JSON: expected a CHECK failure, got: $M19_R" ;; esac
M19_R=$(m19_try "$M19_INS VALUES ($M19_I4, 'q', '{}', 'weekly', $M19_NOW)")
case $M19_R in *CHECK*) ok ;; *) fail "rate_card 'weekly': expected a CHECK failure, got: $M19_R" ;; esac
M19_R=$(m19_try "$M19_INS VALUES ($M19_I4, 'q', NULL, 'live', $M19_NOW)")
case $M19_R in *CHECK*) ok ;; *) fail "a rate card with no quote: expected a CHECK failure, got: $M19_R" ;; esac
M19_R=$(m19_try "$M19_INS VALUES ($M19_I4, '', '{}', 'live', $M19_NOW)")
case $M19_R in *CHECK*) ok ;; *) fail "an empty quote_id: expected a CHECK failure, got: $M19_R" ;; esac
M19_R=$(m19_try "$M19_INS VALUES ($M19_I4, 'q', '{}', 'live', '')")
case $M19_R in *CHECK*) ok ;; *) fail "an empty received_at: expected a CHECK failure, got: $M19_R" ;; esac
M19_R=$(m19_try "$M19_INS VALUES ($M19_I4, 'q', '\"' || hex(zeroblob(800000)) || '\"', 'live', $M19_NOW)")
case $M19_R in *CHECK*) ok ;; *) fail "a quote over 1.5 MB: expected a CHECK failure, got: $M19_R" ;; esac
M19_R=$(m19_try "$M19_INS VALUES (999999, 'q', '{}', 'live', $M19_NOW)")
case $M19_R in *FOREIGN*) ok ;; *) fail "an intake record that does not exist: expected a FOREIGN KEY failure, got: $M19_R" ;; esac
expect_eq "$(m19_try "$M19_INS VALUES ($M19_I4, 'q', NULL, NULL, $M19_NOW)")" "ok" "a null-quote row inserts"
M19_R=$(m19_try "$M19_INS VALUES ($M19_I4, 'q2', NULL, NULL, $M19_NOW)")
case $M19_R in *UNIQUE*|*PRIMARY*) ok ;; *) fail "two snapshots for one record: expected a UNIQUE failure, got: $M19_R" ;; esac
m19_try "DELETE FROM joinr_quote_snapshots WHERE intake_id = $M19_I4" >/dev/null
expect_eq "$(m19_snap "$M19_Q4" "s.quote_id")" "none" "the test row is gone"

# --- a won quote with its whole quote ---------------------------------------------------------------
echo "--- a won quote with the whole quote: the snapshot, the job and its materials ---"
M19_Q1_BASE='{"quoteNumber":"CI-M19-0001","siteAddress":"19 Timber Lane, Sydney","clientName":"M19 Client One","wonAt":"2099-07-02T01:00:00Z","spec":{"sheetCount":21,"twoPac":true,"benchtop":"laminate","jobType":"Kitchen"},"raw":{"doorsPanels":["2-pac shaker doors"],"benchtops":["Laminate"],"jobTypes":["Kitchen"]}}'
M19_Q1_ITEM=$(printf '%s' "$M19_Q1_BASE" | jq -c '. + {_quote: true}')
m19_event "$M19_Q1" won won "$M19_Q1_ITEM"
m19_sync "sync the won quote with its quote"
expect_eq "$(m19_intake "$M19_Q1" state)" "accepted" "accepted by itself"
M19_J1=$(m19_intake "$M19_Q1" job_id)
M19_I1=$(m19_intake "$M19_Q1" id)
M19_VALUE=$(m19_intake "$M19_Q1" "json_extract(payload, '\$.valueIncGstCents')")
expect_eq "$(m19_snap "$M19_Q1" "s.rate_card")" "snapshot" "the snapshot is stored, priced at the frozen card"
expect_eq "$(m19_snap "$M19_Q1" "json_extract(s.quote_json, '\$.rooms[0].name')")" "Kitchen" "its first room is the Kitchen"
expect_eq "$(m19_snap "$M19_Q1" "s.quote_id")" "$M19_Q1" "it names the revision it was priced for"
expect_eq "$(m19_intake "$M19_Q1" "instr(payload, 'rooms') + instr(payload, 'costOfGoods') + instr(payload, '\"quote\"')")" "0" "the quote is NOT in the stored payload (so it can never raise 'changed')"
expect_eq "$(m19_intake "$M19_Q1" changed)" "0" "not flagged changed"

req GET "/api/job-records/$M19_J1/materials" "$DPM"
expect_status 200 "GET the materials"
expect_jq '(.lines | length) == 15' "15 lines: 11 from the quote's materials, 4 text lines"
expect_jq '[.lines[] | select(.name == "Board sheets")] | length == 0' "no thin 'Board sheets' line: the quote's board lines replace it"
expect_jq '.lines[] | select(.name == "White Melamine 18mm" and (.notes == "Kitchen")) | .qty == 12 and .unit == "sheets" and .section == "boards" and .source == "joinr"' "a board line: Kitchen, 12 sheets, in boards"
expect_jq '.lines[] | select(.name == "White Melamine 18mm" and (.notes == "Laundry")) | .qty == 5' "the same board in the Laundry is its own line"
expect_jq '.lines[] | select(.name == "Laminate benchtop 33mm") | .qty == 4.2 and .unit == "m" and .section == "benchtop"' "a benchtop line"
expect_jq '.lines[] | select(.name == "Tandembox 450 Grey") | .qty == 6 and .section == "drawers"' "a drawer line"
expect_jq '.lines[] | select(.name == "Inner drawer 450") | .section == "drawers" and .notes == "Kitchen (inner drawers)"' "an inner drawer line, noted"
expect_jq '.lines[] | select(.name == "Finger pull profile") | .qty == 14 and .section == "handles"' "a handles line"
expect_jq '.lines[] | select(.name == "Soft-close hinge" and (.notes == "Kitchen")) | .qty == 28 and .section == "hardware"' "a hardware line"
expect_jq '.lines[] | select(.name == "Bin pull-out 450") | .section == "room_extras"' "a room extras line"
expect_jq '.lines[] | select(.name == "Pantry pull-out") | .section == "other" and .qty == 1' "an additional item lands in other"
expect_jq '[.lines[] | select(.name == "Trade discount")] | length == 0' "a credit (negative price) is not a material"
expect_jq '[.lines[] | select(.name == "Design and drafting" or .name == "Assembly" or .name == "Install" or .name == "Site trips")] | length == 0' "NO labour lines (office, factory, site, travel)"
expect_jq '[.lines[] | select(.name == "2-pac shaker doors" or .name == "Two-pac finish" or .name == "Benchtop: laminate")] | length == 3' "the text lines the quote does not carry stay"
expect_eq "$(m19_sql "SELECT COUNT(*) AS n FROM job_materials WHERE job_id = $M19_J1 AND source = 'joinr' AND joinr_key LIKE 'q:%'" | jq -r '.[0].n')" "11" "the quote's lines carry the q: keys"

# --- the API: money for jobs.value, none for the rest ----------------------------------------------------
echo "--- GET /api/job-records/:id/joinr-quote ---"
req GET "/api/job-records/$M19_J1/joinr-quote" "$DPM"
expect_status 200 "design/PM (jobs.value)"
expect_jq '.status == "ok" and .money == true and .quoteNumber == "CI-M19-0001" and (.joinrUrl | startswith("http"))' "ok, with money, the quote number and the Joinr link"
expect_jq '(.quote.rooms | length) == 2 and .quote.rooms[0].name == "Kitchen" and .quote.pricedAt == "snapshot"' "two rooms, priced at the frozen card"
expect_jq '.quote.totals.incGstCents == '"$M19_VALUE"' and .quote.totals.marginCents > 0 and .quote.totals.costOfGoodsCents > 0' "the total equals Joinr's value; margin and cost of goods are there"
expect_jq '.quote.rooms[0].sections[] | select(.title == "Board & Edge") | .totalCents > 0 and .lines[0].unitRateCents == 8200 and .lines[0].lineTotalCents == 98400' "a section total and a line's rate and total"
expect_jq '.quote.tier.label == "Retail" and .quote.gst.rate == 0.1 and (.quote.warnings | length) == 1 and .quote.rooms[1].totals.incGstCents > 0' "tier, GST, warnings and room totals"
expect_jq '.quote.labour.factory.typed == 32 and .quote.labour.factory.hours == 16 and .quote.labour.factory.costCents > 0 and .quote.labour.office.hours == 8' "labour hours and cost"
expect_jq '(.quote.options | length) == 1 and .quote.options[0].priceIncGstCents == 480000 and (.quote.notes | startswith("Client wants"))' "options and notes"
req GET "/api/job-records/$M19_J1/joinr-quote" "$ACCT"
expect_status 200 "accounts (jobs.value)"
expect_jq '.money == true and .quote.totals.incGstCents == '"$M19_VALUE" "accounts sees the money too"

req GET "/api/job-records/$M19_J1/joinr-quote" "$SCHED"
expect_status 200 "scheduling (jobs.view only)"
expect_jq '.status == "ok" and .money == false' "ok, without money"
expect_jq '(.quote.rooms | length) == 2 and .quote.rooms[0].sections[0].lines[0].name != null and .quote.rooms[0].sections[0].lines[0].qty != null' "the rooms and their lines (item, qty) are there"
expect_jq '.quote.labour.factory.typed == 32 and .quote.labour.office.hours == 8 and (.quote.options | length) == 1 and (.quote.notes | startswith("Client wants"))' "labour hours, options and notes are there"
if printf '%s' "$BODY" | grep -Eqi 'cents|markup|"tier"|"gst"|margin|warning|totals|cogs|overhead|"adjust"|rate'; then
  fail "scheduling's answer carries a money-looking field: ${BODY:0:600}"
fi
ok
expect_jq '.quote.rooms[0].sections[0].lines[0] | keys == ["name","qty","unit"]' "a line has only its item, qty and unit for scheduling"
req GET "/api/job-records/$M19_J1/joinr-quote" "$SHOW"
expect_status 403 "showroom cannot read it"
req GET "/api/job-records/$M19_J1/joinr-quote" ""
expect_status 401 "logged out is 401"
req GET "/api/job-records/999999/joinr-quote" "$DPM"
expect_status 404 "a job that does not exist"
req POST /api/job-records "$DPM" '{"name":"M19 plain job"}'
expect_status 201 "create a job with no Joinr quote"
M19_JP=$(jqr '.id')
req GET "/api/job-records/$M19_JP/joinr-quote" "$DPM"
expect_jq '.status == "not-linked"' "a job not tied to Joinr: not-linked"
req GET "/api/job-records/$M19_J1/joinr-quote?x=1" "$DPM"
expect_status 200 "extra query parameters are ignored"
req GET "/api/job-records/$M19_J1" "$SCHED"
if printf '%s' "$BODY" | grep -q 'valueCents'; then fail "the job record leaks valueCents to scheduling"; fi
ok

# --- a re-priced quote alone is not a change -----------------------------------------------------------------
echo "--- Joinr sends the same quote re-priced (live card, 15% GST) but no edit ---"
M19_RE_ITEM=$(printf '%s' "$M19_Q1_BASE" | jq -c --argjson v "$M19_VALUE" '. + {valueIncGstCents: $v, _quote: {pricedAt: "live", gstRate: 0.15}}')
m19_event "$M19_Q1" changed won "$M19_RE_ITEM"
m19_sync "sync the re-priced item"
expect_eq "$(m19_intake "$M19_Q1" changed)" "0" "NOT flagged Changed in Joinr"
expect_eq "$(m19_snap "$M19_Q1" "s.rate_card")" "snapshot" "the snapshot is as it was (still the frozen card)"
expect_eq "$(m19_snap "$M19_Q1" "json_extract(s.quote_json, '\$.gst.rate')")" "0.1" "with the old GST rate"
expect_eq "$(m19_sql "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'joinr.changed' AND CAST(entity_id AS TEXT) = '$M19_I1'" | jq -r '.[0].n')" "0" "no 'Changed in Joinr' alert for it"

# --- a real change updates the snapshot, and Update materials uses it ----------------------------------------
echo "--- Joinr changes the quote for real: flagged, snapshot updated, materials updated on request ---"
M19_CH_ITEM=$(printf '%s' "$M19_Q1_BASE" | jq -c '.spec.sheetCount = 27 | .valueIncGstCents = 1500000 | ._quote = {boards: 20, extraLine: true}')
m19_event "$M19_Q1" changed won "$M19_CH_ITEM"
m19_sync "sync the real change"
expect_eq "$(m19_intake "$M19_Q1" changed)" "1" "flagged Changed in Joinr"
expect_eq "$(m19_snap "$M19_Q1" "json_extract(s.quote_json, '\$.rooms[0].lines[1].qty')")" "20" "the snapshot took the new board quantity (20 sheets)"
expect_eq "$(m19_snap "$M19_Q1" "json_extract(s.quote_json, '\$.rooms[0].lines[7].name')")" "Bar handle 160mm" "and the new handle line"
req GET "/api/job-records/$M19_J1/materials" "$DPM"
expect_jq '(.lines | length) == 15 and .joinr.changed == true' "the list was not rewritten by itself"
expect_jq '.lines[] | select(.name == "White Melamine 18mm" and (.notes == "Kitchen")) | .qty == 12' "still 12 sheets until Update"
req POST "/api/job-records/$M19_J1/materials/update-from-joinr" "$DPM" '{}'
expect_status 200 "Update materials from Joinr"
expect_jq '.summary.added == 1 and .summary.updated == 1 and .summary.gone == 0' "1 added (the handle), 1 updated (the boards), none gone"
expect_jq '.lines[] | select(.name == "White Melamine 18mm" and (.notes == "Kitchen")) | .qty == 20' "the Kitchen boards are 20 sheets now"
expect_jq '.lines[] | select(.name == "Bar handle 160mm") | .qty == 6 and .section == "handles" and .source == "joinr"' "the new handle line is there"
expect_jq '[.lines[] | select(.name == "Assembly" or .name == "Install" or .name == "Design and drafting")] | length == 0' "still no labour lines"
req POST "/api/job-records/$M19_J1/materials/update-from-joinr" "$DPM" '{}'
expect_jq '.summary.added == 0 and .summary.updated == 0 and .summary.gone == 0' "a second Update finds nothing to do: the keys match"
req GET "/api/job-records/$M19_J1/joinr-quote" "$DPM"
expect_jq '.quote.rooms[0].sections[] | select(.title == "Board & Edge") | .lines[0].qty == 20' "the page's API shows the new snapshot"

# An item that sends the quote as null on a real change replaces the snapshot with 'too large'.
# --- a malformed quote is dropped; the item and the cursor are fine -------------------------------------------------
echo "--- a malformed quote: dropped, the item kept ---"
m19_event "$M19_Q2" won won '{"quoteNumber":"CI-M19-0002","siteAddress":"2 Bad Quote St","clientName":"M19 Client Two","valueIncGstCents":700000,"spec":{"sheetCount":10,"twoPac":null,"benchtop":null,"jobType":"Wardrobe"},"quote":{"rooms":"not a list","totals":7}}'
m19_event "$M19_Q5" won won '{"quoteNumber":"CI-M19-0005","siteAddress":"5 String Quote St","clientName":"M19 Client Five","valueIncGstCents":710000,"spec":{"sheetCount":11,"twoPac":null,"benchtop":null,"jobType":"Wardrobe"},"quote":"nonsense"}'
m19_sync "sync the malformed quotes"
expect_eq "$(m19_intake "$M19_Q2" state)" "accepted" "the item with a malformed quote was accepted"
expect_eq "$(m19_intake "$M19_Q5" state)" "accepted" "so was the one whose quote is a string"
expect_eq "$(m19_snap "$M19_Q2" "s.quote_id")" "none" "no snapshot for the malformed quote"
expect_eq "$(m19_snap "$M19_Q5" "s.quote_id")" "none" "none for the string either"
M19_J2=$(m19_intake "$M19_Q2" job_id)
req GET "/api/job-records/$M19_J2/materials" "$DPM"
expect_jq '[.lines[] | select(.name == "Board sheets" and .qty == 10)] | length == 1' "its materials fall back to the thin mapping"
req GET "/api/job-records/$M19_J2/joinr-quote" "$DPM"
expect_jq '.status == "none"' "the API says none"
req GET /api/joinr/status "$DPM"
expect_jq '.lastError == null' "the sync has no error: the cursor was not stalled"
# A later good item still flows (the cursor moved past the malformed ones).
m19_event "$M19_Q3" won won '{"quoteNumber":"CI-M19-0003","siteAddress":"3 After St","clientName":"M19 Client Three","valueIncGstCents":800000,"spec":{"sheetCount":8,"twoPac":null,"benchtop":null,"jobType":"Vanity"},"quote":null}'
m19_sync "sync an item after them"
expect_eq "$(m19_intake "$M19_Q3" state)" "accepted" "the next item was accepted"

# --- a null quote (too large, or Joinr could not price it) ----------------------------------------------------
echo "--- quote: null ---"
expect_eq "$(m19_snap "$M19_Q3" "s.quote_json IS NULL")" "1" "a snapshot row with no quote"
expect_eq "$(m19_snap "$M19_Q3" "s.rate_card IS NULL")" "1" "and no rate card"
M19_J3=$(m19_intake "$M19_Q3" job_id)
for pair in "DPM:$DPM" "SCHED:$SCHED"; do
  who=${pair%%:*}; jar=${pair#*:}
  req GET "/api/job-records/$M19_J3/joinr-quote" "$jar"
  expect_status 200 "$who GET a null-quote job"
  expect_jq '.status == "too-large" and (.joinrUrl | startswith("http")) and .quoteNumber == "CI-M19-0003" and (has("quote") | not)' "$who: too-large, with the Joinr link and no quote"
done
req GET "/api/job-records/$M19_J3/materials" "$DPM"
expect_jq '[.lines[] | select(.name == "Board sheets" and .qty == 8)] | length == 1' "its materials use the thin mapping"

# --- a quote over 1.5 MB is dropped --------------------------------------------------------------------------------------------
echo "--- a quote over 1.5 MB ---"
M19_Q6=c1900000-0000-4000-8000-000000000006
m19_event "$M19_Q6" won won '{"quoteNumber":"CI-M19-0006","siteAddress":"6 Big Quote St","clientName":"M19 Client Six","valueIncGstCents":810000,"spec":{"sheetCount":6,"twoPac":null,"benchtop":null,"jobType":"Kitchen"},"_quote":{"padRooms":6}}'
m19_sync "sync the very large quote"
expect_eq "$(m19_intake "$M19_Q6" state)" "accepted" "the item with the over-size quote was accepted"
expect_eq "$(m19_snap "$M19_Q6" "s.quote_id")" "none" "its quote was dropped (nothing stored)"
req GET /api/joinr/status "$DPM"
expect_jq '.lastError == null' "no sync error"

# --- Joinr starts sending the quote for a record that had none -------------------------------------------------------------------
echo "--- a record that had no quote gets one, with no change ---"
M19_Q4_BASE='{"quoteNumber":"CI-M19-0004","siteAddress":"4 Old Joinr Rd","clientName":"M19 Client Four","wonAt":"2099-07-04T01:00:00Z","valueIncGstCents":900000,"spec":{"sheetCount":9,"twoPac":null,"benchtop":null,"jobType":"Vanity"}}'
m19_event "$M19_Q4" changed won "$(printf '%s' "$M19_Q4_BASE" | jq -c '. + {_quote: {boards: 3}}')"
m19_sync "sync the first quote for the old record"
expect_eq "$(m19_intake "$M19_Q4" changed)" "0" "not a change"
expect_eq "$(m19_snap "$M19_Q4" "s.rate_card")" "snapshot" "but the snapshot is stored now"
req GET "/api/job-records/$M19_J4/joinr-quote" "$DPM"
expect_jq '.status == "ok"' "and the page API has it"

# --- a real change to null replaces the snapshot ------------------------------------------------------------------------------------
echo "--- a real change that arrives with quote: null ---"
m19_event "$M19_Q4" changed won "$(printf '%s' "$M19_Q4_BASE" | jq -c '.spec.sheetCount = 12 | .quote = null')"
m19_sync "sync the change with a null quote"
expect_eq "$(m19_intake "$M19_Q4" changed)" "1" "flagged"
expect_eq "$(m19_snap "$M19_Q4" "s.quote_json IS NULL")" "1" "the snapshot is now 'no quote' (too large)"
req GET "/api/job-records/$M19_J4/joinr-quote" "$DPM"
expect_jq '.status == "too-large"' "the page API says so"
# A change with a malformed quote leaves the snapshot as it was.
m19_event "$M19_Q4" changed won "$(printf '%s' "$M19_Q4_BASE" | jq -c '.spec.sheetCount = 13 | .quote = {rooms: 5}')"
m19_sync "sync the change with a malformed quote"
expect_eq "$(m19_snap "$M19_Q4" "s.quote_json IS NULL")" "1" "a malformed quote does not touch the snapshot"

# --- tidy up ----------------------------------------------------------------------------------------------------------------------------------------------
echo "--- tidy up: stop the stand-in and remove the Joinr set-up ---"
m19_fake POST /_control/stop
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
req GET /api/joinr/status "$DPM"
expect_status 200 "status after the tidy-up"
expect_jq '.configured == false' "Joinr is no longer set up"
