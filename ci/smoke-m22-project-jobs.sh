# M22 smoke: project jobs (0.2.1, docs/plans/m22-project-jobs.md): the Projects and Ordering halves of
# design_ordering, the project owner, the project page, finalised order lists and Send to Ordering.
# Sourced by ci/smoke.sh after the M21 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie jars ($ADMIN $DPM $ACCT $SCHED
# $SHOW $ORDR), the ids ($ACCT_ID $ORDR_ID ...), $BASE, $WORK and $CONTAINER. No shebang and no
# `set`: the caller owns both. Made-up names only; it reads only its own rows.

# ============================================================================
step "m22. project jobs: stages, owner, project page, order lists, send to Ordering"
# ============================================================================

M22_TAG="m22p$(date +%s)"

# A write on the live database: prints the last inserted row id.
m22_exec() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
const [sql, ...args] = process.argv.slice(1);
const info = d.prepare(sql).run(...args);
console.log(String(info.lastInsertRowid));
d.close();' "$@" | tr -d '\r'
}

echo "--- the migration ---"
M22_COLS=$(docker exec "$CONTAINER" node -e '
const d = require("better-sqlite3")("/data/db/photos.db", { readonly: true });
const cols = (t) => d.prepare("SELECT name FROM pragma_table_info(?)").all(t).map((c) => c.name);
process.stdout.write(JSON.stringify({ jobs: cols("jobs"), m: cols("job_materials"), l: cols("project_order_lists") }));' | tr -d '\r')
expect_eq "$(printf '%s' "$M22_COLS" | jq -r '[.jobs[] | select(. == "project_owner_id" or . == "sent_to_ordering_at" or . == "project_notes")] | length')" "3" "jobs has the three new columns"
expect_eq "$(printf '%s' "$M22_COLS" | jq -r '[.m[] | select(. == "colour" or . == "finish" or . == "brand" or . == "code" or . == "supplier")] | length')" "5" "job_materials has the five new columns"
expect_eq "$(printf '%s' "$M22_COLS" | jq -r '.l | length > 0')" "true" "project_order_lists exists"

# M24: Send to Ordering also places the job on the board; this suite tests the list, so placement
# is off here (ci/smoke-m24-board-money.sh turns it back on and tests it).
req PUT /api/settings "$ADMIN" '{"board":{"leadWeeks":0}}'
expect_status 200 "board lead 0 for the M22 and M23 suites"

echo "--- pages and access ---"
req GET /project.html "$DPM";         expect_status 200 "dpm GET /project.html"
req GET /projectorder.html "$DPM";    expect_status 200 "dpm GET /projectorder.html"
req GET /project.html "$SHOW";        expect_status 403 "showroom GET /project.html"
req GET /api/project-owners;          expect_status 401 "logged out GET /api/project-owners"
req GET /pipeline.js "$DPM"
case $BODY in *'["projects", "Projects"]'*'["ordering", "Ordering"]'*) ok ;; *) fail "pipeline.js has no Projects and Ordering columns" ;; esac
case $BODY in *'["design_ordering", "Design / ordering"]'*) fail "pipeline.js still has the Design / ordering column" ;; *) ok ;; esac
req GET /job.html "$DPM"
case $BODY in *'id="pjOwner"'*'projectowner.js'*) ok ;; *) fail "job.html has no project owner line" ;; esac

