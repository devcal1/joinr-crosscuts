# M13 smoke, Wave 1 C: alarm holders and codes.
# Sourced by ci/smoke.sh after the M12 suites, so it shares that script's helpers (step, req, hdr,
# expect_status, expect_jq, expect_eq, jqr, fail, ok, create_user, login, own_password, new_jar),
# the cookie jars ($ADMIN, the owner, $ACCT $DPM), $WORK and $CONTAINER. No shebang and no `set`:
# the caller owns both.
# It does not assume a pristine database: it uses slot numbers 900-909 only and clears them first,
# its names carry a run tag, and it checks only its own rows. Made-up names and codes only (this
# repo is public). Its audit rows are read as the owner ($ADMIN). Its own second admin (to prove
# a non-owner admin can't Show a code) is disabled at the end.
# Contract: docs/plans/m13-contracts.md sections 5, 7.2 and 11.4.

# ============================================================================
step "m13. alarm holders and codes"
# ============================================================================

# The tag is letters only, so no name can hold a made-up code's digits.
M13_A_TAG=$(date +%s | tr '0-9' 'a-j')
M13_A_PERSON="M13 Person $M13_A_TAG"
M13_A_TEMP="M13 Temp $M13_A_TAG"
M13_A_OFFICE="M13 Office $M13_A_TAG"
M13_A_C1="0042"
M13_A_C2="097531086420"
M13_A_KEYFILE=/data/config/alarm-code-key
M13_A_AWAY=/tmp/m13-alarm-code-key
M13_A_MISSING_SHOW="The alarm code key is missing, so codes can't be shown. Restore config/alarm-code-key from a backup."
M13_A_MISSING_SAVE="The alarm code key is missing. Restore config/alarm-code-key from a backup, or clear every saved code, before saving a new one."
M13_A_INVALID_FILE="The alarm code key file (config/alarm-code-key) isn't a valid key. Restore it from a backup, or remove it so a new one can be made."

# Today is the server's (Sydney) date.
req GET /api/orders/deliveries "$ADMIN"
expect_status 200 "admin reads the server's today"
M13_A_TODAY=$(jqr '.date')
M13_A_TOMORROW=$(date -u -d "$M13_A_TODAY 1 day" +%F)

# m13_a_no_codes WHAT: the last response body holds neither made-up code.
m13_a_no_codes() {
  case "$BODY" in
    *"$M13_A_C1"* | *"$M13_A_C2"*) fail "$1: the answer holds a code: ${BODY:0:300}" ;;
  esac
  ok
}

# m13_a_slot ID: sets BODY to that slot's object from GET /api/alarms (and checks no code is in it).
m13_a_slot() {
  req GET /api/alarms "$ADMIN"
  expect_status 200 "GET /api/alarms"
  m13_a_no_codes "GET /api/alarms"
  BODY=$(printf '%s' "$BODY" | jq -c ".slots[] | select(.id == $1)")
  [ -n "$BODY" ] || fail "slot id $1 is not in GET /api/alarms"
}

# m13_a_last_audit ACTION ID: sets BODY to the newest ACTION audit row for slot row ID.
m13_a_last_audit() {
  req GET "/api/audit?action=$1&entityType=alarm_slot&entityId=$2&limit=1" "$ADMIN"
  expect_status 200 "the slot's $1 rows"
  m13_a_no_codes "the $1 audit rows"
  expect_jq '.rows | length == 1' "an $1 row for slot row $2"
  BODY=$(printf '%s' "$BODY" | jq -c '.rows[0]')
}

# A key file left in /tmp by an earlier run that stopped half-way goes back first.
docker exec "$CONTAINER" sh -c "if [ -f $M13_A_AWAY ] && [ ! -f $M13_A_KEYFILE ]; then mv $M13_A_AWAY $M13_A_KEYFILE; fi"

echo "--- access ---"
req GET /alarms.html "$ADMIN"
expect_status 200 "admin GET /alarms.html"
req GET /alarms.html "$ACCT"
expect_status 403 "acct GET /alarms.html"
req GET /api/alarms "$ADMIN"
expect_status 200 "admin GET /api/alarms"
expect_jq '(.slots | type == "array") and (.company | type == "object") and (.times | length == 7) and (.people | type == "array") and (.keyState | type == "string")' \
  "the overview has slots, company, seven days, people and the key state"
