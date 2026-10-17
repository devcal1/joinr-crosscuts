# M6 smoke, Wave 1 B: the "New from Joinr" inbox (list, Accept, Link, Ignore, Acknowledge,
# the job panel lookup). Sourced by ci/smoke.sh (the smoke-m6-*.sh loop after the M5 suites), so it
# shares that script's shell: the helpers (step, req, expect_status, expect_jq, expect_eq, jqr,
# create_user, login, new_jar, fail, ok), the cookie jars ($ADMIN $SCHED $ACCT $DPM $SHOW), $BASE,
# $WORK and $CONTAINER. No shebang and no `set`: the caller owns both. It does not assume a
# pristine database: it seeds its own joinr_intake rows (root ids "m6b-*") straight into the live
# database through the container's own better-sqlite3, so it does not need the puller or a fake
# Joinr. Contract: docs/plans/m6-contracts.md sections 3, 5 and 6.

# ============================================================================
step "m6-b. the New from Joinr inbox"
# ============================================================================

# One run of SQL against the live database through the container's better-sqlite3.
m6b_sql() { # SQL [PARAM...]  -> prints lastInsertRowid
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
const info = d.prepare(process.argv[1]).run(...process.argv.slice(2));
console.log(String(info.lastInsertRowid));
d.close();
' "$@" | tr -d '\r'
}

# A wire-contract item (docs/integrations/joinr-crosscuts-intake.md) for ROOT and QUOTE_NO,
# optionally reshaped by a jq filter.
m6b_item() { # ROOT QUOTE_NO [JQ_FILTER]
  jq -nc --arg r "$1" --arg q "$2" '{
    cursor: "100", event: "won", quoteId: ("q-" + $r), rootQuoteId: $r, revision: 1, quoteNumber: $q,
    status: "won", standing: "active", deletedAt: null,
    wonAt: "2026-07-01T14:30:00.000Z", updatedAt: "2026-07-01T14:30:00.000Z",
    clientName: "M6B Client", clientPhone: "0400 111 222", clientEmail: "m6b@example.com",
    siteAddress: "12 Wattle St, Bondi NSW", label: "Kitchen", reference: "REF9", quoteDate: "2026-06-20",
    valueIncGstCents: 1234567, estimatedHours: {office: 4, factory: 30.5, site: 8, travel: 2},
    spec: {sheetCount: 14, twoPac: true, benchtop: "stone", jobType: "Kitchen"},
    raw: {doorsPanels: ["2pac (S4)", "2pac (S4)", "Shaker"], benchtops: ["Caesarstone 40mm"], jobTypes: ["Kitchen"]},
    url: ("https://app.joinr.com.au/org/o/quotes/q-" + $r)
  }' | jq -c "${3:-.}"
}

# Inserts a record -> M6B_ID.
m6b_seed() { # ITEM_JSON [STATE] [CHANGED 0|1] [LAST_EVENT]
  local item=$1 state=${2:-new} changed=${3:-0} ev=${4:-won}
  local root qid qn st
  root=$(printf '%s' "$item" | jq -r '.rootQuoteId')
  qid=$(printf '%s' "$item" | jq -r '.quoteId')
  qn=$(printf '%s' "$item" | jq -r '.quoteNumber // empty')
  st=$(printf '%s' "$item" | jq -r '.status')
  M6B_ID=$(m6b_sql "INSERT INTO joinr_intake (root_quote_id, quote_id, quote_number, joinr_status, last_event, payload, state, changed) VALUES (?,?,NULLIF(?,''),?,?,?,?,?)" \
    "$root" "$qid" "${qn:-}" "$st" "$ev" "$item" "$state" "$changed")
  [ -n "$M6B_ID" ] || fail "seeding $root returned no id"
}

# How many audit rows of ACTION exist for the entity.
m6b_audits() { # ACTION ENTITY_ID
  req GET "/api/audit?action=$1&entityId=$2&limit=1" "$ADMIN"
  expect_status 200 "GET /api/audit?action=$1"
  jqr '.total'
}

