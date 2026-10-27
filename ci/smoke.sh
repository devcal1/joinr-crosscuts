#!/usr/bin/env bash
# Crosscuts smoke test. Runs against a built image; needs docker, curl and jq.
#
#   ci/smoke.sh <image>        e.g. ci/smoke.sh crosscuts-web:smoke-test
#
# The image is started with a fresh temp host directory mounted at /data/db,
# /data/uploads and /data/config on port 3000. Steps (in order):
#   0  runtime versions (Node major, better-sqlite3) match the source; 7-Zip and
#      rsync run in the image and no popt alias file exists
#   a  first-run setup            b  logged-out sweep (every routed API, pages)
#   c  photo + schedule suite     d  one user per role preset, overrides
#   e  wrong password / lockout   f  remember-me cookie lifetime
#   g  PIN lock / unlock          h  foreign Origin refused
#   i  audit log                  j  default week is the Sydney Monday
#   k  cutover rehearsal: old public image -> this image on the same volume
#
# Env: OLD_IMAGE (default ghcr.io/devcal1/thcabinets-web:latest) is the
# pre-Crosscuts image used by the rehearsal.
#
# On any failure the container logs are printed and the script exits non-zero.
# Containers and temp dirs are always cleaned up.
set -Eeuo pipefail
trap 'on_err "$LINENO" "$BASH_COMMAND"' ERR

IMAGE=${1:?usage: ci/smoke.sh <image>}
OLD_IMAGE=${OLD_IMAGE:-ghcr.io/devcal1/thcabinets-web:latest}
PORT=3000
BASE="http://localhost:$PORT"
ORIGIN_OK="http://localhost:$PORT"
REQ_ORIGIN=$ORIGIN_OK   # overridden for the foreign-Origin check

CONTAINER=crosscuts-smoke
OLD_CONTAINER=crosscuts-smoke-old
RH_CONTAINER=crosscuts-smoke-rehearsal
CONTAINERS=("$CONTAINER" "$OLD_CONTAINER" "$RH_CONTAINER")

WORK=$(mktemp -d)
DATA="$WORK/data"
mkdir -p "$DATA/db" "$DATA/uploads" "$DATA/config"
CI_BODY="$WORK/ci-body.json"
BODY_FILE="$WORK/resp-body"
HDR_FILE="$WORK/resp-headers"

STATUS=""
BODY=""
LAST_REQ=""
PASS=0

# ---------------------------------------------------------------- cleanup ---

cleanup() {
  local rc=$?
  set +e
  if [ "$rc" -ne 0 ]; then
    echo >&2
    echo "=== SMOKE TEST FAILED (exit $rc) ===" >&2
    local c
    for c in "${CONTAINERS[@]}"; do
      if docker inspect "$c" >/dev/null 2>&1; then
        echo "=== docker logs $c ===" >&2
        docker logs "$c" >&2 2>&1
        gh_error "docker logs $c (last 40 lines):
$(docker logs --tail 40 "$c" 2>&1)"
      fi
    done
  fi
  docker rm -f "${CONTAINERS[@]}" >/dev/null 2>&1
  # Files written by the containers are owned by root.
  rm -rf "$WORK" 2>/dev/null || sudo -n rm -rf "$WORK" 2>/dev/null
  exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------- helpers ---

# GitHub Actions turns "::error::" lines into annotations, which (unlike the job log) can be
# read without signing in to GitHub. Newlines and % must be escaped; long text is cut.
gh_error() {
  [ -n "${GITHUB_ACTIONS:-}" ] || return 0
  local msg=${1:0:3500}
  msg=${msg//'%'/'%25'}
  msg=${msg//$'\r'/'%0D'}
  msg=${msg//$'\n'/'%0A'}
  echo "::error title=smoke::${msg}"
}

fail() {
  echo "FAIL: $*" >&2
  gh_error "[${CURRENT_STEP:-?}] FAIL: $*"
  exit 1
}

# A command that fails under set -e (not through fail) also leaves an annotation: the step,
# the file and line, and the command.
on_err() {
  gh_error "[${CURRENT_STEP:-?}] ${BASH_SOURCE[1]:-?}:${1}: command failed: ${2}"
}

ok() {
  PASS=$((PASS + 1))
}

step() {
  CURRENT_STEP="$*"
  echo
  echo "=== $* ==="
}

# req METHOD PATH [jar] [json]
# Sends the request with the Origin header, with the cookie jar if one is
# given (read and written, so Set-Cookie updates it), and a JSON body if one is
# given. Sets STATUS, BODY (response text) and, in $HDR_FILE, the headers.
req() {
  local method=$1 path=$2 jar=${3:-} data=${4:-}
  local -a args=(-s -o "$BODY_FILE" -D "$HDR_FILE" -w '%{http_code}' -X "$method" -H "Origin: $REQ_ORIGIN")
  if [ -n "$jar" ]; then args+=(-b "$jar" -c "$jar"); fi
  if [ -n "$data" ]; then args+=(-H 'Content-Type: application/json' --data "$data"); fi
  LAST_REQ="$method $path"
  STATUS=$(curl "${args[@]}" "$BASE$path")
  BODY=$(cat "$BODY_FILE")
}

# Prints a response header from the last req (case-insensitive name).
hdr() {
  { grep -i "^$1:" "$HDR_FILE" || true; } | head -n 1 | tr -d '\r' | sed -E 's/^[^:]*:[[:space:]]*//'
}

# The Set-Cookie line for crosscuts_sid from the last req (empty if none).
sid_cookie() {
  { grep -i '^set-cookie:[[:space:]]*crosscuts_sid=' "$HDR_FILE" || true; } | head -n 1 | tr -d '\r'
}

# Max-Age (seconds) of that cookie, or empty if it has none.
sid_max_age() {
  sid_cookie | { grep -io 'max-age=[0-9]*' || true; } | head -n 1 | cut -d= -f2
}

# Runs a jq filter over the last response body, raw output.
jqr() {
  printf '%s' "$BODY" | jq -r "$1"
}

expect_status() {
  local want=$1 what=${2:-$LAST_REQ}
  [ "$STATUS" = "$want" ] || fail "$what: expected HTTP $want, got $STATUS: ${BODY:0:400}"
  ok
}

# Any 4xx/5xx (a refusal) when the exact code is not part of the contract.
expect_refused() {
  local what=${1:-$LAST_REQ}
  case $STATUS in
    4* | 5*) ok ;;
    *) fail "$what: expected a refusal (4xx), got $STATUS: ${BODY:0:400}" ;;
  esac
}

# jq -e over the last response body must be truthy.
expect_jq() {
  local filter=$1 what=${2:-$LAST_REQ}
  printf '%s' "$BODY" | jq -e "$filter" >/dev/null \
    || fail "$what: jq '$filter' is not true for: ${BODY:0:600}"
  ok
}

expect_eq() {
  local got=$1 want=$2 what=$3
  [ "$got" = "$want" ] || fail "$what: expected '$want', got '$got'"
  ok
}

new_jar() {
  : >"$1"
}

# Authenticated curl for the photo/schedule suite (ported verbatim from the old
# publish.yml, with the admin cookie jar added).
ccurl() {
  curl -s -H "Origin: $ORIGIN_OK" -b "$ADMIN" "$@"
}

start_container() { # name image host-dir mount-root
  local name=$1 image=$2 dir=$3 root=$4
  docker rm -f "$name" >/dev/null 2>&1 || true
  # BACKUP_SCHEDULE_DISABLED=1 is CI only (docs/plans/backup-contracts.md section 7.8): no
  # backup timer in any container; the old image ignores it. JOINR_OPEN_QUOTES_TIMER_DISABLED=1 is
  # CI only too (ci/smoke-m16-openquotes.sh): no 5-minute open-quotes fetch to race the suite's
  # counted requests; the old image ignores it.
  docker run -d --name "$name" -p "$PORT:3000" -e BACKUP_SCHEDULE_DISABLED=1 -e JOINR_OPEN_QUOTES_TIMER_DISABLED=1 \
    -v "$dir/db:$root/db" -v "$dir/uploads:$root/uploads" -v "$dir/config:$root/config" \
    "$image" >/dev/null
}

wait_healthy() { # container name
  local name=$1 i
  echo "Waiting for $name to come up..."
  for i in $(seq 1 60); do
    if curl -sf "$BASE/healthz" >/dev/null; then
      echo "$name is up."
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
      fail "$name exited during startup"
    fi
    sleep 1
  done
  fail "$name never became healthy"
}

# Monday of this week in Australia/Sydney, YYYY-MM-DD.
sydney_monday() {
  local today dow
  today=$(TZ=Australia/Sydney date +%F)
  dow=$(TZ=Australia/Sydney date +%u)
  date -u -d "$today - $((dow - 1)) days" +%F
}

# ============================================================================
# Start the image under test
# ============================================================================

docker rm -f "${CONTAINERS[@]}" >/dev/null 2>&1 || true
echo "Starting $IMAGE with a fresh data dir at $DATA..."
start_container "$CONTAINER" "$IMAGE" "$DATA" /data
wait_healthy "$CONTAINER"

# ============================================================================
step "0. runtime versions match the Dockerfile and the lockfile"
# ============================================================================

# Expected values are read from the source, so an upgrade release proves itself
# here without this script being edited.
APP_SRC="$(cd "$(dirname "$0")/.." && pwd)/crosscuts/app"
want_node=$(sed -nE 's/^FROM node:([0-9]+)-.*/\1/p' "$APP_SRC/Dockerfile")
want_bsq=$(jq -r '.packages["node_modules/better-sqlite3"].version' "$APP_SRC/package-lock.json")
[ -n "$want_node" ] || fail "could not read the Node major from the Dockerfile FROM line"
got_node=$(docker exec "$CONTAINER" node -p 'process.versions.node.split(".")[0]')
expect_eq "$got_node" "$want_node" "Node major in the image"
got_bsq=$(docker exec "$CONTAINER" node -p 'require("better-sqlite3/package.json").version')
expect_eq "$got_bsq" "$want_bsq" "better-sqlite3 version in the image"
sqlite=$(docker exec "$CONTAINER" node -p \
  'new (require("better-sqlite3"))(":memory:").prepare("select sqlite_version() v").get().v')
echo "Node $(docker exec "$CONTAINER" node -v), better-sqlite3 $got_bsq, SQLite $sqlite"
# Backups (docs/plans/backup-contracts.md section 16.2): 7-Zip and rsync run, and no popt alias
# file can add flags to rsync unseen.
docker exec "$CONTAINER" sh -c '(7zz i || 7z i) >/dev/null 2>&1' || fail "7-Zip does not run in the image"
ok
docker exec "$CONTAINER" rsync --version >/dev/null || fail "rsync does not run in the image"
ok
docker exec "$CONTAINER" sh -c 'test ! -e /etc/popt' || fail "/etc/popt exists in the image"
docker exec "$CONTAINER" sh -c 'test ! -e /etc/popt.d' || fail "/etc/popt.d exists in the image"
ok
sz_out=$(docker exec "$CONTAINER" sh -c '7zz i 2>/dev/null || 7z i 2>/dev/null' || true)
rsync_out=$(docker exec "$CONTAINER" rsync --version || true)
echo "$(grep -m1 '7-Zip' <<<"$sz_out" || echo '7-Zip: no version line')"
echo "${rsync_out%%$'\n'*}"

# ============================================================================
step "a. first-run setup"
# ============================================================================

ADMIN="$WORK/jar-admin"
new_jar "$ADMIN"
ADMIN_PW='CiAdmin-Passw0rd-1'

req GET /api/auth/status
expect_status 200 "auth status before setup"
expect_jq '.setupNeeded == true and .loggedIn == false' "auth status before setup"

req POST /api/auth/setup "$ADMIN" \
  "$(jq -nc --arg p "$ADMIN_PW" '{username:"admin",displayName:"CI Admin",password:$p}')"
expect_status 201 "setup creates the admin"
expect_jq '.user != null' "setup returns the user"

req POST /api/auth/setup "" \
  "$(jq -nc --arg p "$ADMIN_PW" '{username:"admin2",displayName:"Second Admin",password:$p}')"
expect_status 404 "a second setup is refused"

req GET /api/auth/status "$ADMIN"
expect_jq '.setupNeeded == false and .loggedIn == true' "auth status after setup"

req GET /api/auth/me "$ADMIN"
expect_status 200 "me as admin"
expect_jq '(.user.roles | index("admin")) != null and (.user.perms | length) == 38 and .user.isOwner == true' "setup user is the owner, an admin with all 38 keys"

# ============================================================================
step "b. logged out: every routed API is 401, pages redirect"
# ============================================================================

req GET /api/meta/routes "$ADMIN"
expect_status 200 "GET /api/meta/routes as admin"
expect_jq 'type == "array" and length >= 30' "route list is a populated array"
ROUTES_JSON=$BODY

swept=0
while IFS=$'\t' read -r r_method r_path; do
  # :id, :day, :key ... -> 1
  p=$(printf '%s' "$r_path" | sed -E 's/:[A-Za-z_][A-Za-z0-9_]*/1/g')
  data=''
  case $r_method in POST | PUT | PATCH) data='{}' ;; esac
  req "$r_method" "$p" "" "$data"
  expect_status 401 "logged out $r_method $p"
  swept=$((swept + 1))
done < <(printf '%s' "$ROUTES_JSON" | jq -r '.[] | select(.access != "public") | [.method, .fullPath] | @tsv')
[ "$swept" -ge 25 ] || fail "only $swept non-public routes were swept; the route list looks wrong"
echo "Swept $swept non-public routes."

req GET /photos/does-not-exist.jpg
expect_status 401 "logged out GET /photos/*"

req GET /schedule.html
expect_status 302 "logged out GET /schedule.html"
case $(hdr location) in
  /login.html\?next=*schedule.html*) ok ;;
  *) fail "logged out /schedule.html: bad Location '$(hdr location)'" ;;
