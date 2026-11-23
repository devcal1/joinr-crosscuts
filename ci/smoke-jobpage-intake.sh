# Job page A smoke (0.2.26, docs/plans/jobpage-contracts.md section A): the Intake "Needs a project
# manager" view (GET /api/joinr/intake?state=unassigned), its count, who may assign, value only for
# jobs.value, and Undo (PUT /api/job-records/:id/owner with {ownerId:null, undo:true}).
# Sourced by ci/smoke.sh after the Ordering login exists, so it shares that script's helpers (step,
# req, expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie jars ($ADMIN $DPM $ACCT
# $SCHED $SHOW $ORDR), the ids ($ORDR_ID ...), $BASE, $WORK and $CONTAINER. No shebang and no `set`:
# the caller owns both. Made-up names only; it counts relative to what earlier suites left behind.
# It waits 62 seconds once, for the 60 second Undo window.

# ============================================================================
step "jobpage A. Intake: needs a project manager, assign, Undo"
# ============================================================================

JPA_TAG="jpa$(date +%s)"

# A write on the live database: prints the last inserted row id.
jpa_exec() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
const [sql, ...args] = process.argv.slice(1);
const info = d.prepare(sql).run(...args);
console.log(String(info.lastInsertRowid));
d.close();' "$@" | tr -d '\r'
}

# A new Won quote waiting in the inbox: jpa_new NAME VALUE_CENTS -> intake id in $JPA_ID
jpa_new() {
  local root="jpa-$JPA_TAG-$1"
  JPA_ID=$(jpa_exec "INSERT INTO joinr_intake (root_quote_id, quote_id, quote_number, joinr_status, last_event, payload, state) VALUES (?, ?, ?, 'won', 'won', ?, 'new')" \
    "$root" "$root" "JPA-$JPA_TAG-$1" \
    "$(jq -nc --arg r "$root" --arg s "$1 Made Up Road $JPA_TAG" --argjson v "$2" '{rootQuoteId:$r, quoteId:$r, clientName:"JPA Client", siteAddress:$s, valueIncGstCents:$v, wonAt:"2026-11-20T01:00:00Z", spec:{sheetCount:4, twoPac:true}}')") \
    || fail "inserting the intake row failed"
  [ -n "$JPA_ID" ] || fail "no intake id"
  ok
}

echo "--- the view and its access ---"
req GET "/api/joinr/intake?state=unassigned" "$DPM"
expect_status 200 "dpm reads the unassigned view"
expect_jq '(.counts.unassigned | type) == "number" and (.rows | type) == "array"' "rows and an unassigned count"
JPA_U0=$(jqr '.counts.unassigned')
req GET "/api/joinr/intake?state=unassigned" "$SCHED"
expect_status 403 "scheduling (no design.view) can't read it"
req GET "/api/joinr/intake?state=unassigned" "$ACCT"
expect_status 403 "accounts (no design.view) can't read it"
req GET "/api/joinr/intake?state=unassigned"
expect_status 401 "logged out"
req GET "/api/joinr/intake?state=nonsense" "$DPM"
expect_status 400 "an unknown view"
req GET "/api/joinr/intake?state=unassigned&countsOnly=1" "$DPM"
expect_jq "(keys == [\"counts\"]) and .counts.unassigned == $JPA_U0" "counts only carries the unassigned count"

echo "--- which jobs are listed ---"
# J1 and J2 are accepted with no owner; J3 is accepted with one; J4 is accepted then lost; N stays in the inbox.
jpa_new J1 962232; JPA_I1=$JPA_ID
jpa_new J2 3148000; JPA_I2=$JPA_ID
jpa_new J3 615000; JPA_I3=$JPA_ID
jpa_new J4 890000; JPA_I4=$JPA_ID
jpa_new N 100000; JPA_IN=$JPA_ID
req POST "/api/joinr/intake/$JPA_I1/accept" "$DPM" '{}'
expect_status 200 "accept J1 with no owner"
JPA_J1=$(jqr '.job.id')
req POST "/api/joinr/intake/$JPA_I2/accept" "$DPM" '{}'
expect_status 200 "accept J2 with no owner"
JPA_J2=$(jqr '.job.id')
req POST "/api/joinr/intake/$JPA_I3/accept" "$DPM" "{\"ownerId\":$ORDR_ID}"
expect_status 200 "accept J3 with an owner"
JPA_J3=$(jqr '.job.id')
req POST "/api/joinr/intake/$JPA_I4/accept" "$DPM" '{}'
expect_status 200 "accept J4"
JPA_J4=$(jqr '.job.id')
req POST "/api/job-records/$JPA_J4/stage" "$DPM" '{"stage":"lost","from":"won"}'
expect_status 200 "J4 is lost"