echo "--- the user who may edit jobs but not see values ---"
create_user m6bnv "CI M6B No Value" 'M6b-Passw0rd-1' design_pm
M6B_NV_ID=$CREATED_ID
req PUT "/api/users/$M6B_NV_ID/overrides/jobs.value" "$ADMIN" '{"effect":"revoke"}'
expect_status 200 "admin revokes jobs.value from the m6bnv user"
M6B_NV="$WORK/jar-m6bnv"
new_jar "$M6B_NV"
login "$M6B_NV" m6bnv 'M6b-Passw0rd-1'
expect_status 200 "login m6bnv"
own_password "$M6B_NV" 'M6b-Passw0rd-1' 'M6b-Passw0rd-2'

echo "--- access ---"
m6b_seed "$(m6b_item m6b-access JRQM6B00)"
M6B_ACCESS=$M6B_ID
for pair in "SHOW:$SHOW" "SCHED:$SCHED" "ACCT:$ACCT"; do
  who=${pair%%:*}; jar=${pair#*:}
  req GET /api/joinr/intake "$jar"
  expect_status 403 "$who GET /api/joinr/intake"
  req GET "/api/joinr/intake/$M6B_ACCESS" "$jar"
  expect_status 403 "$who GET /api/joinr/intake/:id"
  req POST "/api/joinr/intake/$M6B_ACCESS/accept" "$jar" '{}'
  expect_status 403 "$who POST accept"
  req POST "/api/joinr/intake/$M6B_ACCESS/ignore" "$jar" '{}'
  expect_status 403 "$who POST ignore"
  req GET /intake.html "$jar"
  expect_status 403 "$who GET /intake.html"
done
req GET /intake.html "$DPM"
expect_status 200 "dpm GET /intake.html"
case $BODY in *"New from Joinr"*) ok ;; *) fail "/intake.html has no 'New from Joinr' title" ;; esac
req GET /api/joinr/job/1 "$SHOW"
expect_status 403 "show GET /api/joinr/job/:id"
req GET /api/joinr/intake
expect_status 401 "logged-out GET /api/joinr/intake"

echo "--- list and get ---"
req GET /api/joinr/intake "$DPM"
expect_status 200 "dpm GET /api/joinr/intake"
expect_jq ".rows | map(select(.id == $M6B_ACCESS)) | length == 1" "the new record is listed in the default view"
expect_jq ".counts.new >= 1 and (.sync | has(\"configured\"))" "counts and the sync status ride along"
expect_jq ".rows[] | select(.id == $M6B_ACCESS) | .state == \"new\" and .changed == false and .job == null and .matches == 0 and .quoteNumber == \"JRQM6B00\"" "intake object core fields"
expect_jq ".rows[] | select(.id == $M6B_ACCESS) | .quote.valueIncGstCents == 1234567 and .quote.spec.sheetCount == 14 and .quote.spec.twoPac == true and .quote.spec.benchtop == \"stone\" and (.quote.url | startswith(\"https://\"))" "dpm sees the quote with its value"
req GET "/api/joinr/intake/$M6B_ACCESS" "$M6B_NV"
expect_status 200 "no-value user GET intake/:id"
expect_jq '.quote.valueIncGstCents == null' "value hidden without jobs.value"
case $BODY in *1234567*) fail "the value leaked to a user without jobs.value" ;; *) ok ;; esac
req GET "/api/joinr/intake?state=new&countsOnly=1" "$DPM"
expect_status 200 "dpm GET the counts only (the Design/PM tile)"
expect_jq '(keys == ["counts"]) and (.counts.new | type) == "number" and (.counts.changed | type) == "number"' "counts only, no rows"
req GET "/api/joinr/intake?state=bogus" "$DPM"
expect_status 400 "unknown view"
req GET /api/joinr/intake/999999 "$DPM"
expect_status 404 "unknown record"

echo "--- accept ---"
# another record whose root id a job already holds
m6b_seed "$(m6b_item m6b-held JRQM6B01)"
M6B_HELD=$M6B_ID
req POST /api/job-records "$DPM" '{"name":"M6B holder","externalRef":"m6b-held"}'
expect_status 201 "a job already holding the root id"
req POST "/api/joinr/intake/$M6B_HELD/accept" "$DPM" '{}'
expect_status 409 "accept 409 when a job already has that external_ref"
req GET "/api/joinr/intake/$M6B_HELD" "$DPM"
expect_jq '.state == "new"' "still new after the refused accept"

