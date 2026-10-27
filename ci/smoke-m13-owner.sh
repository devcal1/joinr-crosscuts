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
# The key counts and the owner-only list come from meta (M13 · 4.3, review C-m5), so adding a key,
# owner-only or not, doesn't break this suite. Only M13's own three keys are named.
req GET /api/users/meta "$ADMIN"
expect_status 200 "the owner GET /api/users/meta"
M13_O_OWNER_ONLY=$(printf '%s' "$BODY" | jq -c '.ownerOnlyKeys')
M13_O_NKEYS=$(jqr '.keys | length')
M13_O_NADMIN=$(jqr '.presets.admin | length')
expect_jq '(.ownerOnlyKeys | type) == "array" and (.ownerOnlyKeys | length) >= 3' "meta lists the owner-only keys"
expect_jq '(.ownerOnlyKeys | index("bonuses.manage")) != null and (.ownerOnlyKeys | index("alarms.manage")) != null and (.ownerOnlyKeys | index("loans.manage")) != null' \
  "the owner-only keys include M13's three"
expect_jq ".ownerId == $M13_O_ADMIN_ID" "meta names the admin as the owner"
expect_jq '. as $m | all(.ownerOnlyKeys[]; . as $k | $m.keys | index($k) != null)' "every owner-only key is in the key list"
expect_jq '. as $m | (.presets.admin | length) == (.keys | length) - (.ownerOnlyKeys | length) - ((.grantOnlyKeys // []) | length) and all(.presets.admin[]; . as $k | $m.keys | index($k) != null) and all(.ownerOnlyKeys[]; . as $k | $m.presets.admin | index($k) == null)' \
  "the admin preset is every key but the owner-only and grant-only ones ($M13_O_NADMIN of $M13_O_NKEYS)"
req GET /api/auth/me "$ADMIN"
expect_jq ".user.isOwner == true and (.user.perms | length) == $M13_O_NKEYS" "the owner holds all $M13_O_NKEYS keys"
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
expect_jq ".user.isOwner == false and (.user.perms | length) == $M13_O_NADMIN" \
  "the second admin isn't the owner and holds the admin preset's $M13_O_NADMIN keys"
expect_jq "[.user.perms[] | select(. as \$p | $M13_O_OWNER_ONLY | index(\$p) != null)] | length == 0" \
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
# Wrong passwords are sent from a made-up client address (X-Forwarded-For; the app trusts one proxy
# hop), so the failures they record, and the lockout they build, fall on that address only, never on
# the smoke's own address, where later suites log in. A new address each run (the run tag).
M13_O_XIP="198.51.100.$((M13_O_TAG % 200 + 20))"
# m13_o_xreq METHOD PATH JAR JSON: req, from $M13_O_XIP.
m13_o_xreq() {
  LAST_REQ="$1 $2 (from $M13_O_XIP)"
  STATUS=$(curl -s -o "$BODY_FILE" -D "$HDR_FILE" -w '%{http_code}' -X "$1" -H "Origin: $REQ_ORIGIN" \
    -H "X-Forwarded-For: $M13_O_XIP" -b "$3" -c "$3" -H 'Content-Type: application/json' --data "$4" "$BASE$2")
  BODY=$(cat "$BODY_FILE")
}
m13_o_xtransfer() { # JAR TARGET_ID CONFIRM PASSWORD, from $M13_O_XIP
  m13_o_xreq POST "/api/users/$2/owner" "$1" "$(jq -nc --arg u "$3" --arg p "$4" '{confirmUsername:$u,password:$p}')"
}
m13_o_transfer "$M13_O_ADM" "$M13_O_ADMIN_ID" "$M13_O_ADMIN_USER" "$M13_O_ADM_PW"
m13_o_refused 403 "Only the owner can hand over ownership" "the second admin takes ownership"
m13_o_transfer "$ADMIN" "$M13_O_ACCT_ID" "$M13_O_ACCT_USER" "$ADMIN_PW"
m13_o_refused 409 "The new owner must be an enabled admin" "the owner hands over to acct (not an admin)"
req POST "/api/users/$M13_O_ADM_ID/owner" "$ADMIN" '{"confirmUsername":"x"}'
m13_o_refused 400 "confirmUsername and password are required" "a hand-over without the password"
m13_o_transfer "$ADMIN" "$M13_O_ADM_ID" "not-$M13_O_ADM_USER" "$ADMIN_PW"
m13_o_refused 400 "Type $M13_O_ADM_USER to confirm" "a hand-over with the wrong username typed"
m13_o_xtransfer "$ADMIN" "$M13_O_ADM_ID" "$M13_O_ADM_USER" "Wrong-$ADMIN_PW"
m13_o_refused 403 "That password isn't right" "a hand-over with the wrong password"
m13_o_transfer "$ADMIN" "$M13_O_ADMIN_ID" "$M13_O_ADMIN_USER" "$ADMIN_PW"
m13_o_refused 409 "You're already the owner" "the owner hands over to themselves"
m13_o_transfer "$ADMIN" "$M13_O_ADM_ID" "  $(printf '%s' "$M13_O_ADM_USER" | tr 'a-z' 'A-Z')  " "$ADMIN_PW"
expect_status 200 "the owner hands over to the second admin (the username typed in capitals, with spaces)"
expect_jq ".from.id == $M13_O_ADMIN_ID and .from.isOwner == false and .to.id == $M13_O_ADM_ID and .to.isOwner == true" \
  "the answer names both, shaped as users"
