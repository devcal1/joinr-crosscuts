# M7 smoke, Wave 1 A: hand-made planner events, repeats, one-off changes, splits and reminders.
# Sourced by ci/smoke.sh after the M7 users are made, so it shares that script's helpers (step,
# req, expect_status, expect_jq, expect_eq, jqr, fail, ok, create_user, login, own_password,
# new_jar), the cookie jars ($ADMIN $SCHED $ACCT $DPM $SHOW $WSHOP $ACCT2 $MULTI), $BASE, $WORK
# and $CONTAINER. No shebang and no `set`: the caller owns both. It does not assume a pristine
# database: it makes its own events (2035 dates, so the live reminder timer never meets them) and
# checks only those. Contract: docs/plans/m7-contracts.md section 15.2.

# ============================================================================
step "m7-events. hand-made events, repeats and reminders"
# ============================================================================

# The user id behind a cookie jar -> M7E_UID.
m7e_uid() { # JAR
  req GET /api/auth/me "$1"
  expect_status 200 "GET /api/auth/me"
  M7E_UID=$(jqr '.user.id')
}
m7e_uid "$ADMIN"; M7E_ADMIN_ID=$M7E_UID
m7e_uid "$ACCT"; M7E_ACCT_ID=$M7E_UID

# POST an event as JAR, expecting 201 -> M7E_ID, M7E_UPD (its updatedAt); BODY is the series.
m7e_post() { # JAR JSON WHAT
  req POST /api/planner/events "$1" "$2"
  expect_status 201 "create: $3"
  M7E_ID=$(jqr '.id')
  M7E_UPD=$(jqr '.updatedAt')
}

# A POST as acct that must be a 400 with exactly SENTENCE.
m7e_bad() { # JSON SENTENCE
  req POST /api/planner/events "$ACCT" "$1"
  expect_status 400 "400: $2"
  expect_jq ".error == \"$2\"" "sentence: $2"
}

# Comma-joined effective start dates of EVENT_ID's occurrences in [FROM, TO] as JAR -> M7E_STARTS.
m7e_starts() { # JAR FROM TO EVENT_ID
  req GET "/api/planner/events?from=$2&to=$3" "$1"
  expect_status 200 "GET /api/planner/events $2..$3"
  M7E_STARTS=$(jqr "[.events[] | select(.eventId == $4) | .start] | join(\",\")")
}

# The series' current updatedAt as JAR -> M7E_UPD.
m7e_upd() { # JAR ID
  req GET "/api/planner/events/$2" "$1"
  expect_status 200 "GET /api/planner/events/$2"
  M7E_UPD=$(jqr '.updatedAt')
}

# Runs the reminder sweep as admin for (AT - WINDOW min, AT] -> M7E_SENT.
m7e_run() { # AT WINDOW
  req POST /api/planner/reminders/run "$ADMIN" "{\"at\":\"$1\",\"windowMinutes\":$2}"
  expect_status 200 "reminder run at $1"
  M7E_SENT=$(jqr '.sent')
}

# How many planner.reminder alerts JAR's user has with exactly LINK -> M7E_N.
m7e_notifs() { # JAR LINK
  req GET "/api/notifications?limit=100" "$1"
  expect_status 200 "GET /api/notifications"
  M7E_N=$(jqr "[.rows[] | select(.kind == \"planner.reminder\" and .link == \"$2\")] | length")
}

m7e_link() { # ID OCCURRENCE [EFFECTIVE_START]
  printf '/planner.html?date=%s&event=e:%s:%s' "${3:-$2}" "$1" "$2"
}

req POST /api/job-records "$ADMIN" '{"name":"CI M7E Job"}'
expect_status 201 "create the M7E job"
M7E_JOB=$(jqr '.id')

