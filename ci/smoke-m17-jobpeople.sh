# M17 smoke: names on Pipeline job tiles (migration 033, docs/plans/m3-contracts.md section 14).
# A login is linked to a board worker (users.worker_id, admin only, one login per worker); anyone
# with jobs.edit puts their own name on a job (job_people) and the job carries
# people: [{userId, name, hue|null}] for everyone who can see it. Sourced by ci/smoke.sh after the
# M16 suites, so it shares that script's helpers (step, req, expect_status, expect_jq, expect_eq,
# jqr, create_user, login, own_password, new_jar, fail, ok), the cookie jars ($ADMIN $SCHED $ACCT
# $DPM $SHOW), $WORK and $CONTAINER. No shebang and no `set`: the caller owns both.
# It does not assume a pristine database: it makes its own workers, users and jobs (names tagged
# M17) and checks only those.

# ============================================================================
step "m17-jobpeople. link a login to a worker; names on job tiles"
# ============================================================================

# SQL against the live database through the container's own better-sqlite3 (foreign keys on, as the
# app runs). m17_try SQL prints "ok" or the error's message.
m17_try() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.pragma("foreign_keys = ON");
try { d.exec(process.argv[1]); process.stdout.write("ok"); }
catch (e) { process.stdout.write(String(e.message)); }
d.close();' "$1" | tr -d '\r'
}

# --- the schema (migration 033) -------------------------------------------------------------
M17_COLS=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db", { readonly: true });
const c = d.prepare("PRAGMA table_info(users)").all().find((x) => x.name === "worker_id");
const jp = d.prepare("PRAGMA table_info(job_people)").all().map((x) => x.name).join(",");
process.stdout.write(JSON.stringify({ worker: !!c, notnull: c ? c.notnull : null, jp }));' | tr -d '\r')
expect_eq "$(printf '%s' "$M17_COLS" | jq -r '.worker')" "true" "users.worker_id exists"
expect_eq "$(printf '%s' "$M17_COLS" | jq -r '.notnull')" "0" "users.worker_id is nullable"
expect_eq "$(printf '%s' "$M17_COLS" | jq -r '.jp')" "job_id,user_id,added_by,added_at" "job_people columns"

# --- workers and logins ---------------------------------------------------------------------
req POST /api/workers "$ADMIN" '{"name":"M17 Worker A"}'
expect_status 201 "create worker A"
M17_WA=$(jqr '.id')
req PATCH "/api/workers/$M17_WA" "$ADMIN" '{"hue":200}'
expect_status 200 "worker A hue 200"
req POST /api/workers "$ADMIN" '{"name":"M17 Worker B"}'
expect_status 201 "create worker B"
M17_WB=$(jqr '.id')
req PATCH "/api/workers/$M17_WB" "$ADMIN" '{"hue":40}'
expect_status 200 "worker B hue 40"
req POST /api/workers "$ADMIN" '{"name":"M17 Worker Gone"}'
expect_status 201 "create worker Gone"
M17_WG=$(jqr '.id')
req PATCH "/api/workers/$M17_WG" "$ADMIN" '{"archived":true}'
expect_status 200 "archive worker Gone"

req GET /api/auth/me "$ADMIN"
M17_ADMIN_ID=$(jqr '.user.id')
req GET /api/auth/me "$DPM"
M17_DPM_ID=$(jqr '.user.id')
req GET /api/auth/me "$SCHED"
M17_SCHED_ID=$(jqr '.user.id')

# GET /api/users/meta lists the workers for the picker.
req GET /api/users/meta "$ADMIN"
expect_status 200 "users meta"
expect_jq "([.workers[] | select(.id == $M17_WA)] | length) == 1 and ([.workers[] | select(.id == $M17_WA)][0].hue == 200)" "meta lists worker A with its hue"
expect_jq "([.workers[] | select(.id == $M17_WG)][0].archived) == true" "meta marks archived workers"
req GET /api/users "$ADMIN"
expect_jq "([.[] | select(.id == $M17_ADMIN_ID)][0].workerId) == null" "a login starts with no worker"