req GET "/api/joinr/intake?state=unassigned" "$DPM"
expect_status 200 "the unassigned view"
expect_jq "([.rows[] | select(.job.id == $JPA_J1 or .job.id == $JPA_J2)] | length) == 2" "J1 and J2 are listed"
expect_jq "([.rows[] | select(.job.id == $JPA_J3 or .job.id == $JPA_J4 or .id == $JPA_IN)] | length) == 0" "an owned job, a lost job and a waiting quote are not"
expect_jq "all(.rows[]; (.state == \"accepted\" or .state == \"linked\") and .job != null)" "only decided records with a job"
expect_jq ".counts.unassigned == $((JPA_U0 + 2)) and .counts.unassigned == (.rows | length)" "the count matches the list"
expect_jq "([.rows[] | select(.job.id == $JPA_J1)][0] | .quoteNumber == \"JPA-$JPA_TAG-J1\" and .quote.clientName == \"JPA Client\" and .quote.spec.sheetCount == 4 and .quote.spec.twoPac == true and (.quote.wonAt | startswith(\"2026-11-20\")))" "a line carries quote no., client, spec and won date"
expect_jq "([.rows[] | select(.job.id == $JPA_J1)][0].quote.valueIncGstCents) == 962232 and ([.rows[] | select(.job.id == $JPA_J2)][0].quote.valueIncGstCents) == 3148000" "dpm (jobs.value) sees the value"
expect_jq ".counts.new >= 1 and .counts.changed != null and .counts.decided != null" "the other counts are still there"

req GET "/api/joinr/intake?state=unassigned" "$ORDR"
expect_status 200 "ordering (design.view, no jobs.value) reads the view"
expect_jq "([.rows[] | select(.job.id == $JPA_J1)][0].quote.valueIncGstCents) == null" "no value without jobs.value"
expect_jq "(tostring | contains(\"962232\")) | not" "the value is nowhere in the response"

echo "--- the default view is unchanged, Waiting for a person ---"
req GET "/api/joinr/intake" "$DPM"
expect_status 200 "no state: Waiting for a person"
expect_jq "all(.rows[]; .state == \"new\") and ([.rows[] | select(.id == $JPA_IN)] | length) == 1" "the server default is still the new quotes"
req GET "/intake.js" "$DPM"
case $BODY in *'Needs a project manager'*'unassigned'*) ok ;; *) fail "intake.js has no Needs a project manager tab" ;; esac

echo "--- who may assign ---"
req PUT "/api/job-records/$JPA_J1/owner" "$ORDR" "{\"ownerId\":$ORDR_ID}"
expect_status 403 "ordering (no jobs.edit) can't set the owner"
req PUT "/api/job-records/$JPA_J1/owner" "$ACCT" "{\"ownerId\":$ORDR_ID}"
expect_status 403 "accounts can't set the owner"
req PUT "/api/job-records/$JPA_J1/owner" "$SCHED" "{\"ownerId\":$ORDR_ID}"
expect_status 403 "scheduling can't set the owner"
req PUT "/api/job-records/$JPA_J1/owner" "$ORDR" '{"ownerId":null,"undo":true}'
expect_status 403 "ordering can't undo either"
req PUT "/api/job-records/$JPA_J1/owner" "$DPM" "{\"ownerId\":$ORDR_ID,\"undo\":true}"
expect_status 400 "undo needs ownerId null"
req PUT "/api/job-records/$JPA_J1/owner" "$DPM" '{"ownerId":null,"undo":true}'
expect_status 409 "nothing to undo on a job with no owner"
req GET "/api/joinr/intake?state=unassigned" "$DPM"
expect_jq ".counts.unassigned == $((JPA_U0 + 2))" "the refusals changed nothing"