echo "--- the owner list ---"
req POST /api/workers "$ADMIN" "{\"name\":\"M22 Worker $M22_TAG\"}"
expect_status 201 "a worker for the owner"
M22_W=$(jqr '.id')
req PATCH "/api/workers/$M22_W" "$ADMIN" '{"hue":150}'
expect_status 200 "worker hue 150"
req PUT "/api/users/$ORDR_ID/worker" "$ADMIN" "{\"workerId\":$M22_W}"
expect_status 200 "the Ordering login is linked to the worker"
req GET /api/auth/me "$DPM";   M22_DPM_ID=$(jqr '.user.id')
req GET /api/auth/me "$ACCT";  ACCT_ID=$(jqr '.user.id')
req GET /api/auth/me "$ADMIN"; M22_ADMIN_ID=$(jqr '.user.id')
req GET /api/project-owners "$DPM"
expect_status 200 "dpm reads the owner list"
expect_jq "([.owners[] | select(.id == $M22_DPM_ID or .id == $ORDR_ID or .id == $M22_ADMIN_ID)] | length) == 3" "design.view holders are listed"
expect_jq "([.owners[] | select(.id == $ACCT_ID or .id == $SCHED_ID)] | length) == 0" "accounts and scheduling are not"
expect_jq "([.owners[] | select(.id == $ORDR_ID)][0].hue) == 150" "an owner carries the linked worker's hue"

echo "--- a job, its owner and the stages ---"
req POST /api/job-records "$DPM" "{\"name\":\"$M22_TAG job\",\"clientName\":\"M22 Test Client\",\"stage\":\"won\"}"
expect_status 201 "dpm makes a job at Won"
M22_J=$(jqr '.id')
expect_jq '.pipelineStage == "won" and .owner == null and .projectOwnerId == null and .sentToOrderingAt == null' "no owner, shown at Won"
req PUT "/api/job-records/$M22_J/owner" "$SCHED" "{\"ownerId\":$ORDR_ID}"
expect_status 403 "scheduling can't set the owner"
req PUT "/api/job-records/$M22_J/owner" "$ORDR" "{\"ownerId\":$ORDR_ID}"
expect_status 403 "ordering (no jobs.edit) can't set the owner"
req PUT "/api/job-records/$M22_J/owner" "$DPM" '{}'
expect_status 400 "ownerId is required"
req PUT "/api/job-records/$M22_J/owner" "$DPM" "{\"ownerId\":$ACCT_ID}"
expect_status 400 "an owner needs Projects access"
req PUT "/api/job-records/$M22_J/owner" "$DPM" '{"ownerId":"x"}'
expect_status 400 "ownerId must be an id"
req PUT "/api/job-records/$M22_J/owner" "$DPM" "{\"ownerId\":$ORDR_ID}"
expect_status 200 "dpm sets the owner"
expect_jq ".job.owner.id == $ORDR_ID and .job.owner.hue == 150" "the owner with their colour"
expect_jq '.job.pipelineStage == "projects"' "M23: a Won job given an owner moves to Projects"
req GET "/api/job-records/$M22_J" "$DPM"
expect_jq ".projectOwnerId == $ORDR_ID and .owner.id == $ORDR_ID and .owner.hue == 150" "the job record carries the owner"
req GET "/api/audit?action=job.owner&entityId=$M22_J&limit=5" "$ADMIN"
expect_jq "(.rows | length) == 1 and .rows[0].after.ownerId == $ORDR_ID" "the owner change is audited"
req PUT "/api/job-records/$M22_J/owner" "$ADMIN" '{"ownerId":null}'
expect_status 200 "admin clears the owner"
expect_jq '.job.owner == null' "cleared"
req PUT "/api/job-records/$M22_J/owner" "$ADMIN" "{\"ownerId\":$ORDR_ID}"
expect_status 200 "admin sets it again"
# M23 moved it to Projects with the owner; back to Won for the stage checks below.
req POST "/api/job-records/$M22_J/stage" "$DPM" '{"stage":"won","from":"projects"}'
expect_status 200 "Projects -> Won (by hand)"

