# M21 smoke: the Benchtop designer (0.2.0, docs/plans/m21-benchtop-designer.md).
# Sourced by ci/smoke.sh after the M20 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, jqr, fail, ok) and the cookie jars ($ADMIN $DPM $ACCT ...), $BASE and
# $WORK. No shebang and no `set`: the caller owns both. Made-up names only; it reads only its own rows.

# ============================================================================
step "m21. benchtop designer: lists, plans, revisions, access"
# ============================================================================

M21_TAG="m21b$(date +%s)"

echo "--- pages and access ---"
req GET /benchtop.html "$DPM";        expect_status 200 "dpm GET /benchtop.html"
case $BODY in *'class="bt-shapeicon"'*'L shape (right)'*) ok ;; *) fail "benchtop.html has no shape buttons" ;; esac
req GET /benchtopprint.html "$DPM";   expect_status 200 "dpm GET /benchtopprint.html"
req GET /benchtopprint.js "$DPM"
case $BODY in *'class: "bp-key"'*) ok ;; *) fail "benchtopprint.js has no key" ;; esac
case $BODY in *'class: "bp-tots"'*) ok ;; *) fail "benchtopprint.js has no totals block" ;; esac
req GET /tokens.css "$DPM"
case $BODY in *'--bt-fill-g:'*'--bt-fill-5:'*) ok ;; *) fail "tokens.css has no plan-set fills" ;; esac
req GET /benchtopadmin.html "$ADMIN"; expect_status 200 "admin GET /benchtopadmin.html"
req GET /benchtopadmin.html "$DPM";   expect_status 403 "dpm GET /benchtopadmin.html"
req GET /api/benchtop-lists;          expect_status 401 "logged out GET /api/benchtop-lists"
req GET /shell/shell.js "$ADMIN"
case $BODY in *'{ label: "Benchtop lists", href: "/benchtopadmin.html", key: "users.admin" }'*) ok ;; *) fail "shell.js: no Benchtop lists item" ;; esac

echo "--- the admin lists ---"
req GET /api/benchtop-lists "$DPM"
expect_status 200 "dpm reads the lists"
expect_jq '([.finishes[] | select(.code == "PR" or .code == "RAW" or .code == "MITRE")] | length) == 3' "the starting finishes"
M21_PR=$(jqr '[.finishes[] | select(.code == "PR")][0].id')
M21_RAW=$(jqr '[.finishes[] | select(.code == "RAW")][0].id')
M21_WF=$(jqr '[.finishes[] | select(.code == "WF")][0].id')
expect_jq '([.finishes[] | select(.code == "RAW" and .mark == "X")] | length) == 1 and ([.finishes[] | select(.code == "SQ" and .mark == "[]")] | length) == 1 and ([.finishes[] | select(.code == "PR" and .mark == "//")] | length) == 1' "the marks: RAW X, PR //, SQ []"
expect_jq '[.finishes[] | select(.code == "WF")][0].waterfall == true' "the Waterfall finish asks for a drop"
req POST /api/benchtop-lists/materials "$DPM" '{"supplier":"x","colour":"y","thickness":20}'
expect_status 403 "dpm can't add a material"
req POST /api/benchtop-lists/materials "$ADMIN" '{"supplier":"","colour":"y","thickness":20}'
expect_status 400 "a material needs a supplier"
req POST /api/benchtop-lists/materials "$ADMIN" '{"supplier":"x","colour":"y","thickness":2}'
expect_status 400 "thickness 5 to 200"
req POST /api/benchtop-lists/materials "$ADMIN" "{\"supplier\":\"$M21_TAG Stone Co\",\"range\":\"Test Range\",\"colour\":\"Made Up White\",\"thickness\":20}"
expect_status 201 "admin adds a material"
M21_MAT=$(jqr '.id')
req POST /api/benchtop-lists/finishes "$ADMIN" '{"code":"ZZ","name":"Test","mark":"~"}'
expect_status 400 "an unknown mark"
req POST /api/benchtop-lists/finishes "$ADMIN" "{\"code\":\"m21\",\"name\":\"$M21_TAG finish\",\"mark\":\"[]\"}"
expect_status 201 "admin adds a finish"
expect_jq '.code == "M21" and .mark == "[]" and .active == true' "codes are upper case"
M21_FIN=$(jqr '.id')
req PATCH "/api/benchtop-lists/finishes/$M21_FIN" "$ADMIN" '{"active":false}'
expect_status 200 "admin hides the finish"
expect_jq '.active == false' "hidden"

