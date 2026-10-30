# Jobs as containers, Tradify style (0.2.8, docs/plans/jobs-tradify-contracts.md section 6.1): job numbers
# (migration 051's backfill and trigger), the job.unassigned alert on a won quote, the project manager
# alert, the jobs list filters and last activity, notes (own-only edit, author or admin soft delete,
# audited), note files (private, never in the photo library), and the job and jobs pages.
# Sourced by ci/smoke.sh after the M28 suites, so it shares that script's helpers, cookie jars and the
# M6 stand-in Joinr helpers (m6_fake, m6_event, m6_sync). No shebang and no `set`: the caller owns both.
# Made-up names only; it reads only its own rows (and checks every job's number is unique).

# ============================================================================
step "jobs-tradify. job numbers, PM alerts, list filters, notes and note files"
# ============================================================================

JT_TAG="jt$(date +%s)"

# jt_sql SQL -> rows as JSON (read-only connection).
jt_sql() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const db = new D("/data/db/photos.db", { readonly: true });
process.stdout.write(JSON.stringify(db.prepare(process.argv[1]).all()));' "$1"
}

# jt_upload JAR JOB NOTE FILE NAME TYPE -> STATUS, BODY
jt_upload() {
  LAST_REQ="POST /api/job-records/$2/notes/$3/files ($5)"
  STATUS=$(curl -s -o "$BODY_FILE" -D "$HDR_FILE" -w '%{http_code}' -X POST -H "Origin: $REQ_ORIGIN" \
    -b "$1" -c "$1" -F "file=@$4;filename=$5;type=$6" "$BASE/api/job-records/$2/notes/$3/files")
  BODY=$(cat "$BODY_FILE")
}

# jt_alerts JAR KIND LINK -> how many alerts of KIND with LINK the login has
jt_alerts() {
  req GET "/api/notifications?limit=200" "$1"
  expect_status 200 "notifications"
  jqr "[.rows[] | select(.kind == \"$2\" and .link == \"$3\")] | length"
}
jt_kind_count() { # JAR KIND -> how many alerts of KIND the login has
  req GET "/api/notifications?limit=200" "$1"
  expect_status 200 "notifications"
  jqr "[.rows[] | select(.kind == \"$2\")] | length"
}

req GET /api/auth/me "$ADMIN"; JT_ADMIN_ID=$(jqr '.user.id')
req GET /api/auth/me "$DPM";   JT_DPM_ID=$(jqr '.user.id')
req GET /api/auth/me "$ACCT";  JT_ACCT_ID=$(jqr '.user.id')
req GET /api/auth/me "$ORDR";  JT_ORDR_ID=$(jqr '.user.id')

echo "--- 1. job numbers ---"
expect_eq "$(jt_sql "SELECT COUNT(*) AS n FROM jobs WHERE job_number IS NULL OR trim(job_number) = ''" | jq -r '.[0].n')" "0" \
  "every job from earlier suites has a job number"
expect_eq "$(jt_sql "SELECT COUNT(*) - COUNT(DISTINCT upper(job_number)) AS d FROM jobs" | jq -r '.[0].d')" "0" \
  "job numbers are unique (case-insensitive)"
req POST /api/job-records "$DPM" "{\"name\":\"$JT_TAG hand made\"}"
expect_status 201 "a hand-made job"
JT_HAND=$(jqr '.id')
expect_eq "$(jqr '.jobNumber')" "$(printf 'J-%04d' "$JT_HAND")" "a hand-made job is J- plus its padded id"
req POST /api/job-records "$DPM" "{\"name\":\"$JT_TAG quoted A\",\"quoteNumber\":\" $JT_TAG-Q1 \"}"
expect_status 201 "a job with a quote number"
JT_QA=$(jqr '.id')
expect_eq "$(jqr '.jobNumber')" "$JT_TAG-Q1" "its job number is the trimmed quote number"
req POST /api/job-records "$DPM" "{\"name\":\"$JT_TAG quoted B\",\"quoteNumber\":\"$(echo "$JT_TAG-q1" | tr a-z A-Z)\"}"
expect_status 201 "a second job with the same quote number (other case)"
JT_QB=$(jqr '.id')
expect_eq "$(jqr '.jobNumber')" "$(printf 'J-%04d' "$JT_QB")" "a quote number already held takes the J- branch"
req POST /api/job-records "$DPM" "{\"name\":\"$JT_TAG typed J\",\"quoteNumber\":\"J-9999\"}"
expect_status 201 "a job whose quote number starts J-"
JT_TJ=$(jqr '.id')
expect_eq "$(jqr '.jobNumber')" "$(printf 'J-%04d' "$JT_TJ")" "a typed J- quote number takes the J- branch"
req PATCH "/api/job-records/$JT_HAND" "$DPM" "{\"quoteNumber\":\"$JT_TAG-LATER\"}"
expect_status 200 "a quote number typed later"
expect_eq "$(jqr '.jobNumber')" "$(printf 'J-%04d' "$JT_HAND")" "the job number is fixed at insert"