echo "--- create and read ---"
m7e_post "$ACCT" '{"title":"M7E Company day","layer":"company","allDay":true,"startDate":"2035-10-01"}' "company all-day"
M7E_C1=$M7E_ID
expect_jq ".layer == \"company\" and .allDay == true and .startDate == \"2035-10-01\" and .endDate == \"2035-10-01\" and .startTime == null and .repeat == \"none\" and .exceptions == [] and .createdBy.id == $M7E_ACCT_ID and .canEdit == true and (.updatedAt | type == \"string\")" "the series shape"
m7e_post "$ACCT" '{"title":"M7E Accounts three days","layer":"accounts","allDay":true,"startDate":"2035-10-02","endDate":"2035-10-04"}' "accounts 3 days"
M7E_A3=$M7E_ID
m7e_post "$ACCT" '{"title":"M7E Accounts timed","layer":"accounts","allDay":false,"startDate":"2035-10-03","startTime":"09:30"}' "accounts timed"
M7E_AT=$M7E_ID
expect_jq '.startTime == "09:30" and .endTime == "10:30" and .endDate == "2035-10-03"' "the end defaults to an hour later"
m7e_post "$ACCT" "{\"title\":\"M7E Secret dentist\",\"notes\":\"M7E private note\",\"layer\":\"personal\",\"allDay\":false,\"startDate\":\"2035-10-03\",\"startTime\":\"09:15\",\"endTime\":\"10:00\",\"jobId\":$M7E_JOB}" "personal with a job"
M7E_P1=$M7E_ID; M7E_P1_UPD=$M7E_UPD
expect_jq ".job.id == $M7E_JOB and .link == \"/job.html?id=$M7E_JOB\"" "the job link"

req GET "/api/planner/events?from=2035-10-01&to=2035-10-07" "$ACCT"
expect_status 200 "GET the first 2035 week"
expect_jq "[.events[] | select(.eventId == $M7E_C1)] | length == 1 and .[0].start == \"2035-10-01\" and .[0].end == \"2035-10-01\" and .[0].allDay == true and .[0].source == \"event\"" "company listed once"
expect_jq "[.events[] | select(.eventId == $M7E_A3)] | length == 1 and .[0].start == \"2035-10-02\" and .[0].end == \"2035-10-04\"" "the 3-day event once"
expect_jq "[.events[] | select(.eventId == $M7E_AT)] | length == 1 and .[0].startTime == \"09:30\" and .[0].endTime == \"10:30\" and .[0].id == \"e:$M7E_AT:2035-10-03\"" "the timed event"
expect_jq "[.events[] | select(.eventId == $M7E_P1)] | length == 1 and .[0].layer == \"personal\" and .[0].startTime == \"09:15\"" "the personal event for its owner"
req GET "/api/planner/events/$M7E_A3" "$ACCT"
expect_status 200 "GET one series"
expect_jq '.exceptions == [] and .repeatDay == null and .splitFromId == null' "no exceptions"