req POST "/api/job-records/$M22_J/stage" "$DPM" '{"stage":"projects","from":"won"}'
expect_status 200 "won -> Projects"
expect_jq '.stage == "design_ordering" and .pipelineStage == "projects" and .sentToOrderingAt == null' "stored design_ordering, shown Projects"
req GET "/api/job-records?stage=projects" "$DPM"
expect_jq "([.[] | select(.id == $M22_J)] | length) == 1" "the Projects filter finds it"
req GET "/api/job-records?stage=ordering" "$DPM"
expect_jq "([.[] | select(.id == $M22_J)] | length) == 0" "the Ordering filter does not"
req POST "/api/job-records/$M22_J/stage" "$DPM" '{"stage":"ordering","from":"projects"}'
expect_status 200 "Projects -> Ordering"
expect_jq '.stage == "design_ordering" and .pipelineStage == "ordering" and .sentToOrderingAt != null' "shown Ordering"
req POST "/api/job-records/$M22_J/stage" "$DPM" '{"stage":"ordering","from":"projects"}'
expect_status 409 "a stale shown stage is a 409"
req POST "/api/job-records/$M22_J/stage" "$DPM" '{"stage":"ready_to_cut","from":"ordering"}'
expect_status 200 "Ordering -> Ready to cut (from as the shown stage)"
expect_jq '.stage == "ready_to_cut" and .pipelineStage == "ready_to_cut" and .sentToOrderingAt != null' "leaving keeps sent_to_ordering_at"
req POST "/api/job-records/$M22_J/stage" "$DPM" '{"stage":"design_ordering","from":"ready_to_cut"}'
expect_status 200 "back to design_ordering"
expect_jq '.pipelineStage == "ordering"' "a plain design_ordering move keeps the half it was in"
req POST "/api/job-records/$M22_J/stage" "$DPM" '{"stage":"projects","from":"design_ordering"}'
expect_status 200 "Ordering -> Projects"
expect_jq '.pipelineStage == "projects" and .sentToOrderingAt == null' "Projects clears it"
req GET "/api/audit?action=job.ordering&entityId=$M22_J&limit=10" "$ADMIN"
expect_jq '(.rows | length) == 2' "set and cleared, both audited"
req PATCH "/api/job-records/$M22_J" "$ADMIN" '{"stage":"ordering"}'
expect_status 200 "admin PATCH to Ordering"
expect_jq '.pipelineStage == "ordering"' "PATCH takes the shown names too"
req PATCH "/api/job-records/$M22_J" "$ADMIN" '{"stage":"projects"}'
expect_status 200 "admin PATCH back to Projects"
req POST /api/job-records "$DPM" "{\"name\":\"$M22_TAG straight to ordering\",\"stage\":\"ordering\"}"
expect_status 201 "a new job made at Ordering"
expect_jq '.stage == "design_ordering" and .pipelineStage == "ordering"' "made at Ordering"

echo "--- the project page and its lines ---"
req GET "/api/job-records/$M22_J/project" "$SHOW"
expect_status 403 "showroom can't read the project"
req GET "/api/job-records/$M22_J/project" "$ACCT"
expect_status 200 "accounts (jobs.view) reads the project"
expect_jq '.can.edit == false and .can.setOwner == false and .can.send == false' "read-only for accounts"
req GET "/api/job-records/$M22_J/project" "$DPM"
expect_status 200 "dpm reads the project"
expect_jq '.can.edit == true and .can.setOwner == true and .can.send == true and .materials == [] and .hardware == [] and .orderList.current == null and .orderList.nextRevision == "A"' "empty, revision A next"
expect_jq '.hours.quotedFactoryMin == null and .hours.booked.manufacturing.toDate == 0 and .hours.booked.installing.ahead == 0' "no hours yet"

req POST "/api/job-records/$M22_J/materials" "$DPM" '{"section":"boards","name":"Board 16mm","qty":12,"unit":"sheets","colour":"Black Wenge","finish":"Matt","supplier":"M22 Boards Co"}'
expect_status 201 "a material with colour, finish and supplier"
M22_L1=$(jqr '.id')
expect_jq '.colour == "Black Wenge" and .finish == "Matt" and .supplier == "M22 Boards Co" and .brand == null' "the new fields"
req POST "/api/job-records/$M22_J/materials" "$DPM" '{"section":"hardware","name":"Hinge soft close","qty":24,"unit":"each","brand":"Blum","code":"71B3550","supplier":"M22 Hardware Co"}'
expect_status 201 "a hardware line with brand and code"
M22_L2=$(jqr '.id')
req POST "/api/job-records/$M22_J/materials" "$DPM" '{"section":"handles","name":"Bar handle 160"}'
expect_status 201 "a handle with no supplier or quantity"
M22_L3=$(jqr '.id')
req POST "/api/job-records/$M22_J/materials" "$DPM" "{\"section\":\"boards\",\"name\":\"x\",\"colour\":\"$(printf 'c%.0s' $(seq 1 101))\"}"
expect_status 400 "a colour over 100 characters"