req GET /api/auth/me "$M13_O_ADM"
expect_jq ".user.isOwner == true and (.user.perms | length) == $M13_O_NKEYS" "the second admin is now the owner, with all $M13_O_NKEYS keys"
req GET /api/auth/me "$ADMIN"
expect_jq ".user.isOwner == false and (.user.perms | length) == $M13_O_NADMIN" \
  "the old owner is an admin with the admin preset's $M13_O_NADMIN keys"
req GET /api/users/meta "$M13_O_ADM"
expect_jq ".ownerId == $M13_O_ADM_ID" "meta names the new owner"
req POST "/api/users/$M13_O_ADM_ID/password" "$ADMIN" '{"password":"M13-Taken-Over-1"}'
m13_o_refused 403 "Only the owner can reset the owner's password" "the old owner resets the new owner's password"
req GET "/api/audit?action=user.owner&entityId=$M13_O_ADM_ID" "$M13_O_ADM"
expect_status 200 "the new owner reads the user.owner audit rows"
expect_jq ".total >= 1 and .rows[0].entityType == \"user\" and .rows[0].before.ownerId == $M13_O_ADMIN_ID and .rows[0].after.ownerId == $M13_O_ADM_ID" \
  "a user.owner audit row records the hand-over"

echo "--- the hand-over's password check counts like a login (review A-m3) ---"
# The second admin, now the owner, gets its password wrong 10 times from $M13_O_XIP: each is 403
# and writes a failure audit row and a failed attempt. The 11th, even with the right password, is
# locked out, with the answer /api/auth/password gives from that address.
for i in 1 2 3 4 5 6 7 8 9 10; do
  m13_o_xtransfer "$M13_O_ADM" "$M13_O_ADMIN_ID" "$M13_O_ADMIN_USER" "Wrong-$i-$M13_O_ADM_PW"
  m13_o_refused 403 "That password isn't right" "wrong password $i on the hand-over"
done
m13_o_xtransfer "$M13_O_ADM" "$M13_O_ADMIN_ID" "$M13_O_ADMIN_USER" "$M13_O_ADM_PW"
m13_o_refused 429 "Too many failed attempts. Try again later." "the 11th try (the right password) is locked out"
expect_jq '(.retryAfterSec | type) == "number" and .retryAfterSec > 0' "the lockout carries retryAfterSec"
[ -n "$(hdr Retry-After)" ] || fail "the hand-over lockout has no Retry-After header"
ok
M13_O_LOCKED=$(printf '%s' "$BODY" | jq -c '{error, keys: keys}')
m13_o_xreq POST /api/auth/password "$M13_O_ADM" \
  "$(jq -nc --arg c "Wrong-$M13_O_ADM_PW" --arg n "M13-Never-Set-$M13_O_TAG" '{currentPassword:$c,newPassword:$n}')"
expect_status 429 "/api/auth/password from the same address is locked out too"
expect_eq "$(printf '%s' "$BODY" | jq -c '{error, keys: keys}')" "$M13_O_LOCKED" \
  "the hand-over's lockout answer is the password route's"
req GET "/api/audit?action=auth.login_failed&entityId=$M13_O_ADM_ID" "$M13_O_ADM"
expect_status 200 "the new owner reads the second admin's auth.login_failed rows"
expect_jq '.total == 10 and ([.rows[] | select(.entityType == "user" and .after.context == "owner_transfer")] | length) == 10' \
  "each wrong password wrote a failure audit row (context owner_transfer); the lockouts wrote none"
M13_O_ATT=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db");
d.pragma("busy_timeout = 5000");
const r = d.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(success), 0) AS s FROM auth_attempts WHERE kind = ? AND username = ? AND ip = ?")
  .get("password", process.argv[1], process.argv[2]);
console.log(r.n + "/" + r.s);
d.close();' "$M13_O_ADM_USER" "$M13_O_XIP") || fail "reading auth_attempts failed"
expect_eq "$M13_O_ATT" "10/0" "the 10 wrong passwords are recorded as failed attempts from that address"

