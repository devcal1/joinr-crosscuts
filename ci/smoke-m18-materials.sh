# M18 smoke: a job's Materials list (migration 034, docs/plans/materials-contracts.md).
# Sourced by ci/smoke.sh after the M17 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, create_user, login, own_password, new_jar, fail, ok), the
# cookie jars ($ADMIN $SCHED $ACCT $DPM $SHOW), $WORK and $CONTAINER. No shebang and no `set`: the
# caller owns both. It does not assume a pristine database: it makes its own jobs and quotes (names
# and numbers tagged M18 / CI-M18-) and checks only those.
#
# A stand-in Joinr (ci/fake-joinr.js) runs inside the container on 127.0.0.1:4999 (the M6 and M16
# suites' use of that port has ended by now; the M11 drawers suite uses 4996). Crosscuts is pointed at
# it through files in /data/config, which are removed at the end.

# ============================================================================
step "m18-materials. a job's Materials list: prefill from Joinr, overrides, re-sync, order lines"
# ============================================================================

M18_KEY='ci-joinr-smoke-key-m18-7f3a9c2e5b1d4a68'
M18_PORT=4999
M18_BASE_URL="http://127.0.0.1:$M18_PORT"
M18_OUT=""

m18_fake() { # METHOD PATH [json] -> M18_OUT
  M18_OUT=$(docker exec "$CONTAINER" node -e '
const [m, p, b] = process.argv.slice(1);
fetch("http://127.0.0.1:4999" + p, { method: m, headers: { "content-type": "application/json" }, body: b || undefined })
  .then(async (r) => { process.stdout.write(await r.text()); if (!r.ok) process.exit(1); })
  .catch((e) => { console.error(String(e)); process.exit(1); });' "$1" "$2" "${3:-}") \
    || fail "fake joinr $1 $2 failed: ${M18_OUT:0:300}"
}

# Read-only SQL on the live database -> rows as JSON.
m18_sql() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const db = new D("/data/db/photos.db", { readonly: true });
process.stdout.write(JSON.stringify(db.prepare(process.argv[1]).all()));' "$1" | tr -d '\r'
}

# A write through the database's own constraints: prints "ok" or the error's message.
m18_try() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.pragma("foreign_keys = ON");
try { d.exec(process.argv[1]); process.stdout.write("ok"); }
catch (e) { process.stdout.write(String(e.message)); }
d.close();' "$1" | tr -d '\r'
}

m18_event() { # ROOT EVENT STATUS ITEM-JSON
  m18_fake POST /_control/event "$(jq -nc --arg r "$1" --arg e "$2" --arg s "$3" --argjson x "$4" \
    '{rootQuoteId:$r, quoteId:$r, event:$e, status:$s} + $x')"
}

# POST /api/joinr/sync twice (a timer run in flight may answer the first call), as the M6 suite does.
m18_sync() {
  req POST /api/joinr/sync "$DPM" '{}'
  expect_status 200 "$1 (first call)"
  req POST /api/joinr/sync "$DPM" '{}'
  expect_status 200 "$1"
  expect_jq '.ok == true' "$1 is ok"
}

m18_intake() { # ROOT FIELD
  m18_sql "SELECT $2 AS v FROM joinr_intake WHERE root_quote_id = '$1'" | jq -r '.[0].v // "null"'
}

# How many audit rows of ACTION exist for the entity.
m18_audits() { # ACTION ENTITY_ID
  req GET "/api/audit?action=$1&entityId=$2&limit=1" "$ADMIN"
  expect_status 200 "GET /api/audit?action=$1"
  jqr '.total'
}

M18_Q1=c1800000-0000-4000-8000-000000000001
M18_Q2=c1800000-0000-4000-8000-000000000002
M18_Q3=c1800000-0000-4000-8000-000000000003

# --- the schema (migration 034) ------------------------------------------------------------
req POST /api/job-records "$DPM" '{"name":"M18 schema job"}'
expect_status 201 "create the schema job"
M18_SJ=$(jqr '.id')
M18_INS="INSERT INTO job_materials (job_id, section, name, source"
expect_eq "$(m18_try "$M18_INS) VALUES ($M18_SJ, 'boards', 'Sheets', 'manual')")" "ok" "a typed line inserts"
M18_COLS=$(m18_sql "SELECT group_concat(name) AS v FROM pragma_table_info('job_materials')" | jq -r '.[0].v')
for c in id job_id position section name qty unit notes source joinr_key overridden gone_from_joinr removed_at order_id created_at updated_at created_by updated_by; do
  case ",$M18_COLS," in *",$c,"*) ok ;; *) fail "job_materials has no column $c: $M18_COLS" ;; esac