echo "--- validation ---"
m7e_bad '{"title":"","layer":"accounts","allDay":true,"startDate":"2035-10-01"}' "Title is required"
m7e_bad "$(jq -nc --arg t "$(printf 'x%.0s' $(seq 1 201))" '{title:$t,layer:"accounts",allDay:true,startDate:"2035-10-01"}')" "Title is too long (200 characters at most)"
m7e_bad "$(jq -nc --arg n "$(printf 'x%.0s' $(seq 1 4001))" '{title:"V",notes:$n,layer:"accounts",allDay:true,startDate:"2035-10-01"}')" "Notes are too long (4,000 characters at most)"
m7e_bad '{"title":"V","layer":"accounts","allDay":true,"startDate":"2035-10-01","endDate":"2036-01-01"}' "An event can last 92 days at most"
m7e_bad '{"title":"V","layer":"accounts","allDay":true,"startDate":"2035-10-02","endDate":"2035-10-01"}' "endDate can't be before startDate"
m7e_bad '{"title":"V","layer":"accounts","allDay":true,"startDate":"2035-10-01","startTime":"09:00"}' "An all-day event has no times"
m7e_bad '{"title":"V","layer":"accounts","allDay":false,"startDate":"2035-10-01","startTime":"24:00"}' "startTime must be a time (HH:MM)"
m7e_bad '{"title":"V","layer":"accounts","allDay":false,"startDate":"2035-10-01","startTime":"09:00","endTime":"09:00"}' "The end time must be after the start time"
m7e_bad '{"title":"V","layer":"accounts","allDay":false,"startDate":"2035-10-01","startTime":"23:59"}' "The end time must be after the start time"
m7e_bad '{"title":"V","layer":"accounts","allDay":false,"startDate":"2035-10-01","endDate":"2035-10-02","startTime":"09:00","endTime":"10:00"}' "A timed event starts and ends on the same day"
m7e_bad '{"title":"V","layer":"accounts","allDay":true,"startDate":"2035-10-01","endDate":"2035-10-08","repeat":"weekly"}' "A weekly event can't last longer than a week"
m7e_bad '{"title":"V","layer":"accounts","allDay":true,"startDate":"2035-10-01","reminder":"hour1"}' "That reminder doesn't fit an all-day event"
m7e_bad '{"title":"V","layer":"personal","allDay":true,"startDate":"2035-10-01","reminder":"morning","remindLayer":true}' "Personal events can't remind anyone else"
m7e_bad '{"title":"V","layer":"accounts","allDay":true,"startDate":"2035-10-01","remindLayer":true}' "Choose a reminder first"
m7e_bad '{"title":"V","layer":"accounts","allDay":true,"startDate":"2035-10-01","jobId":99999999}' "Unknown job"
m7e_bad '{"title":"V","layer":"nope","allDay":true,"startDate":"2035-10-01"}' "Unknown layer"
m7e_bad '{"title":"V","layer":"accounts","allDay":true,"startDate":"2035-02-30"}' "startDate must be a date (YYYY-MM-DD)"
req POST /api/planner/events "$ACCT" '{"title":"V","layer":"install","allDay":true,"startDate":"2035-10-01"}'
expect_status 403 "acct posting to Install & hardware"
expect_jq '.error == "You can'"'"'t add events to that layer"' "the layer sentence"

echo "--- range ---"
req GET "/api/planner/events?from=2035-10-01&to=2035-12-02" "$ACCT"
expect_status 400 "63 days"
expect_jq '.error == "Ask for 62 days at most"' "the range sentence"
req GET "/api/planner/events?from=2035-10-01&to=2035-12-01" "$ACCT"
expect_status 200 "62 days"
req GET "/api/planner/events?from=2035-10-02&to=2035-10-01" "$ACCT"
expect_status 400 "to before from"
req GET "/api/planner/events?from=2035-10-01&to=2035-10-07&layers=nope" "$ACCT"
expect_status 400 "an unknown layer"

echo "--- repeats ---"
m7e_post "$ACCT" '{"title":"M7E Weekly nine","layer":"company","allDay":false,"startDate":"2035-10-01","startTime":"09:00","endTime":"10:00","repeat":"weekly","reminder":"hour1"}' "timed weekly"
M7E_WK=$M7E_ID
req GET "/api/planner/events?from=2035-09-24&to=2035-10-21" "$ACCT"
expect_status 200 "GET across the October change-over"
expect_jq "[.events[] | select(.eventId == $M7E_WK) | [.start, .startTime]] == [[\"2035-10-01\",\"09:00\"],[\"2035-10-08\",\"09:00\"],[\"2035-10-15\",\"09:00\"]]" "a weekly 9:00 stays 9:00 across daylight saving"

m7e_post "$ACCT" '{"title":"M7E Fortnightly","layer":"company","allDay":true,"startDate":"2035-10-01","repeat":"fortnightly"}' "fortnightly"
M7E_FN=$M7E_ID
m7e_starts "$ACCT" 2035-10-01 2035-10-31 "$M7E_FN"
expect_eq "$M7E_STARTS" "2035-10-01,2035-10-15,2035-10-29" "fortnightly in October"