echo "--- 2. a won quote with no project manager ---"
JT_FAKE_PORT=4999
docker cp "$(dirname "$0")/fake-joinr.js" "$CONTAINER":/tmp/fake-joinr.js
docker exec -d "$CONTAINER" node /tmp/fake-joinr.js "$JT_FAKE_PORT" "$M6_KEY"
for _ in $(seq 1 50); do
  docker exec "$CONTAINER" node -e 'fetch("http://127.0.0.1:4999/_control/requests").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' && break
  sleep 0.2
done
req PUT /api/joinr/settings "$ADMIN" "{\"baseUrl\":\"$M6_BASE_URL\",\"apiKey\":\"$M6_KEY\"}"
expect_status 200 "admin points Crosscuts at the stand-in again"
m6_sync "$DPM" "the first sync after set-up"
JT_ROOT1=a7000000-0000-4000-8000-000000000001
JT_ROOT2=a7000000-0000-4000-8000-000000000002
JT_UNASSIGNED_ADMIN_BEFORE=$(jt_kind_count "$ADMIN" job.unassigned)
m6_event "$JT_ROOT1" "$JT_ROOT1" won won "{\"quoteNumber\":\"$JT_TAG-W1\",\"siteAddress\":\"1 Made-up St\",\"clientName\":\"JT Client One\"}"
m6_sync "$DPM" "sync the won quote"
JT_W1=$(jt_sql "SELECT job_id AS v FROM joinr_intake WHERE root_quote_id = '$JT_ROOT1'" | jq -r '.[0].v // "null"')
[ "$JT_W1" != "null" ] || fail "the won quote made a job"
ok
req GET "/api/job-records/$JT_W1" "$DPM"
expect_jq ".stage == \"won\" and .jobNumber == \"$JT_TAG-W1\" and .projectOwnerId == null and .projectManager == null" \
  "a Won job numbered by its Joinr quote number, no project manager"
for jar in "$ADMIN" "$DPM" "$ORDR"; do
  expect_eq "$(jt_alerts "$jar" job.unassigned "/job.html?id=$JT_W1")" "1" "each design.view holder gets one job.unassigned"
done
req GET "/api/notifications?limit=200" "$DPM"
expect_jq "[.rows[] | select(.kind == \"job.unassigned\" and .link == \"/job.html?id=$JT_W1\")][0].title | startswith(\"New job from Joinr: \")" "the alert title"
expect_jq "[.rows[] | select(.kind == \"job.unassigned\" and .link == \"/job.html?id=$JT_W1\")][0].body == \"$JT_TAG-W1 · JT Client One. No project manager yet.\"" "the alert's body"
expect_eq "$(jt_alerts "$ACCT" job.unassigned "/job.html?id=$JT_W1")" "0" "accounts (no design.view) is not told"
# The clash: two live jobs hold the quote number, so the won quote waits in the inbox, and nobody is told.
req POST /api/job-records "$DPM" "{\"name\":\"$JT_TAG clash 1\",\"quoteNumber\":\"$JT_TAG-W2\"}"
expect_status 201 "clash job 1"
req POST /api/job-records "$DPM" "{\"name\":\"$JT_TAG clash 2\",\"quoteNumber\":\"$JT_TAG-W2\"}"
expect_status 201 "clash job 2"
JT_UNASSIGNED_ADMIN_MID=$(jt_kind_count "$ADMIN" job.unassigned)
m6_event "$JT_ROOT2" "$JT_ROOT2" won won "{\"quoteNumber\":\"$JT_TAG-W2\",\"siteAddress\":\"2 Made-up St\",\"clientName\":\"JT Client Two\"}"
m6_sync "$DPM" "sync the clashing won quote"
expect_eq "$(jt_sql "SELECT state AS v FROM joinr_intake WHERE root_quote_id = '$JT_ROOT2'" | jq -r '.[0].v // "null"')" "new" \
  "a won quote matching two jobs stays in the inbox"