req GET "/api/job-records/$M22_J/project" "$DPM"
expect_jq "(.materials | map(.id)) == [$M22_L1] and (.hardware | map(.id) | sort) == ([$M22_L2, $M22_L3] | sort)" "materials and hardware split by section"
expect_jq "(.problems | length) == 1 and .problems[0].id == $M22_L3 and (.problems[0].missing | sort) == [\"quantity\",\"supplier\"]" "the handle needs a supplier and a quantity"

echo "--- finalise ---"
req POST "/api/job-records/$M22_J/project/finalise" "$ACCT"
expect_status 403 "accounts can't finalise"
req POST "/api/job-records/$M22_J/project/finalise" "$DPM" '{}'
expect_status 400 "finalise refuses lines without supplier or quantity"
expect_jq "(.problems | length) == 1 and .problems[0].id == $M22_L3" "and names them"
req PATCH "/api/job-records/$M22_J/materials/$M22_L3" "$DPM" '{"qty":10,"unit":"each","supplier":"M22 Hardware Co","brand":"Kethy"}'
expect_status 200 "fill in the handle"
req POST "/api/job-records/$M22_J/project/finalise" "$DPM" '{}'
expect_status 201 "finalise revision A"
expect_jq '.orderList.current.revision == "A" and .orderList.current.lineCount == 3 and .orderList.changed == false and .orderList.nextRevision == "B" and .orderList.current.sentAt == null' "revision A, 3 lines, unchanged"
req POST "/api/job-records/$M22_J/project/finalise" "$DPM" '{}'
expect_status 409 "nothing changed since A"
req GET "/api/job-records/$M22_J/project/order-lists/A" "$ACCT"
expect_status 200 "accounts reads revision A"
expect_jq '.revision == "A" and (.materials | length) == 1 and (.hardware | length) == 2 and .superseded == false and .job.owner == "CI Ordering"' "the frozen list"
expect_jq '([.hardware[] | select(.brand == "Blum" and .code == "71B3550")] | length) == 1' "brand and code frozen"
req GET "/api/job-records/$M22_J/project/order-lists/Z" "$DPM"
expect_status 404 "no revision Z"
# M23 (m23-contracts section 4): Send to Ordering needs a requested install date.
req PATCH "/api/job-records/$M22_J" "$DPM" '{"requestedInstallDate":"2030-03-04"}'
expect_status 200 "a requested install date for sending"

req PATCH "/api/job-records/$M22_J/materials/$M22_L1" "$DPM" '{"colour":"Natural Oak"}'
expect_status 200 "change a colour after finalising"
req GET "/api/job-records/$M22_J/project" "$DPM"
expect_jq '.orderList.changed == true and .orderList.current.revision == "A" and .orderList.nextRevision == "B"' "changed since A"
req POST "/api/job-records/$M22_J/project/send" "$DPM" '{}'
expect_status 409 "send refuses a changed list"
req POST "/api/job-records/$M22_J/project/finalise" "$DPM" '{}'
expect_status 201 "finalise revision B"
expect_jq '.orderList.current.revision == "B" and (.orderList.revisions | map(.revision)) == ["A","B"]' "revision B"
req GET "/api/job-records/$M22_J/project/order-lists/A" "$DPM"
expect_jq '.superseded == true and .materials[0].colour == "Black Wenge"' "A is superseded and keeps its colour"