echo "--- a plan for a job ---"
req POST /api/job-records "$ADMIN" "{\"name\":\"$M21_TAG job\",\"clientName\":\"M21 Test Client\",\"siteAddress\":\"1 Made Up Street, Nowhere\"}"
expect_status 201 "admin makes the job"
M21_JOB=$(jqr '.id')
req GET "/api/job-records/$M21_JOB/benchtop-plan" "$ACCT"
expect_status 200 "acct (jobs.view) reads the job's plan"
expect_jq ".plan == null and .job.clientName == \"M21 Test Client\"" "no plan yet; the job's client"
req POST "/api/job-records/$M21_JOB/benchtop-plan" "$ACCT" '{}'
expect_status 403 "acct (no jobs.edit) can't start one"
M21_BAD='{"design":{"pieces":[{"id":"a1","name":"Run","shape":"l","runs":[{"len":3600,"depth":600}],"edges":{},"joins":[],"cutouts":[]}]}}'
req POST "/api/job-records/$M21_JOB/benchtop-plan" "$DPM" "$M21_BAD"
expect_status 400 "an L needs two runs"
M21_D="{\"pieces\":[{\"id\":\"a1\",\"name\":\"Kitchen L\",\"shape\":\"l\",\"materialId\":$M21_MAT,\"runs\":[{\"len\":3600,\"depth\":600},{\"len\":2400,\"depth\":650}],\"edges\":{\"e0\":$M21_RAW,\"e2\":$M21_PR},\"thick\":{\"e2\":40},\"datum\":\"e5\",\"radii\":{\"c1\":100,\"c2\":0},\"joins\":[{\"run\":0,\"at\":1800}],\"cutouts\":[{\"kind\":\"sink\",\"label\":\"Undermount\",\"w\":800,\"h\":450,\"edge\":\"e0\",\"located\":true,\"along\":2200,\"in\":75},{\"kind\":\"tap\",\"w\":35,\"edge\":\"e0\",\"along\":2580,\"in\":25}]},{\"id\":\"b2\",\"name\":\"Island\",\"shape\":\"lr\",\"x\":1200,\"y\":1500,\"runs\":[{\"len\":2400,\"depth\":900},{\"len\":1800,\"depth\":600}],\"edges\":{\"e2\":$M21_WF},\"drops\":{\"e2\":870},\"joins\":[],\"cutouts\":[]}]}"
req POST "/api/job-records/$M21_JOB/benchtop-plan" "$DPM" '{"design":{"pieces":[{"id":"a1","shape":"leg","leg":{"width":600,"height":870}}]}}'
expect_status 400 "the waterfall leg piece is gone"
req POST "/api/job-records/$M21_JOB/benchtop-plan" "$DPM" "{\"design\":{\"pieces\":[{\"id\":\"a1\",\"shape\":\"straight\",\"runs\":[{\"len\":2000,\"depth\":600}],\"edges\":{\"e0\":$M21_WF},\"drops\":{\"e0\":870}}]}}"
expect_status 400 "a waterfall only on an end edge"
req POST "/api/job-records/$M21_JOB/benchtop-plan" "$DPM" "{\"design\":{\"pieces\":[{\"id\":\"a1\",\"shape\":\"straight\",\"runs\":[{\"len\":2000,\"depth\":600}],\"edges\":{\"e1\":$M21_WF}}]}}"
expect_status 400 "a waterfall needs its drop"
req POST "/api/job-records/$M21_JOB/benchtop-plan" "$DPM" '{"design":{"pieces":[{"id":"a1","shape":"straight","runs":[{"len":2000,"depth":600}],"thick":{"e1":2}}]}}'
expect_status 400 "an edge thickness out of range"
req POST "/api/job-records/$M21_JOB/benchtop-plan" "$DPM" '{"design":{"pieces":[{"id":"a1","shape":"straight","runs":[{"len":2000,"depth":600}],"datum":"e7"}]}}'
expect_status 400 "an unknown reference edge"
req POST "/api/job-records/$M21_JOB/benchtop-plan" "$DPM" '{"design":{"pieces":[{"id":"a1","shape":"l","runs":[{"len":3600,"depth":600},{"len":2400,"depth":600}],"radii":{"c3":50}}]}}'
expect_status 400 "no radius on an internal corner"
req POST "/api/job-records/$M21_JOB/benchtop-plan" "$DPM" '{"design":{"pieces":[{"id":"a1","shape":"straight","runs":[{"len":2000,"depth":600}],"radii":{"c1":301}}]}}'
expect_status 400 "a radius over half the shorter edge"
req POST "/api/job-records/$M21_JOB/benchtop-plan" "$DPM" '{"design":{"pieces":[{"id":"a1","shape":"straight","runs":[{"len":2000,"depth":600}],"radii":{"c4":50}}]}}'
expect_status 400 "an unknown corner"
req POST "/api/job-records/$M21_JOB/benchtop-plan" "$DPM" "{\"design\":$M21_D,\"notes\":\"Made-up note.\"}"
expect_status 201 "dpm starts the plan"
expect_jq '.revision == null and (.design.pieces | length) == 2 and .design.pieces[0].cutouts[1].h == 35 and .design.pieces[0].thick.e2 == 40 and .design.pieces[0].radii.c1 == 100 and .design.pieces[0].radii.c2 == null and .design.pieces[0].datum == "e5" and .design.pieces[0].cutouts[0].edge == "e5" and .design.pieces[0].cutouts[0].located == true and .design.pieces[0].cutouts[1].located == false and .design.pieces[1].shape == "lr" and .design.pieces[1].x == 1200 and .design.pieces[1].y == 1500 and .design.pieces[1].drops.e2 == 870 and .notes == "Made-up note."' "the plan as saved"
M21_PLAN=$(jqr '.id')
M21_UPD=$(jqr '.updatedAt')
req POST "/api/job-records/$M21_JOB/benchtop-plan" "$DPM" '{}'
expect_status 409 "one plan per job"
req PUT "/api/benchtop-plans/$M21_PLAN" "$DPM" '{"design":{"pieces":[{"id":"a1","shape":"straight","runs":[{"len":2000,"depth":600}],"joins":[{"run":0,"at":2500}]}]},"notes":""}'
expect_status 400 "a join beyond the run"
req PUT "/api/benchtop-plans/$M21_PLAN" "$DPM" '{"design":{"pieces":[{"id":"a1","shape":"straight","runs":[{"len":2000,"depth":600}],"edges":{"e9":1}}]},"notes":""}'
expect_status 400 "an unknown edge"
req GET /api/benchtop-plans "$DPM"
expect_jq "[.plans[] | select(.id == $M21_PLAN)][0] | .pieces == 2 and .revision == null" "in the Benchtops list"
req GET /api/benchtop-plans "$ACCT"
expect_status 403 "acct (no design.view) has no list"