# The lockout is for that address only: from the smoke's own address the right password works.
m13_o_transfer "$M13_O_ADM" "$M13_O_ADMIN_ID" "$M13_O_ADMIN_USER" "$M13_O_ADM_PW"
expect_status 200 "the second admin hands ownership back"
req GET /api/users/meta "$ADMIN"
expect_jq ".ownerId == $M13_O_ADMIN_ID" "meta names the admin as the owner again"
req GET /api/auth/me "$ADMIN"
expect_jq ".user.isOwner == true and (.user.perms | length) == $M13_O_NKEYS" "the admin holds all $M13_O_NKEYS keys again"

echo "--- email usernames, and changing a username (Todd 2026-10-20) ---"
M13_O_EM_A="m13.a$M13_O_TAG@example.test"
M13_O_EM_B="m13.b$M13_O_TAG@example.test"
M13_O_EM_PW="M13-Email-Passw0rd-$M13_O_TAG"
M13_O_PLAIN="m13plain$M13_O_TAG"
# A mixed-case email address is stored lowercase; the user has no roles beyond showroom.
req POST /api/users "$ADMIN" \
  "$(jq -nc --arg u "M13.A$M13_O_TAG@Example.TEST" --arg p "Tmp-$M13_O_EM_PW" '{username:$u,displayName:"M13 Email A",password:$p,roles:["showroom"]}')"
expect_status 201 "create a user whose username is an email address (typed in mixed case)"
expect_jq ".username == \"$M13_O_EM_A\"" "the email username is stored lowercase"
M13_O_EM_ID=$(jqr '.id')
# Not allowed: no dot in the domain, two @, a space, an empty part, too long.
for bad in "a@b" "a@@b.test" "a b@x.test" "a@b..test" "@x.test" "a@.test" "a@b.test." "$(printf 'x%.0s' $(seq 1 33))" "$(printf 'x%.0s' $(seq 1 60))@x.test"; do
  req POST /api/users "$ADMIN" "$(jq -nc --arg u "$bad" '{username:$u,displayName:"Bad",password:"Bad-Passw0rd-1",roles:[]}')"
  expect_status 400 "create with username '${bad:0:20}' is refused"
done
# A plain name still works.
create_user "$M13_O_PLAIN" "M13 Plain Name" "Tmp-$M13_O_EM_PW" showroom
M13_O_PLAIN_ID=$CREATED_ID
# Sign in with the address in any case.
M13_O_EM_JAR="$WORK/jar-m13-em"
new_jar "$M13_O_EM_JAR"
login "$M13_O_EM_JAR" "M13.A$M13_O_TAG@EXAMPLE.test" "Tmp-$M13_O_EM_PW"
expect_status 200 "sign in with the email username typed in mixed case"
own_password "$M13_O_EM_JAR" "Tmp-$M13_O_EM_PW" "$M13_O_EM_PW"
M13_O_PLAIN_JAR="$WORK/jar-m13-plain"
new_jar "$M13_O_PLAIN_JAR"
login "$M13_O_PLAIN_JAR" "$(printf '%s' "$M13_O_PLAIN" | tr a-z A-Z)" "Tmp-$M13_O_EM_PW"
expect_status 200 "sign in with a plain username in capitals"

echo "--- renaming a login ---"
req PATCH "/api/users/$M13_O_EM_ID/username" "$ACCT" "{\"username\":\"x$M13_O_EM_B\"}"
expect_status 403 "acct (no users.admin) renames a login"
req PATCH "/api/users/$M13_O_EM_ID/username" "$ADMIN" '{"username":"a@b"}'
expect_status 400 "rename to an invalid username"
req PATCH "/api/users/$M13_O_EM_ID/username" "$ADMIN" '{}'
expect_status 400 "rename with no username"
req PATCH "/api/users/999999/username" "$ADMIN" "{\"username\":\"$M13_O_EM_B\"}"
expect_status 404 "rename a login that doesn't exist"
req PATCH "/api/users/$M13_O_EM_ID/username" "$ADMIN" "{\"username\":\"$(printf '%s' "$M13_O_PLAIN" | tr a-z A-Z)\"}"
expect_status 409 "rename to a name that is taken (case-insensitively)"
req PATCH "/api/users/$M13_O_EM_ID/username" "$ADMIN" "{\"username\":\"$M13_O_ACCT_USER\"}"
expect_status 409 "rename to another login's username"
req PATCH "/api/users/$M13_O_EM_ID/username" "$ADMIN" "{\"username\":\"  $(printf '%s' "$M13_O_EM_B" | tr a-z A-Z)  \"}"
expect_status 200 "the owner renames the email user (typed in capitals with spaces)"
expect_jq ".id == $M13_O_EM_ID and .username == \"$M13_O_EM_B\" and .displayName == \"M13 Email A\" and .roles == [\"showroom\"] and .mustChangePassword == false and .disabled == false" \
  "the new username is stored lowercase and everything else is as it was"
