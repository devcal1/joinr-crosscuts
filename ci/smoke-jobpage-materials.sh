# Job page smoke: Orders & materials (0.2.26, migration 067, docs/plans/jobpage-contracts.md section C):
# prefill (history, section defaults), left-out lines (skip_order), Send to orders in one step
# (send-preview and send-now), and what must not change (revision fingerprints, drawers ordered once).
# Sourced by ci/smoke.sh after the order-delete suite, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, create_user, login, own_password, new_jar, fail, ok), the
# cookie jars ($ADMIN $SCHED $ACCT $DPM $SHOW $ORDR), $BASE, $WORK and $CONTAINER. No shebang and no
# `set`: the caller owns both. Made-up names only (tagged), it reads only its own rows. It needs the
# board lead the M24 suite leaves (2 weeks) and puts the section defaults back to blank at the end.

# ============================================================================
step "jobpage-materials. prefill, left-out lines, send to orders in one step"
# ============================================================================

JP_TAG="jp$(date +%s)"
JP_TODAY=$(TZ=Australia/Sydney date +%F)
JP_DOW=$(date -u -d "$JP_TODAY" +%u)
JP_MON=$(date -u -d "$JP_TODAY -$((JP_DOW - 1)) days" +%F)
JP_W2=$(date -u -d "$JP_MON +14 days" +%F)
req PUT /api/settings "$ADMIN" '{"board":{"leadWeeks":2}}'
expect_status 200 "board lead 2 weeks (what the M24 suite leaves)"

# Reads the live database: prints the JSON of one query's rows.
jp_q() {
  docker exec "$CONTAINER" node -e '
const d = require("better-sqlite3")("/data/db/photos.db", { readonly: true });
const [sql, ...args] = process.argv.slice(1);
process.stdout.write(JSON.stringify(d.prepare(sql).all(...args)));' "$@" | tr -d '\r'
}

# One number from a query (the first column of the first row).
jp_n() {
  jp_q "$@" | jq -r '.[0] | to_entries[0].value'
}

# A write on the live database: prints "ok" or the error's message.
jp_x() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.pragma("foreign_keys = ON");
try { const [sql, ...args] = process.argv.slice(1); d.prepare(sql).run(...args); process.stdout.write("ok"); }
catch (e) { process.stdout.write(String(e.message)); }
d.close();' "$@" | tr -d '\r'
}

# jp_job NAME: a Won job; prints nothing, sets JP_ID.
jp_job() {
  req POST /api/job-records "$DPM" "{\"name\":\"$JP_TAG $1\",\"stage\":\"won\",\"valueCents\":1000000}"
  expect_status 201 "job $1"
  JP_ID=$(jqr '.id')
}

# jp_line JOB SECTION NAME QTY UNIT [json fields]: a typed line; sets JP_LID, leaves the response in BODY.
jp_line() {
  local extra=${6:-"{}"}
  req POST "/api/job-records/$1/materials" "$DPM" \
    "$(jq -nc --arg s "$2" --arg n "$3" --argjson q "$4" --arg u "$5" --argjson e "$extra" '{section:$s,name:$n,qty:$q,unit:$u} + $e')"
  expect_status 201 "line $3"
  JP_LID=$(jqr '.id')
}

jp_revs() { jp_n "SELECT COUNT(*) AS n FROM project_order_lists WHERE job_id = ?" "$1"; }
jp_orders() { jp_n "SELECT COUNT(*) AS n FROM orders WHERE job_id = ? AND deleted_at IS NULL" "$1"; }
jp_deposits() { jp_n "SELECT COUNT(*) AS n FROM invoices WHERE job_id = ? AND kind = 'deposit'" "$1"; }

# --- the schema (migration 067) ------------------------------------------------------------------
echo "--- the migration ---"
JP_COLS=$(jp_q "SELECT group_concat(name) AS v FROM pragma_table_info('job_materials')" | jq -r '.[0].v')
for c in suggested prefilled_at skip_order; do
  case ",$JP_COLS," in *",$c,"*) ok ;; *) fail "job_materials has no column $c: $JP_COLS" ;; esac
