# Backup smoke (docs/plans/backup-contracts.md section 16.3): snapshots, the copy to a stand-in
# NAS, Back up now, the refusal lock, the restore CLI and the no-leak rule.
# Sourced by ci/smoke.sh after the M6 suites, so it shares that script's shell: the helpers
# (step, req, expect_status, expect_jq, expect_eq, jqr, ok, fail), the cookie jars
# ($ADMIN $SCHED $ACCT $DPM $SHOW), $WORK, $BASE, $ORIGIN_OK, $REQ_ORIGIN, $IMAGE and $CONTAINER.
# No shebang and no `set`: the caller owns both (errexit, nounset and pipefail are on).
# It does not assume a pristine database: every run it checks is newer than the newest
# backup_runs row it noted first, and every count it checks is relative.
#
# The stand-in NAS is rsync's own daemon inside the app container (as ci/smoke-m6-intake.sh runs
# its fake Joinr), on 127.0.0.1:8873, with an add-only module rooted at /tmp/fake-nas. The values
# below are THROWAWAY CI VALUES, made up for this file: never a real address, account, module,
# password or passphrase. Every config file this suite writes is removed at the end, so the
# cutover rehearsal (step k) sees no backup set-up.
#
# Checks, in order (section 16.3): 1 access; 2 nothing set up; 3 passphrase not usable;
# 4 passphrase only; 5 event loop; 6 half set up; 7 the copy; 8 second run; 9 wrong password
# and the refusal lock; 10 daemon down; 11 no leaks; 12 restore drill; 13 clean-up. Plus, for
# information only, whether this image's 7-Zip reads a passphrase from stdin (section 18 item 2).

BK_PP='ciBackupPass-5d2e8f1a7c3'          # the test passphrase: 24 characters
BK_PP_SHORT='ciShortPw01'                  # 11 characters: not usable
BK_PP_WRONG='ciNotThePassphrase-00000'
BK_NAS_PW='ciNasPassw0rd-9b4c6e2a1f'       # the stand-in's rsync password: 24 characters
BK_NAS_PW_WRONG='ciNasWrongPw-0000000000x'
BK_ACCOUNT=ci-cc-backup
BK_MODULE=ccnas
BK_PORT=8873
BK_NAS_URL="rsync://$BK_ACCOUNT@127.0.0.1:$BK_PORT/$BK_MODULE"
BK_FIX_FIRST="The NAS refused the last copy's password or module. Place the NAS files again with the backup helper first: repeated refusals could make the NAS block the Umbrel."
BK_COPY_TAIL="The backups on the Umbrel are not affected."
BK_ARCHIVES=/data/db/backups/archives
BK_SEEN="$WORK/bk-seen.txt"                # every backup API body this suite saw (scanned in step 11)
BK_WAIT_TRIES=180                          # bk_wait: 0.5 s apart, so 90 s
BK_BEFORE=0
: >"$BK_SEEN"

# ---------------------------------------------------------------- helpers ---

bk_seen() {
  printf '%s\n' "$BODY" >>"$BK_SEEN"
}

# bk_status [WHAT]: GET /api/backup/status as the admin (must be 200); BODY is the status.
bk_status() {
  req GET /api/backup/status "$ADMIN"
  bk_seen
  expect_status 200 "${1:-admin GET /api/backup/status}"
}

# bk_run: POST /api/backup/run as the admin (Back up now). Leaves STATUS and BODY.
bk_run() {
  req POST /api/backup/run "$ADMIN" '{}'
  bk_seen
}

# bk_sql SQL: the rows as JSON (read-only connection to the live database).
bk_sql() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const db = new D("/data/db/photos.db", { readonly: true });
process.stdout.write(JSON.stringify(db.prepare(process.argv[1]).all()));' "$1"
}

# bk_val SQL: the first column of the first row as text ("null" for NULL, "" for no row).
bk_val() {
  bk_sql "$1" | jq -r '.[0] | if . == null then "" else (to_entries[0].value | tostring) end'
}

# bk_mark: notes the newest backup_runs id, so later checks look only at newer runs.
bk_mark() {
  BK_BEFORE=$(bk_val "SELECT COALESCE(MAX(id), 0) AS n FROM backup_runs")
  [ -n "$BK_BEFORE" ] || fail "could not read the newest backup_runs id"
}

# bk_rewind: moves every backup_runs started_at/finished_at back 11 minutes (CI only, section
# 18 item 13), so the 10-minute rule doesn't answer the next Back up now with 429.
bk_rewind() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const db = new D("/data/db/photos.db");
db.pragma("busy_timeout = 5000");
db.prepare(process.argv[1]).run();
db.close();' "UPDATE backup_runs SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '-11 minutes'), finished_at = CASE WHEN finished_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', finished_at, '-11 minutes') END" \
    || fail "bk_rewind could not move the backup_runs times back"
}

# bk_wait ROWS WHAT: polls the status every 0.5 s until nothing is running and at least ROWS
# finished backup_runs rows newer than bk_mark exist (1: a snapshot; 2: a snapshot and a copy).
# Ends with BODY = a fresh status.
bk_wait() {
  local want=$1 what=$2 i done_rows running_rows
  for i in $(seq 1 "$BK_WAIT_TRIES"); do
    req GET /api/backup/status "$ADMIN"
    bk_seen
    if [ "$STATUS" = 200 ] && [ "$(jqr '.running == null')" = true ]; then
      done_rows=$(bk_val "SELECT COUNT(*) AS n FROM backup_runs WHERE id > $BK_BEFORE AND status <> 'running'")
      running_rows=$(bk_val "SELECT COUNT(*) AS n FROM backup_runs WHERE status = 'running'")
      if [ "$done_rows" -ge "$want" ] && [ "$running_rows" = 0 ]; then
        bk_status "$what: status after the run"
        ok
        return 0
      fi
    fi
    sleep 0.5
  done
  fail "$what: the run did not finish within $((BK_WAIT_TRIES / 2)) s: ${BODY:0:400}"
}

