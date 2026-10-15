# M13 smoke, Wave 1 A: the owner and the owner-only keys.
# Sourced by ci/smoke.sh after the M12 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok, create_user, login, own_password, new_jar) and
# the cookie jars ($ADMIN, the owner since first-run setup; $ACCT; $DPM). No shebang and no `set`:
# the caller owns both.
# It does not assume a pristine database: its second admin carries a run tag, it reads user ids from
# /api/auth/me, and it checks only its own audit rows. It leaves the admin the owner and disables
# its second admin, so later suites see the users they expect. Made-up names only (this repo is
# public).
# Contract: docs/plans/m13-contracts.md sections 3 and 11.2.

# ============================================================================
step "m13. the owner and owner-only keys"
# ============================================================================

M13_O_TAG=$(date +%s)
M13_O_OWNER_ONLY='["bonuses.manage","alarms.manage","loans.manage"]'

# m13_o_me JAR: sets M13_O_ID and M13_O_USER to that user's id and username.
m13_o_me() {
  req GET /api/auth/me "$1"
  expect_status 200 "GET /api/auth/me"
  M13_O_ID=$(jqr '.user.id')
  M13_O_USER=$(jqr '.user.username')
}

# m13_o_refused STATUS SENTENCE WHAT: the last answer is STATUS with exactly that sentence.
m13_o_refused() {
  expect_status "$1" "$3"
  expect_jq ".error == $(jq -nc --arg e "$2" '$e')" "$3 says why"
}

# m13_o_audit_insert ENTITY_TYPE ACTION: one row straight into audit_log, as the M9 suite does.
m13_o_audit_insert() {
  docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
d.prepare("INSERT INTO audit_log (actor_label, action, entity_type, entity_id, after_json) VALUES (?, ?, ?, ?, ?)")
  .run("m13-smoke", process.argv[2], process.argv[1], "0", JSON.stringify({ m13: true }));
d.close();' "$1" "$2" || fail "inserting an audit_log row ($1) failed"
  ok
}

m13_o_me "$ADMIN"
M13_O_ADMIN_ID=$M13_O_ID
M13_O_ADMIN_USER=$M13_O_USER
m13_o_me "$ACCT"
M13_O_ACCT_ID=$M13_O_ID
M13_O_ACCT_USER=$M13_O_USER

echo "--- meta ---"
req GET /api/users/meta "$ADMIN"
expect_status 200 "the owner GET /api/users/meta"
expect_jq ".ownerOnlyKeys == $M13_O_OWNER_ONLY" "meta lists the three owner-only keys"
expect_jq ".ownerId == $M13_O_ADMIN_ID" "meta names the admin as the owner"
expect_jq '(.keys | length) == 30 and [.keys[27], .keys[28], .keys[29]] == .ownerOnlyKeys' \
  "the key list (30 keys) ends with the three owner-only keys"
req GET /api/auth/me "$ADMIN"
expect_jq '.user.isOwner == true and (.user.perms | length) == 30' "the owner holds all 30 keys"
req GET /api/users "$ADMIN"
expect_status 200 "the owner GET /api/users"
expect_jq "[.[] | select(.isOwner)] | length == 1 and .[0].id == $M13_O_ADMIN_ID" "exactly one user is the owner, the admin"
expect_jq "all(.[]; has(\"isOwner\"))" "every user object carries isOwner"

echo "--- a second admin ---"
M13_O_ADM_USER="m13adm$M13_O_TAG"
M13_O_ADM_PW="M13-Adm-Passw0rd-$M13_O_TAG"
create_user "$M13_O_ADM_USER" "M13 Second Admin $M13_O_TAG" "Tmp-$M13_O_ADM_PW" admin
M13_O_ADM_ID=$CREATED_ID
M13_O_ADM="$WORK/jar-m13-adm"
new_jar "$M13_O_ADM"
login "$M13_O_ADM" "$M13_O_ADM_USER" "Tmp-$M13_O_ADM_PW"
expect_status 200 "login the second admin"
own_password "$M13_O_ADM" "Tmp-$M13_O_ADM_PW" "$M13_O_ADM_PW"
req GET /api/auth/me "$M13_O_ADM"
expect_jq '.user.isOwner == false and (.user.perms | length) == 27' "the second admin isn't the owner and holds 27 keys"
expect_jq '[.user.perms[] | select(. == "bonuses.manage" or . == "alarms.manage" or . == "loans.manage")] | length == 0' \
  "the second admin holds none of the owner-only keys"