done
expect_eq "$(jp_n "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('material_section_suppliers','joinr_quote_pdfs')")" "2" "both new tables exist"
jp_job "schema"
JP_SMOKE_J=$JP_ID
JP_R=$(jp_x "INSERT INTO job_materials (job_id, section, name, source, skip_order) VALUES ($JP_SMOKE_J, 'other', 'JP bad skip', 'manual', 2)")
case $JP_R in *CHECK*) ok ;; *) fail "skip_order 2: expected a CHECK failure, got: $JP_R" ;; esac
JP_R=$(jp_x "INSERT INTO job_materials (job_id, section, name, source) VALUES ($JP_SMOKE_J, 'other', 'JP default row', 'manual')")
expect_eq "$JP_R" "ok" "a plain insert still works"
expect_eq "$(jp_q "SELECT skip_order AS s, suggested AS g, prefilled_at AS p FROM job_materials WHERE name = 'JP default row'" | jq -c '.[0]')" '{"s":0,"g":"[]","p":null}' "a line made the old way: not left out, nothing suggested, not prefilled"
jp_x "DELETE FROM job_materials WHERE name = 'JP default row'" >/dev/null

# --- section defaults ------------------------------------------------------------------------------
echo "--- section default suppliers ---"
req GET /api/material-section-suppliers
expect_status 401 "logged out GET /api/material-section-suppliers"
req GET /api/material-section-suppliers "$SHOW"
expect_status 403 "showroom cannot read the defaults"
req GET /api/material-section-suppliers "$DPM"
expect_status 200 "dpm reads the defaults"
expect_jq '(.sections | length) == 10 and .sections[0].section == "boards" and (.sections | all(.supplier == null))' "ten sections, none set"
req PUT /api/material-section-suppliers "$DPM" '{"sections":{"boards":"No way"}}'
expect_status 403 "only users.admin writes the defaults"
req PUT /api/material-section-suppliers "$ADMIN" '{"sections":{"nope":"No way"}}'
expect_status 400 "an unknown section"
req PUT /api/material-section-suppliers "$ADMIN" '{"sections":{"boards":5}}'
expect_status 400 "a supplier that is not text"
req PUT /api/material-section-suppliers "$ADMIN" '{}'
expect_status 400 "no sections"
req PUT /api/material-section-suppliers "$ADMIN" '{"sections":{"boards":"JP Default Boards Co","handles":"JP Default Handles Co"}}'
expect_status 200 "admin sets two defaults"
expect_jq '([.sections[] | select(.supplier != null)] | length) == 2 and (.sections[] | select(.section == "boards") | .supplier) == "JP Default Boards Co"' "saved"
req GET "/api/audit?action=material.section_suppliers&limit=1" "$ADMIN"
expect_jq '.total >= 1' "the change is audited"

# --- prefill from the section default -----------------------------------------------------------------
echo "--- prefill: section defaults, and a person's edits are never overwritten ---"
jp_job "defaults"
JP_J1=$JP_ID
jp_line "$JP_J1" boards "$JP_TAG White HMR 16mm" 3 sheets
JP_BOARD=$JP_LID
expect_jq '.supplier == "JP Default Boards Co" and .suggested == ["supplier"] and .prefilledAt != null' "an empty board line is suggested the section default"
jp_line "$JP_J1" handles "$JP_TAG Bar handle" 12 each
JP_HANDLE=$JP_LID
expect_jq '.supplier == "JP Default Handles Co" and .suggested == ["supplier"]' "a handle line is suggested the handles default"
jp_line "$JP_J1" hardware "$JP_TAG Hinge" 24 each
JP_HINGE=$JP_LID
expect_jq '.supplier == null and .suggested == [] and .prefilledAt != null' "no default for hardware: nothing suggested, but looked at"
jp_line "$JP_J1" boards "$JP_TAG Typed board" 2 sheets '{"supplier":"JP Typed Co","brand":"JP Typed Brand"}'
JP_TYPED=$JP_LID
expect_jq '.supplier == "JP Typed Co" and .brand == "JP Typed Brand" and .suggested == []' "a typed supplier is never replaced by a suggestion"
req PATCH "/api/job-records/$JP_J1/materials/$JP_BOARD" "$DPM" '{"supplier":"JP Own Supplier"}'
expect_status 200 "a person changes the suggested supplier"
expect_jq '.supplier == "JP Own Supplier" and .suggested == []' "editing a field ends its suggestion"
req PATCH "/api/job-records/$JP_J1/materials/$JP_BOARD" "$DPM" '{"supplier":""}'
expect_status 200 "a person clears the supplier"
req POST "/api/job-records/$JP_J1/materials/prefill" "$SCHED" '{}'
expect_status 403 "scheduling cannot prefill"
req POST "/api/job-records/$JP_J1/materials/prefill" "$DPM" '{}'
expect_status 200 "prefill again"
expect_jq '.filled == 0 and (.lines[] | select(.id == '"$JP_BOARD"') | .supplier == null and .suggested == [])' "a field a person cleared is never refilled"
req GET "/api/job-records/$JP_J1/materials" "$ACCT"
expect_status 200 "accounts (jobs.view) reads the list, with the new fields"
expect_jq '(.lines[0] | has("suggested") and has("skipOrder") and has("prefilledAt") and has("orderExpected"))' "the new line fields are there"