esac

req GET /
expect_status 302 "logged out GET /"
case $(hdr location) in
  /login.html\?next=*) ok ;;
  *) fail "logged out /: bad Location '$(hdr location)'" ;;
esac

for open_path in /healthz /login.html /tokens.css; do
  req GET "$open_path"
  expect_status 200 "logged out GET $open_path"
done

# ============================================================================
step "c. photo and schedule suite (as admin)"
# ============================================================================

echo "--- Photo API ---"
echo "GET /api/photos should start empty..."
body=$(ccurl -sf "$BASE"/api/photos)
[ "$body" = "[]" ] || { echo "Expected [], got: $body" >&2; exit 1; }

echo "Uploading a test photo..."
printf '%s' "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" | base64 -d > "$WORK/test.png"
upload_response=$(ccurl -sf -F "photos=@$WORK/test.png;type=image/png" -F "tags=ci-test" "$BASE"/api/photos)
echo "$upload_response"
failed_count=$(echo "$upload_response" | jq -r '.failed | length')
[ "$failed_count" = "0" ] || { echo "Expected no failed uploads, got: $upload_response" >&2; exit 1; }
photo_id=$(echo "$upload_response" | jq -r '.created[0].id')
thumb_url=$(echo "$upload_response" | jq -r '.created[0].thumbUrl')
width=$(echo "$upload_response" | jq -r '.created[0].width')
[ "$photo_id" != "null" ] || { echo "No photo id in response" >&2; exit 1; }
[ "$thumb_url" != "null" ] && [ -n "$thumb_url" ] || { echo "No thumbUrl in response" >&2; exit 1; }
[ "$width" = "1" ] || { echo "Expected width 1, got $width" >&2; exit 1; }

echo "Confirming it shows up in the listing..."
ccurl -sf "$BASE"/api/photos | jq -e ".[] | select(.id == $photo_id)" > /dev/null

# M4: /photos serves top-level image files only; uploads/files/ (private) never.
echo "Checking /photos serves only top-level image files..."
for p_case in "$thumb_url:200" "/photos/files/:404" "/photos/files/x.pdf:404" "$thumb_url/:404" "/photos/:404"; do
  p_path=${p_case%:*}; p_want=${p_case##*:}
  status=$(ccurl -s -o /dev/null -w "%{http_code}" "$BASE$p_path")
  [ "$status" = "$p_want" ] || { echo "GET $p_path: expected $p_want, got $status" >&2; exit 1; }
done

echo "Editing tags..."
ccurl -sf -X PATCH -H "Content-Type: application/json" -d '{"tags":"ci-test-edited"}' \
  "$BASE/api/photos/$photo_id" | jq -e '.tags == "ci-test-edited"' > /dev/null

echo "Deleting..."
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/photos/$photo_id")
[ "$status" = "204" ] || { echo "Expected 204 on delete, got $status" >&2; exit 1; }

echo "Confirming it's gone..."
body=$(ccurl -sf "$BASE"/api/photos)
[ "$body" = "[]" ] || { echo "Expected [] after delete, got: $body" >&2; exit 1; }

# A phone photo taken upright is often stored landscape with EXIF orientation 6.
# This 4x2 JPEG carries that tag, so it displays 2x4: the stored size and the
# thumbnail must both come out portrait, or sharp has stopped auto-orienting.
echo "Uploading a JPEG tagged EXIF orientation 6 (stored 4x2, displays 2x4)..."
printf '%s' "/9j/4QC8RXhpZgAASUkqAAgAAAAGABIBAwABAAAABgAAABoBBQABAAAAVgAAABsBBQABAAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA6AMAADhjAADoAwAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAAAQAAAADoAQAAQAAAAIAAAAAAAAA/+IB8ElDQ19QUk9GSUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwAQCwwODAoQDg0OEhEQExgoGhgWFhgxIyUdKDozPTw5Mzg3QEhcTkBEV0U3OFBtUVdfYmdoZz5NcXlwZHhcZWdj/9sAQwEREhIYFRgvGhovY0I4QmNjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj/8AAEQgAAgAEAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAD/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCgAP/Z" | base64 -d > "$WORK/orient6.jpg"
upload_response=$(ccurl -sf -F "photos=@$WORK/orient6.jpg;type=image/jpeg" -F "tags=ci-orient" "$BASE"/api/photos)
echo "$upload_response"
[ "$(echo "$upload_response" | jq -r '.failed | length')" = "0" ] || { echo "Orientation-6 upload failed: $upload_response" >&2; exit 1; }
photo_id=$(echo "$upload_response" | jq -r '.created[0].id')
dims=$(echo "$upload_response" | jq -r '.created[0] | "\(.width)x\(.height)"')
[ "$dims" = "2x4" ] || { echo "Expected stored size 2x4 (portrait) for orientation 6, got $dims" >&2; exit 1; }
thumb_file=$(echo "$upload_response" | jq -r '.created[0].thumbUrl' | sed 's#^/photos/##')
thumb_dims=$(docker exec "$CONTAINER" node -e \
  'require("sharp")(process.argv[1]).metadata().then(m => console.log(m.width + "x" + m.height + " " + m.format + " o" + (m.orientation || 1)))' \
  "/data/uploads/$thumb_file")
[ "$thumb_dims" = "2x4 webp o1" ] || { echo "Expected an upright 2x4 WebP thumbnail, got: $thumb_dims" >&2; exit 1; }
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/photos/$photo_id")
[ "$status" = "204" ] || { echo "Expected 204 deleting the orientation-6 photo, got $status" >&2; exit 1; }
body=$(ccurl -sf "$BASE"/api/photos)
[ "$body" = "[]" ] || { echo "Expected [] after deleting the orientation-6 photo, got: $body" >&2; exit 1; }

echo "Photo API smoke test passed."

echo "--- Schedule API ---"

echo "GET /api/workers should have the seeded roster..."
worker_count=$(ccurl -sf "$BASE"/api/workers | jq 'length')
[ "$worker_count" -ge 1 ] || { echo "Expected at least 1 seeded worker, got $worker_count" >&2; exit 1; }

echo "Creating a CI worker..."
worker_id=$(ccurl -sf -X POST -H "Content-Type: application/json" -d '{"name":"CI Worker"}' \
  "$BASE"/api/workers | jq -r '.id')
[ "$worker_id" != "null" ] || { echo "No worker id returned" >&2; exit 1; }

echo "GET /api/schedule should return a two-week fortnight, 7 days apart..."
schedule=$(ccurl -sf "$BASE/api/schedule?week=2025-11-19")
week1_start=$(echo "$schedule" | jq -r '.weeks[0].start')
week2_start=$(echo "$schedule" | jq -r '.weeks[1].start')
week1_dow=$(date -u -d "$week1_start" +%u)
[ "$week1_dow" = "1" ] || { echo "Expected week1 to start on a Monday, got $week1_start (dow $week1_dow)" >&2; exit 1; }
expected_week2=$(date -u -d "$week1_start + 7 days" +%F)
[ "$week2_start" = "$expected_week2" ] || { echo "Expected week2 $expected_week2, got $week2_start" >&2; exit 1; }

echo "Adding a job row to week 1 manufacturing..."
row=$(ccurl -sf -X POST -H "Content-Type: application/json" \
  -d "{\"weekStart\":\"$week1_start\",\"panel\":\"manufacturing\",\"jobName\":\"CI Job\",\"notes\":\"n1\"}" \
  "$BASE"/api/rows)
row_id=$(echo "$row" | jq -r '.rowId')
job_id=$(echo "$row" | jq -r '.jobId')
[ "$row_id" != "null" ] || { echo "No rowId returned: $row" >&2; exit 1; }

echo "Confirming the job shows up in /api/jobs..."
ccurl -sf "$BASE"/api/jobs | jq -e ".[] | select(.id == $job_id and .name == \"CI Job\")" > /dev/null

echo "Assigning the CI worker to Monday..."
assignment=$(ccurl -sf -X POST -H "Content-Type: application/json" \
  -d "{\"day\":\"mon\",\"workerId\":$worker_id}" \
  "$BASE/api/rows/$row_id/assignments")
assignment_id=$(echo "$assignment" | jq -r '.assignmentId')
[ "$assignment_id" != "null" ] || { echo "No assignmentId returned: $assignment" >&2; exit 1; }

echo "Confirming the assignment shows up in the schedule..."
ccurl -sf "$BASE/api/schedule?week=$week1_start" \
  | jq -e ".weeks[0].manufacturing[] | select(.rowId == $row_id) | .cells.mon[] | select(.workerId == $worker_id)" > /dev/null

echo "Re-adding the same worker to the same day should be idempotent..."
dup_assignment=$(ccurl -sf -X POST -H "Content-Type: application/json" \
  -d "{\"day\":\"mon\",\"workerId\":$worker_id}" \
  "$BASE/api/rows/$row_id/assignments")
dup_assignment_id=$(echo "$dup_assignment" | jq -r '.assignmentId')
[ "$dup_assignment_id" = "$assignment_id" ] || { echo "Expected existing assignmentId $assignment_id, got $dup_assignment_id" >&2; exit 1; }
chip_count=$(ccurl -sf "$BASE/api/schedule?week=$week1_start" \
  | jq "[.weeks[0].manufacturing[] | select(.rowId == $row_id) | .cells.mon[]] | length")
[ "$chip_count" = "1" ] || { echo "Expected 1 chip after repeat assignment, got $chip_count" >&2; exit 1; }

echo "Editing job notes..."
ccurl -sf -X PATCH -H "Content-Type: application/json" -d '{"notes":"updated"}' \
  "$BASE/api/jobs/$job_id" | jq -e '.notes == "updated"' > /dev/null

echo "Duplicating the row to next week..."
dup=$(ccurl -sf -X POST -H "Content-Type: application/json" -d '{}' \
  "$BASE/api/rows/$row_id/duplicate")
dup_row_id=$(echo "$dup" | jq -r '.rowId')
[ "$dup_row_id" != "null" ] && [ "$dup_row_id" != "$row_id" ] || { echo "Duplicate row not created: $dup" >&2; exit 1; }
ccurl -sf "$BASE/api/schedule?week=$week1_start" \
  | jq -e ".weeks[1].manufacturing[] | select(.rowId == $dup_row_id) | .cells.mon[] | select(.workerId == $worker_id)" > /dev/null

echo "Adding a job row to week 1 installing (for flag testing)..."
install_row=$(ccurl -sf -X POST -H "Content-Type: application/json" \
  -d "{\"weekStart\":\"$week1_start\",\"panel\":\"installing\",\"jobId\":$job_id}" \
  "$BASE"/api/rows)
install_row_id=$(echo "$install_row" | jq -r '.rowId')
[ "$install_row_id" != "null" ] || { echo "No rowId returned: $install_row" >&2; exit 1; }

echo "Flagging Tuesday as locked in on the installing row..."
ccurl -sf -X POST -H "Content-Type: application/json" -d '{"day":"tue"}' \
  "$BASE/api/rows/$install_row_id/flags" | jq -e '.flagged == true' > /dev/null

echo "Confirming the flag shows up in the schedule response..."
ccurl -sf "$BASE/api/schedule?week=$week1_start" \
  | jq -e ".weeks[0].installing[] | select(.rowId == $install_row_id) | .flags.tue == true" > /dev/null

echo "Flagging a manufacturing row should be rejected..."
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{"day":"mon"}' \
  "$BASE/api/rows/$row_id/flags")
[ "$status" = "400" ] || { echo "Expected 400 flagging a manufacturing row, got $status" >&2; exit 1; }

echo "Unflagging Tuesday..."
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/rows/$install_row_id/flags/tue")
[ "$status" = "204" ] || { echo "Expected 204 unflagging, got $status" >&2; exit 1; }
ccurl -sf "$BASE/api/schedule?week=$week1_start" \
  | jq -e ".weeks[0].installing[] | select(.rowId == $install_row_id) | .flags.tue == false" > /dev/null

echo "Re-flagging Tuesday so the row delete runs with a live flag..."
ccurl -sf -X POST -H "Content-Type: application/json" -d '{"day":"tue"}' \
  "$BASE/api/rows/$install_row_id/flags" | jq -e '.flagged == true' > /dev/null

echo "Cleaning up the installing row..."
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/rows/$install_row_id")
[ "$status" = "204" ] || { echo "Expected 204 deleting installing row, got $status" >&2; exit 1; }

echo "Flag smoke test passed."

echo "--- Row reordering and week moves ---"
# These two modes rewrite stored ordering (sort_order across a whole
# panel) and stored placement (week_start), so they get exercised
# against a real container and real SQLite before anything publishes.

echo "Adding three manufacturing rows to reorder..."
add_order_row() {
  ccurl -sf -X POST -H "Content-Type: application/json" \
    -d "{\"weekStart\":\"$week1_start\",\"panel\":\"manufacturing\",\"jobName\":\"CI Order $1\"}" \
    "$BASE"/api/rows | jq -r '.rowId'
}
ra=$(add_order_row A)
rb=$(add_order_row B)
rc=$(add_order_row C)
for r in "$ra" "$rb" "$rc"; do
  [ "$r" != "null" ] && [ -n "$r" ] || { echo "A reorder row got no rowId" >&2; exit 1; }
done

# Order of just these three rows, in board order.
panel_order() {
  ccurl -sf "$BASE/api/schedule?week=$week1_start" \
    | jq -r "[.weeks[0].manufacturing[] | select(.rowId==$ra or .rowId==$rb or .rowId==$rc) | .rowId] | join(\",\")"
}
got=$(panel_order)
[ "$got" = "$ra,$rb,$rc" ] || { echo "Expected $ra,$rb,$rc on insert, got $got" >&2; exit 1; }

echo "Dragging the last row to the front of the panel..."
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X PATCH -H "Content-Type: application/json" \
  -d '{"toIndex":0}' "$BASE/api/rows/$rc/move")
