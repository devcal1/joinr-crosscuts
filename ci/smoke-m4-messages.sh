# M4 smoke, Wave 1 B: messages (chat).
# Sourced by ci/smoke.sh after the M3 suites, so it shares that script's helpers
# (step, req, expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie
# jars ($ADMIN $SCHED $ACCT $DPM $SHOW). No shebang and no `set`: the caller owns
# both. It does not assume a pristine database: it posts its own messages and
# checks only those (and the counts that follow from them).
# Contract: docs/plans/m4-contracts.md section 9.

# ============================================================================
step "m4-b. messages"
# ============================================================================

# The id of channel SLUG as seen by JAR -> M4B_CH (empty if JAR cannot see it).
m4b_channel() { # JAR SLUG
  req GET /api/messages/channels "$1"
  expect_status 200 "GET /api/messages/channels"
  M4B_CH=$(jqr ".rows[] | select(.slug == \"$2\") | .id")
}

# The unread count of channel SLUG in JAR's channel list -> M4B_UNREAD.
m4b_unread() { # JAR SLUG
  req GET /api/messages/channels "$1"
  expect_status 200 "GET /api/messages/channels"
  M4B_UNREAD=$(jqr ".rows[] | select(.slug == \"$2\") | .unread")
}

# Posts BODY as JAR to channel CH_ID -> M4B_MSG (the new message id).
m4b_post() { # JAR CH_ID BODY
  req POST "/api/messages/channels/$2" "$1" "{\"body\":\"$3\"}"
  expect_status 201 "post to channel $2"
  M4B_MSG=$(jqr '.id')
}

# JAR's bell count (the plain notifications, not the chat count) -> M4B_BELL.
m4b_bell() { # JAR
  req GET /api/notifications/unread-count "$1"
  expect_status 200 "GET /api/notifications/unread-count"
  M4B_BELL=$(jqr '.unread')
}

echo "--- access ---"
req GET /api/messages/channels "$SHOW"
expect_status 403 "show GET /api/messages/channels"
req POST /api/messages/channels/1 "$SHOW" '{"body":"hello"}'
expect_status 403 "show POST /api/messages/channels/1"
req GET /messages.html "$SCHED"
expect_status 200 "sched GET /messages.html"
req GET /messages.html "$SHOW"
expect_status 403 "show GET /messages.html"

echo "--- channels by role ---"
req GET /api/messages/channels "$ACCT"
expect_status 200 "acct GET /api/messages/channels"
expect_jq '[.rows[].slug] == ["all","accounts"]' "acct sees All and Accounts only"
req GET /api/messages/channels "$SCHED"
expect_status 200 "sched GET /api/messages/channels"
expect_jq '[.rows[].slug] == ["all","scheduling"]' "sched sees All and Scheduling only"
req GET /api/messages/channels "$DPM"
expect_status 200 "dpm GET /api/messages/channels"
expect_jq '[.rows[].slug] == ["all","design"]' "dpm sees All and Design/PM only"
req GET /api/messages/channels "$ADMIN"
expect_status 200 "admin GET /api/messages/channels"
expect_jq '[.rows[].slug] == ["all","accounts","design","scheduling"]' "admin sees all four, in order"
expect_jq 'all(.rows[]; has("id") and has("name") and has("unread") and has("lastMessageAt"))' "channel rows carry id, name, unread and lastMessageAt"

m4b_channel "$ADMIN" all
M4B_ALL=$M4B_CH
m4b_channel "$ADMIN" scheduling
M4B_SCHED_CH=$M4B_CH
m4b_channel "$ADMIN" accounts
M4B_ACCT_CH=$M4B_CH
[ -n "$M4B_ALL" ] && [ -n "$M4B_SCHED_CH" ] && [ -n "$M4B_ACCT_CH" ] || fail "the seeded channels were not found"
ok

echo "--- a channel you cannot see is 404 ---"
req POST "/api/messages/channels/$M4B_SCHED_CH" "$ACCT" '{"body":"not for accounts"}'
expect_status 404 "acct posts to the scheduling channel"
req GET "/api/messages/channels/$M4B_SCHED_CH" "$ACCT"
expect_status 404 "acct reads the scheduling channel"
req POST "/api/messages/channels/$M4B_SCHED_CH/read" "$ACCT" '{"lastId":1}'
expect_status 404 "acct marks the scheduling channel read"
req GET /api/messages/channels/999999 "$ADMIN"
expect_status 404 "an unknown channel"
m4b_post "$SCHED" "$M4B_SCHED_CH" "scheduling only"
M4B_HIDDEN=$M4B_MSG
req DELETE "/api/messages/$M4B_HIDDEN" "$ACCT"
expect_status 404 "acct removes a message in a channel it cannot see"