# Admin only.
req PUT "/api/users/$M17_ADMIN_ID/worker" "$DPM" "{\"workerId\":$M17_WA}"
expect_status 403 "dpm cannot link a worker"
req PUT "/api/users/$M17_DPM_ID/worker" "$SCHED" "{\"workerId\":$M17_WA}"
expect_status 403 "scheduling cannot link a worker"
req PUT "/api/users/$M17_DPM_ID/worker" "" "{\"workerId\":$M17_WA}"
expect_status 401 "logged out cannot link a worker"

# Validation.
req PUT "/api/users/$M17_ADMIN_ID/worker" "$ADMIN" '{}'
expect_status 400 "workerId is required"
req PUT "/api/users/$M17_ADMIN_ID/worker" "$ADMIN" '{"workerId":"x"}'
expect_status 400 "workerId must be a number"
req PUT "/api/users/$M17_ADMIN_ID/worker" "$ADMIN" '{"workerId":999999}'
expect_status 400 "no such worker"
req PUT "/api/users/$M17_ADMIN_ID/worker" "$ADMIN" "{\"workerId\":$M17_WG}"
expect_status 400 "an archived worker cannot be newly linked"
req PUT "/api/users/999999/worker" "$ADMIN" "{\"workerId\":$M17_WA}"
expect_status 404 "no such user"

# Link the admin to A. One login per worker.
req PUT "/api/users/$M17_ADMIN_ID/worker" "$ADMIN" "{\"workerId\":$M17_WA}"
expect_status 200 "admin linked to worker A"
expect_jq ".workerId == $M17_WA" "the user shows its worker"
req PUT "/api/users/$M17_DPM_ID/worker" "$ADMIN" "{\"workerId\":$M17_WA}"
expect_status 409 "worker A is already linked to another login"
expect_jq '.error | test("already linked")' "the 409 says why"
req GET /api/users "$ADMIN"
expect_jq "([.[] | select(.id == $M17_DPM_ID)][0].workerId) == null" "the refused link changed nothing"
# Same worker again is a no-op, not a conflict (and writes no second audit row).
req PUT "/api/users/$M17_ADMIN_ID/worker" "$ADMIN" "{\"workerId\":$M17_WA}"
expect_status 200 "linking the same worker again"
# The database itself refuses two logins on one worker.
expect_eq "$(m17_try "UPDATE users SET worker_id = $M17_WA WHERE id = $M17_DPM_ID" | grep -ci 'unique')" "1" "migration 033: a second login on one worker is a UNIQUE error"
expect_eq "$(m17_try "UPDATE users SET worker_id = 999999 WHERE id = $M17_DPM_ID" | grep -ci 'foreign key')" "1" "migration 033: users.worker_id is a foreign key"

# DPM (jobs.edit) has no worker: its chip is grey (hue null).

# --- jobs, adding your own name -------------------------------------------------------------
M17_TAG="M17-$(date +%s)"
req POST /api/job-records "$ADMIN" "$(jq -nc --arg n "$M17_TAG Alpha" '{name:$n}')"
expect_status 201 "create job Alpha"
M17_J1=$(jqr '.id')
expect_jq '.people == []' "a new job has no people"
req POST /api/job-records "$ADMIN" "$(jq -nc --arg n "$M17_TAG Beta" '{name:$n}')"
expect_status 201 "create job Beta"
M17_J2=$(jqr '.id')

req POST "/api/job-records/$M17_J1/people" "$ADMIN"
expect_status 201 "admin adds their name"
expect_jq ".people | length == 1 and .[0].userId == $M17_ADMIN_ID and .[0].hue == 200 and (.[0].name | length > 0)" "the chip carries the worker's hue"
req POST "/api/job-records/$M17_J1/people" "$ADMIN"
expect_status 200 "adding again is a no-op"
expect_jq '.people | length == 1' "no duplicate name"