[ "$status" = "204" ] || { echo "Expected 204 on toIndex move, got $status" >&2; exit 1; }
got=$(panel_order)
[ "$got" = "$rc,$ra,$rb" ] || { echo "Expected $rc,$ra,$rb after drag, got $got" >&2; exit 1; }

echo "A move with no direction/toIndex/week must be rejected..."
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X PATCH -H "Content-Type: application/json" \
  -d '{}' "$BASE/api/rows/$ra/move")
[ "$status" = "400" ] || { echo "Expected 400 on empty move body, got $status" >&2; exit 1; }

echo "Assigning a worker so the week move has something to carry..."
ccurl -sf -X POST -H "Content-Type: application/json" \
  -d "{\"day\":\"wed\",\"workerId\":$worker_id}" \
  "$BASE/api/rows/$ra/assignments" > /dev/null

next_week=$(date -u -d "$week1_start + 7 days" +%F)
echo "Moving that row to next week..."
ccurl -sf -X PATCH -H "Content-Type: application/json" -d '{"week":"next"}' \
  "$BASE/api/rows/$ra/move" | jq -e ".weekStart == \"$next_week\"" > /dev/null

echo "It must be gone from this week and present next week, worker intact..."
ccurl -sf "$BASE/api/schedule?week=$week1_start" \
  | jq -e "[.weeks[0].manufacturing[] | select(.rowId == $ra)] | length == 0" > /dev/null
ccurl -sf "$BASE/api/schedule?week=$week1_start" \
  | jq -e ".weeks[1].manufacturing[] | select(.rowId == $ra) | .cells.wed[] | select(.workerId == $worker_id)" > /dev/null

echo "Moving it back to the original week..."
ccurl -sf -X PATCH -H "Content-Type: application/json" -d '{"week":"prev"}' \
  "$BASE/api/rows/$ra/move" | jq -e ".weekStart == \"$week1_start\"" > /dev/null
ccurl -sf "$BASE/api/schedule?week=$week1_start" \
  | jq -e ".weeks[0].manufacturing[] | select(.rowId == $ra) | .cells.wed[] | select(.workerId == $worker_id)" > /dev/null