echo "--- unread counts and the read marker ---"
m4b_bell "$SCHED"
M4B_BELL_SCHED=$M4B_BELL
m4b_bell "$ACCT"
M4B_BELL_ACCT=$M4B_BELL

m4b_post "$ACCT" "$M4B_ALL" "first from accounts"
M4B_M1=$M4B_MSG
req GET "/api/messages/channels/$M4B_ALL" "$ACCT"
expect_status 200 "acct reads All"
expect_jq "(.rows | map(select(.id == $M4B_M1)) | length) == 1" "the new message is in the list"
expect_jq "(.rows[] | select(.id == $M4B_M1)) | .body == \"first from accounts\" and .removed == false and .canRemove == true and .author.name != null and .channelId == $M4B_ALL" "the message object"
expect_jq ".lastReadId >= $M4B_M1" "posting moves the author's own marker to the new message"

m4b_unread "$SCHED" all
[ "$M4B_UNREAD" -ge 1 ] || fail "sched's All unread should be at least 1, got $M4B_UNREAD"
ok
req GET /api/notifications/unread-count "$SCHED"
expect_status 200 "sched GET /api/notifications/unread-count"
expect_jq '.messages >= 1' "sched's menu bar count includes the chat"
m4b_unread "$ACCT" all
expect_eq "$M4B_UNREAD" "0" "the author's own unread count for All"

req GET "/api/messages/channels/$M4B_ALL" "$SCHED"
expect_status 200 "sched reads All"
expect_jq "(.rows[] | select(.id == $M4B_M1)) | .canRemove == false" "sched cannot remove another user's message"
req POST "/api/messages/channels/$M4B_ALL/read" "$SCHED" "{\"lastId\":$M4B_M1}"
expect_status 204 "sched marks All read"
m4b_unread "$SCHED" all
expect_eq "$M4B_UNREAD" "0" "sched's All unread after reading"

m4b_post "$ACCT" "$M4B_ALL" "second from accounts"
M4B_M2=$M4B_MSG
m4b_unread "$SCHED" all
expect_eq "$M4B_UNREAD" "1" "one unread after a second message"
req POST "/api/messages/channels/$M4B_ALL/read" "$SCHED" "{\"lastId\":$M4B_M1}"
expect_status 204 "a stale read marker is accepted"
m4b_unread "$SCHED" all
expect_eq "$M4B_UNREAD" "1" "an older lastId does not clear the unread message"
req POST "/api/messages/channels/$M4B_ALL/read" "$SCHED" "{\"lastId\":$M4B_M2}"
expect_status 204 "sched reads up to the second message"
req POST "/api/messages/channels/$M4B_ALL/read" "$SCHED" "{\"lastId\":$M4B_M1}"
expect_status 204 "sched sends an older lastId again"
m4b_unread "$SCHED" all
expect_eq "$M4B_UNREAD" "0" "the marker never moves back"

# A huge lastId is capped at the channel's newest message, so a later message is still unread.
req POST "/api/messages/channels/$M4B_ALL/read" "$SCHED" '{"lastId":999999999}'
expect_status 204 "a lastId beyond the newest message"
m4b_post "$ACCT" "$M4B_ALL" "third from accounts"
M4B_M3=$M4B_MSG
m4b_unread "$SCHED" all
expect_eq "$M4B_UNREAD" "1" "a marker is never beyond the channel's newest message"
req POST "/api/messages/channels/$M4B_ALL/read" "$SCHED" '{"lastId":"x"}'
expect_status 400 "a non-numeric lastId"
req POST "/api/messages/channels/$M4B_ALL/read" "$SCHED" '{}'
expect_status 400 "a missing lastId"