m7e_post "$ACCT" '{"title":"M7E Monthly 31st","layer":"accounts","allDay":true,"startDate":"2035-01-31","repeat":"monthly"}' "monthly from the 31st"
M7E_MO=$M7E_ID
expect_jq '.repeatDay == 31' "repeatDay 31"
m7e_starts "$ACCT" 2035-01-01 2035-02-28 "$M7E_MO"
expect_eq "$M7E_STARTS" "2035-01-31,2035-02-28" "monthly: 31 Jan, 28 Feb"
m7e_starts "$ACCT" 2035-03-01 2035-04-30 "$M7E_MO"
expect_eq "$M7E_STARTS" "2035-03-31,2035-04-30" "monthly: 31 Mar, 30 Apr"
m7e_post "$ACCT" '{"title":"M7E Leap","layer":"accounts","allDay":true,"startDate":"2036-01-31","repeat":"monthly"}' "monthly in a leap year"
m7e_starts "$ACCT" 2036-02-01 2036-02-29 "$M7E_ID"
expect_eq "$M7E_STARTS" "2036-02-29" "monthly: 29 Feb 2036"
m7e_post "$ACCT" '{"title":"M7E Monthly until","layer":"accounts","allDay":true,"startDate":"2035-01-31","repeat":"monthly","repeatUntil":"2035-03-31"}' "monthly with an end"
m7e_starts "$ACCT" 2035-03-01 2035-04-30 "$M7E_ID"
expect_eq "$M7E_STARTS" "2035-03-31" "repeatUntil 31 Mar: no April"

echo "--- reminders on the weekly (before it is edited) ---"
req POST /api/planner/reminders/run "$ACCT" '{}'
expect_status 403 "acct can't run the sweep"
m7e_run "2035-10-07T21:00:30Z" 5
[ "$M7E_SENT" -ge 1 ] || fail "hour1 on 2035-10-08 09:00 AEDT: expected sent >= 1, got $M7E_SENT"
ok
M7E_L=$(m7e_link "$M7E_WK" 2035-10-08)
req GET "/api/notifications?limit=100" "$ACCT"
expect_status 200 "acct's alerts"
expect_jq "[.rows[] | select(.kind == \"planner.reminder\" and .link == \"$M7E_L\" and .readAt == null and (.title | startswith(\"In 1 hour:\")))] | length == 1" "acct has the unread hour1 reminder"
m7e_run "2035-10-07T21:00:30Z" 5
m7e_notifs "$ACCT" "$M7E_L"
expect_eq "$M7E_N" 1 "the same run again sends nothing new"
m7e_run "2035-10-07T21:00:30Z" 5
expect_eq "$M7E_SENT" 0 "a repeated window sends 0"
M7E_L22=$(m7e_link "$M7E_WK" 2035-10-22)
m7e_run "2035-10-21T22:00:30Z" 5
m7e_notifs "$ACCT" "$M7E_L22"
expect_eq "$M7E_N" 0 "the naive (wrong-offset) instant sends nothing"