# bk_put NAME VALUE: writes /data/config/NAME as the backup helper does (a hidden temporary with
# mode 600, then moved into place, so the file gets a fresh mtime).
bk_put() {
  printf '%s\n' "$2" | docker exec -i "$CONTAINER" sh -c \
    'umask 077 && cat > "/data/config/.$1.new" && chmod 600 "/data/config/.$1.new" && mv -f "/data/config/.$1.new" "/data/config/$1"' \
    sh "$1" || fail "could not write the config file $1"
}

bk_rm_config() {
  docker exec "$CONTAINER" rm -f /data/config/backup-passphrase /data/config/nas-url /data/config/nas-password \
    /data/config/.backup-passphrase.new /data/config/.nas-url.new /data/config/.nas-password.new \
    /data/config/backup-passphrase.bak /data/config/.backup-passphrase.bak.new
}

# bk_7z ARGS...: 7-Zip inside the container (exit code passed through).
bk_7z() {
  docker exec "$CONTAINER" "$BK_7Z" "$@"
}

# bk_sha FILE: sha256 of a file inside the container ("" if it can't be read).
bk_sha() {
  { docker exec "$CONTAINER" sha256sum "$1" 2>/dev/null || true; } | cut -d' ' -f1
}

# The stand-in NAS answers a module listing (no password needed for that).
bk_nas_answers() {
  docker exec "$CONTAINER" rsync --contimeout=3 "rsync://127.0.0.1:$BK_PORT/" >/dev/null 2>&1
}

# Stops the stand-in: SIGTERM to every process whose command line names its config file (the
# daemon and any child serving a connection). Read from /proc, so it needs no pkill.
bk_nas_stop() {
  docker exec "$CONTAINER" node -e '
const fs = require("fs");
for (const p of fs.readdirSync("/proc")) {
  if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
  let cmd = "";
  try { cmd = fs.readFileSync("/proc/" + p + "/cmdline", "utf8"); } catch { continue; }
  if (cmd.includes("bk-rsyncd.conf")) { try { process.kill(Number(p), "SIGTERM"); } catch {} }
}' >/dev/null 2>&1 || true
}

# bk_nas_files: every file on the stand-in as {"<path>": size}.
bk_nas_files() {
  docker exec "$CONTAINER" node -e '
const fs = require("fs");
const path = require("path");
const out = {};
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) walk(p, r);
    else if (e.isFile()) out[r] = fs.statSync(p).size;
  }
})("/tmp/fake-nas", "");
process.stdout.write(JSON.stringify(out));'
}

# bk_drill ARGS...: runs a command in a throwaway container of this image with the drill folder
# at /data and no network, as docs/restore.md runs the restore CLI.
bk_drill() {
  docker run --rm --network none -v "$BK_DRILL:/data" "$IMAGE" "$@" </dev/null
}

# bk_scan FILE WHAT: none of the test secrets or address parts appears in FILE. The port is
# matched with its address ("127.0.0.1:8873"): a bare 8873, or ":8873" in JSON, could be part of
# any byte count or duration ("bytes":88731).
bk_scan() {
  local file=$1 what=$2 label needle
  while IFS='|' read -r label needle; do
    if grep -qF -- "$needle" "$file"; then fail "$what contains the $label"; fi
  done <<EOF
test passphrase|$BK_PP
NAS password|$BK_NAS_PW
wrong NAS password|$BK_NAS_PW_WRONG
NAS address|$BK_ACCOUNT@127.0.0.1:$BK_PORT/$BK_MODULE
rsync account|$BK_ACCOUNT
rsync module|$BK_MODULE
stand-in address and port|127.0.0.1:$BK_PORT
EOF
  ok
}

BK_7Z=$(docker exec "$CONTAINER" sh -c 'command -v 7zz || command -v 7z' | tr -d '\r' || true)
[ -n "$BK_7Z" ] || fail "no 7-Zip binary (7zz or 7z) on the image's PATH"

req GET /api/auth/me "$ADMIN"
expect_status 200 "admin GET /api/auth/me"
BK_ADMIN_ID=$(jqr '.user.id')

# A clean start: no backup set-up left by anything earlier.
bk_rm_config
docker exec "$CONTAINER" rm -rf /tmp/fake-nas /tmp/bk-x /tmp/bk-xf
req GET "/api/audit?action=backup.run&limit=1" "$ADMIN"
expect_status 200 "audit backup.run before the suite"
BK_AUDIT0=$(jqr '.total')

# ============================================================================
step "backup-1. access: logged out 401, admin 200, every other role 403"
# ============================================================================

req GET /api/backup/status
expect_status 401 "logged out GET /api/backup/status"
req POST /api/backup/run "" '{}'
expect_status 401 "logged out POST /api/backup/run"
for bk_jar in "$SCHED" "$ACCT" "$DPM" "$SHOW"; do
  req GET /api/backup/status "$bk_jar"
  bk_seen
  expect_status 403 "non-admin GET /api/backup/status ($(basename "$bk_jar"))"
  req POST /api/backup/run "$bk_jar" '{}'
  bk_seen
  expect_status 403 "non-admin POST /api/backup/run ($(basename "$bk_jar"))"
done
bk_status "admin GET /api/backup/status"
expect_jq 'has("enabled") and has("scheduleOn") and has("tools") and has("running") and has("snapshot") and has("copy") and has("archives") and has("totals") and has("recent")' "the status has the section 9 fields"

# ============================================================================
step "backup-2. nothing set up: snapshots off, copy not set up, Back up now 409"
# ============================================================================