req POST "/api/job-records/$M17_J1/people" "$DPM"
expect_status 201 "dpm (jobs.edit) adds their name"
expect_jq ".people | length == 2 and (map(select(.userId == $M17_DPM_ID)) | .[0].hue) == null" "a login with no worker has hue null"
expect_jq ".people[0].userId == $M17_ADMIN_ID and .people[1].userId == $M17_DPM_ID" "names come oldest first"

# Without jobs.edit: 403 on add, but the names are visible.
req POST "/api/job-records/$M17_J1/people" "$SCHED"
expect_status 403 "scheduling cannot add a name"
req POST "/api/job-records/$M17_J1/people" "$ACCT"
expect_status 403 "accounts cannot add a name"
req POST "/api/job-records/$M17_J1/people" "$SHOW"
expect_status 403 "showroom cannot add a name"
req POST "/api/job-records/$M17_J1/people" ""
expect_status 401 "logged out cannot add a name"
req GET "/api/job-records/$M17_J1" "$SCHED"
expect_status 200 "scheduling reads the job"
expect_jq '.people | length == 2' "scheduling sees the names"
req GET "/api/job-records?archived=0" "$SCHED"
expect_status 200 "scheduling reads the list"
expect_jq "([.[] | select(.id == $M17_J1)][0].people | length) == 2 and ([.[] | select(.id == $M17_J2)][0].people | length) == 0" "the list carries each job's names"
req GET "/api/job-records?archived=0" "$ACCT"
expect_jq "([.[] | select(.id == $M17_J1)][0].people | map(.hue)) == [200, null]" "accounts sees the hues too"

# The hue follows the worker's colour, and a link change.
req PATCH "/api/workers/$M17_WA" "$ADMIN" '{"hue":300}'
expect_status 200 "worker A hue 300"
req GET "/api/job-records/$M17_J1" "$DPM"
expect_jq "(.people | map(select(.userId == $M17_ADMIN_ID))[0].hue) == 300" "the hue follows the worker's colour"
req PUT "/api/users/$M17_DPM_ID/worker" "$ADMIN" "{\"workerId\":$M17_WB}"
expect_status 200 "dpm linked to worker B"
req GET "/api/job-records/$M17_J1" "$DPM"
expect_jq "(.people | map(select(.userId == $M17_DPM_ID))[0].hue) == 40" "linking a worker gives the chip its hue"

# 404s.
req POST "/api/job-records/999999/people" "$ADMIN"
expect_status 404 "add to a job that does not exist"
req DELETE "/api/job-records/999999/people/$M17_ADMIN_ID" "$ADMIN"
expect_status 404 "remove from a job that does not exist"

# --- removing --------------------------------------------------------------------------------
req DELETE "/api/job-records/$M17_J1/people/$M17_ADMIN_ID" "$DPM"
expect_status 403 "a non-admin cannot remove someone else's name"
req DELETE "/api/job-records/$M17_J1/people/$M17_ADMIN_ID" "$SCHED"
expect_status 403 "scheduling cannot remove a name"
req DELETE "/api/job-records/$M17_J1/people/$M17_ADMIN_ID" "$SHOW"
expect_status 403 "showroom cannot remove a name"
req GET "/api/job-records/$M17_J1" "$DPM"
expect_jq '.people | length == 2' "the refused removals changed nothing"
req DELETE "/api/job-records/$M17_J1/people/$M17_DPM_ID" "$DPM"
expect_status 200 "dpm removes their own name"
expect_jq ".people | length == 1 and .[0].userId == $M17_ADMIN_ID" "only the admin's name is left"
req DELETE "/api/job-records/$M17_J1/people/$M17_DPM_ID" "$DPM"
expect_status 200 "removing a name that is not there is a no-op"