echo "--- this one ---"
m7e_upd "$ACCT" "$M7E_WK"; M7E_WK_UPD0=$M7E_UPD
req PATCH "/api/planner/events/$M7E_WK" "$ACCT" "{\"updatedAt\":\"$M7E_UPD\",\"scope\":\"one\",\"occurrence\":\"2035-10-08\",\"title\":\"M7E Moved one\",\"startDate\":\"2035-10-09\",\"startTime\":\"11:00\",\"endTime\":\"12:00\"}"
expect_status 200 "move the 10-08 occurrence"
expect_jq "[.exceptions[] | select(.occurrence == \"2035-10-08\")] | length == 1" "the exception is stored"
[ "$(jqr '.updatedAt')" != "$M7E_WK_UPD0" ] || fail "an exception write must change the series' updatedAt"
ok
M7E_WK_UPD=$(jqr '.updatedAt')
req GET "/api/planner/events?from=2035-10-08&to=2035-10-14" "$ACCT"
expect_status 200 "GET the moved week"
expect_jq "[.events[] | select(.eventId == $M7E_WK)] | length == 1 and .[0].start == \"2035-10-09\" and .[0].startTime == \"11:00\" and .[0].title == \"M7E Moved one\" and .[0].changed == true and .[0].id == \"e:$M7E_WK:2035-10-08\"" "10-08 shows on 10-09 with the new title"
m7e_starts "$ACCT" 2035-10-09 2035-10-09 "$M7E_WK"
expect_eq "$M7E_STARTS" "2035-10-09" "a range of just 10-09 includes it"
m7e_starts "$ACCT" 2035-10-08 2035-10-08 "$M7E_WK"
expect_eq "$M7E_STARTS" "" "a range of just 10-08 doesn't"
req PATCH "/api/planner/events/$M7E_WK" "$ACCT" "{\"updatedAt\":\"$M7E_WK_UPD\",\"scope\":\"one\",\"occurrence\":\"2035-10-15\",\"layer\":\"accounts\"}"
expect_status 400 "a layer change for one occurrence"
expect_jq '.error == "Change that for this and all later occurrences"' "the scope-one sentence"
req PATCH "/api/planner/events/$M7E_WK" "$ACCT" "{\"updatedAt\":\"$M7E_WK_UPD\",\"scope\":\"one\",\"occurrence\":\"2035-10-16\",\"title\":\"x\"}"
expect_status 400 "not an occurrence"
expect_jq '.error == "That date isn'"'"'t an occurrence of this event"' "the occurrence sentence"
req DELETE "/api/planner/events/$M7E_WK?scope=one&occurrence=2035-10-15&updatedAt=$(jq -rn --arg u "$M7E_WK_UPD" '$u|@uri')" "$ACCT"
expect_status 204 "delete the 10-15 occurrence"
m7e_starts "$ACCT" 2035-10-14 2035-10-23 "$M7E_WK"
expect_eq "$M7E_STARTS" "2035-10-22" "10-15 gone, 10-22 still there"

echo "--- reminders after one-off changes ---"
m7e_run "2035-10-14T21:00:30Z" 5
m7e_notifs "$ACCT" "$(m7e_link "$M7E_WK" 2035-10-15)"
expect_eq "$M7E_N" 0 "a cancelled occurrence never fires"
m7e_run "2035-10-08T23:00:30Z" 5
m7e_notifs "$ACCT" "$(m7e_link "$M7E_WK" 2035-10-08 2035-10-09)"
expect_eq "$M7E_N" 1 "the moved occurrence fires at its new time"

echo "--- this and all later ---"
m7e_upd "$ACCT" "$M7E_MO"
req PATCH "/api/planner/events/$M7E_MO" "$ACCT" "{\"updatedAt\":\"$M7E_UPD\",\"scope\":\"later\",\"occurrence\":\"2035-04-30\",\"title\":\"M7E Monthly later\"}"
expect_status 200 "split the monthly at 30 April"
expect_jq ".splitFromId == $M7E_MO and .startDate == \"2035-04-30\" and .repeatDay == 31 and .title == \"M7E Monthly later\"" "the new series"
M7E_MO2=$(jqr '.id')
req GET "/api/planner/events/$M7E_MO" "$ACCT"
expect_jq '.repeatUntil == "2035-04-29"' "the original ends the day before"
m7e_starts "$ACCT" 2035-05-01 2035-05-31 "$M7E_MO2"
expect_eq "$M7E_STARTS" "2035-05-31" "May: the 31st again"
expect_jq "[.events[] | select(.eventId == $M7E_MO2)][0].title == \"M7E Monthly later\"" "with the new title"
m7e_starts "$ACCT" 2035-05-01 2035-05-31 "$M7E_MO"
expect_eq "$M7E_STARTS" "" "nothing from the original in May"
m7e_upd "$ACCT" "$M7E_WK"
req PATCH "/api/planner/events/$M7E_WK" "$ACCT" "{\"updatedAt\":\"$M7E_UPD\",\"scope\":\"later\",\"occurrence\":\"2035-10-22\",\"title\":\"M7E Weekly later\"}"
expect_status 200 "split the weekly at 10-22"
M7E_WK2=$(jqr '.id')
req GET "/api/planner/events?from=2035-10-08&to=2035-10-31" "$ACCT"
expect_status 200 "GET after the weekly split"
expect_jq "[.events[] | select(.eventId == $M7E_WK)] | map(.title) == [\"M7E Moved one\"]" "the 10-09 exception still shows (before the split)"
expect_jq "[.events[] | select(.eventId == $M7E_WK2) | .start] == [\"2035-10-22\",\"2035-10-29\"]" "the new series from 10-22"