bk_mark
bk_status
expect_jq '.enabled == true and .scheduleOn == false and .tools.sevenZip == true and .tools.rsync == true and .running == null' "enabled, no schedule in CI, both tools present"
expect_jq '.snapshot.state == "off" and .snapshot.passphrase == "missing"' "snapshots are off without a passphrase"
expect_jq '.copy.state == "off" and .copy.files.nasUrl == "missing" and .copy.files.nasPassword == "missing" and .copy.locked == false' "the copy is not set up"
bk_run
expect_status 409 "Back up now with nothing set up"
expect_jq '.error | startswith("Snapshots are off: the backup passphrase is not on the server.")' "the 409 says the passphrase is not on the server"
expect_eq "$(bk_val "SELECT COUNT(*) AS n FROM backup_runs WHERE id > $BK_BEFORE")" 0 "no backup_runs row for a refused Back up now"
req GET "/api/audit?action=backup.run&limit=1" "$ADMIN"
expect_eq "$(jqr '.total')" "$BK_AUDIT0" "no backup.run audit row for a refused Back up now"

# ============================================================================
step "backup-3. passphrase not usable (11 characters): invalid, Back up now 409"
# ============================================================================

bk_put backup-passphrase "$BK_PP_SHORT"
bk_status
expect_jq '.snapshot.state == "invalid" and .snapshot.passphrase == "not_usable"' "an 11-character passphrase is not usable"
bk_run
expect_status 409 "Back up now with an unusable passphrase"
expect_jq '.error | startswith("The backup passphrase file is not usable")' "the 409 says the passphrase file is not usable"
expect_eq "$(bk_val "SELECT COUNT(*) AS n FROM backup_runs WHERE id > $BK_BEFORE")" 0 "still no backup_runs row"

# ============================================================================
step "backup-4. passphrase only: a manual snapshot, encrypted, names hidden, restorable"
# ============================================================================

bk_put backup-passphrase "$BK_PP"
# A hand-made copy of the passphrase beside it (Backup 4.3): no copy of the passphrase may ever
# go in an archive, whatever its suffix. Removed again after this step's checks.
bk_put backup-passphrase.bak "$BK_PP"
bk_status
expect_jq '.snapshot.state == "ready" and .snapshot.passphrase == "set" and .copy.state == "off"' "snapshots ready, the copy still off"
bk_run
expect_status 202 "Back up now with the passphrase only"
expect_jq '.running == true and .joined == false and .copy == false' "a new flight, without a copy"
bk_wait 1 "the passphrase-only run"
expect_jq ".snapshot.last.id > $BK_BEFORE and .snapshot.last.kind == \"snapshot\" and .snapshot.last.trigger == \"manual\" and .snapshot.last.status == \"succeeded\"" "the manual snapshot succeeded"
expect_jq '.snapshot.last.sentence | test("^Succeeded: an? ")' "the snapshot sentence says it succeeded"
expect_jq ".snapshot.lastSuccess.id == .snapshot.last.id" "lastSuccess is this run"
expect_eq "$(bk_val "SELECT COUNT(*) AS n FROM backup_runs WHERE id > $BK_BEFORE AND kind = 'copy'")" 0 "no copy row while the NAS is not set up"
BK_ARCH4=$(jqr '.snapshot.last.detail.archive')
case $BK_ARCH4 in
  crosscuts-db-*-manual.7z) ok ;;
  *) fail "the manual snapshot's archive name is '$BK_ARCH4'" ;;
esac
expect_jq "[.archives[] | select(.name == \"$BK_ARCH4\" and .kind == \"manual\" and .bytes > 0)] | length == 1" "the archive is listed as manual"
expect_jq '.totals.archives >= 1 and .totals.archiveBytes > 0' "the totals count it"
BK_VACUUM4=$(jqr '.snapshot.last.detail.vacuumMs')
BK_CHECK4=$(jqr '.snapshot.last.detail.checkMs')
docker exec "$CONTAINER" sh -c 'test -f "$1"' sh "$BK_ARCHIVES/$BK_ARCH4" || fail "the archive file is not in $BK_ARCHIVES"
ok

echo "7-Zip: the archive opens with the passphrase only, and hides its names..."
bk_7z t -bsp0 -bso0 "-p$BK_PP" -- "$BK_ARCHIVES/$BK_ARCH4" >/dev/null 2>&1 || fail "7z t with the passphrase failed"
ok
if bk_7z t -bsp0 -bso0 "-p$BK_PP_WRONG" -- "$BK_ARCHIVES/$BK_ARCH4" >/dev/null 2>&1; then
  fail "7z t accepted a wrong passphrase"
fi
ok
bk_list_wrong=$(bk_7z l "-p$BK_PP_WRONG" -- "$BK_ARCHIVES/$BK_ARCH4" 2>&1 || true)
case $bk_list_wrong in
  *photos.db* | *MANIFEST.txt*) fail "7z l with a wrong passphrase shows the names inside" ;;
  *) ok ;;
esac
bk_list_right=$(bk_7z l "-p$BK_PP" -- "$BK_ARCHIVES/$BK_ARCH4" 2>&1 || true)
case $bk_list_right in
  *photos.db*MANIFEST.txt* | *MANIFEST.txt*photos.db*) ok ;;
  *) fail "7z l with the passphrase does not list photos.db and MANIFEST.txt" ;;
esac
case $bk_list_right in
  *passphrase*) fail "the archive holds a backup-passphrase file (backup-passphrase.bak was beside it)" ;;
  *) ok ;;
esac

