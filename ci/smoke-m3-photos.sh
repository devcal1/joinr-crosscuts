# M3 smoke, Wave 1 C: photos and tags.
# Sourced by ci/smoke.sh after the M2 suites, so it shares that script's helpers
# (step, req, expect_*, jqr, audit_total, create_user), the cookie jars
# ($ADMIN $SCHED $ACCT $DPM $SHOW), $WORK, $BASE, $REQ_ORIGIN, $BODY_FILE and
# $CONTAINER. Not run on its own. It does not assume a pristine database: it
# creates its own job, photos and user, and checks only those.
# Step c's upload, orientation-6 and empty-list checks are not touched here.

# ============================================================================
step "m3-c. photos and tags"
# ============================================================================

# m3c_count: sets M3C_COUNT, the number of photos admin can list.
m3c_count() {
  req GET /api/photos "$ADMIN"
  expect_status 200 "GET /api/photos (count)"
  M3C_COUNT=$(jqr 'length')
}

# m3c_files: sets M3C_FILES, the number of files in the uploads directory.
m3c_files() {
  M3C_FILES=$(docker exec "$CONTAINER" sh -c 'ls /data/uploads | wc -l' | tr -d ' \r')
}

# m3c_upload JAR TAGS [JOB_ID]: multipart upload of the 1x1 test PNG from step c.
# Sets STATUS and BODY like req.
m3c_upload() {
  local jar=$1 tags=$2 job=${3:-}
  local -a args=(-s -o "$BODY_FILE" -w '%{http_code}' -H "Origin: $REQ_ORIGIN" -b "$jar" \
    -F "photos=@$WORK/test.png;type=image/png" -F "tags=$tags")
  if [ -n "$job" ]; then args+=(-F "jobId=$job"); fi
  LAST_REQ="POST /api/photos"
  STATUS=$(curl "${args[@]}" "$BASE/api/photos")
  BODY=$(cat "$BODY_FILE")
}

req POST /api/job-records "$DPM" '{"name":"CI M3 Photo Job"}'
expect_status 201 "dpm creates the photo job"
M3C_JOB=$(jqr '.id')

echo "--- who may upload, and who may read the tag counts ---"
m3c_upload "$SHOW" "m3 nope"
expect_status 403 "show POST /api/photos"
req GET /api/photos/tags "$SCHED"
expect_status 200 "sched GET /api/photos/tags"

echo "--- upload, tidy tags and the job link ---"
m3c_count
M3C_BASE=$M3C_COUNT

m3c_upload "$ADMIN" ' M3Kitchen, m3kitchen ,M3 Oak,,' "$M3C_JOB"
expect_status 201 "admin uploads with a job and untidy tags"
expect_jq '.failed | length == 0' "the upload has no failures"
expect_jq '.created[0].tags == "m3kitchen, m3 oak"' "upload tags are trimmed, lowercased and de-duplicated"
expect_jq ".created[0].jobId == $M3C_JOB and .created[0].jobName == \"CI M3 Photo Job\"" "the upload response names the job"
M3C_P1=$(jqr '.created[0].id')

echo "--- a bad job is refused before any file is processed ---"
m3c_count
M3C_BEFORE=$M3C_COUNT
m3c_files
M3C_FILES_BEFORE=$M3C_FILES
m3c_upload "$ADMIN" "m3 bad" 999999
expect_status 400 "upload with a job that does not exist"
expect_jq '.error == "No such job"' "the refusal says No such job"
m3c_upload "$ADMIN" "m3 bad" abc
expect_status 400 "upload with a job id that is not a number"
m3c_count
expect_eq "$M3C_COUNT" "$M3C_BEFORE" "the photo count is unchanged after the refused uploads"
m3c_files
expect_eq "$M3C_FILES" "$M3C_FILES_BEFORE" "the refused uploads left no files behind"

m3c_upload "$ADMIN" "M3KITCHEN"
expect_status 201 "admin uploads a second photo with no job"
expect_jq '.created[0].tags == "m3kitchen"' "second photo tags are lowercased"
expect_jq '.created[0] | has("jobId") and .jobId == null' "a photo with no job has jobId null for a jobs.view holder"
M3C_P2=$(jqr '.created[0].id')

echo "--- tag counts ---"
req GET /api/photos/tags "$SHOW"
expect_status 200 "show GET /api/photos/tags"
expect_jq 'any(.[]; .tag == "m3kitchen" and .count == 2)' "m3kitchen is counted for both photos"
expect_jq 'any(.[]; .tag == "m3 oak" and .count == 1)' "m3 oak is counted once"
expect_jq 'all(.[]; .tag == (.tag | ascii_downcase))' "no mixed-case tag is listed"

echo "--- the showroom never sees the job ---"
req GET /api/photos "$SHOW"
expect_status 200 "show GET /api/photos"
expect_jq 'length >= 2' "show lists the photos"
expect_jq 'all(.[]; (has("jobId") or has("jobName")) | not)' "show sees no jobId or jobName"
expect_jq 'all(.[]; keys == ["createdAt","height","id","tags","thumbUrl","url","width"])' "show sees exactly the old photo shape"
req GET /api/photos "$DPM"
expect_status 200 "dpm GET /api/photos"
expect_jq "map(select(.id == $M3C_P1)) | .[0] | .jobId == $M3C_JOB and .jobName == \"CI M3 Photo Job\"" "dpm sees the linked photo's job"
req GET "/api/photos?jobId=$M3C_JOB" "$DPM"
expect_status 200 "dpm GET /api/photos?jobId="
expect_jq "length == 1 and .[0].id == $M3C_P1" "the job filter returns exactly the linked photo"
req GET "/api/photos?jobId=$M3C_JOB" "$SHOW"
expect_status 403 "show GET /api/photos?jobId="
req GET "/api/photos?jobId=abc" "$DPM"
expect_status 400 "dpm GET /api/photos?jobId=abc"
req GET "/api/photos?jobId=999999" "$DPM"
expect_status 200 "dpm GET /api/photos?jobId= for a job with no photos"
expect_jq 'length == 0' "a job with no photos lists none"