# --- send-now on J1, which also makes history ---------------------------------------------------------
echo "--- send to orders: access, then a first real send ---"
req PATCH "/api/job-records/$JP_J1/materials/$JP_BOARD" "$DPM" '{"supplier":"JP Own Supplier"}'
req PATCH "/api/job-records/$JP_J1/materials/$JP_HANDLE" "$DPM" '{"supplier":"JP Hist Supplier","brand":"JP Brand","code":"JP-1","colour":"Black","finish":"Satin"}'
expect_status 200 "full details on the handle"
req PATCH "/api/job-records/$JP_J1/materials/$JP_HINGE" "$DPM" '{"supplier":"JP Hist Supplier"}'
req GET "/api/job-records/$JP_J1/project/send-preview"
expect_status 401 "logged out send-preview"
req GET "/api/job-records/$JP_J1/project/send-preview" "$SHOW"
expect_status 403 "showroom send-preview"
req GET "/api/job-records/$JP_J1/project/send-preview" "$ACCT"
expect_status 200 "accounts reads the preview"
expect_jq '.can.send == false and .ready == false and (.reasons | any(test("install date")))' "accounts: cannot send; no install date yet"
req GET "/api/job-records/$JP_J1/project/send-preview" "$ORDR"
expect_jq '.can.send == false' "ordering has orders.edit but not jobs.edit: cannot send"
req PATCH "/api/job-records/$JP_J1" "$DPM" '{"requestedInstallDate":"2031-05-06"}'
expect_status 200 "a requested install date"
req GET "/api/job-records/$JP_J1/project/send-preview" "$DPM"
expect_status 200 "dpm reads the preview"
expect_jq '.ready == true and .reasons == [] and .lineCount == 4 and .willFinalise == true and .revision == "A" and .requestedInstallDate == "2031-05-06" and .depositWillBeRaised == true and .depositWaitsForValue == false and .stage == "won"' "ready: four lines, revision A, a deposit will be raised"
expect_jq ".boardWeek == \"$JP_W2\"" "the board week is the Monday two weeks out"
expect_jq '.suppliers == ["JP Hist Supplier","JP Own Supplier","JP Typed Co"]' "suppliers, A to Z"
JP_FP=$(jqr '.fingerprint')
req POST "/api/job-records/$JP_J1/project/send-now" "$ACCT" "{\"fingerprint\":\"$JP_FP\"}"
expect_status 403 "accounts cannot send"
req POST "/api/job-records/$JP_J1/project/send-now" "$ORDR" "{\"fingerprint\":\"$JP_FP\"}"
expect_status 403 "ordering (no jobs.edit) cannot send"
req POST "/api/job-records/$JP_J1/project/send-now" "$DPM" '{}'
expect_status 400 "the fingerprint is required"
expect_eq "$(jp_revs "$JP_J1")" "0" "refused: no revision"