echo "--- all ---"
m7e_post "$ACCT" '{"title":"M7E All","layer":"accounts","allDay":true,"startDate":"2035-10-01","repeat":"weekly"}' "weekly for scope all"
M7E_ALL=$M7E_ID
req PATCH "/api/planner/events/$M7E_ALL" "$ACCT" "{\"updatedAt\":\"$M7E_UPD\",\"scope\":\"one\",\"occurrence\":\"2035-10-08\",\"title\":\"M7E Odd one\"}"
expect_status 200 "a one-off change"
M7E_UPD=$(jqr '.updatedAt')
req PATCH "/api/planner/events/$M7E_ALL" "$ACCT" "{\"updatedAt\":\"$M7E_UPD\",\"scope\":\"all\",\"startDate\":\"2035-10-02\"}"
expect_status 200 "move the whole series"
expect_jq '.startDate == "2035-10-02" and .exceptions == []' "the one-off change is replaced"
req GET "/api/audit?entityType=planner_event&entityId=$M7E_ALL&action=planner.event.update&limit=5" "$ADMIN"
expect_status 200 "GET the audit for the series"
expect_jq '[.rows[] | select(.action == "planner.event.update" and .after.exceptionsCleared == 1)] | length == 1' "the audit row has exceptionsCleared: 1"

echo "--- delete scopes ---"
m7e_post "$ACCT" '{"title":"M7E Delete me","layer":"accounts","allDay":true,"startDate":"2035-10-01","repeat":"weekly"}' "weekly to delete"
M7E_DEL=$M7E_ID
req DELETE "/api/planner/events/$M7E_DEL?scope=later&occurrence=2035-10-15&updatedAt=$(jq -rn --arg u "$M7E_UPD" '$u|@uri')" "$ACCT"
expect_status 204 "delete from the third occurrence"
req GET "/api/planner/events/$M7E_DEL" "$ACCT"
expect_jq '.repeatUntil == "2035-10-14"' "repeatUntil is the day before"
M7E_UPD=$(jqr '.updatedAt')
req DELETE "/api/planner/events/$M7E_DEL?scope=later&occurrence=2035-10-01&updatedAt=$(jq -rn --arg u "$M7E_UPD" '$u|@uri')" "$ACCT"
expect_status 204 "delete from the first occurrence"
req GET "/api/planner/events/$M7E_DEL" "$ACCT"
expect_status 404 "the series is gone"

echo "--- concurrency ---"
m7e_post "$ACCT" '{"title":"M7E Race","layer":"accounts","allDay":true,"startDate":"2035-10-05"}' "race"
M7E_RACE=$M7E_ID
req PATCH "/api/planner/events/$M7E_RACE" "$ACCT" "{\"updatedAt\":\"$M7E_UPD\",\"title\":\"M7E Race one\"}"
expect_status 200 "the first edit"
req PATCH "/api/planner/events/$M7E_RACE" "$ACCT2" "{\"updatedAt\":\"$M7E_UPD\",\"title\":\"M7E Race two\"}"
expect_status 409 "the second edit with the same updatedAt"
expect_jq ".error == \"Someone else changed this event. Reload to see it.\" and .event.id == $M7E_RACE and .event.title == \"M7E Race one\"" "the 409 sentence and the event"