echo "--- a non-owner admin is refused ---"
req PUT "/api/users/$M13_O_ADM_ID/overrides/bonuses.manage" "$M13_O_ADM" '{"effect":"grant"}'
m13_o_refused 403 "Only the owner can grant or revoke bonuses.manage" "the second admin grants itself bonuses.manage"
req PUT "/api/users/$M13_O_ACCT_ID/overrides/loans.manage" "$M13_O_ADM" '{"effect":"grant"}'
m13_o_refused 403 "Only the owner can grant or revoke loans.manage" "the second admin grants acct loans.manage"
req DELETE "/api/users/$M13_O_ACCT_ID/overrides/loans.manage" "$M13_O_ADM"
m13_o_refused 403 "Only the owner can grant or revoke loans.manage" "the second admin revokes acct's loans.manage override"
req PATCH "/api/users/$M13_O_ADMIN_ID" "$M13_O_ADM" '{"displayName":"M13 Not The Owner"}'
m13_o_refused 403 "Only the owner can change the owner's login" "the second admin renames the owner"
req PATCH "/api/users/$M13_O_ADMIN_ID" "$M13_O_ADM" '{"roles":["accounts"]}'
m13_o_refused 403 "Only the owner can change the owner's login" "the second admin changes the owner's roles"
req PATCH "/api/users/$M13_O_ADMIN_ID" "$M13_O_ADM" '{"disabled":true}'
m13_o_refused 403 "Only the owner can change the owner's login" "the second admin disables the owner"
req POST "/api/users/$M13_O_ADMIN_ID/password" "$M13_O_ADM" '{"password":"M13-Taken-Over-1"}'
m13_o_refused 403 "Only the owner can reset the owner's password" "the second admin resets the owner's password"
req POST "/api/users/$M13_O_ADMIN_ID/sessions/revoke" "$M13_O_ADM"
m13_o_refused 403 "Only the owner can sign the owner out" "the second admin signs the owner out"
req PUT "/api/users/$M13_O_ADMIN_ID/overrides/board.edit" "$M13_O_ADM" '{"effect":"revoke"}'
m13_o_refused 403 "Only the owner can change the owner's login" "the second admin sets an override on the owner"
req DELETE "/api/users/$M13_O_ADMIN_ID/overrides/board.edit" "$M13_O_ADM"
m13_o_refused 403 "Only the owner can change the owner's login" "the second admin clears an override on the owner"
for p in /api/bonuses /api/alarms /api/loans /bonuses.html /alarms.html /loans.html; do
  req GET "$p" "$M13_O_ADM"
  expect_status 403 "the second admin GET $p"
done
req GET /api/auth/me "$ADMIN"
expect_jq ".user.id == $M13_O_ADMIN_ID and .user.isOwner == true" "the owner is still signed in and still the owner"
M13_O_FRESH="$WORK/jar-m13-owner-fresh"
new_jar "$M13_O_FRESH"
login "$M13_O_FRESH" "$M13_O_ADMIN_USER" "$ADMIN_PW"
expect_status 200 "the owner's password still works"

echo "--- the owner ---"
req PUT "/api/users/$M13_O_ADMIN_ID/overrides/board.edit" "$ADMIN" '{"effect":"revoke"}'
m13_o_refused 409 "The owner holds every key, so overrides don't apply" "the owner sets an override on themselves"
req PUT "/api/users/$M13_O_ACCT_ID/overrides/loans.manage" "$ADMIN" '{"effect":"grant"}'
expect_status 200 "the owner grants acct loans.manage"
expect_jq '(.perms | index("loans.manage")) != null and .isOwner == false' "acct now holds loans.manage"
req GET /api/loans "$ACCT"
expect_status 200 "acct GET /api/loans with the grant"
req GET /loans.html "$ACCT"
expect_status 200 "acct GET /loans.html with the grant"
req GET /bonuses.html "$ACCT"
expect_status 403 "acct GET /bonuses.html (only loans was granted)"
req POST "/api/users/$M13_O_ACCT_ID/password" "$M13_O_ADM" '{"password":"M13-Taken-Over-1"}'
m13_o_refused 403 "Only the owner can reset the password of someone holding loans.manage" \
  "the second admin resets the password of acct, who holds loans.manage"
req DELETE "/api/users/$M13_O_ACCT_ID/overrides/loans.manage" "$ADMIN"
expect_status 200 "the owner removes acct's loans.manage"
req GET /api/loans "$ACCT"
expect_status 403 "acct GET /api/loans after the override is removed"

echo "--- the audit filter ---"
M13_O_ACTION="m13.test.$M13_O_TAG"
m13_o_audit_insert bonus "$M13_O_ACTION"
m13_o_audit_insert alarm_slot "$M13_O_ACTION"
m13_o_audit_insert loan "$M13_O_ACTION"
req GET "/api/audit?action=$M13_O_ACTION" "$ADMIN"
expect_status 200 "the owner GET /api/audit for the test rows"
expect_jq '.total == 3 and (.rows | length) == 3' "the owner sees all three private rows"
req GET /api/audit/actions "$ADMIN"
expect_jq "index(\"$M13_O_ACTION\") != null" "the owner's action list names the test action"
req GET "/api/audit?action=$M13_O_ACTION" "$M13_O_ADM"
expect_status 200 "the second admin GET /api/audit for the test rows"
expect_jq '.total == 0 and (.rows | length) == 0' "the second admin sees none of them"
req GET "/api/audit?entityType=bonus" "$M13_O_ADM"
expect_status 200 "the second admin asks for bonus rows"
expect_jq '.total == 0 and .rows == []' "asking for a hidden entity type answers an empty list"
req GET /api/audit/actions "$M13_O_ADM"
expect_status 200 "the second admin GET /api/audit/actions"
expect_jq "index(\"$M13_O_ACTION\") == null" "the second admin's action list doesn't name the test action"
req PUT "/api/users/$M13_O_ADM_ID/overrides/loans.manage" "$ADMIN" '{"effect":"grant"}'
expect_status 200 "the owner grants the second admin loans.manage"
req GET "/api/audit?action=$M13_O_ACTION" "$M13_O_ADM"
expect_jq '.total == 1 and .rows[0].entityType == "loan"' "with loans.manage the second admin sees the loan row only"
req GET /api/audit/actions "$M13_O_ADM"
expect_jq "index(\"$M13_O_ACTION\") != null" "and its action is now listed"
req DELETE "/api/users/$M13_O_ADM_ID/overrides/loans.manage" "$ADMIN"
expect_status 200 "the owner removes the second admin's loans.manage"