req POST "/api/joinr/intake/$M6B_ACCESS/accept" "$M6B_NV" '{}'
expect_status 200 "accept by a user without jobs.value"
expect_jq '.item.state == "accepted" and .job.stage == "won" and (.job | has("valueCents") | not)' "accept returns the item and the job, value hidden"
M6B_JOB=$(jqr '.job.id')
req GET "/api/job-records/$M6B_JOB" "$DPM"
expect_status 200 "GET the accepted job"
expect_jq '.name == "12 Wattle St, Bondi NSW" and .stage == "won" and .source == "joinr" and .externalRef == "m6b-access" and .quoteNumber == "JRQM6B00"' "job name, stage, source, external_ref, quote number"
expect_jq '.wonDate == "2026-07-02" and .quotedDate == "2026-06-20"' "won_date is the Sydney date of wonAt; quoted_date from the quote"
expect_jq '.clientName == "M6B Client" and .clientPhone == "0400 111 222" and .clientEmail == "m6b@example.com" and .siteAddress == "12 Wattle St, Bondi NSW"' "client and site"
expect_jq '.sheetCount == 14 and .isTwoPac == true and .benchtop == "stone" and .jobType == "Kitchen" and .valueCents == 1234567' "spec and value (even though the accepting user cannot see values)"
expect_jq '.joinrQuoteUrl == "https://app.joinr.com.au/org/o/quotes/q-m6b-access"' "Joinr link"
expect_jq '.notes == "From Joinr JRQM6B00: Doors/panels: 2pac (S4), Shaker; Benchtop: Caesarstone 40mm; Job type: Kitchen; Estimated hours: office 4, factory 30.5, site 8, travel 2."' "notes text"
req GET "/api/joinr/intake/$M6B_ACCESS" "$DPM"
expect_jq ".state == \"accepted\" and .job.id == $M6B_JOB and .decidedBy.id == $M6B_NV_ID and .decidedAt != null" "record decided by the accepting user"
expect_eq "$(m6b_audits job.create "$M6B_JOB")" 1 "job.create audit row"
expect_eq "$(m6b_audits joinr.accept "$M6B_ACCESS")" 1 "joinr.accept audit row"
req POST "/api/joinr/intake/$M6B_ACCESS/accept" "$DPM" '{}'
expect_status 409 "a second accept is refused"
req POST "/api/joinr/intake/$M6B_ACCESS/ignore" "$DPM" '{}'
expect_status 409 "ignore after accept is refused"
req GET /api/job-records "$DPM"
expect_jq "[.[] | select(.externalRef == \"m6b-access\")] | length == 1" "still exactly one job for the root id"

echo "--- the Pipeline's Quoted column: Joinr lines (GET /api/pipeline/joinr-quotes) ---"
# Only quotes still waiting (state new) are listed: accepted and linked ones already have a
# job card of their own, ignored ones were declined, withdrawn ones are gone from Joinr.
m6b_seed "$(m6b_item m6b-pl-new JRQM6BPL '.wonAt = "2030-01-02T00:00:00.000Z"')"
m6b_seed "$(m6b_item m6b-pl-ign JRQM6BPI)" ignored
m6b_seed "$(m6b_item m6b-pl-wd JRQM6BPW)" withdrawn
req GET /api/pipeline/joinr-quotes "$SHOW"
expect_status 403 "show GET /api/pipeline/joinr-quotes"
req GET /api/pipeline/joinr-quotes "$DPM"
expect_status 200 "dpm GET /api/pipeline/joinr-quotes"
expect_jq '[.[] | select(.quoteNumber == "JRQM6BPL")] | length == 1' "the waiting Joinr quote is listed"
expect_jq '.[] | select(.quoteNumber == "JRQM6BPL") | .url == "https://app.joinr.com.au/org/o/quotes/q-m6b-pl-new" and .clientName == "M6B Client" and .siteAddress == "12 Wattle St, Bondi NSW" and .joinrStatus == "won" and .valueCents == 1234567' "the line carries the link, client, site, status and value"
expect_jq '.[] | select(.quoteNumber == "JRQM6BPL") | (keys | sort) == ["clientName","id","joinrStatus","quoteNumber","siteAddress","url","valueCents","wonAt"]' "and nothing else (no raw payload)"
expect_jq '[.[] | select(.quoteNumber == "JRQM6BPI" or .quoteNumber == "JRQM6BPW" or .quoteNumber == "JRQM6B00")] | length == 0' "ignored, withdrawn and accepted quotes are not listed"
expect_jq '[.[] | select(.wonAt) | .wonAt] | . == (sort | reverse)' "newest won first"
req GET /api/pipeline/joinr-quotes "$M6B_NV"
expect_status 200 "a user without jobs.value GET /api/pipeline/joinr-quotes"
expect_jq 'length > 0 and all(.[]; has("valueCents") | not)' "no value for a user who cannot see values"