echo "--- polling and paging ---"
req GET "/api/messages/channels/$M4B_ALL?after=$M4B_M2" "$SCHED"
expect_status 200 "poll after the second message"
expect_jq "[.rows[].id] == [$M4B_M3]" "after returns only the newer message"
expect_jq '.more == false' "after: nothing further"
req GET "/api/messages/channels/$M4B_ALL?after=$M4B_M3" "$SCHED"
expect_status 200 "poll after the newest message"
expect_jq '.rows == []' "nothing newer, nothing returned"
req GET "/api/messages/channels/$M4B_ALL?limit=2" "$SCHED"
expect_status 200 "newest two messages"
expect_jq "[.rows[].id] == [$M4B_M2, $M4B_M3] and .more == true" "the newest messages come back oldest first, with more behind"
req GET "/api/messages/channels/$M4B_ALL?before=$M4B_M2&limit=1" "$SCHED"
expect_status 200 "one message before the second"
expect_jq "[.rows[].id] == [$M4B_M1]" "before returns the older message"
req GET "/api/messages/channels/$M4B_ALL?after=$M4B_M1&before=$M4B_M3" "$SCHED"
expect_status 400 "after and before together"
req GET "/api/messages/channels/$M4B_ALL?after=abc" "$SCHED"
expect_status 400 "a bad cursor"
req GET "/api/messages/channels/$M4B_ALL?limit=0" "$SCHED"
expect_status 400 "a zero limit"

echo "--- removal ---"
req DELETE "/api/messages/$M4B_M1" "$SCHED"
expect_status 403 "sched removes acct's message"
req DELETE "/api/messages/$M4B_M1" "$ACCT"
expect_status 204 "acct removes its own message"
req GET "/api/messages/channels/$M4B_ALL" "$SCHED"
expect_status 200 "sched reads All after the removal"
expect_jq "(.rows[] | select(.id == $M4B_M1)) | .removed == true and .body == null and .canRemove == false" "the removed message comes back as removed with no body"
req DELETE "/api/messages/$M4B_M1" "$ACCT"
expect_status 409 "removing it again"
req DELETE "/api/messages/999999" "$ACCT"
expect_status 404 "removing an unknown message"
m4b_post "$ACCT" "$M4B_ALL" "admin will remove this"
M4B_M4=$M4B_MSG
req DELETE "/api/messages/$M4B_M4" "$ADMIN"
expect_status 204 "admin removes another user's message"
req GET "/api/audit?action=message.remove&entityType=message&entityId=$M4B_M1&limit=1" "$ADMIN"
expect_status 200 "GET /api/audit for the removal"
expect_jq '.total >= 1' "the removal is audited"

# A removed message no longer counts as unread.
m4b_post "$ACCT" "$M4B_ALL" "unread then removed"
M4B_M5=$M4B_MSG
m4b_unread "$SCHED" all
M4B_BEFORE_RM=$M4B_UNREAD
req DELETE "/api/messages/$M4B_M5" "$ACCT"
expect_status 204 "acct removes an unread message"
m4b_unread "$SCHED" all
[ "$M4B_UNREAD" -eq $((M4B_BEFORE_RM - 1)) ] || fail "removing an unread message should lower the count (was $M4B_BEFORE_RM, now $M4B_UNREAD)"
ok

echo "--- no notifications ---"
m4b_bell "$ACCT"
M4B_BELL_ACCT_NOW=$M4B_BELL
m4b_bell "$SCHED"
M4B_BELL_SCHED_NOW=$M4B_BELL
expect_eq "$M4B_BELL_ACCT_NOW" "$M4B_BELL_ACCT" "acct's bell count is unchanged by chat"
expect_eq "$M4B_BELL_SCHED_NOW" "$M4B_BELL_SCHED" "sched's bell count is unchanged by chat"
req GET "/api/notifications?limit=100" "$SCHED"
expect_status 200 "GET /api/notifications as sched"
expect_jq '[.rows[] | select(.kind | test("message|chat"))] | length == 0' "no chat notification exists"

echo "--- limits ---"
req POST "/api/messages/channels/$M4B_ALL" "$ACCT" '{"body":""}'
expect_status 400 "an empty message"
req POST "/api/messages/channels/$M4B_ALL" "$ACCT" '{"body":"   "}'
expect_status 400 "a blank message"
req POST "/api/messages/channels/$M4B_ALL" "$ACCT" '{}'
expect_status 400 "no body"
req POST "/api/messages/channels/$M4B_ALL" "$ACCT" '{"body":123}'
expect_status 400 "a body that is not text"
M4B_4000=$(head -c 4000 /dev/zero | tr '\0' 'a')
M4B_4001=$(head -c 4001 /dev/zero | tr '\0' 'a')
req POST "/api/messages/channels/$M4B_ALL" "$ACCT" "{\"body\":\"$M4B_4001\"}"
expect_status 400 "a 4,001 character message"
req POST "/api/messages/channels/$M4B_ALL" "$ACCT" "{\"body\":\"$M4B_4000\"}"
expect_status 201 "a 4,000 character message"
M4B_LONG=$(jqr '.id')
req DELETE "/api/messages/$M4B_LONG" "$ACCT"
expect_status 204 "tidy up the long message"