echo "--- editing the link and the tags ---"
req PATCH "/api/photos/$M3C_P1" "$DPM" '{"jobId":null}'
expect_status 200 "dpm clears the job"
expect_jq 'has("jobId") and .jobId == null and .jobName == null' "the job is cleared"
req PATCH "/api/photos/$M3C_P1" "$DPM" "{\"jobId\":$M3C_JOB}"
expect_status 200 "dpm links the job again"
expect_jq ".jobId == $M3C_JOB and .jobName == \"CI M3 Photo Job\"" "the job is linked again"
req PATCH "/api/photos/$M3C_P1" "$DPM" '{"jobId":999999}'
expect_status 400 "dpm links a job that does not exist"
req PATCH "/api/photos/$M3C_P1" "$DPM" '{"tags":"B, a, b"}'
expect_status 200 "dpm edits the tags"
expect_jq '.tags == "b, a"' "edited tags are tidied"
req PATCH "/api/photos/$M3C_P1" "$SHOW" '{"tags":"m3 show"}'
expect_status 403 "show PATCH /api/photos/:id"
req PATCH "/api/photos/$M3C_P1" "$SCHED" '{"tags":"m3 sched"}'
expect_status 403 "sched PATCH /api/photos/:id"
req PATCH "/api/photos/999999" "$DPM" '{"tags":"x"}'
expect_status 404 "dpm PATCH a photo that does not exist"

echo "--- photos.admin without jobs.view cannot touch jobs ---"
create_user m3cphoto "CI M3 Photo Admin" 'M3c-Passw0rd-1' showroom
M3C_USER=$CREATED_ID
req PUT "/api/users/$M3C_USER/overrides/photos.admin" "$ADMIN" '{"effect":"grant"}'
expect_status 200 "admin grants photos.admin to the m3cphoto user"
M3C_JAR="$WORK/jar-m3cphoto"
new_jar "$M3C_JAR"
login "$M3C_JAR" m3cphoto 'M3c-Passw0rd-1'
expect_status 200 "login m3cphoto"
own_password "$M3C_JAR" 'M3c-Passw0rd-1' 'M3c-Passw0rd-2'
m3c_count
M3C_BEFORE=$M3C_COUNT
m3c_files
M3C_FILES_BEFORE=$M3C_FILES
m3c_upload "$M3C_JAR" "m3 nojob" "$M3C_JOB"
expect_status 403 "upload with a job id and no jobs.view"
m3c_count
expect_eq "$M3C_COUNT" "$M3C_BEFORE" "the photo count is unchanged after the forbidden upload"
m3c_files
expect_eq "$M3C_FILES" "$M3C_FILES_BEFORE" "the forbidden upload left no files behind"
m3c_upload "$M3C_JAR" "m3 nojob"
expect_status 201 "the same user uploads with no job"
expect_jq '.created[0] | (has("jobId") or has("jobName")) | not' "the upload response has no job keys without jobs.view"
M3C_P3=$(jqr '.created[0].id')
req PATCH "/api/photos/$M3C_P3" "$M3C_JAR" "{\"jobId\":$M3C_JOB}"
expect_status 403 "PATCH jobId without jobs.view"
req PATCH "/api/photos/$M3C_P3" "$M3C_JAR" '{"tags":"m3 nojob, m3 edited"}'
expect_status 200 "PATCH tags without jobs.view"
expect_jq '(has("jobId") or has("jobName")) | not' "the PATCH response has no job keys without jobs.view"

echo "--- audit rows ---"
audit_total photo.upload
[ "$AUDIT_TOTAL" -ge 3 ] || fail "expected at least 3 photo.upload audit rows, got $AUDIT_TOTAL"
ok
audit_total photo.tags
[ "$AUDIT_TOTAL" -ge 2 ] || fail "expected at least 2 photo.tags audit rows, got $AUDIT_TOTAL"
ok
audit_total photo.link
[ "$AUDIT_TOTAL" -ge 2 ] || fail "expected at least 2 photo.link audit rows, got $AUDIT_TOTAL"
ok

echo "--- delete ---"
for p in "$M3C_P1" "$M3C_P2" "$M3C_P3"; do
  req DELETE "/api/photos/$p" "$ADMIN"
  expect_status 204 "admin deletes photo $p"
done
req DELETE "/api/photos/$M3C_P1" "$ADMIN"
expect_status 404 "deleting a photo twice"
audit_total photo.delete
[ "$AUDIT_TOTAL" -ge 3 ] || fail "expected at least 3 photo.delete audit rows, got $AUDIT_TOTAL"
ok
m3c_count
expect_eq "$M3C_COUNT" "$M3C_BASE" "the photo count is back to where it started"
req GET /api/photos/tags "$ADMIN"
expect_status 200 "GET /api/photos/tags after the deletes"
expect_jq 'all(.[]; (.tag | contains("m3")) | not)' "the deleted photos' tags are no longer counted"