echo "--- jobs.edit without orders.edit: edits lines, cannot send ---"
create_user jpje "CI JP Jobs Edit" "Tmp-Jp-Je-Passw0rd-1" design_pm
JP_JE_ID=$CREATED_ID
req PUT "/api/users/$JP_JE_ID/overrides/orders.edit" "$ADMIN" '{"effect":"revoke"}'
expect_status 200 "revoke orders.edit from the jobs.edit user"
JP_JE="$WORK/jar-jpje"
new_jar "$JP_JE"
login "$JP_JE" jpje "Tmp-Jp-Je-Passw0rd-1"
expect_status 200 "login the jobs.edit user"
own_password "$JP_JE" "Tmp-Jp-Je-Passw0rd-1" "Jp-Je-Passw0rd-1"
req PATCH "/api/job-records/$JP_J1/materials/$JP_HINGE" "$JP_JE" '{"notes":"JP note"}'
expect_status 200 "jobs.edit alone still edits a line"
req PATCH "/api/job-records/$JP_J1/materials/$JP_HINGE" "$JP_JE" '{"notes":""}'
req GET "/api/job-records/$JP_J1/project/send-preview" "$JP_JE"
expect_jq '.can.send == false' "jobs.edit alone: no Send"
JP_FP=$(jqr '.fingerprint')
req POST "/api/job-records/$JP_J1/project/send-now" "$JP_JE" "{\"fingerprint\":\"$JP_FP\"}"
expect_status 403 "jobs.edit alone cannot send"
expect_eq "$(jp_revs "$JP_J1")" "0" "still no revision"

req POST "/api/job-records/$JP_J1/project/send-now" "$DPM" "{\"fingerprint\":\"$JP_FP\"}"
expect_status 200 "dpm sends in one step"
expect_jq '.revision == "A" and .created == 4 and .skipped == 0 and .job.sentToOrderingAt != null and .orderList.current.sentAt != null and .depositDue == true and .placed.weekStart == "'"$JP_W2"'"' "revision A, four order lines, sent to Ordering, a deposit, on the board"
expect_eq "$(jp_revs "$JP_J1")" "1" "one revision"
expect_eq "$(jp_orders "$JP_J1")" "4" "four order lines"
expect_eq "$(jp_deposits "$JP_J1")" "1" "one deposit"
expect_eq "$(jp_n "SELECT COUNT(*) AS n FROM week_rows WHERE job_id = ? AND week_start = ?" "$JP_J1" "$JP_W2")" "1" "on the board two weeks out"
req GET "/api/audit?action=project.send&entityId=$JP_J1&limit=5" "$ADMIN"
expect_jq '.total == 1' "audited once"
req POST "/api/job-records/$JP_J1/project/send-now" "$DPM" "{\"fingerprint\":\"$JP_FP\"}"
expect_status 409 "pressing it again with the same fingerprint is refused"
expect_eq "$(jp_orders "$JP_J1")" "4" "still four order lines"
expect_eq "$(jp_revs "$JP_J1")" "1" "still one revision"
req GET "/api/job-records/$JP_J1/project/send-preview" "$DPM"
expect_jq '.ready == false and .willFinalise == false and .latest.revision == "A" and .latest.sentAt != null and (.reasons | any(test("already been sent")))' "after sending: nothing to send"
expect_jq '.depositWillBeRaised == false and .boardWeek == null' "no second deposit, no second placement"