echo "Cleaning up the reorder rows..."
for r in $ra $rb $rc; do
  status=$(ccurl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/rows/$r")
  [ "$status" = "204" ] || { echo "Expected 204 deleting reorder row $r, got $status" >&2; exit 1; }
done

echo "Reorder and week-move smoke test passed."

echo "--- Backlog and finish-week ---"
# All of this runs in 2031 so it can't collide with the 2025 rows above.
# Every row and backlog entry created here is deleted at the end.

# Sends a request, keeps the response body in "$CI_BODY", prints the status code.
ci_req() {
  ccurl -s -o "$CI_BODY" -w "%{http_code}" "$@"
}

echo "Adding a backlog item..."
status=$(ci_req -X POST -H "Content-Type: application/json" -d '{"name":"CI Backlog"}' \
  "$BASE"/api/jobs/backlog)
[ "$status" = "201" ] || { echo "Expected 201 adding backlog item, got $status: $(cat "$CI_BODY")" >&2; exit 1; }
backlog_id=$(jq -r '.id' "$CI_BODY")
[ "$backlog_id" != "null" ] || { echo "No backlog id returned: $(cat "$CI_BODY")" >&2; exit 1; }

echo "Confirming it shows up in the backlog on the schedule response..."
ccurl -sf "$BASE/api/schedule?week=$week1_start" \
  | jq -e ".backlog[] | select(.id == $backlog_id and .name == \"CI Backlog\")" > /dev/null

echo "An empty backlog name must be rejected..."
status=$(ci_req -X POST -H "Content-Type: application/json" -d '{"name":""}' \
  "$BASE"/api/jobs/backlog)
[ "$status" = "400" ] || { echo "Expected 400 on empty backlog name, got $status" >&2; exit 1; }

echo "Deleting the backlog item..."
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/jobs/backlog/$backlog_id")
[ "$status" = "204" ] || { echo "Expected 204 deleting backlog item, got $status" >&2; exit 1; }
echo "Confirming it's gone from the backlog..."
ccurl -sf "$BASE/api/schedule?week=$week1_start" \
  | jq -e "[.backlog[] | select(.id == $backlog_id)] | length == 0" > /dev/null

echo "Deleting an unknown backlog id should be 404..."
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/jobs/backlog/999999999")
[ "$status" = "404" ] || { echo "Expected 404 deleting unknown backlog id, got $status" >&2; exit 1; }

echo "Backlog round trip passed."

echo "Placing a backlog item into a week's installing panel..."
place_week="2031-03-24"
status=$(ci_req -X POST -H "Content-Type: application/json" -d '{"name":"CI Placed"}' \
  "$BASE"/api/jobs/backlog)
[ "$status" = "201" ] || { echo "Expected 201 adding backlog item, got $status: $(cat "$CI_BODY")" >&2; exit 1; }
placed_backlog_id=$(jq -r '.id' "$CI_BODY")

echo "A bad panel must be rejected, and the backlog item must survive it..."
status=$(ci_req -X POST -H "Content-Type: application/json" \
  -d "{\"weekStart\":\"$place_week\",\"panel\":\"sideways\"}" \
  "$BASE/api/jobs/backlog/$placed_backlog_id/place")
[ "$status" = "400" ] || { echo "Expected 400 on bad panel, got $status" >&2; exit 1; }
ccurl -sf "$BASE/api/schedule?week=$place_week" \
  | jq -e ".backlog[] | select(.id == $placed_backlog_id)" > /dev/null

echo "Placing it into the installing panel..."
status=$(ci_req -X POST -H "Content-Type: application/json" \
  -d "{\"weekStart\":\"$place_week\",\"panel\":\"installing\"}" \
  "$BASE/api/jobs/backlog/$placed_backlog_id/place")
[ "$status" = "201" ] || { echo "Expected 201 placing backlog item, got $status: $(cat "$CI_BODY")" >&2; exit 1; }
placed_row_id=$(jq -r '.rowId' "$CI_BODY")
[ "$placed_row_id" != "null" ] || { echo "No rowId returned: $(cat "$CI_BODY")" >&2; exit 1; }

echo "Confirming the row shows up in that week's installing panel..."
ccurl -sf "$BASE/api/schedule?week=$place_week" \
  | jq -e ".weeks[0].installing[] | select(.rowId == $placed_row_id)" > /dev/null

echo "Confirming the backlog item is gone..."
ccurl -sf "$BASE/api/schedule?week=$place_week" \
  | jq -e "[.backlog[] | select(.id == $placed_backlog_id)] | length == 0" > /dev/null

echo "Placing an unknown backlog id should be 404..."
status=$(ci_req -X POST -H "Content-Type: application/json" \
  -d "{\"weekStart\":\"$place_week\",\"panel\":\"installing\"}" \
  "$BASE/api/jobs/backlog/999999999/place")
[ "$status" = "404" ] || { echo "Expected 404 placing unknown backlog id, got $status" >&2; exit 1; }

echo "Backlog placement passed."

echo "Finish-week: creating jobs in the source week..."
fw_src="2031-03-03"
fw_next=$(date -u -d "$fw_src + 7 days" +%F)

# Adds a row to the source week for a job (args: job name, panel); prints the response JSON.
new_src_row() {
  ccurl -sf -X POST -H "Content-Type: application/json" \
    -d "{\"weekStart\":\"$fw_src\",\"panel\":\"$2\",\"jobName\":\"$1\"}" \
    "$BASE"/api/rows
}

mfg_job=$(new_src_row "CI Finish Mfg" manufacturing | jq -r '.jobId')

inst=$(new_src_row "CI Finish Install" installing)
inst_job=$(echo "$inst" | jq -r '.jobId')
inst_row=$(echo "$inst" | jq -r '.rowId')
echo "Assigning the CI worker to the source installing row (should be copied forward)..."
ccurl -sf -X POST -H "Content-Type: application/json" \
  -d "{\"day\":\"mon\",\"workerId\":$worker_id}" \
  "$BASE/api/rows/$inst_row/assignments" > /dev/null

idle_job=$(new_src_row "CI Finish Idle" manufacturing | jq -r '.jobId')
done_job=$(new_src_row "CI Finish Done" manufacturing | jq -r '.jobId')
probe_job=$(new_src_row "CI Finish Probe" manufacturing | jq -r '.jobId')
for j in "$mfg_job" "$inst_job" "$idle_job" "$done_job" "$probe_job"; do
  [ "$j" != "null" ] && [ -n "$j" ] || { echo "A finish-week job got no jobId" >&2; exit 1; }
done

# Source-week rows (ids and cells) as compact JSON, to prove finish-week leaves them alone.
fw_src_state() {
  ccurl -sf "$BASE/api/schedule?week=$fw_src" \
    | jq -c '[(.weeks[0].manufacturing + .weeks[0].installing)[] | {rowId, cells}] | sort_by(.rowId)'
}
# Row count across the fortnight plus backlog count, as compact JSON.
fw_counts() {
  ccurl -sf "$BASE/api/schedule?week=$fw_src" \
    | jq -c '[((.weeks[0].manufacturing + .weeks[0].installing + .weeks[1].manufacturing + .weeks[1].installing) | length), (.backlog | length)]'
}

fw_body="{\"weekStart\":\"$fw_src\",\"results\":[{\"jobId\":$mfg_job,\"outcome\":\"manufacturing\"},{\"jobId\":$inst_job,\"outcome\":\"install\"},{\"jobId\":$idle_job,\"outcome\":\"not_started\"},{\"jobId\":$done_job,\"outcome\":\"complete\"}]}"
src_before=$(fw_src_state)

echo "Calling finish-week for the source week..."
status=$(ci_req -X POST -H "Content-Type: application/json" -d "$fw_body" \
  "$BASE"/api/rows/finish-week)
[ "$status" = "200" ] || { echo "Expected 200 from finish-week, got $status: $(cat "$CI_BODY")" >&2; exit 1; }
counts_first=$(fw_counts)

echo "Manufacturing job should land in next week's manufacturing panel..."
ccurl -sf "$BASE/api/schedule?week=$fw_src" \
  | jq -e ".weeks[1].manufacturing[] | select(.jobId == $mfg_job)" > /dev/null

echo "Install job should land in next week's installing panel, with the worker copied..."
ccurl -sf "$BASE/api/schedule?week=$fw_src" \
  | jq -e ".weeks[1].installing[] | select(.jobId == $inst_job) | .cells.mon[] | select(.workerId == $worker_id)" > /dev/null

echo "Not-started job should be in the backlog and in no panel next week..."
ccurl -sf "$BASE/api/schedule?week=$fw_src" \
  | jq -e ".backlog[] | select(.jobId == $idle_job)" > /dev/null
ccurl -sf "$BASE/api/schedule?week=$fw_src" \
  | jq -e "[(.weeks[1].manufacturing + .weeks[1].installing)[] | select(.jobId == $idle_job)] | length == 0" > /dev/null

echo "Complete job should create nothing at all..."
ccurl -sf "$BASE/api/schedule?week=$fw_src" \
  | jq -e "[(.weeks[1].manufacturing + .weeks[1].installing)[] | select(.jobId == $done_job)] | length == 0" > /dev/null
ccurl -sf "$BASE/api/schedule?week=$fw_src" \
  | jq -e "[.backlog[] | select(.jobId == $done_job)] | length == 0" > /dev/null

echo "Source week must be unchanged..."
[ "$(fw_src_state)" = "$src_before" ] || { echo "Source week changed after finish-week" >&2; exit 1; }

echo "Repeating the identical finish-week call should create nothing new..."
status=$(ci_req -X POST -H "Content-Type: application/json" -d "$fw_body" \
  "$BASE"/api/rows/finish-week)
[ "$status" = "200" ] || { echo "Expected 200 from repeat finish-week, got $status: $(cat "$CI_BODY")" >&2; exit 1; }
jq -e '(.created | length) == 0 and (.skipped | length) > 0' "$CI_BODY" > /dev/null \
  || { echo "Repeat finish-week should create nothing and skip everything: $(cat "$CI_BODY")" >&2; exit 1; }
[ "$(fw_counts)" = "$counts_first" ] || { echo "Repeat finish-week changed row or backlog counts" >&2; exit 1; }

echo "Bad finish-week bodies must be rejected and write nothing..."
counts_before_bad=$(fw_counts)
for body in \
  "{\"weekStart\":\"$fw_src\",\"results\":[{\"jobId\":$probe_job,\"outcome\":\"manufacturing\"},{\"jobId\":$probe_job,\"outcome\":\"sideways\"}]}" \
  "{\"weekStart\":\"$fw_src\",\"results\":[{\"jobId\":$probe_job,\"outcome\":\"manufacturing\"},{\"jobId\":999999999,\"outcome\":\"manufacturing\"}]}" \
  "{\"weekStart\":\"$fw_src\",\"results\":[{\"jobId\":$probe_job,\"outcome\":\"manufacturing\"},{\"jobId\":$probe_job,\"outcome\":\"install\"}]}" \
  "{\"weekStart\":\"$fw_src\",\"results\":[]}"; do
  status=$(ci_req -X POST -H "Content-Type: application/json" -d "$body" \
    "$BASE"/api/rows/finish-week)
  [ "$status" = "400" ] || { echo "Expected 400 from bad finish-week body, got $status: $body" >&2; exit 1; }
done
[ "$(fw_counts)" = "$counts_before_bad" ] || { echo "Rejected finish-week calls still changed row or backlog counts" >&2; exit 1; }
ccurl -sf "$BASE/api/schedule?week=$fw_src" \
  | jq -e "[(.weeks[1].manufacturing + .weeks[1].installing)[] | select(.jobId == $probe_job)] | length == 0" > /dev/null

echo "Cleaning up the finish-week backlog entry..."
idle_backlog_id=$(ccurl -sf "$BASE/api/schedule?week=$fw_src" \
  | jq -r ".backlog[] | select(.jobId == $idle_job) | .id")
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/jobs/backlog/$idle_backlog_id")
[ "$status" = "204" ] || { echo "Expected 204 deleting finish-week backlog entry, got $status" >&2; exit 1; }

echo "Cleaning up the CI rows in both test fortnights..."
for week in "$fw_src" "$place_week"; do
  rows=$(ccurl -sf "$BASE/api/schedule?week=$week" \
    | jq -r '(.weeks[0].manufacturing + .weeks[0].installing + .weeks[1].manufacturing + .weeks[1].installing)[] | .rowId')
  for r in $rows; do
    status=$(ccurl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/rows/$r")
    [ "$status" = "204" ] || { echo "Expected 204 deleting CI row $r, got $status" >&2; exit 1; }
  done
done

echo "Send-back to backlog: creating a row to send back..."
sb_week="2031-03-24"
sb_body=$(ccurl -sf -X POST -H "Content-Type: application/json" \
  -d "{\"weekStart\":\"$sb_week\",\"panel\":\"manufacturing\",\"jobName\":\"CI Send Back\"}" \
  "$BASE"/api/rows)
sb_row=$(echo "$sb_body" | jq -r '.rowId')
sb_job=$(echo "$sb_body" | jq -r '.jobId')
[ "$sb_row" != "null" ] && [ "$sb_job" != "null" ] || { echo "Send-back row not created: $sb_body" >&2; exit 1; }

echo "Sending the row back to the To start list..."
status=$(ci_req -X PATCH -H "Content-Type: application/json" -d '{"backlog":true}' \
  "$BASE/api/rows/$sb_row/move")
[ "$status" = "200" ] || { echo "Expected 200 sending row back, got $status: $(cat "$CI_BODY")" >&2; exit 1; }
sb_backlog_id=$(jq -r '.backlogId' "$CI_BODY")
[ "$sb_backlog_id" != "null" ] || { echo "No backlogId returned: $(cat "$CI_BODY")" >&2; exit 1; }

echo "Confirming the row is gone from the week and the job is in the backlog..."
ccurl -sf "$BASE/api/schedule?week=$sb_week" \
  | jq -e "[(.weeks[0].manufacturing + .weeks[0].installing + .weeks[1].manufacturing + .weeks[1].installing)[] | select(.rowId == $sb_row)] | length == 0" > /dev/null
ccurl -sf "$BASE/api/schedule?week=$sb_week" \
  | jq -e ".backlog[] | select(.id == $sb_backlog_id and .jobId == $sb_job)" > /dev/null

echo "Adding a second row for the same job, then sending it back..."
sb_row2=$(ccurl -sf -X POST -H "Content-Type: application/json" \
  -d "{\"weekStart\":\"$sb_week\",\"panel\":\"installing\",\"jobId\":$sb_job}" \
  "$BASE"/api/rows | jq -r '.rowId')
[ "$sb_row2" != "null" ] || { echo "Second send-back row not created" >&2; exit 1; }
status=$(ci_req -X PATCH -H "Content-Type: application/json" -d '{"backlog":true}' \
  "$BASE/api/rows/$sb_row2/move")
[ "$status" = "200" ] || { echo "Expected 200 on second send-back, got $status: $(cat "$CI_BODY")" >&2; exit 1; }
[ "$(jq -r '.backlogId' "$CI_BODY")" = "$sb_backlog_id" ] || { echo "Second send-back created a different backlog id" >&2; exit 1; }
echo "Confirming the job still has exactly one backlog entry..."
ccurl -sf "$BASE/api/schedule?week=$sb_week" \
  | jq -e "[.backlog[] | select(.jobId == $sb_job)] | length == 1" > /dev/null

echo "Sending an unknown row back should be 404..."
status=$(ci_req -X PATCH -H "Content-Type: application/json" -d '{"backlog":true}' \
  "$BASE/api/rows/999999999/move")
[ "$status" = "404" ] || { echo "Expected 404 sending unknown row back, got $status" >&2; exit 1; }

echo "Cleaning up the send-back backlog entry..."
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/jobs/backlog/$sb_backlog_id")
[ "$status" = "204" ] || { echo "Expected 204 deleting send-back backlog entry, got $status" >&2; exit 1; }

echo "Send-back to backlog passed."

echo "Backlog and finish-week smoke test passed."

echo "Archiving the CI worker..."
ccurl -sf -X PATCH -H "Content-Type: application/json" -d '{"archived":true}' \
  "$BASE/api/workers/$worker_id" | jq -e '.archived == true' > /dev/null

echo "Deleting the assignment and both rows..."
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/assignments/$assignment_id")
[ "$status" = "204" ] || { echo "Expected 204 deleting assignment, got $status" >&2; exit 1; }
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/rows/$row_id")
[ "$status" = "204" ] || { echo "Expected 204 deleting row, got $status" >&2; exit 1; }
status=$(ccurl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/rows/$dup_row_id")
[ "$status" = "204" ] || { echo "Expected 204 deleting dup row, got $status" >&2; exit 1; }

echo "Verifying the row deletes left no orphaned day_flags behind..."
orphan_flags=$(docker exec "$CONTAINER" node -e "console.log(require('better-sqlite3')('/data/db/photos.db').prepare('SELECT COUNT(*) AS n FROM day_flags').get().n)")
[ "$orphan_flags" = "0" ] || { echo "Expected 0 day_flags after row deletes, got $orphan_flags" >&2; exit 1; }

echo "Schedule API smoke test passed."

# ============================================================================
step "d. one user per role preset, and permission overrides"
# ============================================================================

# create_user USERNAME DISPLAY PASSWORD ROLE  -> sets CREATED_ID
create_user() {
  req POST /api/users "$ADMIN" \
    "$(jq -nc --arg u "$1" --arg d "$2" --arg p "$3" --arg r "$4" '{username:$u,displayName:$d,password:$p,roles:[$r]}')"
  expect_status 201 "create user $1"
  expect_jq ".username == \"$1\" and .mustChangePassword == true" "user $1 is created with mustChangePassword"
  CREATED_ID=$(jqr '.id')
}

# login JAR USERNAME PASSWORD [remember]
login() {
  req POST /api/auth/login "$1" \
    "$(jq -nc --arg u "$2" --arg p "$3" --argjson r "${4:-false}" '{username:$u,password:$p,remember:$r}')"
}

# A new user signs in with the password an admin set and must choose their own
# before the API serves anything else (the server enforces it).
# own_password JAR CURRENT NEW
own_password() {
  req POST /api/auth/password "$1" "$(jq -nc --arg c "$2" --arg n "$3" '{currentPassword:$c,newPassword:$n}')"
  expect_status 204 "choose own password"
  req GET /api/auth/me "$1"
  expect_jq '.user.mustChangePassword == false and .user.passwordReason == null' "no password change pending"
}

SCHED_PW='Sched-Passw0rd-1'
ACCT_PW='Acct-Passw0rd-1'
DPM_PW='Dpm-Passw0rd-1'
SHOW_PW='Show-Passw0rd-1'
LOCK_PW='Lock-Passw0rd-1'

# Created with a temporary password (Tmp-...); each user then picks their own.
create_user sched "CI Scheduling" "Tmp-$SCHED_PW" scheduling
SCHED_ID=$CREATED_ID
create_user acct "CI Accounts" "Tmp-$ACCT_PW" accounts
create_user dpm "CI Design PM" "Tmp-$DPM_PW" design_pm
create_user show "CI Showroom" "Tmp-$SHOW_PW" showroom
create_user locktest "CI Lockout" "$LOCK_PW" showroom

# A duplicate username is a 409 (case-insensitively).
req POST /api/users "$ADMIN" \
  "$(jq -nc --arg p "$SCHED_PW" '{username:"SCHED",displayName:"Dup",password:$p,roles:["showroom"]}')"
expect_status 409 "duplicate username"

SCHED="$WORK/jar-sched"
ACCT="$WORK/jar-acct"
DPM="$WORK/jar-dpm"
SHOW="$WORK/jar-show"
for j in "$SCHED" "$ACCT" "$DPM" "$SHOW"; do new_jar "$j"; done

login "$SCHED" sched "Tmp-$SCHED_PW"
expect_status 200 "login sched"
login "$ACCT" acct "Tmp-$ACCT_PW"
expect_status 200 "login acct"
login "$DPM" dpm "Tmp-$DPM_PW"
expect_status 200 "login dpm"
login "$SHOW" show "Tmp-$SHOW_PW"
expect_status 200 "login show"

# mustChangePassword blocks the API (server-enforced, Todd 2026-10-11) except
# who-am-I, lock and the change itself.
req GET /api/auth/me "$SCHED"
expect_status 200 "me as sched"
expect_jq '.user.mustChangePassword == true and .user.passwordReason == "admin"' "sched must change an admin-set password"
req GET /api/schedule "$SCHED"
expect_status 403 "sched cannot use the API before changing the password"
expect_jq '.mustChangePassword == true' "the 403 says why"
own_password "$SCHED" "Tmp-$SCHED_PW" "$SCHED_PW"
own_password "$ACCT" "Tmp-$ACCT_PW" "$ACCT_PW"
own_password "$DPM" "Tmp-$DPM_PW" "$DPM_PW"
own_password "$SHOW" "Tmp-$SHOW_PW" "$SHOW_PW"

D_WEEK=2032-03-01   # a Monday far from every other test week

echo "scheduling preset..."
req GET /api/schedule "$SCHED"
expect_status 200 "sched GET /api/schedule"
req POST /api/rows "$SCHED" \
  "{\"weekStart\":\"$D_WEEK\",\"panel\":\"manufacturing\",\"jobName\":\"CI Sched Row\"}"
expect_status 201 "sched POST /api/rows"
SCHED_ROW1=$(jqr '.rowId')
req GET /api/users "$SCHED"
expect_status 403 "sched GET /api/users"
req PATCH /api/job-records/1 "$SCHED" '{"notes":"x"}'
expect_status 403 "sched PATCH /api/job-records/1"

echo "accounts preset..."
req GET /api/schedule "$ACCT"
expect_status 200 "acct GET /api/schedule"
req POST /api/rows "$ACCT" \
  "{\"weekStart\":\"$D_WEEK\",\"panel\":\"manufacturing\",\"jobName\":\"CI Acct Row\"}"
expect_status 403 "acct POST /api/rows"
req GET /api/job-records "$ACCT"
expect_status 200 "acct GET /api/job-records"

echo "design_pm preset..."
req POST /api/job-records "$DPM" '{"name":"CI Design Job","valueCents":123456}'
expect_status 201 "dpm POST /api/job-records"
expect_jq '.name == "CI Design Job" and .valueCents == 123456' "dpm sees the value it set"
DPM_JOB=$(jqr '.id')
req GET /api/audit "$DPM"
expect_status 403 "dpm GET /api/audit"

echo "jobs.value gating..."
req GET "/api/job-records/$DPM_JOB" "$SCHED"
expect_status 200 "sched GET /api/job-records/:id"
expect_jq '.name == "CI Design Job" and (has("valueCents") | not)' "valueCents is omitted without jobs.value"
req GET "/api/job-records/$DPM_JOB" "$ACCT"
expect_jq '.valueCents == 123456' "valueCents is present with jobs.value"

echo "showroom preset..."
req GET /api/photos "$SHOW"
expect_status 200 "show GET /api/photos"
req GET /api/schedule "$SHOW"
expect_status 403 "show GET /api/schedule"
req GET /schedule.html "$SHOW"
expect_status 403 "show GET /schedule.html"

# M7 (docs/plans/m7-contracts.md section 15.1): the workshop role and the two planner keys.
req GET /api/users/meta "$ADMIN"
expect_status 200 "admin GET /api/users/meta"
expect_jq '.roles | index("workshop") != null' "the roles include workshop"
expect_jq '.keys | length == 38' "38 feature keys (M10 adds orders.view and orders.receive; M11 stock.count and stock.order; M13 bonuses.manage, alarms.manage and loans.manage; department notes add the five notes.* keys; M23 notes.workshop; M25 shift.report; M27 maintenance.manage)"
expect_jq '.presets.admin | length == 35 and (index("notes.scheduling") != null) and (index("notes.design") != null) and (index("notes.ordering") != null) and (index("notes.accounts") != null) and (index("notes.admin") != null) and (index("notes.workshop") != null) and (index("bonuses.manage") == null) and (index("alarms.manage") == null) and (index("loans.manage") == null)' "the admin preset is the 35 keys (all six notes.* keys) without M13's three owner-only keys"
expect_jq '.presets.workshop == ["board.view","planner.view","notes.workshop","shift.report"]' "the workshop preset is board.view and planner.view (and M23's notes.workshop, M25's shift.report)"
# M10 (docs/plans/m10-contracts.md section 10.1): the two new roles and their presets.
expect_jq '.roles | index("ordering") != null and index("workshop_manager") != null' "the roles include ordering and workshop_manager"
expect_jq '.presets.ordering == ["board.view","jobs.view","design.view","photos.search","orders.view","orders.edit","orders.mark_ordered","orders.receive","tasks.use","messages.use","planner.view","planner.edit","stock.count","stock.order","notes.ordering"]' "the ordering preset is as M10 section 3 plus M11's stock keys and notes.ordering"
expect_jq '.presets.workshop_manager == ["board.view","orders.view","orders.receive","tasks.use","messages.use","planner.view","planner.edit","stock.count","notes.ordering","notes.workshop","maintenance.manage"]' "the workshop_manager preset is as M10 section 3 plus stock.count (M11), notes.ordering and notes.workshop (M23) and maintenance.manage (M27)"

echo "per-user override (revoke board.edit from sched)..."
req PUT "/api/users/$SCHED_ID/overrides/board.edit" "$ADMIN" '{"effect":"revoke"}'
expect_status 200 "admin revokes board.edit from sched"
req POST /api/rows "$SCHED" \
  "{\"weekStart\":\"$D_WEEK\",\"panel\":\"manufacturing\",\"jobName\":\"CI Sched Row Revoked\"}"
expect_status 403 "sched POST /api/rows after the revoke"
req DELETE "/api/users/$SCHED_ID/overrides/board.edit" "$ADMIN"
expect_status 200 "admin removes the override"
req POST /api/rows "$SCHED" \
  "{\"weekStart\":\"$D_WEEK\",\"panel\":\"manufacturing\",\"jobName\":\"CI Sched Row Restored\"}"
expect_status 201 "sched POST /api/rows after the override is removed"
SCHED_ROW2=$(jqr '.rowId')

echo "cleaning up the rows the role checks created..."
for r in "$SCHED_ROW1" "$SCHED_ROW2"; do
  req DELETE "/api/rows/$r" "$ADMIN"
  expect_status 204 "admin deletes row $r"
done

# ============================================================================
step "e. wrong password and login lockout"
# ============================================================================

LOCKJ="$WORK/jar-lock"
new_jar "$LOCKJ"
login "$LOCKJ" locktest 'not-the-password-1'
expect_status 401 "wrong password"
# 10 failures per username+IP in 15 minutes lock the login out. Attempts 2-10
# are not asserted individually (an implementation may refuse the 10th); the
# 11th must be refused with 429 either way.
for i in 2 3 4 5 6 7 8 9 10; do
  login "$LOCKJ" locktest "not-the-password-$i"
done
login "$LOCKJ" locktest 'not-the-password-11'
expect_status 429 "eleventh wrong password"
expect_jq '(.retryAfterSec | type) == "number"' "429 carries retryAfterSec"

echo "30 parallel bad logins for one fresh username..."
# Attempts are reserved before scrypt runs, so a burst can't outrun the limit:
# at most 10 may be answered 401, everything else must be refused with 429
# (lockout, or the busy response when the scrypt cap is full).
BURST="$WORK/burst"
mkdir -p "$BURST"
for i in $(seq 1 30); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Origin: $ORIGIN_OK" -H 'Content-Type: application/json' \
    --data '{"username":"burstuser","password":"not-the-password-burst"}' "$BASE/api/auth/login" >"$BURST/$i" &
done
wait
burst_codes=$(cat "$BURST"/*)
n401=$(grep -c '^401$' <<<"$burst_codes" || true)
n429=$(grep -c '^429$' <<<"$burst_codes" || true)
[ "$n401" -le 10 ] || fail "burst: $n401 of 30 parallel bad logins got 401 (limit is 10)"
ok
[ "$((n401 + n429))" -eq 30 ] || fail "burst: expected only 401/429 answers, got: $(tr '\n' ' ' <<<"$burst_codes")"
ok

# ============================================================================
step "f. remember-me cookie lifetime"
# ============================================================================

REM="$WORK/jar-sched-remembered"
new_jar "$REM"
login "$REM" sched "$SCHED_PW" true
expect_status 200 "login sched with remember"
[ -n "$(sid_cookie)" ] || fail "remembered login set no crosscuts_sid cookie"
ma=$(sid_max_age)
[ -n "$ma" ] || fail "remembered login: crosscuts_sid has no Max-Age ($(sid_cookie))"
{ [ "$ma" -ge 2500000 ] && [ "$ma" -le 2600000 ]; } || fail "remembered login: Max-Age $ma is not about 30 days"
ok

NOREM="$WORK/jar-dpm-session"
new_jar "$NOREM"
login "$NOREM" dpm "$DPM_PW" false
expect_status 200 "login dpm without remember"
[ -n "$(sid_cookie)" ] || fail "plain login set no crosscuts_sid cookie"
ma=$(sid_max_age)
[ -z "$ma" ] || fail "plain login: crosscuts_sid unexpectedly has Max-Age $ma"
ok

# ============================================================================
step "g. PIN lock and unlock"
# ============================================================================

req POST /api/auth/pin "$REM" "$(jq -nc --arg p "$SCHED_PW" '{currentPassword:$p,pin:"4321"}')"
expect_status 204 "set PIN"
req POST /api/auth/lock "$REM"
expect_status 204 "lock"
req GET /api/workers "$REM"
expect_status 401 "locked GET /api/workers"
expect_jq '.locked == true' "locked response says locked:true"
req GET /api/auth/status "$REM"
expect_jq '.locked == true and .pinAvailable == true' "status offers the PIN on the remembered device"
req POST /api/auth/unlock "$REM" '{"pin":"4321"}'
expect_status 200 "unlock with the right PIN"
req GET /api/schedule "$REM"
expect_status 200 "GET /api/schedule after unlock"

echo "a browser without the device cookie cannot use the PIN..."
SIDONLY="$WORK/jar-sid-only"
{ echo '# Netscape HTTP Cookie File'; grep crosscuts_sid "$REM"; } >"$SIDONLY"
req POST /api/auth/lock "$SIDONLY"
expect_status 204 "lock (sid-only jar)"
req GET /api/auth/status "$SIDONLY"
expect_jq '.locked == true and .pinAvailable == false' "no PIN offered without the device cookie"
req POST /api/auth/unlock "$SIDONLY" '{"pin":"4321"}'
expect_refused "PIN unlock without the device cookie"
req GET /api/schedule "$SIDONLY"
expect_status 401 "still locked after the refused PIN"

echo "five wrong PINs lock the device's PIN..."
PINJ="$WORK/jar-pin"
new_jar "$PINJ"
login "$PINJ" sched "$SCHED_PW" true
expect_status 200 "login sched (remember) for the PIN lockout"
req POST /api/auth/lock "$PINJ"
expect_status 204 "lock (PIN lockout jar)"
for i in 1 2 3 4 5; do
  req POST /api/auth/unlock "$PINJ" '{"pin":"0000"}'
  expect_refused "wrong PIN attempt $i"
done
req POST /api/auth/unlock "$PINJ" '{"pin":"4321"}'
expect_refused "right PIN after five wrong ones"
req POST /api/auth/unlock "$PINJ" "$(jq -nc --arg p "$SCHED_PW" '{password:$p}')"
expect_status 200 "unlock with the password"
req GET /api/schedule "$PINJ"
expect_status 200 "GET /api/schedule after the password unlock"

echo "a device revoked by an admin cannot PIN-unlock..."
REVJ="$WORK/jar-revoked-device"
new_jar "$REVJ"
login "$REVJ" sched "$SCHED_PW" true
expect_status 200 "login sched (remember) for the device revoke"
dev_cookie() { { grep crosscuts_dev "$1" || true; } | awk '{print $NF}'; }
old_dev=$(dev_cookie "$REVJ")
[ -n "$old_dev" ] || fail "remembered login set no crosscuts_dev cookie"
req POST /api/auth/lock "$REVJ"
expect_status 204 "lock (revoked-device jar)"
req GET /api/auth/status "$REVJ"
expect_jq '.locked == true and .pinAvailable == true' "PIN is offered before the revoke"
req POST "/api/users/$SCHED_ID/sessions/revoke" "$ADMIN"
expect_status 204 "admin revokes the sessions of sched"
req POST /api/auth/unlock "$REVJ" '{"pin":"4321"}'
expect_refused "PIN unlock after the device was revoked"
req GET /api/schedule "$REVJ"
expect_status 401 "revoked session stays out"
live_devs=$(docker exec "$CONTAINER" node -e "console.log(require('better-sqlite3')('/data/db/photos.db').prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = $SCHED_ID AND revoked_at IS NULL').get().n)")
expect_eq "$live_devs" "0" "no live devices left for sched after the revoke"
login "$REVJ" sched "$SCHED_PW" true
expect_status 200 "remembered login after the revoke"
new_dev=$(dev_cookie "$REVJ")
[ -n "$new_dev" ] && [ "$new_dev" != "$old_dev" ] || fail "remembered login reused the revoked device cookie"
ok

# ============================================================================
step "h. foreign Origin is refused"
# ============================================================================

REQ_ORIGIN=http://evil.example
req POST /api/workers "$ADMIN" '{"name":"Evil Worker"}'
expect_status 403 "POST /api/workers with a foreign Origin"
req POST /api/auth/login "" '{"username":"admin","password":"x"}'
expect_status 403 "POST /api/auth/login with a foreign Origin"
req GET /api/workers "$ADMIN"
expect_status 200 "GET with a foreign Origin is not blocked"
REQ_ORIGIN=$ORIGIN_OK

# ============================================================================
step "i. audit log"
# ============================================================================

audit_total() { # action-prefix
  req GET "/api/audit?action=$1&limit=1" "$ADMIN"
  expect_status 200 "GET /api/audit?action=$1"
  AUDIT_TOTAL=$(jqr '.total')
}

audit_total auth.login
[ "$AUDIT_TOTAL" -ge 1 ] || fail "expected at least 1 auth.login audit row, got $AUDIT_TOTAL"
ok
audit_total user.create
[ "$AUDIT_TOTAL" -ge 4 ] || fail "expected at least 4 user.create audit rows, got $AUDIT_TOTAL"
ok
audit_total user.override
[ "$AUDIT_TOTAL" -ge 2 ] || fail "expected at least 2 user.override audit rows, got $AUDIT_TOTAL"
ok
audit_total job.create
[ "$AUDIT_TOTAL" -ge 1 ] || fail "expected at least 1 job.create audit row, got $AUDIT_TOTAL"
ok

req GET "/api/audit?action=user.create&limit=1" "$ADMIN"
expect_jq '.rows[0] | has("id") and has("at") and has("actorLabel") and has("action")' "audit rows have the contract shape"

echo "audit_log is append-only..."
out=$(docker exec "$CONTAINER" node -e '
const db = require("better-sqlite3")("/data/db/photos.db");
try { db.prepare("UPDATE audit_log SET action = ?").run("tampered"); console.log("UPDATE-SUCCEEDED"); }
catch (e) { console.log("UPDATE-BLOCKED: " + e.message); }
' 2>&1) || true
case $out in
  *UPDATE-BLOCKED*append-only*) ok ;;
  *) fail "UPDATE on audit_log was not blocked by the trigger: $out" ;;
esac
out=$(docker exec "$CONTAINER" node -e '
const db = require("better-sqlite3")("/data/db/photos.db");
try { db.prepare("DELETE FROM audit_log").run(); console.log("DELETE-SUCCEEDED"); }
catch (e) { console.log("DELETE-BLOCKED: " + e.message); }
' 2>&1) || true
case $out in
  *DELETE-BLOCKED*append-only*) ok ;;
  *) fail "DELETE on audit_log was not blocked by the trigger: $out" ;;
esac

# ============================================================================
step "j. default week is the Sydney Monday"
# ============================================================================

expected_monday=$(sydney_monday)
req GET /api/schedule "$ADMIN"
expect_status 200 "GET /api/schedule with no week"
expect_eq "$(jqr '.weeks[0].start')" "$expected_monday" "weeks[0].start is this week's Sydney Monday"

# M2 suites (ci/smoke-m2-*.sh) share this shell: helpers, jars, $CONTAINER.
# Step g revoked every sched session, so sign the $SCHED jar in again first.
new_jar "$SCHED"
login "$SCHED" sched "$SCHED_PW"
expect_status 200 "sched signs in again for the M2 suites"
for f in "$(dirname "$0")"/smoke-m2-*.sh; do [ -f "$f" ] && source "$f"; done
# M3 suites (ci/smoke-m3-*.sh): same rules; they must not assume a pristine DB.
for f in "$(dirname "$0")"/smoke-m3-*.sh; do [ -f "$f" ] && source "$f"; done

# M4 scaffold checks (docs/plans/m4-contracts.md section 9): the people picker and the
# menu bar counts.
req GET /api/people "$SCHED"
expect_status 200 "sched GET /api/people"
[ "$(jqr '[.rows[] | keys | sort == ["displayName","id"]] | all')" = "true" ]   || fail "/api/people rows must carry only id and displayName: ${BODY:0:300}"
req GET /api/people "$SHOW"
expect_status 403 "show GET /api/people"
req GET /api/notifications/unread-count "$SCHED"
expect_status 200 "sched GET /api/notifications/unread-count"
[ "$(jqr '[.unread, .tasks, .tasksOverdue, .messages] | map(type == "number") | all')" = "true" ]   || fail "unread-count must have four number fields: ${BODY:0:300}"
# M4 suites (ci/smoke-m4-*.sh): same rules; they must not assume a pristine DB.
for f in "$(dirname "$0")"/smoke-m4-*.sh; do [ -f "$f" ] && source "$f"; done
# M5 suites (ci/smoke-m5-*.sh): same rules; they must not assume a pristine DB.
for f in "$(dirname "$0")"/smoke-m5-*.sh; do [ -f "$f" ] && source "$f"; done
# M6 suites (ci/smoke-m6-*.sh): same rules; they must not assume a pristine DB.
for f in "$(dirname "$0")"/smoke-m6-*.sh; do [ -f "$f" ] && source "$f"; done
# M7 (docs/plans/m7-contracts.md section 15.1): three more users, then the M7 suites.
# $WORK is the temp directory, so the workshop jar is $WSHOP.
create_user wshop "CI Workshop" "Tmp-Wshop-Passw0rd-1" workshop
WSHOP_ID=$CREATED_ID
create_user acct2 "CI Accounts Two" "Tmp-Acct2-Passw0rd-1" accounts
ACCT2_ID=$CREATED_ID
create_user multi "CI Accounts and Design" "Tmp-Multi-Passw0rd-1" accounts
MULTI_ID=$CREATED_ID
req PATCH "/api/users/$MULTI_ID" "$ADMIN" '{"roles":["accounts","design_pm"]}'
expect_status 200 "multi gets two roles"
WSHOP="$WORK/jar-wshop"; ACCT2="$WORK/jar-acct2"; MULTI="$WORK/jar-multi"
for j in "$WSHOP" "$ACCT2" "$MULTI"; do new_jar "$j"; done
login "$WSHOP" wshop "Tmp-Wshop-Passw0rd-1"; expect_status 200 "login wshop"
own_password "$WSHOP" "Tmp-Wshop-Passw0rd-1" "Wshop-Passw0rd-1"
login "$ACCT2" acct2 "Tmp-Acct2-Passw0rd-1"; expect_status 200 "login acct2"
own_password "$ACCT2" "Tmp-Acct2-Passw0rd-1" "Acct2-Passw0rd-1"
login "$MULTI" multi "Tmp-Multi-Passw0rd-1"; expect_status 200 "login multi"
own_password "$MULTI" "Tmp-Multi-Passw0rd-1" "Multi-Passw0rd-1"
req GET /api/auth/me "$WSHOP"
expect_status 200 "me as wshop"
expect_jq '.user.roles == ["workshop"]' "wshop holds the workshop role (migration 017 allows it)"
for f in "$(dirname "$0")"/smoke-m7-*.sh; do [ -f "$f" ] && source "$f"; done
# M8 suites (ci/smoke-m8-*.sh, docs/plans/m8-contracts.md section 9): same rules.
for f in "$(dirname "$0")"/smoke-m8-*.sh; do [ -f "$f" ] && source "$f"; done
# M9 suites (ci/smoke-m9-*.sh, docs/plans/m9-contracts.md section 10): same rules.
for f in "$(dirname "$0")"/smoke-m9-*.sh; do [ -f "$f" ] && source "$f"; done
# M10 (docs/plans/m10-contracts.md section 10.1): an Ordering user and a Workshop Manager, then the
# M10 suites (same rules).
create_user ordr "CI Ordering" "Tmp-Ordr-Passw0rd-1" ordering
ORDR_ID=$CREATED_ID
create_user wsmgr "CI Workshop Manager" "Tmp-Wsmgr-Passw0rd-1" workshop_manager
WSMGR_ID=$CREATED_ID
ORDR="$WORK/jar-ordr"; WSMGR="$WORK/jar-wsmgr"
for j in "$ORDR" "$WSMGR"; do new_jar "$j"; done
login "$ORDR" ordr "Tmp-Ordr-Passw0rd-1"; expect_status 200 "login ordr"
own_password "$ORDR" "Tmp-Ordr-Passw0rd-1" "Ordr-Passw0rd-1"
login "$WSMGR" wsmgr "Tmp-Wsmgr-Passw0rd-1"; expect_status 200 "login wsmgr"
own_password "$WSMGR" "Tmp-Wsmgr-Passw0rd-1" "Wsmgr-Passw0rd-1"
req GET /api/auth/me "$ORDR"
expect_jq '.user.roles == ["ordering"]' "ordr holds the ordering role (migration 021 allows it)"
req GET /api/auth/me "$WSMGR"
expect_jq '.user.roles == ["workshop_manager"]' "wsmgr holds the workshop_manager role (migration 021 allows it)"
for f in "$(dirname "$0")"/smoke-m10-*.sh; do [ -f "$f" ] && source "$f"; done
# M11 suites (ci/smoke-m11-*.sh, docs/plans/m11-contracts.md section 12): same rules.
for f in "$(dirname "$0")"/smoke-m11-*.sh; do [ -f "$f" ] && source "$f"; done
# M12 suites (ci/smoke-m12-*.sh, docs/plans/m12-contracts.md section 10): same rules.
for f in "$(dirname "$0")"/smoke-m12-*.sh; do [ -f "$f" ] && source "$f"; done
# M13 suites (ci/smoke-m13-*.sh, docs/plans/m13-contracts.md section 11): same rules.
for f in "$(dirname "$0")"/smoke-m13-*.sh; do [ -f "$f" ] && source "$f"; done
# M14 suites (ci/smoke-m14-*.sh, docs/plans/m9-contracts.md section 13): same rules.
for f in "$(dirname "$0")"/smoke-m14-*.sh; do [ -f "$f" ] && source "$f"; done
# M15 suites (ci/smoke-m15-*.sh, docs/plans/notes-contracts.md): same rules.
for f in "$(dirname "$0")"/smoke-m15-*.sh; do [ -f "$f" ] && source "$f"; done
# M16 suites (ci/smoke-m16-*.sh, docs/plans/m3-contracts.md section 13, J3): same rules.
for f in "$(dirname "$0")"/smoke-m16-*.sh; do [ -f "$f" ] && source "$f"; done
# M17 suites (ci/smoke-m17-*.sh, docs/plans/m3-contracts.md section 14, names on job tiles): same rules.
for f in "$(dirname "$0")"/smoke-m17-*.sh; do [ -f "$f" ] && source "$f"; done
# M18 suites (ci/smoke-m18-*.sh, docs/plans/materials-contracts.md, a job's Materials list): same rules.
for f in "$(dirname "$0")"/smoke-m18-*.sh; do [ -f "$f" ] && source "$f"; done
# M19 suites (ci/smoke-m19-*.sh, task J4, the whole Joinr quote: snapshot, money for jobs.value only): same rules.
for f in "$(dirname "$0")"/smoke-m19-*.sh; do [ -f "$f" ] && source "$f"; done
# M20 suites (ci/smoke-m20-*.sh, docs/plans/m20-recurring-tasks.md, recurring tasks and the 0.2.0 renames): same rules.
for f in "$(dirname "$0")"/smoke-m20-*.sh; do [ -f "$f" ] && source "$f"; done
# M21 suites (ci/smoke-m21-*.sh, docs/plans/m21-benchtop-designer.md, the Benchtop designer): same rules.
for f in "$(dirname "$0")"/smoke-m21-*.sh; do [ -f "$f" ] && source "$f"; done
# M22 suites (ci/smoke-m22-*.sh, docs/plans/m22-project-jobs.md, project jobs): same rules.
for f in "$(dirname "$0")"/smoke-m22-*.sh; do [ -f "$f" ] && source "$f"; done
# M23 suites (ci/smoke-m23-*.sh, docs/plans/m23-contracts.md, Projects steps and hand-offs): same rules.
for f in "$(dirname "$0")"/smoke-m23-*.sh; do [ -f "$f" ] && source "$f"; done
# M24 suites (ci/smoke-m24-*.sh, docs/plans/m24-contracts.md, board placement and money triggers): same rules.
for f in "$(dirname "$0")"/smoke-m24-*.sh; do [ -f "$f" ] && source "$f"; done
# M25 suites (ci/smoke-m25-*.sh, docs/plans/m25-contracts.md, the workshop end-of-shift report): same rules.
for f in "$(dirname "$0")"/smoke-m25-*.sh; do [ -f "$f" ] && source "$f"; done
# M26 suites (ci/smoke-m26-*.sh, docs/plans/m26-contracts.md, morning check and completion): same rules.
for f in "$(dirname "$0")"/smoke-m26-*.sh; do [ -f "$f" ] && source "$f"; done
# M27 suites (ci/smoke-m27-*.sh, docs/plans/m27-contracts.md, the workshop manager): same rules.
for f in "$(dirname "$0")"/smoke-m27-*.sh; do [ -f "$f" ] && source "$f"; done
# Backup suite (ci/smoke-backup.sh, docs/plans/backup-contracts.md section 16.3): same rules.
[ -f "$(dirname "$0")/smoke-backup.sh" ] && source "$(dirname "$0")/smoke-backup.sh"

# ============================================================================
step "k. cutover rehearsal: old public image, then this image on the same volume"
# ============================================================================

# Done with the main container; the rehearsal reuses port 3000.
docker rm -f "$CONTAINER" >/dev/null

RH_DIR="$WORK/rehearsal"
mkdir -p "$RH_DIR/db" "$RH_DIR/uploads" "$RH_DIR/config"

echo "Pulling and starting the old image ($OLD_IMAGE)..."
docker pull "$OLD_IMAGE" >/dev/null || fail "could not pull $OLD_IMAGE"
# The old image keeps its data at /app/db, /app/uploads and /app/config, and has no auth.
start_container "$OLD_CONTAINER" "$OLD_IMAGE" "$RH_DIR" /app
wait_healthy "$OLD_CONTAINER"

# Old app: no auth, no Origin check.
oapi() {
  curl -sf -H 'Content-Type: application/json' "$@"
}

M=$(sydney_monday)
rh_past=$(date -u -d "$M - 14 days" +%F)
rh_cur=$M
rh_next=$(date -u -d "$M + 7 days" +%F)
rh_f2=$(date -u -d "$M + 14 days" +%F)
rh_f3=$(date -u -d "$M + 21 days" +%F)

echo "Seeding the old app through its API..."
rh_worker=$(oapi -X POST -d '{"name":"RH Worker"}' "$BASE/api/workers" | jq -r '.id')
[ "$rh_worker" != "null" ] && [ -n "$rh_worker" ] || fail "rehearsal: no worker id"

# rh_row WEEK PANEL NAME -> row JSON
rh_row() {
  oapi -X POST -d "{\"weekStart\":\"$1\",\"panel\":\"$2\",\"jobName\":\"$3\"}" "$BASE/api/rows"
}
# rh_assign ROWID DAY
rh_assign() {
  oapi -X POST -d "{\"day\":\"$2\",\"workerId\":$rh_worker}" "$BASE/api/rows/$1/assignments" >/dev/null
}

# Past week only -> complete
r=$(rh_row "$rh_past" manufacturing "RH Past Only" | jq -r '.rowId')
rh_assign "$r" wed
# Current week (with an installing row and a real day flag) -> on_board
cur=$(rh_row "$rh_cur" manufacturing "RH Current")
cur_row=$(printf '%s' "$cur" | jq -r '.rowId')
cur_job=$(printf '%s' "$cur" | jq -r '.jobId')
rh_assign "$cur_row" mon
cur_inst=$(oapi -X POST -d "{\"weekStart\":\"$rh_cur\",\"panel\":\"installing\",\"jobId\":$cur_job}" "$BASE/api/rows" | jq -r '.rowId')
oapi -X POST -d '{"day":"tue"}' "$BASE/api/rows/$cur_inst/flags" | jq -e '.flagged == true' >/dev/null
# Next week -> on_board
r=$(rh_row "$rh_next" installing "RH Next" | jq -r '.rowId')
rh_assign "$r" fri
# Future week, outside the fortnight window -> on_board
rh_row "$rh_f3" manufacturing "RH Future" >/dev/null
# Backlog only -> ready_to_cut
oapi -X POST -d '{"name":"RH Backlog Only"}' "$BASE/api/jobs/backlog" >/dev/null
# In the backlog AND in a future week -> on_board (the first rule wins)
both_job=$(oapi -X POST -d '{"name":"RH Backlog And Future"}' "$BASE/api/jobs/backlog" | jq -r '.jobId')
oapi -X POST -d "{\"weekStart\":\"$rh_f2\",\"panel\":\"installing\",\"jobId\":$both_job}" "$BASE/api/rows" >/dev/null

echo "Inserting an orphan day_flags row (as the old app could leave behind)..."
orphans=$(docker exec "$OLD_CONTAINER" node -e '
const db = require("better-sqlite3")("/app/db/photos.db");
db.pragma("foreign_keys = OFF");
db.prepare("INSERT INTO day_flags (week_row_id, day) VALUES (999999, ?)").run("mon");
console.log(db.prepare("SELECT COUNT(*) AS n FROM day_flags WHERE week_row_id NOT IN (SELECT id FROM week_rows)").get().n);
')
expect_eq "$orphans" "1" "old DB holds one orphan day_flags row"

old_cur=$(oapi "$BASE/api/schedule?week=$rh_cur")
old_next=$(oapi "$BASE/api/schedule?week=$rh_next")
# Guard against comparing two empty boards.
printf '%s' "$old_cur" | jq -e '(.weeks[0].manufacturing | length) >= 1 and (.weeks[0].installing | length) >= 1 and (.backlog | length) >= 2 and .weeks[0].installing[0].flags.tue == true' >/dev/null \
  || fail "rehearsal: the old board looks unseeded: $old_cur"
ok
printf '%s' "$old_next" | jq -e '(.weeks[0].installing | length) >= 1' >/dev/null \
  || fail "rehearsal: next week looks unseeded: $old_next"
ok

# Migration 011 (the photo tag tidy, m3-contracts section 8): two photos with
# untidy and tidy tags. The old app trims the whole string and keeps the rest
# as typed. --form-string sends the value literally.
echo "Uploading two tagged photos to the old app..."
curl -sf -F "photos=@$WORK/test.png;type=image/png" --form-string "tags=  Kitchen, kitchen ,White Oak,, OAK " \
  "$BASE/api/photos" >/dev/null || fail "rehearsal: old app photo upload 1 failed"
curl -sf -F "photos=@$WORK/test.png;type=image/png" --form-string "tags=already, tidy" \
  "$BASE/api/photos" >/dev/null || fail "rehearsal: old app photo upload 2 failed"
old_photos=$(oapi "$BASE/api/photos" | jq 'length')
expect_eq "$old_photos" "2" "rehearsal: old app holds two photos"

# Flush the WAL so the files on the volume are self-contained, then stop.
docker exec "$OLD_CONTAINER" node -e 'require("better-sqlite3")("/app/db/photos.db").pragma("wal_checkpoint(TRUNCATE)")' >/dev/null || true
docker stop "$OLD_CONTAINER" >/dev/null
docker rm "$OLD_CONTAINER" >/dev/null

echo "Starting this image on the same volume (mounted at /data/*)..."
start_container "$RH_CONTAINER" "$IMAGE" "$RH_DIR" /data
wait_healthy "$RH_CONTAINER"

RHADMIN="$WORK/jar-rh-admin"
new_jar "$RHADMIN"
req POST /api/auth/setup "$RHADMIN" \
  "$(jq -nc --arg p "$ADMIN_PW" '{username:"admin",displayName:"CI Admin",password:$p}')"
expect_status 201 "rehearsal: setup on the migrated database"

# Compare only what the old app returned: the new app may add fields.
NORM='def cell: {assignmentId, workerId, name, bg, fg};
def row: {rowId, jobId, jobName, notes, cells: (.cells | map_values(map(cell))), flags};
def week: {start, label, manufacturing: [.manufacturing[] | row], installing: [.installing[] | row]};
{weeks: [.weeks[] | week], backlog: [.backlog[] | {id, jobId, name, notes}]}'

req GET "/api/schedule?week=$rh_cur" "$RHADMIN"
expect_status 200 "rehearsal: GET /api/schedule (current week)"
expect_eq "$(printf '%s' "$BODY" | jq -S -c "$NORM")" "$(printf '%s' "$old_cur" | jq -S -c "$NORM")" \
  "rehearsal: current-week board matches the old app"
req GET "/api/schedule?week=$rh_next" "$RHADMIN"
expect_status 200 "rehearsal: GET /api/schedule (next week)"
expect_eq "$(printf '%s' "$BODY" | jq -S -c "$NORM")" "$(printf '%s' "$old_next" | jq -S -c "$NORM")" \
  "rehearsal: next-week board matches the old app"

req GET /api/job-records "$RHADMIN"
expect_status 200 "rehearsal: GET /api/job-records"
stage_of() {
  printf '%s' "$BODY" | jq -r --arg n "$1" '[.[] | select(.name == $n) | .stage] | .[0] // "MISSING"'
}
expect_eq "$(stage_of 'RH Past Only')" complete "rehearsal: past-only job"
expect_eq "$(stage_of 'RH Current')" on_board "rehearsal: current-week job"
expect_eq "$(stage_of 'RH Next')" on_board "rehearsal: next-week job"
expect_eq "$(stage_of 'RH Future')" on_board "rehearsal: future-week job"
expect_eq "$(stage_of 'RH Backlog Only')" ready_to_cut "rehearsal: backlog-only job"
expect_eq "$(stage_of 'RH Backlog And Future')" on_board "rehearsal: job in both backlog and a future week"

orphans=$(docker exec "$RH_CONTAINER" node -e '
const db = require("better-sqlite3")("/data/db/photos.db");
console.log(db.prepare("SELECT COUNT(*) AS n FROM day_flags WHERE week_row_id NOT IN (SELECT id FROM week_rows)").get().n);
')
expect_eq "$orphans" "0" "rehearsal: orphan day_flags rows after the sweep"
real_flags=$(docker exec "$RH_CONTAINER" node -e '
const db = require("better-sqlite3")("/data/db/photos.db");
console.log(db.prepare("SELECT COUNT(*) AS n FROM day_flags").get().n);
')
expect_eq "$real_flags" "1" "rehearsal: the real day flag survived the sweep"

backups=$(docker exec "$RH_CONTAINER" sh -c 'ls /data/db/backups | grep -c "^photos-pre-001-.*\.db$"' || true)
expect_eq "$backups" "1" "rehearsal: pre-migration backup photos-pre-001-* exists"
# Capture first, then grep: under pipefail, grep -q exiting early would SIGPIPE
# docker logs and fail the pipeline even on a match.
logs=$(docker logs "$RH_CONTAINER" 2>&1)
grep -q 'foreign_key_check: ok' <<<"$logs" || fail "rehearsal: foreign_key_check was not clean"
ok

# Migration 011 tidied the old app's tags: same row count, one row rewritten.
rh_tags=$(docker exec "$RH_CONTAINER" node -e '
const db = require("better-sqlite3")("/data/db/photos.db");
console.log(JSON.stringify(db.prepare("SELECT tags FROM photos ORDER BY id").all().map((r) => r.tags)));
')
expect_eq "$(printf '%s' "$rh_tags" | jq 'length')" "$old_photos" "rehearsal: photo count after 011"
expect_eq "$(printf '%s' "$rh_tags" | jq -r '.[0]')" "kitchen, white oak, oak" "rehearsal: 011 tidied the untidy tags"
expect_eq "$(printf '%s' "$rh_tags" | jq -r '.[1]')" "already, tidy" "rehearsal: 011 left the tidy tags alone"
grep -qF '[migrate] 011 tag tidy: 1 of 2 photo(s) rewritten' <<<"$logs" \
  || fail "rehearsal: logs lack the 011 tag tidy line"
ok

echo "Restarting: nothing may re-apply and no new backup may appear..."
docker restart "$RH_CONTAINER" >/dev/null
wait_healthy "$RH_CONTAINER"
backups=$(docker exec "$RH_CONTAINER" sh -c 'ls /data/db/backups | grep -c "^photos-pre-"' || true)
expect_eq "$backups" "1" "rehearsal: backup count after restart"
logs=$(docker logs "$RH_CONTAINER" 2>&1)
grep -q '\[migrate\] up to date' <<<"$logs" || fail "rehearsal: logs do not say migrations are up to date after the restart"
ok
req GET /api/auth/status
expect_jq '.setupNeeded == false' "rehearsal: users survived the restart"

echo
echo "Smoke test passed ($PASS helper assertions, plus the ported photo/schedule suite)."