# An admin removes anyone's name.
req POST "/api/job-records/$M17_J1/people" "$DPM"
expect_status 201 "dpm adds again"
req POST "/api/job-records/$M17_J2/people" "$DPM"
expect_status 201 "dpm adds to Beta"
req DELETE "/api/job-records/$M17_J1/people/$M17_DPM_ID" "$ADMIN"
expect_status 200 "admin removes dpm's name"
expect_jq ".people | map(.userId) == [$M17_ADMIN_ID]" "dpm is off Alpha"
req GET "/api/job-records/$M17_J2" "$ADMIN"
expect_jq ".people | map(.userId) == [$M17_DPM_ID]" "and still on Beta"
req DELETE "/api/job-records/$M17_J1/people/$M17_ADMIN_ID" "$ADMIN"
expect_status 200 "admin removes their own name"
expect_jq '.people == []' "Alpha has nobody"

# The job fields still work with people present, and an edit doesn't touch the names.
req PATCH "/api/job-records/$M17_J2" "$DPM" '{"notes":"m17 note"}'
expect_status 200 "patch a job with people on it"
expect_jq ".notes == \"m17 note\" and (.people | length) == 1" "PATCH answers with the names"

# --- unlinking, the audit trail, the table ----------------------------------------------------
req PUT "/api/users/$M17_DPM_ID/worker" "$ADMIN" '{"workerId":null}'
expect_status 200 "unlink dpm's worker"
expect_jq '.workerId == null' "dpm has no worker"
req GET "/api/job-records/$M17_J2" "$SCHED"
expect_jq '.people[0].hue == null' "the chip goes grey"

req GET "/api/audit?action=job.person_add&entityType=job&entityId=$M17_J1&limit=20" "$ADMIN"
expect_status 200 "audit: person_add"
expect_jq ".rows | length == 3 and (map(.after.userId) | sort) == ([$M17_ADMIN_ID, $M17_DPM_ID, $M17_DPM_ID] | sort)" "one audit row per name added (no row for the no-op)"
req GET "/api/audit?action=job.person_remove&entityType=job&entityId=$M17_J1&limit=20" "$ADMIN"
expect_status 200 "audit: person_remove"
expect_jq ".rows | length == 3 and all(.[]; .before.userId != null and .after == null)" "one audit row per name removed (none for the no-op)"
expect_jq ".rows | map(.actorUserId) | sort == ([$M17_ADMIN_ID, $M17_ADMIN_ID, $M17_DPM_ID] | sort)" "the audit rows name who acted"
req GET "/api/audit?action=user.worker&entityType=user&entityId=$M17_DPM_ID&limit=20" "$ADMIN"
expect_status 200 "audit: user.worker"
expect_jq ".rows | length == 2" "linking and unlinking are audited, a refused link is not"
expect_jq "(.rows | map(.after.workerId) | sort) == [null, $M17_WB]" "the audit rows hold the worker ids"

# Table constraints.
expect_eq "$(m17_try "INSERT INTO job_people (job_id, user_id, added_by, added_at) VALUES ($M17_J2, $M17_DPM_ID, $M17_DPM_ID, 'x')" | grep -ci 'unique\|primary')" "1" "migration 033: one name per login per job"
expect_eq "$(m17_try "INSERT INTO job_people (job_id, user_id, added_by, added_at) VALUES (999999, $M17_DPM_ID, NULL, 'x')" | grep -ci 'foreign key')" "1" "migration 033: job_people.job_id is a foreign key"
expect_eq "$(m17_try "INSERT INTO job_people (job_id, user_id, added_by, added_at) VALUES ($M17_J2, 999999, NULL, 'x')" | grep -ci 'foreign key')" "1" "migration 033: job_people.user_id is a foreign key"
expect_eq "$(m17_try "INSERT INTO job_people (job_id, user_id, added_by) VALUES ($M17_J2, $M17_ADMIN_ID, NULL)" | grep -ci 'not null')" "1" "migration 033: added_at is required"

# Tidy: take the suite's names off and unlink, so the data is as the other suites expect.
req DELETE "/api/job-records/$M17_J2/people/$M17_DPM_ID" "$ADMIN"
expect_status 200 "tidy: remove dpm from Beta"
req PUT "/api/users/$M17_ADMIN_ID/worker" "$ADMIN" '{"workerId":null}'
expect_status 200 "tidy: unlink the admin"