echo "Extracting it: photos.db is sound and matches the live database and MANIFEST.txt..."
docker exec "$CONTAINER" sh -c 'rm -rf /tmp/bk-x && mkdir -p /tmp/bk-x'
bk_7z x -bsp0 -bso0 -y "-p$BK_PP" -o/tmp/bk-x -- "$BK_ARCHIVES/$BK_ARCH4" >/dev/null 2>&1 || fail "7z x with the passphrase failed"
ok
bk_facts=$(docker exec "$CONTAINER" node -e '
const fs = require("fs");
const D = require("better-sqlite3");
const M = require("/app/lib/backup/manifest");
const man = M.parseManifest(fs.readFileSync("/tmp/bk-x/MANIFEST.txt", "utf8"));
const x = new D("/tmp/bk-x/photos.db", { readonly: true });
const check = x.pragma("integrity_check", { simple: true });
const facts = M.dbFacts(x);
x.close();
const live = new D("/data/db/photos.db", { readonly: true });
const n = (t) => live.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
const liveCounts = { users: n("users"), jobs: n("jobs") };
live.close();
process.stdout.write(JSON.stringify({
  check, manOk: !!man, kind: man && man.kind, man: man && man.counts, arch: facts.counts, live: liveCounts,
  migrations: man && man.migrationCount, archMigrations: facts.migrationCount, configFiles: man ? man.configFiles : null,
  passphraseFile: fs.existsSync("/tmp/bk-x/config/backup-passphrase"),
  passphraseCopies: fs.existsSync("/tmp/bk-x/config") ? fs.readdirSync("/tmp/bk-x/config").filter((n) => /passphrase/i.test(n)).length : 0,
}));') || fail "could not read the extracted archive"
printf '%s' "$bk_facts" | jq -e '.check == "ok" and .manOk == true and .kind == "manual"' >/dev/null \
  || fail "the extracted photos.db or MANIFEST.txt is not right: $bk_facts"
ok
printf '%s' "$bk_facts" | jq -e '.arch.users == .live.users and .arch.jobs == .live.jobs' >/dev/null \
  || fail "the archive's users/jobs counts differ from the live database: $bk_facts"
ok
printf '%s' "$bk_facts" | jq -e '.man == .arch and .migrations == .archMigrations' >/dev/null \
  || fail "MANIFEST.txt counts differ from the archived photos.db: $bk_facts"
ok
printf '%s' "$bk_facts" | jq -e '.passphraseFile == false and .passphraseCopies == 0 and ((.configFiles // []) | map(select(test("passphrase"; "i"))) | length == 0)' >/dev/null \
  || fail "the archive holds config/backup-passphrase or a copy of it (backup-passphrase.bak): $bk_facts"
ok
docker exec "$CONTAINER" rm -rf /tmp/bk-x
docker exec "$CONTAINER" rm -f /data/config/backup-passphrase.bak

echo "An immediate second Back up now is too soon..."
bk_run
expect_status 429 "a second Back up now straight away"
expect_jq '(.retryAfterSeconds | type) == "number" and .retryAfterSeconds > 0' "the 429 carries retryAfterSeconds"
expect_jq '.error | startswith("A good snapshot was taken less than 10 minutes ago.")' "the 429 says why"
req GET "/api/audit?action=backup.run&limit=5" "$ADMIN"
expect_status 200 "GET /api/audit?action=backup.run"
expect_eq "$(jqr '.total')" "$((BK_AUDIT0 + 1))" "one backup.run audit row (not for the 409s or the 429)"
expect_jq ".rows[0].action == \"backup.run\" and .rows[0].actorUserId == $BK_ADMIN_ID" "the audit row names the admin"

echo "Information only (section 18 item 2): does this image's 7-Zip read a passphrase from stdin?"
bk_stdin_rc=0
printf '%s\n' "$BK_PP" | docker exec -i "$CONTAINER" timeout 20 "$BK_7Z" t -bsp0 -bso0 -- "$BK_ARCHIVES/$BK_ARCH4" >/dev/null 2>&1 \
  || bk_stdin_rc=$?
if [ "$bk_stdin_rc" = 0 ]; then
  echo "INFO: 7-Zip ($BK_7Z) read the passphrase from stdin (no -p): archive.js could switch to stdin."
else
  echo "INFO: 7-Zip ($BK_7Z) did not read the passphrase from stdin (exit $bk_stdin_rc; 124 or 143 = timed out after 20 s): -p stays."
fi

# ============================================================================
step "backup-5. event loop: /healthz answers during a run; vacuumMs"
# ============================================================================

bk_rewind
bk_mark
bk_run
expect_status 202 "Back up now for the event-loop check"
bk_slow=0
for bk_i in $(seq 1 20); do
  bk_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/healthz" || true)
  [ "$bk_code" = 200 ] || bk_slow=$((bk_slow + 1))
done
[ "$bk_slow" = 0 ] || fail "$bk_slow of 20 /healthz calls during a run did not answer 200 within 2 s"
ok
bk_wait 1 "the event-loop run"
expect_jq ".snapshot.last.id > $BK_BEFORE and .snapshot.last.status == \"succeeded\"" "the event-loop run's snapshot succeeded"
echo "INFO: VACUUM INTO took $BK_VACUUM4 ms (step 4) and $(jqr '.snapshot.last.detail.vacuumMs') ms (this run); integrity_check took $BK_CHECK4 ms (step 4) and $(jqr '.snapshot.last.detail.checkMs') ms (this run); the snapshot took $(jqr '.snapshot.last.detail.durationMs') ms. Both block the event loop (accepted, contracts section 18)."

# ============================================================================
step "backup-6. NAS half set up, then not usable"
# ============================================================================

bk_put nas-url "$BK_NAS_URL"
bk_status
expect_jq '.copy.state == "half" and .copy.files.nasUrl == "set" and .copy.files.nasPassword == "missing"' "only nas-url: half set up"
bk_put nas-password "$BK_NAS_PW"
bk_put nas-url "rsync://$BK_ACCOUNT@nas.example.test:$BK_PORT/$BK_MODULE"
bk_status
expect_jq '.copy.state == "invalid" and .copy.files.nasUrl == "not_usable" and .copy.files.nasPassword == "set"' "an address with a host name is not usable"

# ============================================================================
step "backup-7. the copy: archives, a photo and an encrypted private file reach the stand-in"
# ============================================================================

echo "--- start the stand-in NAS inside the container ---"
bk_nas_stop
# rsync refuses to start while an old pid file exists.
docker exec "$CONTAINER" sh -c 'rm -rf /tmp/fake-nas /tmp/bk-rsyncd.pid && mkdir -p /tmp/fake-nas/photos && chmod 700 /tmp/fake-nas'
docker exec -i "$CONTAINER" sh -c 'cat > /tmp/bk-rsyncd.conf' <<EOF
pid file = /tmp/bk-rsyncd.pid
log file = /tmp/bk-rsyncd.log
use chroot = no

[$BK_MODULE]
  path = /tmp/fake-nas
  read only = no
  uid = root
  gid = root
  auth users = $BK_ACCOUNT
  secrets file = /tmp/bk-rsyncd.secrets
  refuse options = delete remove-source-files partial inplace append
EOF
printf '%s:%s\n' "$BK_ACCOUNT" "$BK_NAS_PW" | docker exec -i "$CONTAINER" sh -c \
  'umask 077 && cat > /tmp/bk-rsyncd.secrets && chmod 600 /tmp/bk-rsyncd.secrets'
docker exec -d "$CONTAINER" rsync --daemon --no-detach "--port=$BK_PORT" --config=/tmp/bk-rsyncd.conf
bk_up=""
for _ in $(seq 1 40); do
  if bk_nas_answers; then
    bk_up=1
    break
  fi
  sleep 0.5
done
[ -n "$bk_up" ] || fail "the stand-in NAS (rsync --daemon) did not start"
ok

echo "--- a foreign file the app must never touch ---"
docker exec "$CONTAINER" sh -c 'head -c 4096 /dev/urandom > /tmp/fake-nas/photos/foreign-not-ours.jpg'
BK_FOREIGN="/tmp/fake-nas/photos/foreign-not-ours.jpg"
BK_FOREIGN_SHA=$(bk_sha "$BK_FOREIGN")
BK_FOREIGN_MTIME=$(docker exec "$CONTAINER" stat -c %Y "$BK_FOREIGN" | tr -d '\r')
[ -n "$BK_FOREIGN_SHA" ] && [ -n "$BK_FOREIGN_MTIME" ] || fail "could not record the foreign file"
ok

echo "--- place the NAS files ---"
bk_put nas-password "$BK_NAS_PW"
bk_put nas-url "$BK_NAS_URL"
bk_status
expect_jq '.copy.state == "ready" and .copy.locked == false and .copy.files.nasUrl == "set" and .copy.files.nasPassword == "set"' "the copy is set up"

echo "--- a test photo (admin) and a private report file (accounts) ---"
printf '%s' "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" | base64 -d >"$WORK/bk-photo.png"
bk_photo=$(curl -sf -H "Origin: $ORIGIN_OK" -b "$ADMIN" -F "photos=@$WORK/bk-photo.png;type=image/png" -F "tags=ci-backup" "$BASE/api/photos") \
  || fail "the backup test photo did not upload"
[ "$(printf '%s' "$bk_photo" | jq -r '.failed | length')" = 0 ] || fail "the backup test photo failed: $bk_photo"
BK_PHOTO=$(printf '%s' "$bk_photo" | jq -r '.created[0].url' | sed 's#^/photos/##')
BK_THUMB=$(printf '%s' "$bk_photo" | jq -r '.created[0].thumbUrl' | sed 's#^/photos/##')
[ -n "$BK_PHOTO" ] && [ "$BK_PHOTO" != null ] && [ -n "$BK_THUMB" ] && [ "$BK_THUMB" != null ] \
  || fail "no file names in the photo upload: $bk_photo"
ok

printf '%%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%% ci backup report\n%%%%EOF\n' >"$WORK/bk-report.pdf"
BK_PERIOD=$(TZ=Australia/Sydney date +%Y-%m)
LAST_REQ="POST /api/reports (backup test file)"
STATUS=$(curl -s -o "$BODY_FILE" -w '%{http_code}' -H "Origin: $REQ_ORIGIN" -b "$ACCT" \
  -F "period=$BK_PERIOD" -F "category=other" --form-string "title=CI Backup Report" \
  -F "file=@$WORK/bk-report.pdf;filename=ci-backup-report.pdf;type=application/pdf" "$BASE/api/reports")
BODY=$(cat "$BODY_FILE")
expect_status 201 "acct uploads the backup test report"
BK_FILE_ID=$(jqr '.file.id')
BK_STORED=$(bk_val "SELECT stored_name FROM files WHERE id = $BK_FILE_ID")
BK_FILE_SHA=$(bk_val "SELECT sha256 FROM files WHERE id = $BK_FILE_ID")
[ -n "$BK_STORED" ] && [ -n "$BK_FILE_SHA" ] || fail "no files row for the uploaded report (file id $BK_FILE_ID)"
ok

echo "--- Back up now with the NAS set up ---"
bk_rewind
bk_mark
bk_run
expect_status 202 "Back up now with the NAS set up"
expect_jq '.running == true and .joined == false and .copy == true' "a new flight with a copy"
bk_wait 2 "the first copy"
expect_jq ".snapshot.last.id > $BK_BEFORE and .snapshot.last.status == \"succeeded\"" "the snapshot succeeded"
expect_jq ".copy.last.id > $BK_BEFORE and .copy.last.kind == \"copy\" and .copy.last.trigger == \"manual\" and .copy.last.status == \"succeeded\"" "the copy succeeded"
expect_jq '.copy.last.detail.missingAfter == 0 and .copy.last.detail.attempted == true' "nothing missing after the copy"
expect_jq '(.copy.last.sentence | startswith("Succeeded: ")) and (.copy.last.sentence | contains("proved on the NAS"))' "the copy sentence says proved on the NAS"
expect_jq '.copy.last.detail.folders.db.sent >= 1 and .copy.last.detail.folders.files.sent >= 1 and .copy.last.detail.folders.photos.sent >= 2' "every folder sent something"
expect_jq ".copy.lastSuccess.id == .copy.last.id and .copy.locked == false" "lastSuccess is this copy"
BK_ARCH7=$(jqr '.snapshot.last.detail.archive')

echo "--- on the stand-in ---"
bk_db_check=$(docker exec "$CONTAINER" node -e '
const fs = require("fs");
const path = require("path");
const A = "/data/db/backups/archives";
const N = "/tmp/fake-nas/db";
const bad = [];
let n = 0;
for (const f of fs.readdirSync(A)) {
  if (!/^crosscuts-.*\.7z$/.test(f)) continue;
  const st = fs.lstatSync(path.join(A, f));
  if (!st.isFile()) continue;
  n += 1;
  let r = null;
  try { r = fs.statSync(path.join(N, f)); } catch {}
  if (!r) bad.push(f + ": missing");
  else if (r.size !== st.size) bad.push(f + ": " + r.size + " bytes, not " + st.size);
}
process.stdout.write(JSON.stringify({ n, bad }));') || fail "could not compare db/ with the archives"
printf '%s' "$bk_db_check" | jq -e '.n >= 3 and (.bad | length) == 0' >/dev/null \
  || fail "db/ on the stand-in does not hold every verified archive at its size: $bk_db_check"
ok
for bk_f in "$BK_PHOTO" "$BK_THUMB"; do
  bk_local=$(bk_sha "/data/uploads/$bk_f")
  bk_remote=$(bk_sha "/tmp/fake-nas/photos/$bk_f")
  [ -n "$bk_local" ] && [ "$bk_local" = "$bk_remote" ] || fail "photos/$bk_f on the stand-in is missing or differs (plain copy expected)"
  ok
done
BK_BLOB="/tmp/fake-nas/files/$BK_STORED.7z"
docker exec "$CONTAINER" sh -c 'test -f "$1"' sh "$BK_BLOB" || fail "files/<stored name>.7z is not on the stand-in"
ok
docker exec "$CONTAINER" sh -c 'test ! -e "$1"' sh "/tmp/fake-nas/files/$BK_STORED" || fail "the private file reached the stand-in in plain"
ok
[ "$(bk_sha "$BK_BLOB")" != "$BK_FILE_SHA" ] || fail "the blob on the stand-in is the plain file"
ok
if bk_7z t -bsp0 -bso0 "-p$BK_PP_WRONG" -- "$BK_BLOB" >/dev/null 2>&1; then
  fail "the private blob opens with a wrong passphrase"
fi
ok
docker exec "$CONTAINER" sh -c 'rm -rf /tmp/bk-xf && mkdir -p /tmp/bk-xf'
bk_7z x -bsp0 -bso0 -y "-p$BK_PP" -o/tmp/bk-xf -- "$BK_BLOB" >/dev/null 2>&1 || fail "7z x of the private blob failed"
expect_eq "$(bk_sha "/tmp/bk-xf/$BK_STORED")" "$BK_FILE_SHA" "the decrypted blob has the files row's sha256"
docker exec "$CONTAINER" rm -rf /tmp/bk-xf
bk_proven=$(bk_val "SELECT proven_at FROM backup_blobs WHERE stored_name = '$BK_STORED'")
[ -n "$bk_proven" ] && [ "$bk_proven" != null ] || fail "backup_blobs has no proven_at for the test file"
ok
bk_status
expect_jq '.totals.blobsTracked >= 1 and .totals.blobsProven >= 1' "the status counts the proven blobs"

echo "--- this run's archive carries the NAS files, never the passphrase ---"
bk_list7=$(bk_7z l "-p$BK_PP" -- "$BK_ARCHIVES/$BK_ARCH7" 2>&1 || true)
case $bk_list7 in *config/nas-url*) ok ;; *) fail "the archive $BK_ARCH7 has no config/nas-url" ;; esac
case $bk_list7 in *config/nas-password*) ok ;; *) fail "the archive $BK_ARCH7 has no config/nas-password" ;; esac
case $bk_list7 in *backup-passphrase*) fail "the archive $BK_ARCH7 holds backup-passphrase" ;; *) ok ;; esac