echo "--- accept: a sparse quote ---"
m6b_seed "$(m6b_item m6b-sparse "" '.quoteNumber = null | .siteAddress = null | .label = null | .clientName = "M6B Sparse" | .clientPhone = null | .clientEmail = null | .wonAt = null | .quoteDate = null | .valueIncGstCents = null | .estimatedHours = null | .spec = {sheetCount: null, twoPac: null, benchtop: null, jobType: null} | .raw = {doorsPanels: [], benchtops: [], jobTypes: []} | .url = "javascript:alert(1)"')"
M6B_SPARSE=$M6B_ID
req GET "/api/joinr/intake/$M6B_SPARSE" "$DPM"
expect_jq '.quote.url == null' "a non-http link is dropped"
req POST "/api/joinr/intake/$M6B_SPARSE/accept" "$DPM" '{}'
expect_status 200 "accept a sparse quote"
expect_jq '.job.name == "M6B Sparse" and .job.stage == "won" and .job.sheetCount == null and .job.isTwoPac == null and .job.benchtop == null and .job.joinrQuoteUrl == null and .job.notes == "From Joinr."' "sparse job: name from the client, nulls stay null"
expect_jq '.job.wonDate | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")' "won_date falls back to today"

echo "--- link ---"
req POST /api/job-records "$DPM" '{"name":"M6B typed in","quoteNumber":"JRQM6B20","clientName":"Typed Client","clientPhone":"0299 999 999","benchtop":"laminate","valueCents":500000}'
expect_status 201 "the job typed in by hand"
M6B_J1=$(jqr '.id')
req POST /api/job-records "$DPM" '{"name":"M6B other number","quoteNumber":"JRQM6B99"}'
expect_status 201 "a job with another quote number"
M6B_J2=$(jqr '.id')
req POST /api/job-records "$DPM" '{"name":"M6B has a ref","quoteNumber":"JRQM6B20","externalRef":"m6b-other-ref"}'
expect_status 201 "a job with the number but already tied to a quote"
M6B_J3=$(jqr '.id')
req POST /api/job-records "$DPM" '{"name":"M6B lost","quoteNumber":"JRQM6B20","stage":"lost"}'
expect_status 201 "a job with the number that was lost"
M6B_J4=$(jqr '.id')
req POST /api/job-records "$DPM" '{"name":"M6B archived","quoteNumber":"JRQM6B20","archived":true}'
expect_status 201 "an archived job with the number"
M6B_J5=$(jqr '.id')
m6b_seed "$(m6b_item m6b-link JRQM6B20 '.clientName = "Joinr Client" | .clientPhone = "0411 000 000" | .clientEmail = "lnk@example.com" | .valueIncGstCents = 777700 | .spec = {sheetCount: 9, twoPac: false, benchtop: "stone", jobType: "Vanity"}')"
M6B_LINK=$M6B_ID
req GET "/api/joinr/intake/$M6B_LINK" "$DPM"
expect_status 200 "GET the record to link"
expect_jq '.matches == 1 and (.matchJobs | map(.id) == ['"$M6B_J1"']) and (.matchJobs[0] | keys == ["clientName","id","name","stage"])' "matchJobs: only the job with the number and no external_ref"
req GET "/api/joinr/intake/$M6B_LINK" "$ACCT"
expect_status 403 "acct GET intake/:id"
req POST "/api/joinr/intake/$M6B_LINK/link" "$DPM" "{\"jobId\":$M6B_J2}"
expect_status 409 "link to a job with another quote number"
req POST "/api/joinr/intake/$M6B_LINK/link" "$DPM" "{\"jobId\":$M6B_J3}"
expect_status 409 "link to a job already tied to a quote"
req POST "/api/joinr/intake/$M6B_LINK/link" "$DPM" "{\"jobId\":$M6B_J4}"
expect_status 409 "link to a lost job"
expect_jq '.error == "Link only to a live job"' "the refusal says live jobs only"
req POST "/api/joinr/intake/$M6B_LINK/link" "$DPM" "{\"jobId\":$M6B_J5}"
expect_status 409 "link to an archived job"
req POST "/api/joinr/intake/$M6B_LINK/link" "$DPM" '{"jobId":999999}'
expect_status 404 "link to a job that does not exist"
req POST "/api/joinr/intake/$M6B_LINK/link" "$DPM" '{}'
expect_status 400 "link without a jobId"
req POST "/api/joinr/intake/$M6B_LINK/link" "$DPM" "{\"jobId\":$M6B_J1}"
expect_status 200 "link the record to the typed-in job"
expect_jq ".item.state == \"linked\" and .item.job.id == $M6B_J1" "record linked"
req GET "/api/job-records/$M6B_J1" "$DPM"
expect_jq '.externalRef == "m6b-link" and .name == "M6B typed in" and .source == "manual" and .stage == "quoted"' "the job gained its external_ref and kept name, source and stage"
expect_jq '.clientName == "Typed Client" and .clientPhone == "0299 999 999" and .benchtop == "laminate" and .valueCents == 500000' "its own non-empty fields are kept"
expect_jq '.clientEmail == "lnk@example.com" and .sheetCount == 9 and .isTwoPac == false and .jobType == "Vanity" and .siteAddress == "12 Wattle St, Bondi NSW" and (.joinrQuoteUrl | endswith("q-m6b-link"))' "its empty fields were filled"
expect_eq "$(m6b_audits job.update "$M6B_J1")" 1 "job.update audit row for the link"
expect_eq "$(m6b_audits joinr.link "$M6B_LINK")" 1 "joinr.link audit row"
req POST "/api/joinr/intake/$M6B_LINK/link" "$DPM" "{\"jobId\":$M6B_J1}"
expect_status 409 "a second link is refused"