echo "--- handing over ownership ---"
m13_o_transfer() { # JAR TARGET_ID CONFIRM PASSWORD
  req POST "/api/users/$2/owner" "$1" "$(jq -nc --arg u "$3" --arg p "$4" '{confirmUsername:$u,password:$p}')"
}
m13_o_transfer "$M13_O_ADM" "$M13_O_ADMIN_ID" "$M13_O_ADMIN_USER" "$M13_O_ADM_PW"
m13_o_refused 403 "Only the owner can hand over ownership" "the second admin takes ownership"
m13_o_transfer "$ADMIN" "$M13_O_ACCT_ID" "$M13_O_ACCT_USER" "$ADMIN_PW"
m13_o_refused 409 "The new owner must be an enabled admin" "the owner hands over to acct (not an admin)"
req POST "/api/users/$M13_O_ADM_ID/owner" "$ADMIN" '{"confirmUsername":"x"}'
m13_o_refused 400 "confirmUsername and password are required" "a hand-over without the password"
m13_o_transfer "$ADMIN" "$M13_O_ADM_ID" "not-$M13_O_ADM_USER" "$ADMIN_PW"
m13_o_refused 400 "Type $M13_O_ADM_USER to confirm" "a hand-over with the wrong username typed"
m13_o_transfer "$ADMIN" "$M13_O_ADM_ID" "$M13_O_ADM_USER" "Wrong-$ADMIN_PW"
m13_o_refused 403 "That password isn't right" "a hand-over with the wrong password"
m13_o_transfer "$ADMIN" "$M13_O_ADMIN_ID" "$M13_O_ADMIN_USER" "$ADMIN_PW"
m13_o_refused 409 "You're already the owner" "the owner hands over to themselves"
m13_o_transfer "$ADMIN" "$M13_O_ADM_ID" "  $(printf '%s' "$M13_O_ADM_USER" | tr 'a-z' 'A-Z')  " "$ADMIN_PW"
expect_status 200 "the owner hands over to the second admin (the username typed in capitals, with spaces)"
expect_jq ".from.id == $M13_O_ADMIN_ID and .from.isOwner == false and .to.id == $M13_O_ADM_ID and .to.isOwner == true" \
  "the answer names both, shaped as users"
req GET /api/auth/me "$M13_O_ADM"
expect_jq '.user.isOwner == true and (.user.perms | length) == 30' "the second admin is now the owner, with 30 keys"
req GET /api/auth/me "$ADMIN"
expect_jq '.user.isOwner == false and (.user.perms | length) == 27' "the old owner is an admin with 27 keys"
req GET /api/users/meta "$M13_O_ADM"
expect_jq ".ownerId == $M13_O_ADM_ID" "meta names the new owner"
req POST "/api/users/$M13_O_ADM_ID/password" "$ADMIN" '{"password":"M13-Taken-Over-1"}'
m13_o_refused 403 "Only the owner can reset the owner's password" "the old owner resets the new owner's password"
req GET "/api/audit?action=user.owner&entityId=$M13_O_ADM_ID" "$M13_O_ADM"
expect_status 200 "the new owner reads the user.owner audit rows"
expect_jq ".total >= 1 and .rows[0].entityType == \"user\" and .rows[0].before.ownerId == $M13_O_ADMIN_ID and .rows[0].after.ownerId == $M13_O_ADM_ID" \
  "a user.owner audit row records the hand-over"
m13_o_transfer "$M13_O_ADM" "$M13_O_ADMIN_ID" "$M13_O_ADMIN_USER" "$M13_O_ADM_PW"
expect_status 200 "the second admin hands ownership back"
req GET /api/users/meta "$ADMIN"
expect_jq ".ownerId == $M13_O_ADMIN_ID" "meta names the admin as the owner again"
req GET /api/auth/me "$ADMIN"
expect_jq '.user.isOwner == true and (.user.perms | length) == 30' "the admin holds all 30 keys again"

echo "--- clean-up ---"
req PATCH "/api/users/$M13_O_ADM_ID" "$ADMIN" '{"disabled":true}'
expect_status 200 "the owner disables the second admin"
expect_jq '.disabled == true and .isOwner == false' "the second admin is disabled"

echo "M13 owner smoke test passed."