expect_eq "$(bk_sha "$BK_FOREIGN")" "$BK_FOREIGN_SHA" "the foreign file's contents are unchanged"
expect_eq "$(docker exec "$CONTAINER" stat -c %Y "$BK_FOREIGN" | tr -d '\r')" "$BK_FOREIGN_MTIME" "the foreign file's mtime is unchanged"

# ============================================================================
step "backup-8. second run: only its own new archive is sent; nothing removed"
# ============================================================================

BK_NAS_BEFORE=$(bk_nas_files)
bk_rewind
bk_mark
bk_run
expect_status 202 "the second Back up now"
bk_wait 2 "the second copy"
expect_jq ".copy.last.id > $BK_BEFORE and .copy.last.status == \"succeeded\" and .copy.last.detail.missingAfter == 0" "the second copy succeeded"
expect_jq '.copy.last.detail.folders.photos.sent == 0 and .copy.last.detail.folders.files.sent == 0 and .copy.last.detail.folders.db.sent == 1' "only the new archive was sent"
expect_jq '.copy.last.detail.folders.photos.alreadyThere >= 2 and .copy.last.detail.folders.files.alreadyThere >= 1' "the rest was already there"
BK_ARCH8=$(jqr '.snapshot.last.detail.archive')
BK_NAS_AFTER=$(bk_nas_files)
jq -en --argjson a "$BK_NAS_BEFORE" --argjson b "$BK_NAS_AFTER" '$a | to_entries | all(.value == $b[.key])' >/dev/null \
  || fail "a file on the stand-in was removed or changed by the second run"