done
M18_R=$(m18_try "$M18_INS, qty) VALUES ($M18_SJ, 'boards', 'Bad', 'manual', -1)")
case $M18_R in *CHECK*) ok ;; *) fail "negative qty: expected a CHECK failure, got: $M18_R" ;; esac
M18_R=$(m18_try "$M18_INS) VALUES ($M18_SJ, 'boards', '   ', 'manual')")
case $M18_R in *CHECK*) ok ;; *) fail "blank name: expected a CHECK failure, got: $M18_R" ;; esac
M18_R=$(m18_try "$M18_INS) VALUES ($M18_SJ, 'boards', 'Bad', 'typed')")
case $M18_R in *CHECK*) ok ;; *) fail "bad source: expected a CHECK failure, got: $M18_R" ;; esac
M18_R=$(m18_try "$M18_INS) VALUES ($M18_SJ, 'boards', 'Bad', 'joinr')")
case $M18_R in *CHECK*) ok ;; *) fail "a joinr line without a key: expected a CHECK failure, got: $M18_R" ;; esac
M18_R=$(m18_try "$M18_INS, joinr_key) VALUES ($M18_SJ, 'boards', 'Bad', 'manual', 'k')")
case $M18_R in *CHECK*) ok ;; *) fail "a manual line with a key: expected a CHECK failure, got: $M18_R" ;; esac
M18_R=$(m18_try "$M18_INS, overridden) VALUES ($M18_SJ, 'boards', 'Bad', 'manual', 2)")
case $M18_R in *CHECK*) ok ;; *) fail "overridden 2: expected a CHECK failure, got: $M18_R" ;; esac
M18_R=$(m18_try "$M18_INS, gone_from_joinr) VALUES ($M18_SJ, 'boards', 'Bad', 'manual', 2)")
case $M18_R in *CHECK*) ok ;; *) fail "gone_from_joinr 2: expected a CHECK failure, got: $M18_R" ;; esac
M18_LONG=$(printf 'x%.0s' $(seq 1 1001))
M18_R=$(m18_try "$M18_INS, notes) VALUES ($M18_SJ, 'boards', 'Bad', 'manual', '$M18_LONG')")
case $M18_R in *CHECK*) ok ;; *) fail "notes of 1001 characters: expected a CHECK failure, got: $M18_R" ;; esac
M18_R=$(m18_try "$M18_INS, unit) VALUES ($M18_SJ, 'boards', 'Bad', 'manual', '$(printf 'u%.0s' $(seq 1 31))')")
case $M18_R in *CHECK*) ok ;; *) fail "unit of 31 characters: expected a CHECK failure, got: $M18_R" ;; esac
M18_R=$(m18_try "$M18_INS) VALUES ($M18_SJ, '$(printf 's%.0s' $(seq 1 41))', 'Bad', 'manual')")
case $M18_R in *CHECK*) ok ;; *) fail "section of 41 characters: expected a CHECK failure, got: $M18_R" ;; esac
M18_R=$(m18_try "$M18_INS) VALUES (999999, 'boards', 'Orphan', 'manual')")
case $M18_R in *FOREIGN*) ok ;; *) fail "a line for a job that does not exist: expected a FOREIGN KEY failure, got: $M18_R" ;; esac
M18_R=$(m18_try "$M18_INS, order_id) VALUES ($M18_SJ, 'boards', 'Bad', 'manual', 999999)")
case $M18_R in *FOREIGN*) ok ;; *) fail "an order that does not exist: expected a FOREIGN KEY failure, got: $M18_R" ;; esac
expect_eq "$(m18_try "$M18_INS, joinr_key) VALUES ($M18_SJ, 'boards', 'K1', 'joinr', 'dup')")" "ok" "a Joinr line with a key inserts"
M18_R=$(m18_try "$M18_INS, joinr_key) VALUES ($M18_SJ, 'boards', 'K1 again', 'joinr', 'dup')")
case $M18_R in *UNIQUE*) ok ;; *) fail "the same key twice on a job: expected a UNIQUE failure, got: $M18_R" ;; esac
m18_try "DELETE FROM job_materials WHERE job_id = $M18_SJ" >/dev/null

# --- the stand-in Joinr -----------------------------------------------------------------------
echo "--- start the stand-in Joinr inside the container ---"
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
# Port 4999 must be free: a stand-in left by an earlier suite is stopped first.
if docker exec "$CONTAINER" node -e 'fetch("http://127.0.0.1:4999/_control/requests").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' 2>/dev/null; then
  m18_fake POST /_control/stop
  sleep 1
fi
docker cp "$(dirname "$0")/fake-joinr.js" "$CONTAINER":/tmp/fake-joinr.js
docker exec -d "$CONTAINER" node /tmp/fake-joinr.js "$M18_PORT" "$M18_KEY"
m18_up=""
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" node -e 'fetch("http://127.0.0.1:4999/_control/requests").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' 2>/dev/null; then
    m18_up=1
    break
  fi
  sleep 0.5
done
[ -n "$m18_up" ] || fail "the stand-in Joinr did not start"
ok
docker exec "$CONTAINER" sh -c "printf '%s\n' '$M18_BASE_URL' > /data/config/joinr-base-url"
docker exec "$CONTAINER" sh -c "printf '%s\n' '$M18_KEY' > /data/config/joinr-api-key"
# Start from now: an earlier suite's sync position does not belong to this stand-in.
m18_try "UPDATE integration_sync SET cursor = NULL WHERE name = 'joinr'" >/dev/null
m18_sync "the first sync stores a position"