req GET /api/alarms "$ACCT"
expect_status 403 "acct GET /api/alarms"
req GET /api/alarms "$DPM"
expect_status 403 "dpm GET /api/alarms"
req GET /api/alarms/summary "$ADMIN"
expect_status 200 "admin GET /api/alarms/summary"
expect_jq '.leavers | type == "array"' "the summary lists leavers"
req GET /api/alarms/summary "$ACCT"
expect_status 403 "acct GET /api/alarms/summary"
for M13_A_GET in /api/alarms /api/alarms/summary; do
  req GET "$M13_A_GET" "$ADMIN"
  expect_eq "$(hdr Cache-Control)" "no-store" "GET $M13_A_GET is Cache-Control: no-store"
done

# A second admin of its own (not the owner, so without alarms.manage), disabled at the end.
M13_A_ADM_USER="m13aladm$M13_A_TAG"
M13_A_ADM_PW="M13-Al-Adm-Passw0rd-$M13_A_TAG"
create_user "$M13_A_ADM_USER" "M13 Alarm Admin $M13_A_TAG" "Tmp-$M13_A_ADM_PW" admin
M13_A_ADM_ID=$CREATED_ID
M13_A_ADM="$WORK/jar-m13-al-adm"
new_jar "$M13_A_ADM"
login "$M13_A_ADM" "$M13_A_ADM_USER" "Tmp-$M13_A_ADM_PW"
expect_status 200 "login the second admin"
own_password "$M13_A_ADM" "Tmp-$M13_A_ADM_PW" "$M13_A_ADM_PW"
req GET /api/auth/me "$M13_A_ADM"
expect_jq '.user.isOwner == false and (.user.perms | index("alarms.manage")) == null' "the second admin isn't the owner and lacks alarms.manage"
req GET /api/alarms "$M13_A_ADM"
expect_status 403 "the second admin GET /api/alarms"