ok
jq -en --argjson a "$BK_NAS_BEFORE" --argjson b "$BK_NAS_AFTER" --arg n "db/$BK_ARCH8" '(($b | length) - ($a | length)) == 1 and ($b | has($n))' >/dev/null \
  || fail "the second run added something other than its own archive db/$BK_ARCH8"
ok
expect_eq "$(bk_sha "$BK_FOREIGN")" "$BK_FOREIGN_SHA" "the foreign file is still unchanged"
expect_eq "$(docker exec "$CONTAINER" stat -c %Y "$BK_FOREIGN" | tr -d '\r')" "$BK_FOREIGN_MTIME" "the foreign file's mtime is still unchanged"

# ============================================================================
step "backup-9. wrong NAS password: the auth sentence, the refusal lock, a bell; re-placing unlocks"
# ============================================================================

bk_put nas-password "$BK_NAS_PW_WRONG"
bk_rewind
bk_mark
bk_run
expect_status 202 "Back up now with a wrong NAS password"
bk_wait 2 "the refused copy"
expect_jq ".copy.last.id > $BK_BEFORE and .copy.last.status == \"failed\" and .copy.last.reason == \"auth\"" "the copy failed with reason auth"
expect_jq "(.copy.last.sentence | contains(\"refused the password\")) and (.copy.last.sentence | endswith(\"$BK_COPY_TAIL\"))" "the auth sentence"
expect_jq '.copy.locked == true and .copy.state == "locked"' "the refusal lock holds"
expect_jq ".snapshot.last.id > $BK_BEFORE and .snapshot.last.status == \"succeeded\"" "the snapshot itself still succeeded"
bk_run
expect_status 409 "Back up now while the refusal lock holds (before the 10-minute rule)"
expect_jq ".error == \"$BK_FIX_FIRST\"" "the 409 is the fix-first sentence"
expect_eq "$(bk_val "SELECT COUNT(*) AS n FROM backup_runs WHERE id > $BK_BEFORE")" 2 "the 409 started nothing"
req GET "/api/notifications?limit=100" "$ADMIN"
expect_status 200 "admin GET /api/notifications"
bk_seen
expect_jq '[.rows[] | select(.kind == "backup.failed" and .readAt == null and .link == "/users.html#backups" and .title == "The copy to the NAS failed" and (.body | contains("refused the password")))] | length >= 1' "the admin has an unread backup.failed bell for the copy"
bk_bells=$(bk_val "SELECT COUNT(*) AS n FROM notifications WHERE user_id = $BK_ADMIN_ID AND kind = 'backup.failed' AND entity_type = 'backup' AND entity_id = 'copy' AND read_at IS NULL")
[ "$bk_bells" -ge 1 ] || fail "no unread backup.failed notification with entity backup/copy for the admin"
ok