# --- a won quote: the job and its materials list are made by themselves --------------------------
echo "--- a won quote becomes a job with a Materials list prefilled from the quote ---"
M18_Q1_ITEM='{"quoteNumber":"CI-M18-0001","siteAddress":"18 Timber Lane, Sydney","clientName":"M18 Client One","wonAt":"2099-06-02T01:00:00Z","valueIncGstCents":2000000,"spec":{"sheetCount":24,"twoPac":true,"benchtop":"stone","jobType":"Kitchen"},"raw":{"doorsPanels":["2pac (S4)","Shaker doors"],"benchtops":["Caesarstone Snow"],"jobTypes":["Kitchen"]},"drawers":[{"section":"drawers","name":"CI M18 Drawer Box","qty":6},{"section":"innerDrawers","name":"CI M18 Cutlery Tray","qty":2}]}'
m18_event "$M18_Q1" won won "$M18_Q1_ITEM"
m18_sync "sync the won quote"
expect_eq "$(m18_intake "$M18_Q1" state)" "accepted" "the quote was accepted by itself"
M18_JA=$(m18_intake "$M18_Q1" job_id)
M18_IA=$(m18_intake "$M18_Q1" id)
req GET "/api/job-records/$M18_JA/materials" "$DPM"
expect_status 200 "dpm GET the job's materials"
expect_jq '(.lines | length) == 8' "eight lines from the quote (sheets, 2 doors, 2 benchtop, two-pac, 2 drawers)"
expect_jq '[.lines[] | select(.source == "joinr" and .origin == "joinr" and .overridden == false and .ordered == false and .goneFromJoinr == false)] | length == 8' "all of them JOINR, untouched, not ordered"
expect_jq '.lines[] | select(.name == "Board sheets") | .qty == 24 and .unit == "sheets" and .section == "boards"' "Board sheets: 24 sheets in boards"
expect_jq '[.lines[] | select(.section == "doors") | .name] | sort == ["2pac (S4)", "Shaker doors"]' "the doors/panels text lines, in the doors section"
expect_jq '.lines[] | select(.name == "Shaker doors") | .qty == null' "a text line has no quantity"
expect_jq '[.lines[] | select(.section == "benchtop") | .name] | sort == ["Benchtop: stone", "Caesarstone Snow"]' "the benchtop kind and the typed benchtop text"
expect_jq '.lines[] | select(.name == "Two-pac finish") | .section == "paint"' "the two-pac finish line"
expect_jq '.lines[] | select(.name == "CI M18 Drawer Box") | .qty == 6 and .unit == "each" and .section == "drawers"' "a drawer line with its count"
expect_jq '.lines[] | select(.name == "CI M18 Cutlery Tray") | .qty == 2 and .notes == "Inner drawers"' "an inner drawer line, noted"
expect_jq '.joinr.linked == true and .joinr.hasJoinrLines == true and .joinr.changed == false and .joinr.quoteNumber == "CI-M18-0001"' "the Joinr block: linked, has lines, not changed"
expect_jq '(.sections | length) == 10 and .sections[0].id == "boards"' "the section list is offered"
expect_eq "$(m18_audits material.fill "$M18_JA")" "1" "one material.fill audit row for the job"
req GET "/api/audit?action=material.fill&entityId=$M18_JA&limit=1" "$ADMIN"
expect_jq '.rows[0].actorUserId == null and .rows[0].actorLabel == "Joinr (automatic)" and .rows[0].after.added == 8' "the fill is audited as Joinr (automatic), 8 added"