echo "--- an existing revision keeps its fingerprint ---"
JP_REV=$(jp_q "SELECT lines_json, fingerprint FROM project_order_lists WHERE job_id = $JP_J1")
expect_eq "$(printf '%s' "$JP_REV" | jq -c '.[0].lines_json | fromjson | .[0] | keys')" '["brand","code","colour","finish","hardware","id","name","notes","qty","section","supplier","unit"]' "a frozen line carries exactly the old twelve fields (no skip_order)"
JP_SHA=$(docker exec "$CONTAINER" node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$(printf '%s' "$JP_REV" | jq -r '.[0].lines_json')" | tr -d '\r')
expect_eq "$JP_SHA" "$(printf '%s' "$JP_REV" | jq -r '.[0].fingerprint')" "the fingerprint is still the sha-256 of the frozen lines"
req GET "/api/job-records/$JP_J1/project" "$DPM"
expect_jq '.orderList.changed == false' "the live list still matches revision A (skip_order defaults to 0)"
req POST "/api/job-records/$JP_J1/materials/prefill" "$DPM" '{}'
req GET "/api/job-records/$JP_J1/project" "$DPM"
expect_jq '.orderList.changed == false' "and prefill did not disturb it"

# --- history -------------------------------------------------------------------------------------------
echo "--- prefill from history: the last ordered line with the same name ---"
jp_job "history"
JP_J2=$JP_ID
jp_line "$JP_J2" handles "  $(printf '%s' "$JP_TAG" | tr 'a-z' 'A-Z') bar HANDLE " 4 each
JP_H1=$JP_LID
expect_jq '.supplier == "JP Hist Supplier" and .brand == "JP Brand" and .code == "JP-1" and .colour == "Black" and .finish == "Satin" and (.suggested | sort) == ["brand","code","colour","finish","supplier"]' "the same item (case and spaces ignored) brings its supplier and details together"
jp_line "$JP_J2" other "$JP_TAG Bar handle" 4 each
expect_jq '.supplier == null and .suggested == []' "a different section is a different item"
jp_line "$JP_J2" handles "$JP_TAG Bar handle" 4 each '{"brand":"Mine"}'
expect_jq '.brand == "Mine" and .supplier == "JP Hist Supplier" and .code == "JP-1" and (.suggested | index("brand")) == null' "a typed brand stays; the empty fields are filled"
jp_line "$JP_J2" handles "$JP_TAG Bar handle" 4 each '{"supplier":"JP Elsewhere"}'
expect_jq '.supplier == "JP Elsewhere" and .brand == null and .suggested == []' "a typed supplier is not joined to another supplier's details"
jp_line "$JP_J2" hardware "$JP_TAG Hinge" 4 each
expect_jq '.supplier == "JP Hist Supplier" and .suggested == ["supplier"]' "history can bring just a supplier"
req GET "/api/job-records/$JP_J1/materials" "$DPM"
JP_HORDER=$(jqr '.lines[] | select(.id == '"$JP_HANDLE"') | .orderId')
req POST "/api/orders/$JP_HORDER/cancel" "$DPM" '{}'
expect_status 200 "cancel the first job's handle order line"
jp_job "history cancelled"
JP_J3=$JP_ID
jp_line "$JP_J3" handles "$JP_TAG Bar handle" 4 each
expect_jq '.supplier == "JP Default Handles Co" and .brand == null' "a cancelled order is not history: the section default instead"

# --- held while the latest revision is current ---------------------------------------------------------
echo "--- prefill waits while the latest revision is current and unchanged ---"
jp_job "held"
JP_J5=$JP_ID
jp_line "$JP_J5" hardware "$JP_TAG Held A" 2 each '{"supplier":"JP Held Co"}'
JP_HA=$JP_LID
jp_line "$JP_J5" hardware "$JP_TAG Held B" 2 each '{"supplier":"JP Held Co"}'
req POST "/api/job-records/$JP_J5/project/finalise" "$DPM" '{}'
expect_status 201 "finalise revision A"
jp_x "UPDATE job_materials SET prefilled_at = NULL WHERE job_id = $JP_J5" >/dev/null
req POST "/api/job-records/$JP_J5/materials/prefill" "$DPM" '{}'
expect_status 200 "prefill on a current revision"
expect_jq '.held == true and .filled == 0' "held"
expect_eq "$(jp_n "SELECT COUNT(*) AS n FROM job_materials WHERE job_id = ? AND prefilled_at IS NOT NULL" "$JP_J5")" "0" "nothing was stamped"
req GET "/api/job-records/$JP_J5/project" "$DPM"
expect_jq '.orderList.changed == false' "revision A is still current"
req PATCH "/api/job-records/$JP_J5/materials/$JP_HA" "$DPM" '{"qty":3}'
req POST "/api/job-records/$JP_J5/materials/prefill" "$DPM" '{}'
expect_jq '.held == false and (.lines | all(.prefilledAt != null))' "once the list has changed, prefill runs"

# --- drawers and left-out lines ----------------------------------------------------------------------
echo "--- Joinr drawers are left out of the order; nothing is ordered twice ---"
jp_job "drawers"
JP_J4=$JP_ID
JP_INS="INSERT INTO job_materials (job_id, position, section, name, qty, unit, source, joinr_key) VALUES ($JP_J4"
expect_eq "$(jp_x "$JP_INS, 1, 'drawers', '$JP_TAG Drawer Box', 6, 'each', 'joinr', 'jp:d1')")" "ok" "a Joinr drawers line"
expect_eq "$(jp_x "$JP_INS, 2, 'boards', '$JP_TAG Joinr Board', 5, 'sheets', 'joinr', 'jp:b1')")" "ok" "a Joinr board line"
req GET "/api/job-records/$JP_J4/materials" "$DPM"
expect_jq '(.lines | length) == 2 and (.lines | all(.prefilledAt == null and .skipOrder == false))' "made the old way: not looked at yet"
req POST "/api/job-records/$JP_J4/materials/prefill" "$DPM" '{}'
expect_status 200 "prefill on open"
expect_jq '(.lines[] | select(.name == "'"$JP_TAG"' Drawer Box") | .skipOrder == true and .supplier == null) and (.lines[] | select(.name == "'"$JP_TAG"' Joinr Board") | .skipOrder == false and .supplier == "JP Default Boards Co" and .origin == "joinr")' "the drawers line is left out; the board line is suggested a supplier and stays a JOINR line"
JP_DRAWER=$(jqr '.lines[] | select(.name == "'"$JP_TAG"' Drawer Box") | .id')
JP_JBOARD=$(jqr '.lines[] | select(.name == "'"$JP_TAG"' Joinr Board") | .id')
jp_line "$JP_J4" drawers "$JP_TAG Typed drawer" 2 each '{"supplier":"JP Drawer Co"}'
expect_jq '.skipOrder == false' "a typed drawers line is not left out"
JP_TDRAWER=$JP_LID
req GET "/api/job-records/$JP_J4/project" "$DPM"
expect_jq "([.materials[], .hardware[]] | map(.id) | sort) == ([$JP_JBOARD, $JP_TDRAWER] | sort) and (.notInOrder | map(.id)) == [$JP_DRAWER] and (.problems | map(.id)) == []" "the project page lists what is in the order; the drawers line is under notInOrder; no problem for it"
req PATCH "/api/job-records/$JP_J4/materials/$JP_DRAWER" "$DPM" '{"skipOrder":"yes"}'
expect_status 400 "skipOrder must be true or false"
req PATCH "/api/job-records/$JP_J4/materials/$JP_DRAWER" "$SCHED" '{"skipOrder":false}'
expect_status 403 "scheduling cannot include a line"
req POST "/api/job-records/$JP_J4/materials/to-orders" "$DPM" "{\"ids\":[$JP_DRAWER],\"supplier\":\"JP Drawer Co\"}"
expect_status 200 "the old Create order lines API"
expect_jq '(.created | length) == 0 and .skipped == [{"id":'"$JP_DRAWER"',"reason":"left out of the order"}]' "it also leaves a left-out line alone"
req PATCH "/api/job-records/$JP_J4/materials/$JP_DRAWER" "$DPM" '{"skipOrder":false}'
expect_status 200 "Include"
expect_jq '.skipOrder == false and .origin == "joinr" and .overridden == false' "included, and still not an edited line"
req GET "/api/job-records/$JP_J4/project/send-preview" "$DPM"
expect_jq '.lineCount == 3' "included: three lines in the order"
req PATCH "/api/job-records/$JP_J4/materials/$JP_DRAWER" "$DPM" '{"skipOrder":true}'
expect_status 200 "Leave out"
req GET "/api/job-records/$JP_J4/project/send-preview" "$DPM"
expect_jq '.lineCount == 2 and (.problems | length) == 0 and (.lines | map(.name) | index("'"$JP_TAG"' Drawer Box")) == null' "left out: two lines, and the drawers line is not in the list"
req PATCH "/api/job-records/$JP_J4" "$DPM" '{"requestedInstallDate":"2031-05-06"}'
req GET "/api/job-records/$JP_J4/project/send-preview" "$DPM"
JP_FP=$(jqr '.fingerprint')
req POST "/api/job-records/$JP_J4/project/send-now" "$DPM" "{\"fingerprint\":\"$JP_FP\"}"
expect_status 200 "send"
expect_jq '.created == 2 and .skipped == 0' "two order lines: the drawers line is not one of them"
expect_eq "$(jp_orders "$JP_J4")" "2" "two orders on the job"
expect_eq "$(jp_n "SELECT COUNT(*) AS n FROM job_materials WHERE id = ? AND order_id IS NOT NULL" "$JP_DRAWER")" "0" "the drawers line has no order line"
req PATCH "/api/job-records/$JP_J4/materials/$JP_JBOARD" "$DPM" '{"skipOrder":true}'
expect_status 409 "an ordered line cannot be left out"
req GET "/api/job-records/$JP_J4/project/order-lists/A" "$DPM"
expect_jq '([.materials[], .hardware[]] | length) == 2 and ([.materials[], .hardware[]] | map(.name) | index("'"$JP_TAG"' Drawer Box")) == null' "the frozen list has no drawers line"