echo "--- assign, then Undo within 60 seconds ---"
req PUT "/api/job-records/$JPA_J1/owner" "$DPM" "{\"ownerId\":$ORDR_ID}"
expect_status 200 "dpm assigns J1"
expect_jq ".job.owner.id == $ORDR_ID and .job.pipelineStage == \"projects\"" "J1 has its owner and moved to Projects"
req GET "/api/joinr/intake?state=unassigned" "$DPM"
expect_jq "([.rows[] | select(.job.id == $JPA_J1)] | length) == 0 and .counts.unassigned == $((JPA_U0 + 1))" "J1 leaves the list and the count drops"
req PUT "/api/job-records/$JPA_J1/owner" "$ADMIN" '{"ownerId":null,"undo":true}'
expect_status 409 "another user can't undo dpm's assignment"
req GET "/api/job-records/$JPA_J1" "$DPM"
expect_jq ".projectOwnerId == $ORDR_ID and .pipelineStage == \"projects\"" "still assigned"
req PUT "/api/job-records/$JPA_J1/owner" "$DPM" '{"ownerId":null,"undo":true}'
expect_status 200 "dpm undoes it"
expect_jq '.job.owner == null and .job.pipelineStage == "won" and .undone.stageRestored == true' "no owner and back at Won"
req GET "/api/job-records/$JPA_J1" "$DPM"
expect_jq '.projectOwnerId == null and .pipelineStage == "won"' "the job record agrees"
req GET "/api/joinr/intake?state=unassigned" "$DPM"
expect_jq "([.rows[] | select(.job.id == $JPA_J1)] | length) == 1 and .counts.unassigned == $((JPA_U0 + 2))" "J1 is back on the list"
req GET "/api/audit?action=job.owner&entityId=$JPA_J1&limit=5" "$ADMIN"
expect_jq '.rows[0].after.undo == true and .rows[0].after.stageRestored == true and .rows[0].after.ownerId == null' "the undo is audited"
req GET "/api/audit?action=job.stage&entityId=$JPA_J1&limit=5" "$ADMIN"
expect_jq '.rows[0].before.stage == "design_ordering" and .rows[0].after.stage == "won"' "and so is the move back to Won"
req PUT "/api/job-records/$JPA_J1/owner" "$DPM" '{"ownerId":null,"undo":true}'
expect_status 409 "a second undo is refused"

echo "--- Undo leaves a stage someone else has moved ---"
req PUT "/api/job-records/$JPA_J2/owner" "$DPM" "{\"ownerId\":$ORDR_ID}"
expect_status 200 "dpm assigns J2"
req POST "/api/job-records/$JPA_J2/stage" "$ADMIN" '{"stage":"ordering","from":"projects"}'
expect_status 200 "admin moves J2 on to Ordering"
req PUT "/api/job-records/$JPA_J2/owner" "$DPM" '{"ownerId":null,"undo":true}'
expect_status 200 "dpm undoes the owner"
expect_jq '.job.owner == null and .job.pipelineStage == "ordering" and .undone.stageRestored == false' "the owner goes; the stage stays where it was moved"

echo "--- Undo after 60 seconds is refused ---"
req PUT "/api/job-records/$JPA_J1/owner" "$DPM" "{\"ownerId\":$ORDR_ID}"
expect_status 200 "dpm assigns J1 again"
sleep 62
req PUT "/api/job-records/$JPA_J1/owner" "$DPM" '{"ownerId":null,"undo":true}'
expect_status 409 "too late to undo"
req GET "/api/job-records/$JPA_J1" "$DPM"
expect_jq ".projectOwnerId == $ORDR_ID and .pipelineStage == \"projects\"" "the assignment stands"
req PUT "/api/job-records/$JPA_J1/owner" "$DPM" '{"ownerId":null}'
expect_status 200 "clearing it by hand still works"