# --- access -----------------------------------------------------------------------------------
echo "--- access: jobs.view reads, jobs.edit writes ---"
create_user m18ord "CI M18 Ordering" "Tmp-M18-Ord-Passw0rd-1" ordering
M18_ORD="$WORK/jar-m18ord"
new_jar "$M18_ORD"
login "$M18_ORD" m18ord "Tmp-M18-Ord-Passw0rd-1"
expect_status 200 "login the ordering user"
own_password "$M18_ORD" "Tmp-M18-Ord-Passw0rd-1" "M18-Ord-Passw0rd-1"
for pair in "SCHED:$SCHED" "ACCT:$ACCT" "ORD:$M18_ORD"; do
  who=${pair%%:*}; jar=${pair#*:}
  req GET "/api/job-records/$M18_JA/materials" "$jar"
  expect_status 200 "$who reads the materials"
  expect_jq '(.lines | length) == 8' "$who sees the lines"
  req POST "/api/job-records/$M18_JA/materials" "$jar" '{"name":"No way"}'
  expect_status 403 "$who cannot add a line"
  req POST "/api/job-records/$M18_JA/materials/fill-from-joinr" "$jar" '{}'
  expect_status 403 "$who cannot fill from Joinr"
  req POST "/api/job-records/$M18_JA/materials/update-from-joinr" "$jar" '{}'
  expect_status 403 "$who cannot update from Joinr"
done
req GET "/api/job-records/$M18_JA/materials" "$SHOW"
expect_status 403 "showroom cannot read the materials"
req POST "/api/job-records/$M18_JA/materials" "$SHOW" '{"name":"No way"}'
expect_status 403 "showroom cannot add a line"
req POST "/api/job-records/$M18_JA/materials/to-orders" "$SHOW" '{"ids":[1]}'
expect_status 403 "showroom cannot create order lines"
req GET "/api/job-records/$M18_JA/materials" "$DPM"
M18_ANY=$(jqr ".lines[0].id")
req PATCH "/api/job-records/$M18_JA/materials/$M18_ANY" "$SCHED" '{"notes":"No way"}'
expect_status 403 "scheduling cannot edit a line"
req DELETE "/api/job-records/$M18_JA/materials/$M18_ANY" "$SCHED"
expect_status 403 "scheduling cannot remove a line"
req POST "/api/job-records/$M18_JA/materials/to-orders" "$SCHED" "{\"ids\":[$M18_ANY]}"
expect_status 403 "scheduling cannot create order lines"
req POST "/api/job-records/$M18_JA/materials/to-orders" "$ACCT" "{\"ids\":[$M18_ANY]}"
expect_status 403 "accounts cannot create order lines"
req PATCH "/api/job-records/$M18_JA/materials/$M18_ANY" "$M18_ORD" '{"notes":"No way"}'
expect_status 403 "ordering cannot edit a line (no jobs.edit)"
req GET "/api/job-records/999999/materials" "$DPM"
expect_status 404 "materials of a job that does not exist"
req GET "/api/job-records/$M18_JA/materials" ""
expect_status 401 "logged out is 401"
req POST "/api/job-records/$M18_JA/materials" "" '{"name":"No way"}'
expect_status 401 "logged out cannot add"

# --- typed lines: add, validation, edit sets overridden, remove ----------------------------------
echo "--- typed lines ---"
req POST "/api/job-records/$M18_JA/materials" "$DPM" '{"section":"handles","name":"Bar handle 160mm","qty":12,"unit":"each","notes":"Brushed nickel"}'
expect_status 201 "dpm adds a typed line"
expect_jq '.source == "manual" and .origin == "typed" and .overridden == false and .qty == 12 and .unit == "each" and .section == "handles" and .ordered == false' "a TYPED line"
M18_HANDLE=$(jqr '.id')
req POST "/api/job-records/$M18_JA/materials" "$DPM" '{"name":"Silicone"}'
expect_status 201 "a line with only a name"
expect_jq '.section == "other" and .qty == null and .unit == null and .notes == ""' "defaults: other, no qty, no unit, no notes"
M18_SILICONE=$(jqr '.id')
req POST "/api/job-records/$M18_JA/materials" "$DPM" '{"section":"hardware","name":"Hinges","qty":"30"}'
expect_status 201 "a numeric-text qty is accepted"
expect_jq '.qty == 30' "30"
req POST "/api/job-records/$M18_JA/materials" "$DPM" '{"qty":1}'
expect_status 400 "a line needs a name"
req POST "/api/job-records/$M18_JA/materials" "$DPM" '{"name":"   "}'
expect_status 400 "a blank name"
req POST "/api/job-records/$M18_JA/materials" "$DPM" '{"name":"Bad","qty":-1}'
expect_status 400 "a negative qty"
req POST "/api/job-records/$M18_JA/materials" "$DPM" '{"name":"Bad","qty":"lots"}'
expect_status 400 "a qty that is not a number"
req POST "/api/job-records/$M18_JA/materials" "$DPM" '{"name":"Bad","section":"nope"}'
expect_status 400 "an unknown section"
req POST "/api/job-records/$M18_JA/materials" "$DPM" "$(jq -nc --arg n "$(printf 'n%.0s' $(seq 1 301))" '{name:$n}')"
expect_status 400 "a name of 301 characters"
req POST "/api/job-records/$M18_JA/materials" "$DPM" '{"name":"Bad","unit":"123456789012345678901234567890x"}'
expect_status 400 "a unit of 31 characters"
req POST "/api/job-records/$M18_JA/materials" "$DPM" '[]'
expect_status 400 "a body that is not an object"

req GET "/api/job-records/$M18_JA/materials" "$DPM"
M18_SHEETS=$(jqr '.lines[] | select(.name == "Board sheets") | .id')
M18_DOOR2PAC=$(jqr '.lines[] | select(.name == "2pac (S4)") | .id')
M18_DOORSHAKER=$(jqr '.lines[] | select(.name == "Shaker doors") | .id')
M18_DRAWER=$(jqr '.lines[] | select(.name == "CI M18 Drawer Box") | .id')
M18_CUTLERY=$(jqr '.lines[] | select(.name == "CI M18 Cutlery Tray") | .id')
req PATCH "/api/job-records/$M18_JA/materials/$M18_SHEETS" "$DPM" '{"qty":26}'
expect_status 200 "dpm edits a Joinr line"
expect_jq '.qty == 26 and .origin == "edited" and .overridden == true and .source == "joinr"' "editing a Joinr line makes it EDITED (overridden)"
req PATCH "/api/job-records/$M18_JA/materials/$M18_HANDLE" "$DPM" '{"notes":"Black","qty":14}'
expect_status 200 "dpm edits a typed line"
expect_jq '.origin == "typed" and .overridden == false and .notes == "Black" and .qty == 14' "a typed line stays TYPED"
req PATCH "/api/job-records/$M18_JA/materials/$M18_DRAWER" "$DPM" "{\"qty\":6}"
expect_status 200 "an edit that changes nothing"
expect_jq '.origin == "joinr" and .overridden == false' "a no-change edit does not make a line EDITED"
req PATCH "/api/job-records/$M18_JA/materials/$M18_HANDLE" "$DPM" '{"qty":-2}'
expect_status 400 "a negative qty on edit"
req PATCH "/api/job-records/$M18_JA/materials/$M18_HANDLE" "$DPM" '{"name":""}'
expect_status 400 "a blank name on edit"
req PATCH "/api/job-records/$M18_JA/materials/$M18_HANDLE" "$DPM" '{"section":"nope"}'
expect_status 400 "an unknown section on edit"
req PATCH "/api/job-records/$M18_JA/materials/999999" "$DPM" '{"notes":"x"}'
expect_status 404 "a line that does not exist"
req GET "/api/audit?action=material.update&entityId=$M18_SHEETS&limit=1" "$ADMIN"
expect_jq '.total == 1 and .rows[0].before.qty == 24 and .rows[0].after.qty == 26 and .rows[0].after.overridden == true' "the edit is audited with before and after, and the override"
req GET "/api/audit?action=material.create&entityId=$M18_HANDLE&limit=1" "$ADMIN"
expect_jq '.total == 1 and .rows[0].after.name == "Bar handle 160mm"' "the add is audited"

# A second job: a line id from another job is not found, whatever the route.
req POST /api/job-records "$DPM" '{"name":"M18 other job"}'
expect_status 201 "create another job"
M18_JB=$(jqr '.id')
req PATCH "/api/job-records/$M18_JB/materials/$M18_HANDLE" "$DPM" '{"notes":"x"}'
expect_status 404 "a line of another job (PATCH)"
req DELETE "/api/job-records/$M18_JB/materials/$M18_HANDLE" "$DPM"
expect_status 404 "a line of another job (DELETE)"
req POST "/api/job-records/$M18_JB/materials/to-orders" "$DPM" "{\"ids\":[$M18_HANDLE]}"
expect_status 404 "a line of another job (to-orders)"
req POST "/api/job-records/$M18_JB/materials/fill-from-joinr" "$DPM" '{}'
expect_status 409 "a job that is not tied to a Joinr quote cannot fill from Joinr"
req POST "/api/job-records/$M18_JB/materials/update-from-joinr" "$DPM" '{}'
expect_status 409 "nor update"
req GET "/api/job-records/$M18_JB/materials" "$DPM"
expect_jq '.lines == [] and .joinr.linked == false and .joinr.hasJoinrLines == false' "a job with no list yet: empty, not linked"

# Remove: a Joinr line that Joinr still has must not come back.
req DELETE "/api/job-records/$M18_JA/materials/$M18_DOOR2PAC" "$DPM"
expect_status 200 "dpm removes a Joinr line (2pac doors)"
req DELETE "/api/job-records/$M18_JA/materials/$M18_DOOR2PAC" "$DPM"
expect_status 404 "removing it again is 404"
req GET "/api/job-records/$M18_JA/materials" "$DPM"
expect_jq '[.lines[] | select(.id == '"$M18_DOOR2PAC"')] | length == 0' "the removed line is off the list"
expect_eq "$(m18_sql "SELECT removed_at IS NOT NULL AS r FROM job_materials WHERE id = $M18_DOOR2PAC" | jq -r '.[0].r')" "1" "it is only soft-removed"
expect_eq "$(m18_audits material.remove "$M18_DOOR2PAC")" "1" "the remove is audited"

# --- Joinr changes the quote: nothing is rewritten by itself -------------------------------------
echo "--- Joinr changes the quote: the callout, then Update materials from Joinr ---"
M18_Q1_CHANGED='{"quoteNumber":"CI-M18-0001","siteAddress":"18 Timber Lane, Sydney","clientName":"M18 Client One","wonAt":"2099-06-02T01:00:00Z","valueIncGstCents":2000000,"spec":{"sheetCount":30,"twoPac":true,"benchtop":"stone","jobType":"Kitchen"},"raw":{"doorsPanels":["2pac (S4)","Slab doors"],"benchtops":["Caesarstone Snow"],"jobTypes":["Kitchen"]},"drawers":[{"section":"drawers","name":"CI M18 Drawer Box","qty":8}]}'
m18_event "$M18_Q1" changed won "$M18_Q1_CHANGED"
m18_sync "sync the change"
expect_eq "$(m18_intake "$M18_Q1" changed)" "1" "the record is flagged Changed in Joinr"
req GET "/api/job-records/$M18_JA/materials" "$DPM"
expect_jq '.joinr.changed == true' "the materials say the quote changed"
expect_jq '(.lines | length) == 10 and ([.lines[] | select(.name == "Slab doors")] | length) == 0' "the list was not rewritten by itself"
expect_jq '(.lines[] | select(.name == "Board sheets") | .qty) == 26 and (.lines[] | select(.name == "CI M18 Drawer Box") | .qty) == 6' "no quantity moved yet"

req POST "/api/job-records/$M18_JA/materials/update-from-joinr" "$DPM" '{}'
expect_status 200 "dpm updates the materials from Joinr"
expect_jq '.summary.added == 1 and .summary.updated == 1 and .summary.gone == 2 and .summary.kept == 1 and .summary.removedKept == 1' "1 added, 1 updated, 2 gone, 1 edited line kept, 1 removed line kept"
expect_jq '(.lines[] | select(.name == "Board sheets") | .qty == 26 and .origin == "edited")' "the EDITED sheets line keeps the person's 26, not Joinr's 30"
expect_jq '(.lines[] | select(.name == "CI M18 Drawer Box") | .qty == 8 and .origin == "joinr" and .goneFromJoinr == false)' "an untouched Joinr line takes the new quantity"
expect_jq '(.lines[] | select(.name == "Slab doors") | .source == "joinr" and .section == "doors")' "a new Joinr line is added"
expect_jq '(.lines[] | select(.name == "Shaker doors") | .goneFromJoinr == true and .id == '"$M18_DOORSHAKER"')' "a line Joinr dropped is marked No longer in Joinr, not deleted"
expect_jq '(.lines[] | select(.name == "CI M18 Cutlery Tray") | .goneFromJoinr == true and .qty == 2)' "so is the inner drawer line, with its quantity left as it was"
expect_jq '[.lines[] | select(.name == "2pac (S4)")] | length == 0' "the removed 2pac line did not come back"
expect_jq '(.lines[] | select(.name == "Bar handle 160mm") | .qty == 14 and .origin == "typed" and .goneFromJoinr == false)' "the typed line is untouched"
expect_jq '(.lines | length) == 11 and .joinr.changed == true' "11 lines; Update does not acknowledge the change"
req GET "/api/audit?action=material.joinr_update&entityId=$M18_JA&limit=1" "$ADMIN"
expect_jq '.total == 1 and .rows[0].after.added == 1 and .rows[0].after.gone == 2' "the update is audited"
req POST "/api/job-records/$M18_JA/materials/update-from-joinr" "$DPM" '{}'
expect_status 200 "update again"
expect_jq '.summary.added == 0 and .summary.updated == 0 and .summary.gone == 0' "a second update changes nothing"
expect_eq "$(m18_audits material.joinr_update "$M18_JA")" "1" "and writes no second audit row"

# A line Joinr brings back is refreshed and no longer flagged.
m18_event "$M18_Q1" changed won "$(printf '%s' "$M18_Q1_CHANGED" | jq -c '.raw.doorsPanels = ["2pac (S4)","Slab doors","Shaker doors"]')"
m18_sync "sync the change that brings Shaker doors back"
req POST "/api/job-records/$M18_JA/materials/update-from-joinr" "$DPM" '{}'
expect_status 200 "update after Joinr brings a line back"
expect_jq '.summary.updated == 1 and (.lines[] | select(.name == "Shaker doors") | .goneFromJoinr == false)' "the returning line is no longer flagged"

# --- Fill from Joinr for a job linked before the list existed -------------------------------------
echo "--- Fill from Joinr (a job tied to Joinr before the list existed) ---"
m18_event "$M18_Q2" won won '{"quoteNumber":"CI-M18-0002","siteAddress":"19 Timber Lane, Sydney","clientName":"M18 Client Two","wonAt":"2099-06-03T01:00:00Z","spec":{"sheetCount":12},"raw":{"doorsPanels":["Slab"]}}'
m18_sync "sync quote 2"
M18_JC=$(m18_intake "$M18_Q2" job_id)
req GET "/api/job-records/$M18_JC/materials" "$DPM"
expect_jq '(.lines | length) == 2' "quote 2 has two lines (sheets, one door)"
m18_try "DELETE FROM job_materials WHERE job_id = $M18_JC" >/dev/null
req GET "/api/job-records/$M18_JC/materials" "$DPM"
expect_jq '.lines == [] and .joinr.linked == true and .joinr.hasJoinrLines == false' "no list, but tied to Joinr: Fill from Joinr is offered"
req POST "/api/job-records/$M18_JC/materials/fill-from-joinr" "$DPM" '{}'
expect_status 200 "dpm fills from Joinr"
expect_jq '.summary.added == 2 and (.lines | length) == 2 and (.lines[] | select(.name == "Board sheets") | .qty == 12)' "the two lines are back"
req POST "/api/job-records/$M18_JC/materials/fill-from-joinr" "$DPM" '{}'
expect_status 200 "fill again"
expect_jq '.summary.added == 0 and (.lines | length) == 2' "a second fill adds nothing"

# --- a job that already exists: Link keeps its typed lines ---------------------------------------
echo "--- linking an existing job keeps its typed lines and adds the quote's ---"
req POST /api/job-records "$DPM" '{"name":"M18 existing job","quoteNumber":"CI-M18-0003"}'
expect_status 201 "create a job that already holds the quote number"
M18_JL=$(jqr '.id')
req POST "/api/job-records/$M18_JL/materials" "$DPM" '{"section":"edging","name":"White edging","qty":50,"unit":"m"}'
expect_status 201 "a typed line before the quote arrives"
m18_event "$M18_Q3" won won '{"quoteNumber":"CI-M18-0003","siteAddress":"20 Timber Lane, Sydney","clientName":"M18 Client Three","wonAt":"2099-06-04T01:00:00Z","spec":{"sheetCount":9}}'
m18_sync "sync quote 3"
expect_eq "$(m18_intake "$M18_Q3" state)" "linked" "quote 3 linked to the existing job"
expect_eq "$(m18_intake "$M18_Q3" job_id)" "$M18_JL" "to that job"
req GET "/api/job-records/$M18_JL/materials" "$DPM"
expect_jq '(.lines | length) == 2 and (.lines[] | select(.name == "White edging") | .origin == "typed") and (.lines[] | select(.name == "Board sheets") | .qty == 9 and .origin == "joinr")' "the typed line stays; the quote's sheets are added"

# --- order lines -----------------------------------------------------------------------------------
echo "--- Create order lines: to_order lines on the job, once ---"
req GET "/api/job-records/$M18_JA" "$DPM"
expect_jq '.materialsOrderedDate == null' "job A has not had its materials marked ordered"
req POST "/api/job-records/$M18_JA/materials/to-orders" "$DPM" '{"ids":[]}'
expect_status 400 "no ids"
req POST "/api/job-records/$M18_JA/materials/to-orders" "$DPM" '{"ids":["x"]}'
expect_status 400 "an id that is not a number"
req POST "/api/job-records/$M18_JA/materials/to-orders" "$DPM" "{\"ids\":[$M18_HANDLE],\"supplier\":\"$(printf 's%.0s' $(seq 1 201))\"}"
expect_status 400 "a supplier of 201 characters"
req POST "/api/job-records/$M18_JA/materials/to-orders" "$DPM" "{\"ids\":[999999]}"
expect_status 404 "a line that does not exist"
req POST "/api/job-records/$M18_JA/materials/to-orders" "$DPM" "{\"ids\":[$M18_SHEETS,$M18_DRAWER,$M18_HANDLE],\"supplier\":\"CI M18 Supplier\"}"
expect_status 200 "dpm creates order lines for three materials"
expect_jq '(.created | length) == 3 and (.skipped | length) == 0' "three created, none skipped"
expect_jq '(.lines[] | select(.id == '"$M18_SHEETS"') | .ordered == true and .orderId != null and .orderStatus == "to_order")' "the sheets line is ORDERED, pointing at a to_order line"
M18_ORDER_SHEETS=$(jqr '.lines[] | select(.id == '"$M18_SHEETS"') | .orderId')
M18_ORDER_HANDLE=$(jqr '.lines[] | select(.id == '"$M18_HANDLE"') | .orderId')
expect_jq '.job.materialsOrderedDate == null' "creating to_order lines does not mark the job's materials ordered"
req GET "/api/job-records/$M18_JA/orders" "$DPM"
expect_status 200 "GET the job's orders"
expect_jq '[.[] | select(.supplier == "CI M18 Supplier" and .status == "to_order")] | length == 3' "three to_order lines with the chosen supplier"
expect_jq '.[] | select(.id == '"$M18_ORDER_SHEETS"') | .description == "Board sheets, 26 sheets" and .status == "to_order" and .orderedDate == null' "the description is the name, quantity and unit"
expect_jq '.[] | select(.id == '"$M18_ORDER_HANDLE"') | .description == "Bar handle 160mm, 14 each" and .notes == "Black"' "a typed line's notes ride along"
req GET "/api/job-records/$M18_JA" "$DPM"
expect_jq '.materialsOrderedDate == null and .materialsInDate == null' "the job's materials dates are untouched"
req POST "/api/job-records/$M18_JA/materials/to-orders" "$DPM" "{\"ids\":[$M18_SHEETS,$M18_DRAWER,$M18_HANDLE],\"supplier\":\"CI M18 Supplier\"}"
expect_status 200 "the same request again"
expect_jq '(.created | length) == 0 and (.skipped | length) == 3' "idempotent: nothing created, three skipped"
req GET "/api/job-records/$M18_JA/orders" "$DPM"
expect_jq '[.[] | select(.supplier == "CI M18 Supplier")] | length == 3' "still three order lines"
expect_eq "$(m18_audits material.to_order "$M18_JA")" "1" "one material.to_order audit row (the repeat wrote none)"

echo "--- a line with a live order line cannot be removed; a cancelled one can be ordered again ---"
req DELETE "/api/job-records/$M18_JA/materials/$M18_HANDLE" "$DPM"
expect_status 409 "an ordered line cannot be removed"
req POST "/api/orders/$M18_ORDER_HANDLE/cancel" "$DPM" '{}'
expect_status 200 "dpm cancels that order line"
req GET "/api/job-records/$M18_JA/materials" "$DPM"
expect_jq '(.lines[] | select(.id == '"$M18_HANDLE"') | .ordered == false and .orderStatus == "cancelled")' "the line is no longer ORDERED once its order line is cancelled"
req POST "/api/job-records/$M18_JA/materials/to-orders" "$DPM" "{\"ids\":[$M18_HANDLE],\"supplier\":\"CI M18 Supplier\"}"
expect_status 200 "order it again"
expect_jq '(.created | length) == 1 and .created[0].orderId != '"$M18_ORDER_HANDLE"'' "a new order line, not the cancelled one"

echo "--- the ordering user may create order lines (orders.edit) without jobs.edit; blank supplier ---"
req POST "/api/job-records/$M18_JC/materials/to-orders" "$M18_ORD" '{"ids":[999999]}'
expect_status 404 "the ordering user: an unknown line id is 404 (the route is open to them)"
req GET "/api/job-records/$M18_JC/materials" "$M18_ORD"
M18_C_SHEETS=$(jqr '.lines[] | select(.name == "Board sheets") | .id')
req POST "/api/job-records/$M18_JC/materials/to-orders" "$M18_ORD" "{\"ids\":[$M18_C_SHEETS]}"
expect_status 200 "the ordering user creates an order line with no supplier"
expect_jq '(.created | length) == 1' "created"
M18_ORDER_BLANK=$(jqr '.created[0].orderId')
req GET "/api/job-records/$M18_JC/orders" "$DPM"
expect_jq '.[] | select(.id == '"$M18_ORDER_BLANK"') | .supplier == "" and .status == "to_order" and .description == "Board sheets, 12 sheets"' "a to_order line with the supplier still to choose"
req PATCH "/api/orders/$M18_ORDER_BLANK" "$ADMIN" '{"status":"ordered"}'
expect_status 409 "it cannot be marked ordered without a supplier"
expect_jq '.error == "Choose a supplier first"' "the refusal says so"
req PATCH "/api/orders/$M18_ORDER_BLANK" "$ADMIN" '{"supplier":"CI M18 Late Supplier","status":"ordered"}'
expect_status 200 "with a supplier chosen in the same edit it can be ordered"
req GET "/api/job-records/$M18_JC/materials" "$DPM"
expect_jq '(.lines[] | select(.id == '"$M18_C_SHEETS"') | .ordered == true and .orderStatus == "ordered")' "the materials line follows: ORDERED"

echo "--- a new to_order line does not disturb a job whose materials were already marked ordered ---"
req POST /api/job-records "$DPM" '{"name":"M18 ordered job"}'
expect_status 201 "create a job"
M18_JD=$(jqr '.id')
req POST "/api/job-records/$M18_JD/orders" "$DPM" '{"supplier":"CI M18 Supplier","description":"First line"}'
expect_status 201 "add an order line by hand"
M18_D_ORDER=$(jqr '.order.id')
req PATCH "/api/orders/$M18_D_ORDER" "$ADMIN" '{"status":"ordered"}'
expect_status 200 "mark it ordered (the last line: materials ordered)"
expect_jq '.job.materialsOrderedDate != null' "the job's materials-ordered date is set"
M18_D_DATE=$(jqr '.job.materialsOrderedDate')
req POST "/api/job-records/$M18_JD/materials" "$DPM" '{"name":"Late addition","qty":2,"unit":"each"}'
expect_status 201 "add a materials line"
M18_D_LINE=$(jqr '.id')
req POST "/api/job-records/$M18_JD/materials/to-orders" "$DPM" "{\"ids\":[$M18_D_LINE],\"supplier\":\"CI M18 Supplier\"}"
expect_status 200 "turn it into an order line"
expect_jq '.job.materialsOrderedDate == "'"$M18_D_DATE"'"' "the materials-ordered date is as it was"
req GET "/api/job-records/$M18_JD/orders" "$DPM"
expect_jq '([.[] | select(.status == "to_order")] | length) == 1 and ([.[] | select(.status == "ordered")] | length) == 1' "one ordered line, one new to_order line"

# --- tidy up ------------------------------------------------------------------------------------------
echo "--- tidy up: stop the stand-in and remove the Joinr set-up ---"
m18_fake POST /_control/stop
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url
req GET /api/joinr/status "$DPM"
expect_status 200 "status after the tidy-up"
expect_jq '.configured == false' "Joinr is no longer set up"