echo "--- placing the password again clears the lock ---"
bk_put nas-password "$BK_NAS_PW"
bk_status
expect_jq '.copy.locked == false and .copy.state == "ready"' "a newer nas-password clears the lock"
bk_rewind
bk_mark
bk_run
expect_status 202 "Back up now after the password is placed again"
bk_wait 2 "the copy after the unlock"
expect_jq ".copy.last.id > $BK_BEFORE and .copy.last.status == \"succeeded\" and .copy.last.detail.missingAfter == 0" "the copy succeeds again"
expect_jq '.copy.locked == false' "still unlocked"

# ============================================================================
step "backup-10. the stand-in stopped: the NAS did not answer, no lock"
# ============================================================================

bk_nas_stop
bk_down=""
for _ in $(seq 1 20); do
  if ! bk_nas_answers; then
    bk_down=1
    break
  fi
  sleep 0.5
done
[ -n "$bk_down" ] || fail "the stand-in NAS did not stop"
ok
bk_rewind
bk_mark
bk_run
expect_status 202 "Back up now with the NAS down"
bk_wait 2 "the unreachable copy"
expect_jq ".copy.last.id > $BK_BEFORE and .copy.last.status == \"failed\" and .copy.last.reason == \"unreachable\"" "the copy failed with reason unreachable"
expect_jq "(.copy.last.sentence | startswith(\"The NAS did not answer\")) and (.copy.last.sentence | endswith(\"$BK_COPY_TAIL\"))" "the did-not-answer sentence"
expect_jq '.copy.locked == false and .copy.state == "ready"' "an unreachable NAS is not a refusal: no lock"
BK_ARCH10=$(jqr '.snapshot.last.detail.archive')

# ============================================================================
step "backup-11. no leaks: API bodies, the audit log, the bell, docker logs"
# ============================================================================

bk_status "a last status for the leak scan"
bk_scan "$BK_SEEN" "a /api/backup response"
BK_AUDIT_FILE="$WORK/bk-audit.txt"
: >"$BK_AUDIT_FILE"
bk_off=0
while :; do
  req GET "/api/audit?limit=500&offset=$bk_off" "$ADMIN"
  expect_status 200 "GET /api/audit (offset $bk_off)"
  printf '%s\n' "$BODY" >>"$BK_AUDIT_FILE"
  bk_total=$(jqr '.total')
  bk_off=$((bk_off + 500))
  [ "$bk_off" -lt "$bk_total" ] || break
done
bk_scan "$BK_AUDIT_FILE" "/api/audit"
req GET "/api/notifications?limit=100" "$ADMIN"
expect_status 200 "admin GET /api/notifications for the leak scan"
printf '%s\n' "$BODY" >"$WORK/bk-bell.txt"
bk_scan "$WORK/bk-bell.txt" "the admin's notifications"
docker logs "$CONTAINER" >"$WORK/bk-logs.txt" 2>&1
bk_scan "$WORK/bk-logs.txt" "docker logs"

# ============================================================================
step "backup-12. restore drill: restore.js db and files in a throwaway container"
# ============================================================================

BK_DRILL="$WORK/bk-drill"
mkdir -p "$BK_DRILL/db" "$BK_DRILL/uploads/files" "$BK_DRILL/config" "$BK_DRILL/in/files"
bk_status
BK_NEWEST=$(jqr '.archives[0].name')
expect_eq "$BK_NEWEST" "$BK_ARCH10" "the newest archive is the last run's"
docker cp "$CONTAINER:$BK_ARCHIVES/$BK_NEWEST" "$BK_DRILL/in/$BK_NEWEST" >/dev/null
docker cp "$CONTAINER:$BK_BLOB" "$BK_DRILL/in/files/$BK_STORED.7z" >/dev/null
bk_drill node -e '
const D = require("better-sqlite3");
const db = new D("/data/db/photos.db");
db.exec("CREATE TABLE dummy (x INTEGER); INSERT INTO dummy VALUES (1);");
db.close();' || fail "could not make the drill's dummy database"
ok