echo "--- for a job ---"
req GET "/api/joinr/job/$M6B_JOB" "$DPM"
expect_status 200 "GET /api/joinr/job/:id for an accepted job"
expect_jq ".id == $M6B_ACCESS and .job.id == $M6B_JOB and .state == \"accepted\"" "forJob returns the intake object"
req GET "/api/joinr/job/$M6B_JOB" "$M6B_NV"
expect_jq '.quote.valueIncGstCents == null' "forJob hides the value without jobs.value"
req GET "/api/joinr/job/$M6B_J2" "$DPM"
expect_status 404 "a job with no Joinr record"
req GET "/api/joinr/job/$M6B_J1" "$SCHED"
expect_status 200 "sched (jobs.view) may look up the Joinr panel data"

echo "--- ignore ---"
m6b_seed "$(m6b_item m6b-ign JRQM6B30)"
M6B_IGN=$M6B_ID
req POST "/api/joinr/intake/$M6B_IGN/ignore" "$DPM" '{}'
expect_status 200 "ignore"
expect_jq '.item.state == "ignored" and .item.decidedAt != null' "record ignored"
expect_eq "$(m6b_audits joinr.ignore "$M6B_IGN")" 1 "joinr.ignore audit row"
req POST "/api/joinr/intake/$M6B_IGN/ignore" "$DPM" '{}'
expect_status 409 "ignore twice"
req POST "/api/joinr/intake/$M6B_IGN/accept" "$DPM" '{}'
expect_status 409 "accept an ignored record"
m6b_seed "$(m6b_item m6b-wd JRQM6B31 '.status = "lost"')" withdrawn 0 unwon
M6B_WD=$M6B_ID
req POST "/api/joinr/intake/$M6B_WD/accept" "$DPM" '{}'
expect_status 409 "accept a withdrawn record"
req POST "/api/joinr/intake/$M6B_WD/link" "$DPM" "{\"jobId\":$M6B_J1}"
expect_status 409 "link a withdrawn record"
req POST "/api/joinr/intake/$M6B_WD/ignore" "$DPM" '{}'
expect_status 200 "ignore a withdrawn record"
req GET "/api/joinr/intake?state=ignored" "$DPM"
expect_jq "[.rows[] | select(.id == $M6B_IGN or .id == $M6B_WD)] | length == 2" "both are in the Ignored view"
req GET "/api/joinr/intake?state=new" "$DPM"
expect_jq "[.rows[] | select(.id == $M6B_IGN or .id == $M6B_ACCESS or .id == $M6B_LINK)] | length == 0" "decided records leave the New view"
req GET "/api/joinr/intake?state=decided" "$DPM"
expect_jq "[.rows[] | select(.id == $M6B_ACCESS or .id == $M6B_LINK)] | length == 2" "accepted and linked records are in the Accepted and linked view"