echo "--- reminder offsets ---"
m7e_post "$ACCT" '{"title":"M7E Day before","layer":"accounts","allDay":false,"startDate":"2035-10-08","startTime":"09:00","reminder":"day1"}' "day1"
M7E_R1=$M7E_ID
m7e_run "2035-10-06T21:59:00Z" 1
m7e_run "2035-10-06T22:00:00Z" 1
m7e_notifs "$ACCT" "$(m7e_link "$M7E_R1" 2035-10-08)"
expect_eq "$M7E_N" 1 "day1 fires at 2035-10-06T22:00:00Z (the same clock time the day before)"
m7e_post "$ACCT" '{"title":"M7E Gap","layer":"accounts","allDay":false,"startDate":"2035-10-07","startTime":"02:30","endTime":"04:00","reminder":"start"}' "start in the spring-forward gap"
M7E_R2=$M7E_ID
m7e_run "2035-10-06T16:30:00Z" 1
m7e_notifs "$ACCT" "$(m7e_link "$M7E_R2" 2035-10-07)"
expect_eq "$M7E_N" 1 "start at 02:30 in the gap fires at 2035-10-06T16:30:00Z"
m7e_post "$ACCT" '{"title":"M7E Quarter","layer":"accounts","allDay":false,"startDate":"2035-10-08","startTime":"09:00","reminder":"min15"}' "min15"
M7E_R3=$M7E_ID
m7e_run "2035-10-07T21:45:00Z" 1
m7e_run "2035-10-07T21:45:00Z" 1
m7e_notifs "$ACCT" "$(m7e_link "$M7E_R3" 2035-10-08)"
expect_eq "$M7E_N" 1 "min15 fires once"
m7e_post "$ACCT" '{"title":"M7E Morning","layer":"accounts","allDay":true,"startDate":"2035-10-08","reminder":"morning"}' "morning"
M7E_R4=$M7E_ID
m7e_run "2035-10-07T20:00:00Z" 1
m7e_notifs "$ACCT" "$(m7e_link "$M7E_R4" 2035-10-08)"
expect_eq "$M7E_N" 1 "morning fires at 2035-10-07T20:00:00Z"
m7e_post "$ACCT" '{"title":"M7E Day before all-day","layer":"accounts","allDay":true,"startDate":"2035-10-08","reminder":"day_before"}' "day_before"
M7E_R5=$M7E_ID
m7e_run "2035-10-06T20:00:00Z" 1
m7e_notifs "$ACCT" "$(m7e_link "$M7E_R5" 2035-10-08)"
expect_eq "$M7E_N" 1 "day_before fires at 2035-10-06T20:00:00Z"

echo "--- who gets a reminder ---"
m7e_post "$ACCT2" '{"title":"M7E Layer reminder","layer":"accounts","allDay":true,"startDate":"2035-11-05","reminder":"morning","remindLayer":true}' "remind everyone on Accounts"
M7E_LR=$M7E_ID
m7e_run "2035-11-04T20:00:00Z" 1
M7E_L=$(m7e_link "$M7E_LR" 2035-11-05)
for M7E_J in "$ACCT" "$ACCT2" "$MULTI" "$ADMIN"; do
  m7e_notifs "$M7E_J" "$M7E_L"
  expect_eq "$M7E_N" 1 "everyone on Accounts is reminded ($M7E_J)"
done
for M7E_J in "$DPM" "$SCHED"; do
  m7e_notifs "$M7E_J" "$M7E_L"
  expect_eq "$M7E_N" 0 "nobody off the layer is reminded ($M7E_J)"