expect_eq "$(jt_kind_count "$ADMIN" job.unassigned)" "$JT_UNASSIGNED_ADMIN_MID" "and sends no job.unassigned"
[ "$JT_UNASSIGNED_ADMIN_MID" -gt "$JT_UNASSIGNED_ADMIN_BEFORE" ] || fail "the first won quote's alert reached the admin"
ok
m6_fake POST /_control/stop
docker exec "$CONTAINER" rm -f /data/config/joinr-api-key /data/config/joinr-base-url

echo "--- 3. the project manager ---"
req PUT "/api/job-records/$JT_W1/owner" "$SHOW" "{\"ownerId\":$JT_DPM_ID}"
expect_status 403 "showroom can't set the project manager"
req PUT "/api/job-records/$JT_W1/owner" "$DPM" "{\"ownerId\":$JT_ACCT_ID}"
expect_status 400 "a user without design.view can't be project manager"
req PUT "/api/job-records/$JT_W1/owner" "$DPM" "{\"ownerId\":$JT_DPM_ID}"
expect_status 200 "dpm makes themselves project manager"
expect_eq "$(jt_alerts "$DPM" job.pm_assigned "/job.html?id=$JT_W1")" "0" "self-assigning sends nothing"
req PUT "/api/job-records/$JT_QA/owner" "$DPM" "{\"ownerId\":$JT_ADMIN_ID}"
expect_status 200 "dpm makes admin project manager of another job"
expect_eq "$(jt_alerts "$ADMIN" job.pm_assigned "/job.html?id=$JT_QA")" "1" "the new project manager gets one job.pm_assigned"
req GET "/api/notifications?limit=200" "$ADMIN"
expect_jq "[.rows[] | select(.kind == \"job.pm_assigned\" and .link == \"/job.html?id=$JT_QA\")][0].title == \"You are project manager for $JT_TAG quoted A\"" "its title"
req PUT "/api/job-records/$JT_QA/owner" "$DPM" "{\"ownerId\":$JT_ADMIN_ID}"
expect_status 200 "the same project manager again"
expect_eq "$(jt_alerts "$ADMIN" job.pm_assigned "/job.html?id=$JT_QA")" "1" "setting the same PM again sends nothing"

echo "--- 4. the jobs list ---"
req GET "/api/job-records?mine=1" "$DPM"
expect_status 200 "mine=1"
expect_jq "(map(.id) | index($JT_W1)) != null and (map(.id) | index($JT_QA)) == null and all(.projectOwnerId == $JT_DPM_ID)" "mine: only the caller's jobs"
expect_jq "[.[] | select(.id == $JT_W1)][0].projectManager.id == $JT_DPM_ID" "projectManager on a row"
req GET "/api/job-records?unassigned=1" "$DPM"
expect_status 200 "unassigned=1"
expect_jq "(map(.id) | index($JT_HAND)) != null and (map(.id) | index($JT_W1)) == null and all(.projectOwnerId == null and .archived == false and ([.stage] | inside([\"complete\",\"invoiced\",\"lost\",\"archived\"]) | not))" "unassigned: live jobs with no PM"
req GET "/api/job-records?mine=1&unassigned=1" "$DPM"
expect_status 400 "mine and unassigned together"
req GET "/api/job-records?mine=yes" "$DPM"
expect_status 400 "a bad mine value"
req GET "/api/job-records?unassigned=0" "$DPM"
expect_status 400 "a bad unassigned value"
req GET "/api/job-records?q=$JT_TAG-W1" "$DPM"
expect_jq "map(.id) == [$JT_W1]" "q finds a job by its job number"
req GET "/api/job-records?q=$(printf 'J-%04d' "$JT_HAND")" "$DPM"
expect_jq "(map(.id) | index($JT_HAND)) != null" "q finds a J- number"
req GET "/api/job-records/$JT_HAND" "$DPM"
JT_ACT0=$(jqr '.lastActivityAt')
[ "$JT_ACT0" != "null" ] || fail "lastActivityAt is set"
ok
sleep 1.1