# --- refusals leave nothing behind --------------------------------------------------------------------
echo "--- a refused send leaves no revision, no stage move, no deposit ---"
jp_job "refused supplier"
JP_J6=$JP_ID
jp_line "$JP_J6" hardware "$JP_TAG Needs supplier" 3 each
jp_line "$JP_J6" hardware "$JP_TAG Has supplier" 3 each '{"supplier":"JP Some Co"}'
req PATCH "/api/job-records/$JP_J6" "$DPM" '{"requestedInstallDate":"2031-05-06"}'
req GET "/api/job-records/$JP_J6/project/send-preview" "$DPM"
expect_jq '.ready == false and (.reasons | any(test("supplier and a quantity"))) and (.problems | length) == 1' "the preview says why"
JP_FP=$(jqr '.fingerprint')
req POST "/api/job-records/$JP_J6/project/send-now" "$DPM" "{\"fingerprint\":\"$JP_FP\"}"
expect_status 400 "a line without a supplier refuses the send"
expect_eq "$(jp_revs "$JP_J6")" "0" "no revision"
expect_eq "$(jp_orders "$JP_J6")" "0" "no order lines"
expect_eq "$(jp_deposits "$JP_J6")" "0" "no deposit"
req GET "/api/job-records/$JP_J6" "$DPM"
expect_jq '.pipelineStage == "won" and .sentToOrderingAt == null' "still at Won"