echo "--- send to Ordering ---"
req POST "/api/job-records/$M22_J/project/send" "$ACCT" '{}'
expect_status 403 "accounts can't send"
req POST "/api/job-records/$M22_J/project/send" "$DPM" '{}'
expect_status 200 "dpm sends revision B"
expect_jq '.revision == "B" and .created == 3 and .skipped == 0 and .suppliers == ["M22 Boards Co","M22 Hardware Co"] and .job.pipelineStage == "ordering" and .orderList.current.sentAt != null' "3 order lines from 2 suppliers, the job at Ordering"
expect_jq '([.materials[], .hardware[]] | all(.ordered == true))' "every line is ordered"
req POST "/api/job-records/$M22_J/project/send" "$DPM" '{}'
expect_status 409 "B is already sent"
req GET "/api/orders?jobId=$M22_J" "$ORDR"
expect_status 200 "ordering lists the job's order lines"
expect_jq '(length == 3) and ([.[] | select(.supplier == "M22 Hardware Co" and (.description | startswith("Hinge soft close, Blum, 71B3550, 24 each")))] | length) == 1' "the hinge line carries brand, code and quantity"
expect_jq '([.[] | select(.supplier == "M22 Boards Co" and .description == "Board 16mm, Natural Oak, Matt, 12 sheets" and .status == "to_order")] | length) == 1' "the board line carries colour and finish"
req GET "/api/audit?action=project.send&entityId=$M22_J&limit=5" "$ADMIN"
expect_jq '(.rows | length) == 1 and .rows[0].after.revision == "B"' "send is audited"

# A new line after sending: revision C sends only it.
req POST "/api/job-records/$M22_J/materials" "$DPM" '{"section":"hardware","name":"Drawer runner","qty":4,"unit":"pairs","supplier":"M22 Hardware Co"}'
expect_status 201 "a line added after sending"
req DELETE "/api/job-records/$M22_J/materials/$M22_L1" "$DPM"
expect_status 409 "an ordered line can't be removed"
req POST "/api/job-records/$M22_J/project/finalise" "$DPM" '{}'
expect_status 201 "finalise revision C"
req POST "/api/job-records/$M22_J/project/send" "$DPM" '{}'
expect_status 200 "send revision C"
expect_jq '.revision == "C" and .created == 1 and .skipped == 3' "only the new line is ordered"

echo "--- job notes ---"
req PUT "/api/job-records/$M22_J/project/notes" "$ACCT" '{"notes":"x"}'
expect_status 403 "accounts can't write notes"
req PUT "/api/job-records/$M22_J/project/notes" "$DPM" "{\"notes\":\"$(printf 'n%.0s' $(seq 1 5001))\"}"
expect_status 400 "notes over 5000 characters"
req PUT "/api/job-records/$M22_J/project/notes" "$DPM" '{"notes":"Client wants soft close everywhere.\nCheck the pantry."}'
expect_status 200 "dpm writes notes"
expect_jq '.job.projectNotes == "Client wants soft close everywhere.\nCheck the pantry."' "kept as typed"

echo "--- hours: Joinr quoted and board person-days ---"
req POST /api/job-records "$ADMIN" "{\"name\":\"$M22_TAG hours job\",\"stage\":\"projects\"}"
expect_status 201 "a job for the hours"
M22_H=$(jqr '.id')
M22_ROOT="m22-hours-$M22_TAG"
M22_INTAKE=$(m22_exec "INSERT INTO joinr_intake (root_quote_id, quote_id, joinr_status, last_event, payload, state, job_id) VALUES (?, ?, 'won', 'won', ?, 'accepted', ?)" \
  "$M22_ROOT" "$M22_ROOT" "$(jq -nc --arg r "$M22_ROOT" '{rootQuoteId:$r, quoteId:$r, estimatedHours:{factory:10.5, site:4}, spec:{benchtop:"stone"}}')" "$M22_H") \
  || fail "inserting the joinr_intake row failed"