echo "--- 5. notes ---"
req POST "/api/job-records/$JT_HAND/notes" "$DPM" '{"body":"  First note from dpm.\nSecond line.  "}'
expect_status 201 "dpm adds a note"
JT_N1=$(jqr '.id')
expect_jq ".body == \"First note from dpm.\\nSecond line.\" and .author.id == $JT_DPM_ID and .editedAt == null and .canEdit == true and .canDelete == true and .files == [] and .jobId == $JT_HAND" "the note, trimmed"
req GET "/api/job-records/$JT_HAND" "$DPM"
expect_jq ".lastActivityAt > \"$JT_ACT0\"" "a note moves last activity"
req POST "/api/job-records/$JT_HAND/notes" "$ACCT" '{"body":"Accounts can add a note too."}'
expect_status 201 "accounts (jobs.view, no jobs.edit) adds a note"
JT_N2=$(jqr '.id')
req POST "/api/job-records/$JT_HAND/notes" "$SHOW" '{"body":"x"}'
expect_status 403 "showroom (no jobs.view) can't"
req GET "/api/job-records/$JT_HAND/notes" "$SHOW"
expect_status 403 "or read them"
req POST "/api/job-records/$JT_HAND/notes" "$DPM" '{"body":"   "}'
expect_status 400 "an empty note"
req POST "/api/job-records/$JT_HAND/notes" "$DPM" "{\"body\":\"$(head -c 5001 /dev/zero | tr '\0' 'a')\"}"
expect_status 400 "a 5001-character note"
req POST "/api/job-records/999999/notes" "$DPM" '{"body":"x"}'
expect_status 404 "no job"
req GET "/api/job-records/$JT_HAND/notes" "$DPM"
expect_status 200 "the notes"
expect_jq ".notes | map(.id) == [$JT_N2, $JT_N1]" "newest first"
expect_jq ".notes[0].canEdit == false and .notes[0].canDelete == false and .notes[1].canEdit == true" "dpm may edit only their own"
req PATCH "/api/job-records/$JT_HAND/notes/$JT_N1" "$DPM" '{"body":"First note, edited."}'
expect_status 200 "the author edits"
expect_jq '.body == "First note, edited." and .editedAt != null' "edited, with editedAt"
req GET "/api/audit?action=job.note_edit&limit=5" "$ADMIN"
expect_jq "[.rows[] | select(.entityId == $JT_N1 or .entityId == \"$JT_N1\")][0] | .before.body == \"First note from dpm.\\nSecond line.\" and .after.body == \"First note, edited.\"" "the edit is audited before and after"
req PATCH "/api/job-records/$JT_HAND/notes/$JT_N2" "$DPM" '{"body":"not mine"}'
expect_status 403 "another's note can't be edited"
req PATCH "/api/job-records/$JT_HAND/notes/$JT_N2" "$ADMIN" '{"body":"not mine either"}'
expect_status 403 "not even by an admin"
req DELETE "/api/job-records/$JT_HAND/notes/$JT_N2" "$DPM"
expect_status 403 "a non-admin can't delete another's note"
req DELETE "/api/job-records/$JT_HAND/notes/$JT_N2" "$ADMIN"
expect_status 200 "an admin soft-deletes any note"
expect_jq '.ok == true' "ok"
req GET "/api/audit?action=job.note_delete&limit=5" "$ADMIN"
expect_jq "[.rows[] | select(.entityId == $JT_N2 or .entityId == \"$JT_N2\")][0] | .before.body == \"Accounts can add a note too.\" and .before.byAdmin == true" "audited with byAdmin"
req GET "/api/job-records/$JT_HAND/notes" "$DPM"
expect_jq ".notes | map(.id) == [$JT_N1]" "the deleted note is gone"
req PATCH "/api/job-records/$JT_HAND/notes/$JT_N2" "$ACCT" '{"body":"back?"}'
expect_status 404 "a deleted note can't be edited"
expect_eq "$(jt_sql "SELECT deleted_by AS v FROM job_notes WHERE id = $JT_N2" | jq -r '.[0].v')" "$JT_ADMIN_ID" "deleted_by is kept"