req GET "/api/audit?action=user.username&entityId=$M13_O_EM_ID" "$ADMIN"
expect_status 200 "read the user.username audit rows"
expect_jq ".total == 1 and .rows[0].entityType == \"user\" and .rows[0].before.username == \"$M13_O_EM_A\" and .rows[0].after.username == \"$M13_O_EM_B\"" \
  "a user.username audit row records the before and after"
# The same name again changes nothing and writes no second audit row.
req PATCH "/api/users/$M13_O_EM_ID/username" "$ADMIN" "{\"username\":\"$M13_O_EM_B\"}"
expect_status 200 "rename to the name it already has"
req GET "/api/audit?action=user.username&entityId=$M13_O_EM_ID" "$ADMIN"
expect_jq '.total == 1' "no second audit row for an unchanged username"
# The session they already had carries on, under the new name.
req GET /api/auth/me "$M13_O_EM_JAR"
expect_status 200 "the renamed user's existing session still works"
expect_jq ".user.username == \"$M13_O_EM_B\" and .user.id == $M13_O_EM_ID" "the session shows the new username"
M13_O_EM_JAR2="$WORK/jar-m13-em2"
new_jar "$M13_O_EM_JAR2"
login "$M13_O_EM_JAR2" "$M13_O_EM_A" "$M13_O_EM_PW"
expect_status 401 "the old username no longer signs in"
login "$M13_O_EM_JAR2" "$M13_O_EM_B" "$M13_O_EM_PW"
expect_status 200 "the new username signs in with the same password"
# The old name is free again.
req PATCH "/api/users/$M13_O_PLAIN_ID/username" "$M13_O_ADM" "{\"username\":\"$M13_O_EM_A\"}"
expect_status 200 "a second admin takes the freed username for another login"
req PATCH "/api/users/$M13_O_PLAIN_ID/username" "$M13_O_ADM" "{\"username\":\"$M13_O_PLAIN\"}"
expect_status 200 "and gives it back"
# The owner's username: only the owner.
req PATCH "/api/users/$M13_O_ADMIN_ID/username" "$M13_O_ADM" "{\"username\":\"owner.$M13_O_TAG@example.test\"}"
m13_o_refused 403 "Only the owner can change the owner's username" "the second admin renames the owner"
req PATCH "/api/users/$M13_O_ADMIN_ID/username" "$ADMIN" "{\"username\":\"owner.$M13_O_TAG@example.test\"}"
expect_status 200 "the owner renames themselves"
expect_jq ".isOwner == true and .username == \"owner.$M13_O_TAG@example.test\"" "still the owner, under the new username"
req GET /api/auth/me "$ADMIN"
expect_jq ".user.isOwner == true and (.user.perms | length) == $M13_O_NKEYS" "the owner's session is untouched"
M13_O_OWN2="$WORK/jar-m13-owner2"
new_jar "$M13_O_OWN2"
login "$M13_O_OWN2" "$M13_O_ADMIN_USER" "$ADMIN_PW"
expect_status 401 "the owner's old username no longer signs in"
login "$M13_O_OWN2" "owner.$M13_O_TAG@example.test" "$ADMIN_PW"
expect_status 200 "the owner signs in with the new username"
# Put the owner's username back for the suites after this one.
req PATCH "/api/users/$M13_O_ADMIN_ID/username" "$ADMIN" "{\"username\":\"$M13_O_ADMIN_USER\"}"
expect_status 200 "the owner changes their username back"
expect_jq ".username == \"$M13_O_ADMIN_USER\"" "the owner has the original username again"
for id in "$M13_O_EM_ID" "$M13_O_PLAIN_ID"; do
  req PATCH "/api/users/$id" "$ADMIN" '{"disabled":true}'
  expect_status 200 "disable the test login $id"
done

echo "--- clean-up, and no hand-over to a disabled admin (review A-M1) ---"
req PATCH "/api/users/$M13_O_ADM_ID" "$ADMIN" '{"disabled":true}'
expect_status 200 "the owner disables the second admin"
expect_jq '.disabled == true and .isOwner == false' "the second admin is disabled"
# The race itself (the target disabled while the password is being checked) can't be staged
# reliably from here; the route re-checks the target inside its transaction (routes/users.js), and
# the local replay for M13 · 4.3 proves it. This checks the answer.
m13_o_transfer "$ADMIN" "$M13_O_ADM_ID" "$M13_O_ADM_USER" "$ADMIN_PW"
m13_o_refused 409 "The new owner must be an enabled admin" "the owner hands over to the disabled second admin"
req GET /api/users "$ADMIN"
expect_jq "[.[] | select(.isOwner)] | length == 1 and .[0].id == $M13_O_ADMIN_ID and .[0].disabled == false" \
  "the admin is still the one owner, and enabled"

echo "M13 owner smoke test passed."