# The archive's own MANIFEST.txt counts, as JSON.
bk_manifest=$(bk_7z e -so "-p$BK_PP" -- "$BK_ARCHIVES/$BK_NEWEST" MANIFEST.txt 2>/dev/null || true)
bk_counts_line=$(printf '%s\n' "$bk_manifest" | sed -n 's/^counts: //p')
[ -n "$bk_counts_line" ] || fail "could not read the counts line of the archive's MANIFEST.txt"
BK_MAN_COUNTS=$(jq -cn --arg c "$bk_counts_line" '$c | split(", ") | map(split(" ") | {(.[0]): (.[1] | tonumber)}) | add')

# bk_drill_state: the drill's db/ and config/ (names and sizes) and photos.db's sha256.
bk_drill_state() {
  bk_drill node -e '
const fs = require("fs");
const crypto = require("crypto");
const list = (d) => fs.readdirSync(d).filter((n) => fs.lstatSync(d + "/" + n).isFile()).sort().map((n) => n + ":" + fs.statSync(d + "/" + n).size);
const sha = crypto.createHash("sha256").update(fs.readFileSync("/data/db/photos.db")).digest("hex");
process.stdout.write(JSON.stringify({ db: list("/data/db"), config: list("/data/config"), sha }));'
}

echo "--- restore.js db with the passphrase on stdin ---"
bk_rc=0
bk_out=$(printf '%s\n' "$BK_PP" | docker run --rm -i --network none -v "$BK_DRILL:/data" "$IMAGE" \
  node tools/restore.js db "/data/in/$BK_NEWEST" --config --yes 2>&1) || bk_rc=$?
[ "$bk_rc" = 0 ] || fail "restore.js db exited $bk_rc: ${bk_out:0:1500}"
ok
bk_after=$(bk_drill node -e '
const fs = require("fs");
const D = require("better-sqlite3");
const out = {};
const db = new D("/data/db/photos.db", { readonly: true });
out.check = db.pragma("integrity_check", { simple: true });
out.counts = {};
for (const t of ["users", "jobs", "week_rows", "photos", "files"]) {
  if (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name = ?").get("table", t).n) {
    out.counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
  }
}
db.close();
const before = fs.readdirSync("/data/db").filter((n) => /^photos-before-restore-.*\.db$/.test(n));
out.beforeFiles = before.length;
out.dummyRows = before.length === 1
  ? new D("/data/db/" + before[0], { readonly: true }).prepare("SELECT COUNT(*) AS n FROM dummy").get().n
  : null;
const mode = (f) => (fs.existsSync(f) ? (fs.statSync(f).mode & 0o777).toString(8) : null);
out.urlMode = mode("/data/config/nas-url");
out.passwordMode = mode("/data/config/nas-password");
out.passphrase = fs.existsSync("/data/config/backup-passphrase");
process.stdout.write(JSON.stringify(out));') || fail "could not read the restored drill folder"
printf '%s' "$bk_after" | jq -e '.check == "ok"' >/dev/null || fail "the restored photos.db failed integrity_check: $bk_after"
ok
printf '%s' "$bk_after" | jq -e --argjson m "$BK_MAN_COUNTS" '.counts == $m' >/dev/null \
  || fail "the restored counts differ from MANIFEST.txt ($BK_MAN_COUNTS): $bk_after"
ok
printf '%s' "$bk_after" | jq -e '.beforeFiles == 1 and .dummyRows == 1' >/dev/null \
  || fail "the replaced database was not kept as photos-before-restore-*.db: $bk_after"
ok
printf '%s' "$bk_after" | jq -e '.urlMode == "600" and .passwordMode == "600" and .passphrase == false' >/dev/null \
  || fail "--config did not restore nas-url and nas-password with mode 600 (or brought a passphrase): $bk_after"
ok

echo "--- restore.js files decrypts the blob ---"
bk_rc=0
bk_out=$(printf '%s\n' "$BK_PP" | docker run --rm -i --network none -v "$BK_DRILL:/data" "$IMAGE" \
  node tools/restore.js files /data/in/files 2>&1) || bk_rc=$?
[ "$bk_rc" = 0 ] || fail "restore.js files exited $bk_rc: ${bk_out:0:1500}"
ok
bk_restored_sha=$({ bk_drill sha256sum "/data/uploads/files/$BK_STORED" || true; } | cut -d' ' -f1)
expect_eq "$bk_restored_sha" "$BK_FILE_SHA" "the restored private file has its original sha256"

echo "--- a wrong passphrase exits 1 and changes nothing ---"
bk_state_before=$(bk_drill_state) || fail "could not read the drill folder"
bk_rc=0
bk_out=$(printf '%s\n' "$BK_PP_WRONG" | docker run --rm -i --network none -v "$BK_DRILL:/data" "$IMAGE" \
  node tools/restore.js db "/data/in/$BK_NEWEST" --yes 2>&1) || bk_rc=$?
expect_eq "$bk_rc" 1 "restore.js db with a wrong passphrase exits 1"
bk_state_after=$(bk_drill_state) || fail "could not read the drill folder"
expect_eq "$bk_state_after" "$bk_state_before" "a refused restore changed nothing in db/ or config/"

# ============================================================================
step "backup-13. clean-up: the stand-in and the backup set-up removed"
# ============================================================================

bk_nas_stop
docker exec "$CONTAINER" rm -rf /tmp/fake-nas /tmp/bk-x /tmp/bk-xf /tmp/bk-rsyncd.conf /tmp/bk-rsyncd.secrets /tmp/bk-rsyncd.pid /tmp/bk-rsyncd.log
bk_rm_config
bk_status
expect_jq '.snapshot.state == "off" and .copy.state == "off" and .running == null' "no backup set-up is left"
echo "Backup suite passed."