echo "--- changed in Joinr and acknowledge ---"
# What the puller writes when Joinr changes a decided quote: changed = 1, a newer payload.
NEWER=$(m6b_item m6b-access JRQM6B00 '.event = "unwon" | .status = "lost" | .valueIncGstCents = 2000000 | .clientName = "M6B Renamed"')
m6b_sql "UPDATE joinr_intake SET changed = 1, last_event = 'unwon', joinr_status = 'lost', payload = ? WHERE id = ?" "$NEWER" "$M6B_ACCESS" >/dev/null
m6b_sql "UPDATE joinr_intake SET changed = 1 WHERE id = ?" "$M6B_IGN" >/dev/null
req GET "/api/joinr/intake?state=changed" "$DPM"
expect_status 200 "the Changed view"
expect_jq "[.rows[] | select(.id == $M6B_ACCESS or .id == $M6B_IGN)] | length == 2" "both changed records are listed (any state)"
expect_jq ".rows[] | select(.id == $M6B_ACCESS) | .changed == true and .joinrStatus == \"lost\" and .lastEvent == \"unwon\" and (.differences | map(.label) | index(\"Value inc GST\") != null and index(\"Client\") != null)" "what differs from the job is reported"
req GET "/api/joinr/intake/$M6B_ACCESS" "$M6B_NV"
expect_jq '(.differences | map(.label) | index("Value inc GST")) == null and (.differences | map(.label) | index("Client")) != null' "the value difference is hidden without jobs.value"
req GET "/api/job-records/$M6B_JOB" "$DPM"
expect_jq '.name == "12 Wattle St, Bondi NSW" and .stage == "won" and .valueCents == 1234567 and .clientName == "M6B Client"' "the job itself is untouched by the change"
req POST "/api/joinr/intake/$M6B_ACCESS/acknowledge" "$ACCT" '{}'
expect_status 403 "acct acknowledge"
req POST "/api/joinr/intake/$M6B_ACCESS/acknowledge" "$DPM" '{}'
expect_status 200 "acknowledge"
expect_jq '.item.changed == false and .item.state == "accepted"' "changed cleared, state kept"
expect_eq "$(m6b_audits joinr.acknowledge "$M6B_ACCESS")" 1 "joinr.acknowledge audit row"
req POST "/api/joinr/intake/$M6B_ACCESS/acknowledge" "$DPM" '{}'
expect_status 200 "acknowledging again is harmless"
expect_eq "$(m6b_audits joinr.acknowledge "$M6B_ACCESS")" 1 "no second acknowledge audit row"
req GET "/api/joinr/intake?state=changed" "$DPM"
expect_jq "([.rows[] | select(.id == $M6B_ACCESS)] | length == 0) and ([.rows[] | select(.id == $M6B_IGN)] | length == 1)" "only the unacknowledged record stays in Changed"