echo "--- slots 900-909 cleared first ---"
req GET /api/alarms "$ADMIN"
for M13_A_OLD in $(jqr '.slots[] | select(.removedDate == null and .slot >= 900 and .slot <= 909) | .id'); do
  M13_A_OLD=${M13_A_OLD//$'\r'/}
  req POST "/api/alarms/slots/$M13_A_OLD/remove" "$ADMIN" '{}'
  expect_status 200 "remove an earlier run's slot (row $M13_A_OLD)"
done
req GET /api/alarms "$ADMIN"
expect_jq '[.slots[] | select(.removedDate == null and .slot >= 900 and .slot <= 909)] | length == 0' "no slot 900-909 in use"

# The audit rows from here on are this run's (checked for codes at the end).
M13_A_AUDIT0=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db", { readonly: true });
console.log(String(d.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM audit_log").get().n));
d.close();' | tr -d '\r') || fail "reading the audit high-water mark failed"
[ -n "$M13_A_AUDIT0" ] || fail "no audit high-water mark"
ok

echo "--- codes ---"
req POST /api/payruns/people "$ACCT" "$(jq -nc --arg n "$M13_A_PERSON" '{name:$n}')"
expect_status 201 "acct adds the pay-only person"
M13_A_PID=$(jqr '.id')

req POST /api/alarms/slots "$ADMIN" "$(jq -nc --argjson p "$M13_A_PID" --arg c "$M13_A_C1" '{slot:900, personId:$p, type:"staff", code:$c}')"
expect_status 201 "slot 900 with a code"
m13_a_no_codes "the new slot's answer"
expect_jq ".slot == 900 and .personId == $M13_A_PID and .name == \"$M13_A_PERSON\" and .personArchived == false and .type == \"staff\" and .leaver == false and .removedDate == null" \
  "slot 900 is the person's, staff"
expect_jq '.code.set == true and .code.readable == true and (.code.setAt | type == "string") and (.code.setBy.id | type == "number")' \
  "slot 900's code is set and readable, with who and when"
expect_jq '.code | has("code") | not' "the slot carries no code field"
M13_A_S900=$(jqr '.id')
M13_A_MODE=$(docker exec "$CONTAINER" stat -c %a "$M13_A_KEYFILE" | tr -d '\r') || fail "the key file isn't in the container"
expect_eq "$M13_A_MODE" "600" "the alarm code key file is mode 600"

req POST "/api/alarms/slots/$M13_A_S900/reveal" "$ADMIN"
expect_status 200 "Show slot 900"
expect_jq ".code == \"$M13_A_C1\"" "reveal answers the code with its leading zeros"
expect_eq "$(hdr Cache-Control)" "no-store" "reveal is Cache-Control: no-store"
expect_eq "$(hdr ETag)" "" "reveal carries no ETag (a hash of the code)"
req POST "/api/alarms/slots/$M13_A_S900/reveal" "$M13_A_ADM" '{}'
expect_status 403 "the second admin (not the owner) can't Show a code"
m13_a_no_codes "the second admin's refusal"
req POST "/api/alarms/slots/$M13_A_S900/reveal" "$ACCT" '{}'
expect_status 403 "acct can't Show a code"
m13_a_no_codes "acct's refusal"

req POST /api/alarms/slots "$ADMIN" "$(jq -nc --arg n "$M13_A_TEMP" --arg c "$M13_A_C2" '{slot:901, holderName:$n, type:"temp", code:$c}')"
expect_status 201 "slot 901, a typed name with a 12-digit code"
m13_a_no_codes "slot 901's answer"
expect_jq ".personId == null and .name == \"$M13_A_TEMP\" and .personArchived == null and .type == \"temp\" and .code.set == true" \
  "slot 901 is the typed name's"
M13_A_S901=$(jqr '.id')
req PATCH "/api/alarms/slots/$M13_A_S901" "$ADMIN" '{"code":"12a4"}'
expect_status 400 "a code with a letter"
expect_jq '.error == "The code must be 1 to 12 digits"' "the code sentence"
expect_jq '(.error | contains("12a4")) | not' "the sentence doesn't repeat the value"
req POST /api/alarms/slots "$ADMIN" "$(jq -nc --arg n "$M13_A_TEMP" '{slot:902, holderName:$n, type:"temp", code:"1234567890123"}')"
expect_status 400 "a 13-digit code"
expect_jq '.error == "The code must be 1 to 12 digits"' "the code sentence (13 digits)"
req PATCH "/api/alarms/slots/$M13_A_S900" "$ADMIN" "$(jq -nc --arg c "$M13_A_C1" '{code:$c}')"
expect_status 200 "slot 900's code typed again"
m13_a_no_codes "the update's answer"
m13_a_last_audit alarm_slot.update "$M13_A_S900"
expect_jq '.after == {code: "changed"}' "the update row says \"changed\" only"
req POST "/api/alarms/slots/$M13_A_S900/reveal" "$ADMIN" '{}'
expect_status 200 "Show slot 900 again"
expect_jq ".code == \"$M13_A_C1\"" "the re-typed code reads back"

echo "--- never in plain ---"
M13_A_PLAIN=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db", { readonly: true });
const [s1, s2, mark, c1, c2] = process.argv.slice(1);
const bad = [];
// Not the key id (16 hex characters, which could hold "0042" by chance) nor a row or user id (a
// number such as 10042): neither can carry a code.
const skip = (k) => k === "code_key_id" || k === "id" || /_id$/.test(k) || /_by$/.test(k);
for (const r of d.prepare("SELECT * FROM alarm_slots WHERE id IN (?, ?)").all(Number(s1), Number(s2))) {
  for (const [k, v] of Object.entries(r)) if (!skip(k) && v != null && (String(v).includes(c1) || String(v).includes(c2))) bad.push("alarm_slots." + k);
}
const rows = d.prepare("SELECT id, before_json, after_json FROM audit_log WHERE id > ? OR entity_type LIKE ?").all(Number(mark), "alarm%");
for (const r of rows) for (const v of [r.before_json, r.after_json]) if (v && (v.includes(c1) || v.includes(c2))) bad.push("audit_log " + r.id);
const rev = d.prepare("SELECT after_json FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY id DESC LIMIT 1").get("alarm_slot.reveal", s1);
console.log(JSON.stringify({ bad, reveal: rev ? rev.after_json : null, audited: rows.length }));
d.close();' "$M13_A_S900" "$M13_A_S901" "$M13_A_AUDIT0" "$M13_A_C1" "$M13_A_C2" | tr -d '\r') \
  || fail "reading the alarm rows in the container failed"
BODY=$M13_A_PLAIN
expect_jq '.bad == []' "no column of the two slots and no audit row holds a code"
expect_jq '.reveal == "{\"slot\":900}"' "the reveal row's after is exactly {slot: 900}"
expect_jq '.audited >= 4' "the audit rows were read"
m13_a_last_audit alarm_slot.reveal "$M13_A_S900"
expect_jq '.after == {slot: 900} and .before == null' "the reveal row, read through the API"
m13_a_last_audit alarm_slot.create "$M13_A_S900"
expect_jq ".after.code == \"set\" and .after.slot == 900 and .after.personId == $M13_A_PID" "the create row says \"set\""

echo "--- slot rules ---"
req POST /api/alarms/slots "$ADMIN" "$(jq -nc --arg n "$M13_A_OFFICE" '{slot:900, holderName:$n, type:"office"}')"
expect_status 409 "a second slot 900"
expect_jq '.error == "Slot 900 is already in use"' "the in-use sentence"
req POST /api/alarms/slots "$ADMIN" "$(jq -nc --arg n "$M13_A_OFFICE" '{slot:1000, holderName:$n, type:"office"}')"
expect_status 400 "slot 1000"
expect_jq '.error == "The slot number must be a whole number from 1 to 999"' "the slot-number sentence"
req POST /api/alarms/slots "$ADMIN" "{\"slot\":903,\"personId\":\"$M13_A_PID\",\"type\":\"office\"}"
expect_status 201 "slot 903 with the person's id as a digit string (as bonuses take it)"
expect_jq ".slot == 903 and .personId == $M13_A_PID and .name == \"$M13_A_PERSON\"" "slot 903 is the person's"
M13_A_S903=$(jqr '.id')
req POST "/api/alarms/slots/$M13_A_S903/remove" "$ADMIN" '{}'
expect_status 200 "remove slot 903"
req POST /api/alarms/slots "$ADMIN" '{"slot":903,"personId":"12a","type":"office"}'
expect_status 400 "a person id that isn't a number"
expect_jq '.error == "Holder must be a person from the pay list"' "the person sentence"
req POST /api/alarms/slots "$ADMIN" "$(jq -nc --arg n "$M13_A_OFFICE" '{slot:903, holderName:$n, type:"office", bogus:1}')"
expect_status 400 "an unknown field"
expect_jq '.error == "Unknown field: bogus"' "the unknown field is named"
req POST /api/alarms/slots "$ADMIN" '{"slot":903,"type":"office"}'
expect_status 400 "no holder"
expect_jq '.error == "Give the holder: a person or a name"' "the holder sentence"
req POST /api/alarms/slots "$ADMIN" "$(jq -nc --arg n "$M13_A_OFFICE" '{slot:903, holderName:$n, type:"guest"}')"
expect_status 400 "a bad type"
expect_jq '.error == "The type must be office, staff or temp"' "the type sentence"
req POST /api/alarms/slots "$ADMIN" "$(jq -nc --arg n "$M13_A_OFFICE" --arg d "$M13_A_TOMORROW" '{slot:903, holderName:$n, type:"office", givenDate:$d}')"
expect_status 400 "a date given in the future"
expect_jq '.error == "The date given can'"'"'t be in the future"' "the future date-given sentence"
req PATCH "/api/alarms/slots/$M13_A_S900" "$ADMIN" '{"code":null}'
expect_status 200 "slot 900's code cleared"
expect_jq '.code.set == false and .code.readable == false and .code.setAt == null' "slot 900 has no code"
m13_a_last_audit alarm_slot.update "$M13_A_S900"
expect_jq '.after == {code: "cleared"}' "the clear row says \"cleared\""
req POST "/api/alarms/slots/$M13_A_S900/reveal" "$ADMIN"
expect_status 409 "Show a slot with no code"
expect_jq '.error == "Slot 900 has no code saved"' "the no-code sentence"
req PATCH "/api/alarms/slots/$M13_A_S900" "$ADMIN" '{"code":null}'
expect_status 200 "clearing again changes nothing"
m13_a_last_audit alarm_slot.update "$M13_A_S900"
expect_jq '.after == {code: "cleared"}' "no new row for a change of nothing"
req PATCH "/api/alarms/slots/$M13_A_S900" "$ADMIN" "$(jq -nc --arg c "$M13_A_C1" --arg d "$M13_A_TODAY" '{code:$c, givenDate:$d}')"
expect_status 200 "slot 900's code set again, with the date given"
m13_a_last_audit alarm_slot.update "$M13_A_S900"
expect_jq ".after == {givenDate: \"$M13_A_TODAY\", code: \"set\"} and .before == {givenDate: null}" "the set row says \"set\""

echo "--- leaver ---"
req PATCH "/api/payruns/people/$M13_A_PID" "$ACCT" '{"archived":true}'
expect_status 200 "acct archives the person"
m13_a_slot "$M13_A_S900"
expect_jq '.leaver == true and .personArchived == true' "slot 900 is a leaver"
req GET /api/alarms/summary "$ADMIN"
expect_status 200 "the summary with a leaver"
expect_jq "[.leavers[] | select(.id == $M13_A_S900 and .slot == 900 and .name == \"$M13_A_PERSON\")] | length == 1" "the summary names the leaver"
req POST "/api/alarms/slots/$M13_A_S900/remove" "$ADMIN" "$(jq -nc --arg d "$M13_A_TOMORROW" '{removedDate:$d}')"
expect_status 400 "a removed date in the future"
expect_jq '.error == "The removed date can'"'"'t be in the future"' "the future removed-date sentence"
req POST "/api/alarms/slots/$M13_A_S900/remove" "$ADMIN" "$(jq -nc --arg d "$M13_A_TODAY" '{removedDate:$d}')"
expect_status 200 "remove slot 900 today"
expect_jq ".removedDate == \"$M13_A_TODAY\" and .leaver == false and .code.set == false" "removed: not a leaver, code cleared"
m13_a_last_audit alarm_slot.remove "$M13_A_S900"
expect_jq ".after == {removedDate: \"$M13_A_TODAY\", code: \"cleared\"}" "the remove row says the code was cleared"
req GET /api/alarms/summary "$ADMIN"
expect_jq "[.leavers[] | select(.id == $M13_A_S900)] | length == 0" "a removed slot isn't a leaver"
req POST "/api/alarms/slots/$M13_A_S900/remove" "$ADMIN" '{}'
expect_status 409 "remove it again"
expect_jq '.error == "Slot 900 is already removed"' "the already-removed sentence"
req PATCH "/api/alarms/slots/$M13_A_S900" "$ADMIN" '{"note":"M13 note"}'
expect_status 409 "edit a removed slot"
expect_jq '.error == "Slot 900 was removed; restore it to change it"' "the removed-slot sentence"
req POST "/api/alarms/slots/$M13_A_S900/restore" "$ADMIN"
expect_status 200 "restore slot 900"
expect_jq '.removedDate == null and .code.set == false and .leaver == true' "restored, with no code (and still a leaver)"
m13_a_last_audit alarm_slot.restore "$M13_A_S900"
expect_jq ".before == {removedDate: \"$M13_A_TODAY\"} and .after == {removedDate: null}" "the restore row"
req POST "/api/alarms/slots/$M13_A_S900/restore" "$ADMIN"
expect_status 409 "restore a slot in use"
expect_jq '.error == "Slot 900 isn'"'"'t removed"' "the not-removed sentence"
req POST "/api/alarms/slots/$M13_A_S900/remove" "$ADMIN" '{}'
expect_status 200 "remove slot 900 again"

echo "--- missing key ---"
req POST /api/alarms/slots "$ADMIN" "$(jq -nc --arg n "$M13_A_OFFICE" '{slot:902, holderName:$n, type:"office"}')"
expect_status 201 "slot 902 without a code"
M13_A_S902=$(jqr '.id')
docker exec "$CONTAINER" sh -c "mv $M13_A_KEYFILE $M13_A_AWAY" || fail "moving the key file away failed"
ok
req GET /api/alarms "$ADMIN"
expect_status 200 "the overview with the key missing"
expect_jq '.keyState == "missing"' "the key state is missing"
expect_jq "[.slots[] | select(.id == $M13_A_S901 and .code.set == true and .code.readable == false)] | length == 1" "901's code is set but can't be read"
req POST "/api/alarms/slots/$M13_A_S901/reveal" "$ADMIN"
expect_status 409 "Show with the key missing"
expect_jq ".error == \"$M13_A_MISSING_SHOW\"" "the missing-key Show sentence"
req PATCH "/api/alarms/slots/$M13_A_S902" "$ADMIN" '{"code":"5"}'
expect_status 409 "save a code with the key missing"
expect_jq ".error == \"$M13_A_MISSING_SAVE\"" "the missing-key save sentence"
req POST /api/alarms/slots "$ADMIN" "$(jq -nc --arg n "$M13_A_OFFICE" '{slot:903, holderName:$n, type:"office", code:"5"}')"
expect_status 409 "create a slot with a code, key missing"
expect_jq ".error == \"$M13_A_MISSING_SAVE\"" "the missing-key save sentence (create)"
req GET /api/alarms "$ADMIN"
expect_jq '[.slots[] | select(.slot == 903 and .removedDate == null)] | length == 0' "the refused create left no slot 903"
M13_A_NOKEY=$(docker exec "$CONTAINER" sh -c "if [ -f $M13_A_KEYFILE ]; then echo made; else echo none; fi" | tr -d '\r')
expect_eq "$M13_A_NOKEY" "none" "no new key was made while a code exists"
req PATCH "/api/alarms/slots/$M13_A_S901" "$ADMIN" '{"code":null}'
expect_status 200 "clear 901's code with the key missing"
expect_jq '.code.set == false' "901's code is cleared"
# A file that isn't a valid key (M13 4.3, A-m5): with no code saved anywhere, its own sentence
# (there is nothing to clear); with codes saved elsewhere (a database that isn't pristine), the
# missing-key one. Either way the file is never overwritten.
M13_A_CODES=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const d = new D("/data/db/photos.db", { readonly: true });
console.log(String(d.prepare("SELECT COUNT(*) AS n FROM alarm_slots WHERE code_ct IS NOT NULL").get().n));
d.close();' | tr -d '\r') || fail "counting the saved codes failed"
docker exec "$CONTAINER" sh -c "printf 'm13-not-a-key\n' > $M13_A_KEYFILE" || fail "writing a file that isn't a key failed"
ok
req GET /api/alarms "$ADMIN"
expect_status 200 "the overview with a file that isn't a key"
expect_jq '.keyState == "missing"' "a file that isn't a key counts as missing"
req PATCH "/api/alarms/slots/$M13_A_S902" "$ADMIN" '{"code":"5"}'
expect_status 409 "save a code with a file that isn't a key"
if [ "$M13_A_CODES" = 0 ]; then
  expect_jq ".error == \"$M13_A_INVALID_FILE\"" "the not-a-valid-key sentence"
else
  expect_jq ".error == \"$M13_A_MISSING_SAVE\"" "the missing-key save sentence (codes saved elsewhere)"
fi
M13_A_JUNK=$(docker exec "$CONTAINER" cat "$M13_A_KEYFILE" | tr -d '\r')
expect_eq "$M13_A_JUNK" "m13-not-a-key" "the file that isn't a key was not overwritten"
docker exec "$CONTAINER" rm -f "$M13_A_KEYFILE" || fail "removing the file that isn't a key failed"
docker exec "$CONTAINER" sh -c "mv $M13_A_AWAY $M13_A_KEYFILE" || fail "moving the key file back failed"
ok
req PATCH "/api/alarms/slots/$M13_A_S901" "$ADMIN" "$(jq -nc --arg c "$M13_A_C2" '{code:$c}')"
expect_status 200 "901's code set again"
expect_jq '.code.set == true and .code.readable == true' "901's code is readable"
req POST "/api/alarms/slots/$M13_A_S901/reveal" "$ADMIN"
expect_status 200 "Show 901 with the key back"
expect_jq ".code == \"$M13_A_C2\"" "901's 12-digit code reads back"
req GET /api/alarms "$ADMIN"
expect_jq '.keyState == "ready"' "the key state is ready again"

echo "--- company and times ---"
req PUT /api/alarms/company "$ADMIN" '{"monitoringPassword":"m13-not-kept"}'
expect_status 400 "a monitoring password"
expect_jq '.error == "Unknown field: monitoringPassword"' "nowhere to put a monitoring password"
req PUT /api/alarms/company "$ADMIN" '{"name":"M13 Alarm Co","accountNumber":"M13-ACC-1","contactName":"M13 Contact","phone":"M13 phone"}'
expect_status 200 "the alarm company"
expect_jq '.name == "M13 Alarm Co" and .accountNumber == "M13-ACC-1" and .contactName == "M13 Contact" and .phone == "M13 phone" and (.updatedAt | type == "string")' \
  "the company's four fields"
req PUT /api/alarms/company "$ADMIN" "$(jq -nc --arg s "$(printf 'x%.0s' $(seq 1 51))" '{phone:$s}')"
expect_status 400 "a 51-character phone"
expect_jq '.error == "Phone must be 50 characters or fewer"' "the phone length sentence"
M13_A_DAYS='[{"day":1,"armsAt":"18:00","disarmsAt":"06:30"},{"day":2,"armsAt":"18:00","disarmsAt":"06:30"},{"day":3,"armsAt":"18:00","disarmsAt":"06:30"},{"day":4,"armsAt":"18:00","disarmsAt":"06:30"},{"day":5,"armsAt":"17:00","disarmsAt":"06:30"},{"day":6,"armsAt":"12:00","disarmsAt":null},{"day":7,"armsAt":null,"disarmsAt":null}]'
req PUT /api/alarms/times "$ADMIN" "{\"days\":$(printf '%s' "$M13_A_DAYS" | jq -c '[.[] | select(.day < 7)]')}"
expect_status 400 "six days"
expect_jq '.error == "Give all seven days, Monday to Sunday"' "the seven-days sentence"
req PUT /api/alarms/times "$ADMIN" "{\"days\":$(printf '%s' "$M13_A_DAYS" | jq -c '.[0].armsAt = "25:00"')}"
expect_status 400 "25:00"
expect_jq '.error == "Monday arms at must be a time (HH:MM)"' "the time sentence"
req PUT /api/alarms/times "$ADMIN" "{\"days\":$M13_A_DAYS}"
expect_status 200 "the weekly times"
expect_jq 'length == 7 and .[0].day == 1 and .[0].label == "Monday" and .[6].label == "Sunday" and .[0].armsAt == "18:00" and .[0].disarmsAt == "06:30" and .[5].disarmsAt == null and .[6].armsAt == null' \
  "seven days, Monday first, as sent"

echo "--- the server log ---"
# Read first, so a failed `docker logs` fails the suite instead of looking like a clean log.
docker logs "$CONTAINER" >"$WORK/m13-alarm-logs.txt" 2>&1 || fail "docker logs failed"
[ -s "$WORK/m13-alarm-logs.txt" ] || fail "docker logs gave nothing to search"
if grep -qF -- "$M13_A_C2" "$WORK/m13-alarm-logs.txt"; then fail "the server log holds the 12-digit code"; fi
ok
rm -f "$WORK/m13-alarm-logs.txt"

echo "--- clean-up ---"
for M13_A_ID in "$M13_A_S901" "$M13_A_S902"; do
  req POST "/api/alarms/slots/$M13_A_ID/remove" "$ADMIN" '{}'
  expect_status 200 "remove slot row $M13_A_ID"
done
req GET /api/alarms "$ADMIN"
expect_jq '[.slots[] | select(.removedDate == null and .slot >= 900 and .slot <= 909)] | length == 0' "no slot 900-909 left in use"
req PATCH "/api/payruns/people/$M13_A_PID" "$ACCT" '{"archived":false}'
expect_status 200 "acct restores the person"
req PATCH "/api/users/$M13_A_ADM_ID" "$ADMIN" '{"disabled":true}'
expect_status 200 "the owner disables the suite's second admin"