echo "--- 6. note files ---"
printf '%s' "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" | base64 -d > "$WORK/jt.png"
printf '<html><body>not an image</body></html>' > "$WORK/jt-fake.png"
head -c 26214401 /dev/zero > "$WORK/jt-big.bin"
printf '\x89PNG\r\n\x1a\n' | dd of="$WORK/jt-big.bin" conv=notrunc 2>/dev/null
req GET /api/photos "$ADMIN"
JT_PHOTOS=$(jqr 'length')
JT_PHOTO_ROWS=$(jt_sql "SELECT COUNT(*) AS n FROM photos" | jq -r '.[0].n')
req POST "/api/job-records/$JT_HAND/notes" "$DPM" '{"body":"A note with a photo."}'
expect_status 201 "a note for files"
JT_N3=$(jqr '.id')
jt_upload "$DPM" "$JT_HAND" "$JT_N3" "$WORK/jt.png" "site.png" image/png
expect_status 201 "a PNG on the note"
JT_F1=$(jqr '.files[0].id')
expect_jq ".files | length == 1 and .[0].image == true and .[0].mime == \"image/png\" and .[0].url == \"/api/files/$JT_F1\" and .[0].name == \"site.png\"" "the file on the note"
jt_upload "$DPM" "$JT_HAND" "$JT_N3" "$WORK/jt-fake.png" "fake.png" image/png
expect_status 400 "a renamed non-image is refused"
jt_upload "$DPM" "$JT_HAND" "$JT_N3" "$WORK/jt-big.bin" "big.png" image/png
expect_status 400 "over 25 MB is refused"
expect_jq '.error | test("too big")' "as lib/files answers"
jt_upload "$ACCT" "$JT_HAND" "$JT_N3" "$WORK/jt.png" "x.png" image/png
expect_status 403 "only the author adds files"
req GET "/api/files/$JT_F1" "$ACCT"
expect_status 200 "served to a jobs.view holder"
req GET "/api/files/$JT_F1" "$SHOW"
expect_status 404 "not to a login without jobs.view"
req GET /api/photos "$ADMIN"
expect_eq "$(jqr 'length')" "$JT_PHOTOS" "GET /api/photos doesn't list a note file"
case $BODY in *"site.png"*) fail "the note file is in the photo library" ;; *) ok ;; esac
req GET "/api/photos?jobId=$JT_HAND" "$ADMIN"
expect_jq 'length == 0' "nor does ?jobId=N"
expect_eq "$(jt_sql "SELECT COUNT(*) AS n FROM photos" | jq -r '.[0].n')" "$JT_PHOTO_ROWS" "no photos row was written"
for i in 2 3 4 5 6 7 8 9 10; do
  jt_upload "$DPM" "$JT_HAND" "$JT_N3" "$WORK/jt.png" "site$i.png" image/png
  expect_status 201 "file $i on the note"
done
jt_upload "$DPM" "$JT_HAND" "$JT_N3" "$WORK/jt.png" "site11.png" image/png
expect_status 409 "an 11th file is refused"
JT_F2=$(jt_sql "SELECT file_id AS v FROM job_note_files WHERE note_id = $JT_N3 ORDER BY file_id DESC LIMIT 1" | jq -r '.[0].v')
req DELETE "/api/job-records/$JT_HAND/notes/$JT_N3/files/$JT_F2" "$ACCT"
expect_status 403 "another login can't remove a file"
req DELETE "/api/job-records/$JT_HAND/notes/$JT_N3/files/$JT_F2" "$DPM"
expect_status 200 "the author removes a file"
expect_jq '.files | length == 9' "nine left"
req DELETE "/api/job-records/$JT_HAND/notes/$JT_N3" "$DPM"
expect_status 200 "the author deletes the note"
req GET "/api/files/$JT_F1" "$ACCT"
expect_status 404 "its files are 404 once the note is deleted"
expect_eq "$(jt_sql "SELECT COUNT(*) AS n FROM files f JOIN job_note_files j ON j.file_id = f.id WHERE j.note_id = $JT_N3 AND f.removed_at IS NULL" | jq -r '.[0].n')" "0" \
  "and are marked removed"

echo "--- 7. pages ---"
req GET /job.html "$DPM"
expect_status 200 "job.html"
case $BODY in *'id="pjOwner"'*'projectowner.js'*) ok ;; *) fail "job.html: pjOwner before projectowner.js" ;; esac
case $BODY in *'id="issues"'*'jobissues.js'*) ok ;; *) fail "job.html: issues before jobissues.js" ;; esac
case $BODY in *'id="confirmComplete"'*'confirmcomplete.js'*) ok ;; *) fail "job.html: confirmComplete before confirmcomplete.js" ;; esac
case $BODY in *'id="reservations"'*'jobreserve.js'*) ok ;; *) fail "job.html: reservations before jobreserve.js" ;; esac
case $BODY in *'id="jobNotes"'*'jobnotes.js'*'jobtabs.js'*'/shell/shell.js'*) ok ;; *) fail "job.html: jobNotes, jobnotes.js and jobtabs.js before the shell" ;; esac
req GET /jobs.html "$DPM"
expect_status 200 "jobs.html"
case $BODY in *'id="rows"'*'jobs.js'*) ok ;; *) fail "jobs.html: rows and jobs.js" ;; esac