done
m7e_post "$ACCT" '{"title":"M7E Personal reminder","layer":"personal","allDay":true,"startDate":"2035-11-06","reminder":"morning"}' "a personal reminder"
M7E_PR=$M7E_ID
m7e_run "2035-11-05T20:00:00Z" 1
M7E_L=$(m7e_link "$M7E_PR" 2035-11-06)
m7e_notifs "$ACCT" "$M7E_L"
expect_eq "$M7E_N" 1 "the owner gets the personal reminder"
for M7E_J in "$ADMIN" "$ACCT2"; do
  m7e_notifs "$M7E_J" "$M7E_L"
  expect_eq "$M7E_N" 0 "nobody else gets the personal reminder ($M7E_J)"
done

echo "--- recipients re-checked at send ---"
create_user m7rem "CI M7 Reminder" "Tmp-M7rem-Passw0rd-1" accounts
M7E_REM_ID=$CREATED_ID
M7E_REM="$WORK/jar-m7rem"
new_jar "$M7E_REM"
login "$M7E_REM" m7rem "Tmp-M7rem-Passw0rd-1"; expect_status 200 "login m7rem"
own_password "$M7E_REM" "Tmp-M7rem-Passw0rd-1" "M7rem-Passw0rd-1"
m7e_post "$M7E_REM" '{"title":"M7E Lost role","layer":"accounts","allDay":true,"startDate":"2035-11-08","reminder":"morning"}' "m7rem's accounts event"
M7E_LOST=$M7E_ID
req PATCH "/api/users/$M7E_REM_ID" "$ADMIN" '{"roles":["design_pm"]}'
expect_status 200 "m7rem moves to design_pm"
m7e_run "2035-11-07T20:00:00Z" 1
m7e_notifs "$M7E_REM" "$(m7e_link "$M7E_LOST" 2035-11-08)"
expect_eq "$M7E_N" 0 "someone who lost the role gets nothing"

echo "--- audit ---"
req GET "/api/audit?entityType=planner_event&entityId=$M7E_C1&limit=20" "$ADMIN"
expect_status 200 "GET the audit for a shared event"
expect_jq '[.rows[] | select(.action == "planner.event.create" and .after.title == "M7E Company day")] | length == 1' "the shared create carries the title"
req PATCH "/api/planner/events/$M7E_P1" "$ACCT" "{\"updatedAt\":\"$M7E_P1_UPD\",\"title\":\"M7E Secret dentist moved\",\"startTime\":\"09:45\"}"
expect_status 200 "acct edits the personal event"
req GET "/api/audit?entityType=planner_event&entityId=$M7E_P1&limit=20" "$ADMIN"
expect_status 200 "GET the audit for the personal event"
expect_jq '[.rows[].action] | (index("planner.event.create") != null and index("planner.event.update") != null)' "the personal rows exist"
expect_jq '[.rows[] | select(.action == "planner.event.create")][0].after | keys == ["fields","layer"]' "after holds only layer and fields"
case $BODY in
  *Secret* | *"private note"* | *'"09:'*) fail "the personal event's content appears in the audit: ${BODY:0:600}" ;;
  *) ok ;;
esac
req GET "/api/planner/events/$M7E_P1" "$ADMIN"
expect_status 404 "admin gets 404 on acct's personal event"

echo "--- the timer ---"
# Capture first, then grep (under pipefail an early grep -q exit would SIGPIPE docker logs).
M7E_LOGS=$(docker logs "$CONTAINER" 2>&1)
grep -qF "[planner] first start: reminder mark seeded" <<<"$M7E_LOGS" \
  || fail "docker logs lack the planner timer's first-start line"
ok
# Logs carry ids and counts only: never a title.
if grep -qF "M7E Secret" <<<"$M7E_LOGS"; then fail "a personal title appears in docker logs"; fi
ok