[ -n "$M22_INTAKE" ] || fail "no intake id"
ok
req POST /api/workers "$ADMIN" "{\"name\":\"M22 Hours Worker $M22_TAG\"}"
M22_HW=$(jqr '.id')
req POST /api/rows "$ADMIN" "{\"weekStart\":\"2020-03-02\",\"panel\":\"manufacturing\",\"jobId\":$M22_H}"
expect_status 201 "a past manufacturing row"
M22_R1=$(jqr '.rowId')
req POST "/api/rows/$M22_R1/assignments" "$ADMIN" "{\"day\":\"mon\",\"workerId\":$M22_HW}"
req POST "/api/rows/$M22_R1/assignments" "$ADMIN" "{\"day\":\"tue\",\"workerId\":$M22_HW}"
req POST /api/rows "$ADMIN" "{\"weekStart\":\"2034-03-06\",\"panel\":\"installing\",\"jobId\":$M22_H}"
expect_status 201 "a future installing row"
M22_R2=$(jqr '.rowId')
req POST "/api/rows/$M22_R2/assignments" "$ADMIN" "{\"day\":\"wed\",\"workerId\":$M22_HW}"
req GET "/api/job-records/$M22_H/project" "$DPM"
expect_status 200 "the hours job's project"
expect_jq '.hours.quotedFactoryMin == 1260 and .hours.quotedInstallMin == 480' "quoted hours from Joinr (doubled back)"
expect_jq '.hours.booked.manufacturing == {"toDate":2,"ahead":0} and .hours.booked.installing == {"toDate":0,"ahead":1}' "two person-days to date, one ahead"

echo "--- a Joinr line keeps syncing after its colour is set ---"
req POST "/api/job-records/$M22_H/materials/fill-from-joinr" "$DPM" '{}'
expect_status 200 "fill from Joinr"
M22_JL=$(jqr '[.lines[] | select(.source == "joinr" and .section == "benchtop")][0].id')
[ -n "$M22_JL" ] && [ "$M22_JL" != "null" ] || fail "no Joinr benchtop line"
ok
req PATCH "/api/job-records/$M22_H/materials/$M22_JL" "$DPM" '{"colour":"Calacatta","supplier":"M22 Stone Co"}'
expect_status 200 "set a Joinr line's colour and supplier"
expect_jq '.origin == "joinr" and .overridden == false and .colour == "Calacatta"' "still a Joinr line, not edited"
req PATCH "/api/job-records/$M22_H/materials/$M22_JL" "$DPM" '{"qty":2}'
expect_jq '.origin == "edited"' "a quantity edit still marks it edited"

echo "--- Accept from Joinr with an owner ---"
M22_NROOT="m22-new-$M22_TAG"
M22_NEW=$(m22_exec "INSERT INTO joinr_intake (root_quote_id, quote_id, quote_number, joinr_status, last_event, payload, state) VALUES (?, ?, ?, 'won', 'won', ?, 'new')" \
  "$M22_NROOT" "$M22_NROOT" "M22-$M22_TAG" "$(jq -nc --arg r "$M22_NROOT" '{rootQuoteId:$r, quoteId:$r, clientName:"M22 Accept Client", siteAddress:"22 Made Up Road"}')") \
  || fail "inserting the new intake row failed"
ok
req POST "/api/joinr/intake/$M22_NEW/accept" "$DPM" "{\"ownerId\":$ACCT_ID}"
expect_status 400 "accept refuses an owner without Projects access"
req GET "/api/joinr/intake/$M22_NEW" "$DPM"
expect_jq '.state == "new"' "nothing was accepted"
req POST "/api/joinr/intake/$M22_NEW/accept" "$DPM" "{\"ownerId\":$ORDR_ID}"
expect_status 200 "accept with an owner"
M22_AJ=$(jqr '.job.id')
req GET "/api/job-records/$M22_AJ" "$DPM"
expect_jq ".pipelineStage == \"projects\" and .owner.id == $ORDR_ID" "the accepted job has its owner (and M23 moved it to Projects)"

echo "--- unlink the worker again ---"
req PUT "/api/users/$ORDR_ID/worker" "$ADMIN" '{"workerId":null}'
expect_status 200 "unlink the Ordering login"