jp_job "refused date"
JP_J7=$JP_ID
jp_line "$JP_J7" hardware "$JP_TAG Date A" 3 each '{"supplier":"JP Some Co"}'
JP_L7=$JP_LID
req GET "/api/job-records/$JP_J7/project/send-preview" "$DPM"
expect_jq '.ready == false and (.reasons | any(test("install date")))' "no install date: not ready"
JP_FP7=$(jqr '.fingerprint')
req POST "/api/job-records/$JP_J7/project/send-now" "$DPM" "{\"fingerprint\":\"$JP_FP7\"}"
expect_status 400 "no install date refuses the send (after finalise would have passed)"
expect_eq "$(jp_revs "$JP_J7")" "0" "the finalise inside it was rolled back: no revision"
req GET "/api/audit?action=project.finalise&entityId=$JP_J7&limit=1" "$ADMIN"
expect_jq '.total == 0' "and its audit row went with it"
expect_eq "$(jp_deposits "$JP_J7")" "0" "no deposit"
req PATCH "/api/job-records/$JP_J7" "$DPM" '{"requestedInstallDate":"2031-05-06"}'
req GET "/api/job-records/$JP_J7/project/send-preview" "$DPM"
JP_FP7B=$(jqr '.fingerprint')
expect_eq "$JP_FP7B" "$JP_FP7" "the install date is not part of the fingerprint"
req PATCH "/api/job-records/$JP_J7/materials/$JP_L7" "$DPM" '{"qty":9}'
req POST "/api/job-records/$JP_J7/project/send-now" "$DPM" "{\"fingerprint\":\"$JP_FP7\"}"
expect_status 409 "a stale fingerprint"
expect_eq "$(jp_revs "$JP_J7")" "0" "nothing was made"
expect_eq "$(jp_orders "$JP_J7")" "0" "no order lines"
req GET "/api/job-records/$JP_J7/project/send-preview" "$DPM"
JP_FP7C=$(jqr '.fingerprint')
[ "$JP_FP7C" != "$JP_FP7" ] || fail "the fingerprint did not change with the quantity"
ok