echo "--- revisions ---"
req POST "/api/benchtop-plans/$M21_PLAN/print" "$ACCT" '{}'
expect_status 403 "acct can't freeze a revision"
req POST "/api/benchtop-plans/$M21_PLAN/print" "$DPM" '{}'
expect_status 200 "print makes revision A"
expect_jq '.letter == "A" and .created == true' "A"
req POST "/api/benchtop-plans/$M21_PLAN/print" "$DPM" '{}'
expect_jq '.letter == "A" and .created == false' "no change: still A"
req PUT "/api/benchtop-plans/$M21_PLAN" "$DPM" "{\"design\":$M21_D,\"notes\":\"Changed note.\",\"expectUpdatedAt\":\"$M21_UPD\"}"
expect_status 200 "dpm changes the notes"
expect_jq '.revision == "A" and .changedSinceRevision == true' "changed since A"
req PUT "/api/benchtop-plans/$M21_PLAN" "$DPM" "{\"design\":$M21_D,\"notes\":\"x\",\"expectUpdatedAt\":\"$M21_UPD\"}"
expect_status 409 "a stale save"
req POST "/api/benchtop-plans/$M21_PLAN/print" "$DPM" '{}'
expect_jq '.letter == "B" and .created == true' "the change makes B"
req GET "/api/benchtop-plans/$M21_PLAN/revisions/A" "$ACCT"
expect_status 200 "acct reads revision A"
expect_jq '.letter == "A" and .notes == "Made-up note." and .latest == false and .job.clientName == "M21 Test Client" and (.materials | length) == 1 and .business != null' "A frozen as it was"
req GET "/api/benchtop-plans/$M21_PLAN/revisions/Z" "$ACCT"
expect_status 404 "no revision Z"
req GET "/api/benchtop-plans/$M21_PLAN" "$DPM"
expect_jq '[.revisions[].letter] == ["B","A"] and .changedSinceRevision == false' "revisions newest first"

echo "--- audit ---"
req GET "/api/audit?entityType=benchtop_plan&entityId=$M21_PLAN" "$ADMIN"
if [ "$STATUS" = "200" ]; then
  expect_jq '([.rows[] | select(.action == "benchtop_plan.create")] | length) == 1 and ([.rows[] | select(.action == "benchtop_plan.update")] | length) == 1 and ([.rows[] | select(.action == "benchtop_plan.revision")] | length) == 2' "saves and revisions are audited"
else
  ok
fi