echo "--- a double click cannot send twice ---"
jp_job "double"
JP_J8=$JP_ID
jp_line "$JP_J8" hardware "$JP_TAG Double A" 3 each '{"supplier":"JP Dbl Co"}'
jp_line "$JP_J8" boards "$JP_TAG Double B" 3 sheets '{"supplier":"JP Dbl Co"}'
req PATCH "/api/job-records/$JP_J8" "$DPM" '{"requestedInstallDate":"2031-05-06"}'
req GET "/api/job-records/$JP_J8/project/send-preview" "$DPM"
JP_FP8=$(jqr '.fingerprint')
cp "$DPM" "$WORK/jar-dbl-1"; cp "$DPM" "$WORK/jar-dbl-2"
for n in 1 2; do
  curl -s -o "$WORK/dbl-body-$n" -w '%{http_code}' -X POST -H "Origin: $REQ_ORIGIN" -H 'Content-Type: application/json' -b "$WORK/jar-dbl-$n" \
    --data "{\"fingerprint\":\"$JP_FP8\"}" "$BASE/api/job-records/$JP_J8/project/send-now" >"$WORK/dbl-code-$n" &
done
wait
JP_CODES=$(printf '%s\n%s\n' "$(cat "$WORK/dbl-code-1")" "$(cat "$WORK/dbl-code-2")" | sort | tr '\n' ' ')
expect_eq "$JP_CODES" "200 409 " "exactly one of two simultaneous presses sends"
expect_eq "$(jp_revs "$JP_J8")" "1" "one revision"
expect_eq "$(jp_orders "$JP_J8")" "2" "two order lines, not four"
expect_eq "$(jp_deposits "$JP_J8")" "1" "one deposit"

echo "--- a second revision sends only the new line ---"
jp_line "$JP_J8" hardware "$JP_TAG Double C" 1 each '{"supplier":"JP Dbl Co"}'
req GET "/api/job-records/$JP_J8/project/send-preview" "$DPM"
expect_jq '.ready == true and .willFinalise == true and .revision == "B" and .lineCount == 3 and .depositWillBeRaised == false and .boardWeek == null' "revision B is next; no second deposit or placement"
JP_FP8=$(jqr '.fingerprint')
req POST "/api/job-records/$JP_J8/project/send-now" "$DPM" "{\"fingerprint\":\"$JP_FP8\"}"
expect_status 200 "send revision B"
expect_jq '.revision == "B" and .created == 1 and .skipped == 2 and .depositDue == false' "one new order line"
expect_eq "$(jp_orders "$JP_J8")" "3" "three order lines in all"

# --- the pages --------------------------------------------------------------------------------------
echo "--- the pages ---"
req GET /job.html "$DPM"
case $BODY in *'id="jmSummary"'*'id="jmProgress"'*) ok ;; *) fail "job.html has no summary and progress blocks" ;; esac
case $BODY in *'id="jmToOrders"'*|*'id="jmOrderBar"'*) fail "job.html still has the Create order lines bar" ;; *) ok ;; esac
req GET /jobmaterials.js "$DPM"
case $BODY in *'/project/send-now'*'/project/send-preview'*) ok ;; *) fail "jobmaterials.js does not call send-preview and send-now" ;; esac
req GET /users.html "$ADMIN"
case $BODY in *'id="msGrid"'*) ok ;; *) fail "users.html has no section defaults card" ;; esac

# Put the defaults back to blank.
req PUT /api/material-section-suppliers "$ADMIN" '{"sections":{"boards":"","handles":""}}'
expect_status 200 "defaults cleared"
expect_jq '(.sections | all(.supplier == null))' "none left"
