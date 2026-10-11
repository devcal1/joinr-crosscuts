# M7 smoke, Wave 2 E: who sees, posts and edits each planner layer, and personal privacy.
# Sourced by ci/smoke.sh after the M7 users are made, so it shares that script's helpers (step,
# req, hdr, expect_status, expect_jq, expect_eq, jqr, fail, ok), the cookie jars ($ADMIN $SCHED
# $ACCT $DPM $SHOW $WSHOP $ACCT2 $MULTI), the ids $WSHOP_ID $ACCT2_ID $MULTI_ID, $BASE, $WORK and
# $CONTAINER. No shebang and no `set`: the caller owns both. It does not assume a pristine
# database: it makes its own events (August 2035, clear of the other M7 suites' June, October and
# November) and one job, and checks only those ids, except where a rule must hold for every row
# (nobody else's personal event, on any date). The job page route reads today to today + 89, so
# its events sit just after today with no reminder (the live timer never sends anything for them).
# Contract: docs/plans/m7-contracts.md sections 5, 9, 11 and 15.4.

# ============================================================================
step "m7-access. layer visibility and privacy"
# ============================================================================

M7X_MON=2035-08-06   # a Monday; the matrix week is 08-06 to 08-12
M7X_SUN=2035-08-12
M7X_TODAY=$(TZ=Australia/Sydney date +%F)
# The personal events' content (acct's and admin's): none of it may reach anyone but its owner,
# and never the audit, the bell of another user or the container log.
M7X_SECRETS_ACCT=("M7X Private dentist" "M7X hush note" "M7X Private job visit" "M7X hush job note")
M7X_SECRETS_ADMIN=("M7X Admin private" "M7X admin diary")
M7X_SECRETS=("${M7X_SECRETS_ACCT[@]}" "${M7X_SECRETS_ADMIN[@]}")

declare -gA M7X_JAR=([admin]="$ADMIN" [acct]="$ACCT" [acct2]="$ACCT2" [dpm]="$DPM" [sched]="$SCHED" [wshop]="$WSHOP" [multi]="$MULTI" [show]="$SHOW")
declare -gA M7X_UID=()
declare -gA M7X_ID=()
declare -gA M7X_OWN=()
declare -gA M7X_NOTE=()
M7X_PLANNERS=(admin acct acct2 dpm sched wshop multi)

for M7X_W in "${M7X_PLANNERS[@]}" show; do
  req GET /api/auth/me "${M7X_JAR[$M7X_W]}"
  expect_status 200 "me as $M7X_W"
  M7X_UID[$M7X_W]=$(jqr '.user.id')
done

# m7x_clean WHAT [VIEWER]: the last response body holds none of the personal secrets, except the
# viewer's own (acct's or admin's) when VIEWER is given.
m7x_clean() {
  local s
  local -a list=()
  [ "${2:-}" = acct ] || list+=("${M7X_SECRETS_ACCT[@]}")
  [ "${2:-}" = admin ] || list+=("${M7X_SECRETS_ADMIN[@]}")
  for s in "${list[@]}"; do
    if [[ $BODY == *"$s"* ]]; then fail "$1: the response contains personal content '$s': ${BODY:0:400}"; fi
  done
  ok
}

# m7x_post KEY WHO JSON: WHO creates an event (201) -> M7X_ID[KEY], M7X_OWN[KEY], M7X_NOTE[KEY].
m7x_post() {
  req POST /api/planner/events "${M7X_JAR[$2]}" "$3"
  expect_status 201 "$2 creates $1"
  M7X_ID[$1]=$(jqr '.id')
  M7X_OWN[$1]=$2
  M7X_NOTE[$1]=$(jqr '.notes')
}

# m7x_upd KEY: the series' current updatedAt, read by its owner -> M7X_UPD.
m7x_upd() {
  req GET "/api/planner/events/${M7X_ID[$1]}" "${M7X_JAR[${M7X_OWN[$1]}]}"
  expect_status 200 "the owner reads $1"
  M7X_UPD=$(jqr '.updatedAt')
}

m7x_uri() {
  jq -rn --arg u "$1" '$u|@uri'
}

# m7x_idlist KEY... -> comma-joined ids, in the order given.
m7x_idlist() {
  local k out=""
  for k in "$@"; do out="$out${out:+,}${M7X_ID[$k]}"; done
  printf '%s' "$out"
}

# m7x_run AT WINDOW: the reminder sweep as admin for (AT - WINDOW min, AT].
m7x_run() {
  req POST /api/planner/reminders/run "$ADMIN" "{\"at\":\"$1\",\"windowMinutes\":$2}"
  expect_status 200 "reminder run at $1"
}

# m7x_bell JAR LINK WANT WHAT: JAR's user has exactly WANT planner.reminder alerts with LINK. The
# sweep writes the bell rows in its own transaction before it answers, so this polls a few times
# (bounded) only to ride out a slow container.
m7x_bell() {
  local i n=""
  for i in 1 2 3 4 5; do
    req GET "/api/notifications?limit=100" "$1"
    expect_status 200 "GET /api/notifications ($4)"
    n=$(jqr "[.rows[] | select(.kind == \"planner.reminder\" and .link == \"$2\")] | length")
    [ "$n" = "$3" ] && break
    [ "$3" = 0 ] && break
    sleep 0.5
  done
  expect_eq "$n" "$3" "$4"
}

echo "--- layers per role (section 5.2) ---"
# m7x_layers WHO PAIRS DEFAULT CANEDIT: GET /layers gives exactly [[id, canPost]...], the default
# and canEdit.
m7x_layers() {
  req GET /api/planner/layers "${M7X_JAR[$1]}"
  expect_status 200 "$1 GET /api/planner/layers"
  expect_jq "([.layers[] | [.id, .canPost]] == $2) and .default == $3 and .canEdit == $4 and (.today | test(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}$\"))" \
    "$1: the layers, default and canEdit of section 5.2"
}
m7x_layers admin '[["company",true],["install",true],["accounts",true],["design_pm",true],["scheduling",true],["workshop",true],["personal",true]]' '"company"' true
expect_jq '[.layers[].label] == ["Company-wide","Install & hardware","Accounts","Design/PM","Scheduling/Production","Workshop","Personal"]' "the layer labels, in order"
m7x_layers acct '[["company",true],["install",false],["accounts",true],["personal",true]]' '"accounts"' true
m7x_layers acct2 '[["company",true],["install",false],["accounts",true],["personal",true]]' '"accounts"' true
m7x_layers dpm '[["company",true],["install",true],["design_pm",true],["personal",true]]' '"design_pm"' true
m7x_layers sched '[["company",true],["install",true],["scheduling",true],["workshop",true],["personal",true]]' '"scheduling"' true
m7x_layers wshop '[["company",false],["install",false],["workshop",false]]' null false
m7x_layers multi '[["company",true],["install",true],["accounts",true],["design_pm",true],["personal",true]]' '"accounts"' true
req GET /api/planner/layers "$SHOW"
expect_status 403 "show GET /api/planner/layers"
expect_jq '.error == "Forbidden"' "show: the key refusal"

echo "--- seed: one event per layer, each by a permitted poster ---"
m7x_post CO acct '{"title":"M7X Company notice","notes":"M7X company note","layer":"company","allDay":true,"startDate":"2035-08-06"}'
m7x_post IN dpm '{"title":"M7X Crane booking","notes":"M7X install note","layer":"install","allDay":true,"startDate":"2035-08-07"}'
m7x_post AC acct '{"title":"M7X Accounts meeting","notes":"M7X accounts note","layer":"accounts","allDay":false,"startDate":"2035-08-07","startTime":"10:00","endTime":"11:00"}'
m7x_post DE dpm '{"title":"M7X Design review","notes":"M7X design note","layer":"design_pm","allDay":true,"startDate":"2035-08-08","endDate":"2035-08-09"}'
m7x_post SC sched '{"title":"M7X Production plan","notes":"M7X production note","layer":"scheduling","allDay":false,"startDate":"2035-08-08","startTime":"07:30"}'
m7x_post WS sched '{"title":"M7X Saw service","notes":"M7X workshop note","layer":"workshop","allDay":true,"startDate":"2035-08-09"}'
# A repeating personal series (the repeat branch of the query) with a reminder (the bell check).
m7x_post PA acct '{"title":"M7X Private dentist","notes":"M7X hush note","layer":"personal","allDay":false,"startDate":"2035-08-09","startTime":"09:15","endTime":"10:00","repeat":"weekly","reminder":"hour1"}'
m7x_post PD admin '{"title":"M7X Admin private","notes":"M7X admin diary","layer":"personal","allDay":true,"startDate":"2035-08-10"}'
expect_jq '.layer == "personal" and .canEdit == true' "admin's own personal event"
M7X_ALL=(CO IN AC DE SC WS PA PD)
M7X_MINE=$(m7x_idlist "${M7X_ALL[@]}")

# Who sees which of the eight (section 5.2), in M7X_ALL order (ids ascend in that order), and the
# layers each may see at all.
declare -gA M7X_SEES=(
  [admin]="CO IN AC DE SC WS PD"
  [acct]="CO IN AC PA"
  [acct2]="CO IN AC"
  [dpm]="CO IN DE"
  [sched]="CO IN SC WS"
  [wshop]="CO IN WS"
  [multi]="CO IN AC DE"
)
declare -gA M7X_VIS=(
  [admin]='["company","install","accounts","design_pm","scheduling","workshop","personal"]'
  [acct]='["company","install","accounts","personal"]'
  [acct2]='["company","install","accounts","personal"]'
  [dpm]='["company","install","design_pm","personal"]'
  [sched]='["company","install","scheduling","workshop","personal"]'
  [wshop]='["company","install","workshop"]'
  [multi]='["company","install","accounts","design_pm","personal"]'
)

# m7x_sees WHO KEY: true when WHO should see KEY.
m7x_sees() {
  [[ " ${M7X_SEES[$1]} " == *" $2 "* ]]
}

# m7x_list_ok WHO WHAT: the last GET /events holds only WHO's visible layers and nobody else's
# personal events (hand-made or automatic, any date).
m7x_list_ok() {
  expect_jq "([.events[].layer] | unique) - ${M7X_VIS[$1]} == []" "$1: only visible layers ($2)"
  expect_jq "[.events[] | select(.layer == \"personal\" and .source == \"event\" and .createdBy.id != ${M7X_UID[$1]})] | length == 0" \
    "$1: nobody else's personal events ($2)"
}

echo "--- the visibility matrix ---"
for M7X_W in "${M7X_PLANNERS[@]}"; do
  M7X_J=${M7X_JAR[$M7X_W]}
  # shellcheck disable=SC2086
  M7X_WANT=$(m7x_idlist ${M7X_SEES[$M7X_W]})
  req GET "/api/planner/events?from=$M7X_MON&to=$M7X_SUN" "$M7X_J"
  expect_status 200 "$M7X_W GET the matrix week"
  expect_jq "[.events[] | select(.source == \"event\") | .eventId | select(IN($M7X_MINE))] | sort == [$M7X_WANT]" \
    "$M7X_W: exactly the hand-made events of section 5.2, once each"
  m7x_list_ok "$M7X_W" "the matrix week"
  m7x_clean "$M7X_W GET the matrix week" "$M7X_W"
  for M7X_K in "${M7X_ALL[@]}"; do
    req GET "/api/planner/events/${M7X_ID[$M7X_K]}" "$M7X_J"
    if m7x_sees "$M7X_W" "$M7X_K"; then
      expect_status 200 "$M7X_W GET $M7X_K"
      expect_jq ".id == ${M7X_ID[$M7X_K]}" "$M7X_W reads $M7X_K"
    else
      expect_status 404 "$M7X_W GET $M7X_K (hidden is 404, never 403)"
      expect_jq '.error == "Not found"' "$M7X_W: the 404 sentence for $M7X_K"
      [[ $BODY != *M7X* ]] || fail "$M7X_W: the 404 for $M7X_K carries content: $BODY"
      ok
    fi
  done
done
req GET "/api/planner/events?from=$M7X_MON&to=$M7X_SUN" "$SHOW"
expect_status 403 "show GET /api/planner/events"
for M7X_K in "${M7X_ALL[@]}"; do
  req GET "/api/planner/events/${M7X_ID[$M7X_K]}" "$SHOW"
  expect_status 403 "show GET $M7X_K"
done

echo "--- ids: not a positive integer, missing, removed ---"
for M7X_P in abc 0 -1 1.5 99999999; do
  req GET "/api/planner/events/$M7X_P" "$ADMIN"
  expect_status 404 "GET /api/planner/events/$M7X_P"
  req PATCH "/api/planner/events/$M7X_P" "$ADMIN" '{"updatedAt":"x","title":"x"}'
  expect_status 404 "PATCH /api/planner/events/$M7X_P"
  req DELETE "/api/planner/events/$M7X_P?updatedAt=x" "$ADMIN"
  expect_status 404 "DELETE /api/planner/events/$M7X_P"
done
m7x_post GONE acct '{"title":"M7X Removed","layer":"company","allDay":true,"startDate":"2035-08-11"}'
req DELETE "/api/planner/events/${M7X_ID[GONE]}?updatedAt=$(m7x_uri "$(jqr '.updatedAt')")" "$ACCT"
expect_status 204 "acct deletes its own company event"
for M7X_W in acct admin; do
  req GET "/api/planner/events/${M7X_ID[GONE]}" "${M7X_JAR[$M7X_W]}"
  expect_status 404 "$M7X_W GET a removed event"
done
req GET "/api/planner/events?from=$M7X_MON&to=$M7X_SUN" "$ADMIN"
expect_jq "[.events[] | select(.eventId == ${M7X_ID[GONE]})] | length == 0" "a removed event is not listed"

echo "--- personal events stay private on every range ---"
# Move one occurrence of acct's weekly personal series (the exception branch of the query).
m7x_upd PA
req PATCH "/api/planner/events/${M7X_ID[PA]}" "$ACCT" \
  "{\"updatedAt\":\"$M7X_UPD\",\"scope\":\"one\",\"occurrence\":\"2035-08-16\",\"startDate\":\"2035-08-18\",\"title\":\"M7X Private dentist moved\"}"
expect_status 200 "acct moves one occurrence of its personal series"
req GET "/api/planner/events?from=2035-08-18&to=2035-08-18" "$ACCT"
expect_jq "[.events[] | select(.eventId == ${M7X_ID[PA]})] | length == 1 and .[0].changed == true and .[0].id == \"e:${M7X_ID[PA]}:2035-08-16\"" \
  "the owner sees the moved occurrence"
for M7X_W in admin acct2 dpm sched wshop multi; do
  M7X_J=${M7X_JAR[$M7X_W]}
  for M7X_R in "2035-08-18 2035-08-18" "2035-08-09 2035-08-09" "2035-08-01 2035-09-30" "2035-08-13 2035-08-19"; do
    M7X_F=${M7X_R% *}; M7X_T=${M7X_R#* }
    req GET "/api/planner/events?from=$M7X_F&to=$M7X_T" "$M7X_J"
    expect_status 200 "$M7X_W GET $M7X_F..$M7X_T"
    expect_jq "[.events[] | select(.eventId == ${M7X_ID[PA]})] | length == 0" "$M7X_W: acct's personal series is not in $M7X_F..$M7X_T"
    m7x_list_ok "$M7X_W" "$M7X_F..$M7X_T"
    m7x_clean "$M7X_W GET $M7X_F..$M7X_T" "$M7X_W"
  done
  req GET "/api/planner/events?from=2035-08-01&to=2035-09-30&layers=personal" "$M7X_J"
  expect_status 200 "$M7X_W GET layers=personal"
  expect_jq "[.events[] | select(.layer == \"personal\" and .source == \"event\" and .createdBy.id != ${M7X_UID[$M7X_W]})] | length == 0" \
    "$M7X_W: layers=personal is only their own"
done
req GET "/api/planner/events?from=2035-08-01&to=2035-09-30&layers=personal" "$ADMIN"
expect_jq "([.events[] | select(.source == \"event\") | .eventId] | index(${M7X_ID[PD]}) != null) and ([.events[] | select(.source == \"event\") | .createdBy.id] | all(. == ${M7X_UID[admin]}))" \
  "admin layers=personal: its own, never acct's"

echo "--- layers= only narrows ---"
req GET "/api/planner/events?from=$M7X_MON&to=$M7X_SUN&layers=accounts,design_pm" "$DPM"
expect_status 200 "dpm layers=accounts,design_pm"
expect_jq "([.events[].layer] | unique) - [\"design_pm\"] == [] and ([.events[] | select(.source == \"event\") | .eventId] | index(${M7X_ID[DE]}) != null)" \
  "dpm: design_pm items only"
req GET "/api/planner/events?from=$M7X_MON&to=$M7X_SUN&layers=accounts" "$ACCT"
expect_status 200 "acct layers=accounts"
expect_jq "([.events[].layer] | unique) - [\"accounts\"] == [] and ([.events[] | select(.source == \"event\") | .eventId] | index(${M7X_ID[AC]}) != null) and (.weeks == [])" \
  "acct: no company items, no board band"
req GET "/api/planner/events?from=$M7X_MON&to=$M7X_SUN&layers=accounts,design_pm,scheduling,personal" "$WSHOP"
expect_status 200 "wshop asks for layers it can't see"
expect_jq '.events == [] and .weeks == []' "wshop: nothing comes back"
req GET "/api/planner/events?from=$M7X_MON&to=$M7X_SUN&layers=company,workshop" "$WSHOP"
expect_jq "[.events[] | select(.source == \"event\") | .eventId | select(IN($M7X_MINE))] | sort == [$(m7x_idlist CO WS)]" \
  "wshop layers=company,workshop: those two"

echo "--- edits: the canEdit matrix (PATCH) ---"
# KEY=status per user. 403 = sees it but may not change it (or has no planner.edit at all);
# 404 = can't see it.
declare -gA M7X_EDITS=(
  [admin]="CO=200 IN=200 AC=200 DE=200 SC=200 WS=200 PA=404 PD=200"
  [acct]="CO=200 IN=403 AC=200 DE=404 SC=404 WS=404 PA=200 PD=404"
  [acct2]="CO=403 IN=403 AC=200 DE=404 SC=404 WS=404 PA=404 PD=404"
  [dpm]="CO=403 IN=200 AC=404 DE=200 SC=404 WS=404 PA=404 PD=404"
  [sched]="CO=403 IN=200 AC=404 DE=404 SC=200 WS=200 PA=404 PD=404"
  [multi]="CO=403 IN=200 AC=200 DE=200 SC=404 WS=404 PA=404 PD=404"
  [wshop]="CO=403 IN=403 AC=403 DE=403 SC=403 WS=403 PA=403 PD=403"
  [show]="CO=403 IN=403 AC=403 DE=403 SC=403 WS=403 PA=403 PD=403"
)
for M7X_W in admin acct acct2 dpm sched multi wshop show; do
  for M7X_P in ${M7X_EDITS[$M7X_W]}; do
    M7X_K=${M7X_P%%=*}; M7X_S=${M7X_P#*=}
    m7x_upd "$M7X_K"
    M7X_N="${M7X_NOTE[$M7X_K]} ($M7X_W)"
    req PATCH "/api/planner/events/${M7X_ID[$M7X_K]}" "${M7X_JAR[$M7X_W]}" \
      "$(jq -nc --arg u "$M7X_UPD" --arg n "$M7X_N" '{updatedAt:$u,scope:"all",notes:$n}')"
    expect_status "$M7X_S" "$M7X_W PATCH $M7X_K"
    case $M7X_S in
      200)
        expect_jq "$(jq -nc --arg n "$M7X_N" '$n') as \$n | .notes == \$n and .createdBy.id == ${M7X_UID[${M7X_OWN[$M7X_K]}]}" "$M7X_W changed $M7X_K (the owner stays)"
        M7X_NOTE[$M7X_K]=$M7X_N ;;
      403) expect_jq '.error == "Forbidden"' "$M7X_W: the 403 for $M7X_K" ;;
      404) expect_jq '.error == "Not found"' "$M7X_W: the 404 for $M7X_K"
           [[ $BODY != *M7X* ]] || fail "$M7X_W: the 404 for $M7X_K carries content: $BODY"
           ok ;;
    esac
  done
done

echo "--- check order: 404 and 403 come before 400 and 409 ---"
M7X_STALE='"updatedAt":"2000-01-01T00:00:00.000Z"'
req PATCH "/api/planner/events/${M7X_ID[PA]}" "$ACCT2" "{$M7X_STALE,\"scope\":\"all\",\"title\":\"x\"}"
expect_status 404 "acct2 stale PATCH on acct's personal (never a 409 carrying the event)"
m7x_clean "acct2 stale PATCH on acct's personal"
req PATCH "/api/planner/events/${M7X_ID[PA]}" "$ADMIN" "{$M7X_STALE,\"scope\":\"all\",\"title\":\"x\"}"
expect_status 404 "admin stale PATCH on acct's personal"
m7x_clean "admin stale PATCH on acct's personal"
req PATCH "/api/planner/events/${M7X_ID[PA]}" "$ADMIN" '{"title":"x"}'
expect_status 404 "admin PATCH on acct's personal with no updatedAt"
req PATCH "/api/planner/events/${M7X_ID[AC]}" "$DPM" "{$M7X_STALE,\"title\":\"x\"}"
expect_status 404 "dpm stale PATCH on the accounts event"
req PATCH "/api/planner/events/${M7X_ID[CO]}" "$ACCT2" "{$M7X_STALE,\"title\":\"x\"}"
expect_status 403 "acct2 stale PATCH on acct's company event (403, not 409)"
req PATCH "/api/planner/events/${M7X_ID[CO]}" "$ACCT2" '{"title":"x"}'
expect_status 403 "acct2 PATCH on acct's company event with no updatedAt (403, not 400)"
req PATCH "/api/planner/events/${M7X_ID[CO]}" "$ADMIN" "{$M7X_STALE,\"title\":\"x\"}"
expect_status 409 "admin stale PATCH on acct's company event"
expect_jq ".event.id == ${M7X_ID[CO]}" "the 409 carries the series for someone who may edit it"

echo "--- deletes ---"
# m7x_del WHO KEY STATUS
m7x_del() {
  m7x_upd "$2"
  req DELETE "/api/planner/events/${M7X_ID[$2]}?scope=all&updatedAt=$(m7x_uri "$M7X_UPD")" "${M7X_JAR[$1]}"
  expect_status "$3" "$1 DELETE $2"
  if [ "$3" = 404 ]; then m7x_clean "$1 DELETE $2"; fi
}
m7x_del dpm WS 404
m7x_del dpm AC 404
m7x_del acct2 PA 404
m7x_del admin PA 404
m7x_del sched PD 404
m7x_del acct2 CO 403
m7x_del dpm CO 403
m7x_del acct IN 403
m7x_del wshop CO 403
m7x_del wshop WS 403
m7x_del show CO 403
for M7X_K in "${M7X_ALL[@]}"; do
  req GET "/api/planner/events/${M7X_ID[$M7X_K]}" "${M7X_JAR[${M7X_OWN[$M7X_K]}]}"
  expect_status 200 "$M7X_K survives the refused deletes"
done

echo "--- posting per layer ---"
# m7x_try WHO LAYER STATUS: an all-day event on 2035-08-20 (outside the matrix week).
m7x_try() {
  req POST /api/planner/events "${M7X_JAR[$1]}" \
    "{\"title\":\"M7X Post $1 $2\",\"layer\":\"$2\",\"allDay\":true,\"startDate\":\"2035-08-20\"}"
  expect_status "$3" "$1 POST to $2"
  case $3 in
    403)
      if [ "$1" = wshop ] || [ "$1" = show ]; then expect_jq '.error == "Forbidden"' "$1: no planner.edit"
      else expect_jq '.error == "You can'"'"'t add events to that layer"' "$1: the layer sentence ($2)"; fi ;;
    201) expect_jq ".layer == \"$2\" and .createdBy.id == ${M7X_UID[$1]}" "$1 posted to $2" ;;
  esac
}
for M7X_L in install design_pm scheduling workshop; do m7x_try acct "$M7X_L" 403; done
for M7X_L in company accounts personal; do m7x_try acct "$M7X_L" 201; done
for M7X_L in accounts scheduling workshop; do m7x_try dpm "$M7X_L" 403; done
for M7X_L in company install design_pm personal; do m7x_try dpm "$M7X_L" 201; done
for M7X_L in accounts design_pm; do m7x_try sched "$M7X_L" 403; done
for M7X_L in company install scheduling workshop personal; do m7x_try sched "$M7X_L" 201; done
for M7X_L in scheduling workshop; do m7x_try multi "$M7X_L" 403; done
for M7X_L in company install accounts design_pm personal; do m7x_try multi "$M7X_L" 201; done
m7x_try acct2 install 403
m7x_try acct2 company 201
for M7X_L in company install accounts design_pm scheduling workshop personal; do m7x_try admin "$M7X_L" 201; done
for M7X_L in company install workshop personal; do m7x_try wshop "$M7X_L" 403; done
for M7X_L in company personal; do m7x_try show "$M7X_L" 403; done

echo "--- 'remind everyone on this layer' is never on Personal ---"
req POST /api/planner/events "$ACCT" '{"title":"M7X Remind all personal","layer":"personal","allDay":true,"startDate":"2035-08-20","reminder":"morning","remindLayer":true}'
expect_status 400 "POST personal with remindLayer"
expect_jq '.error == "Personal events can'"'"'t remind anyone else"' "the personal remindLayer sentence"
m7x_upd PA
req PATCH "/api/planner/events/${M7X_ID[PA]}" "$ACCT" "{\"updatedAt\":\"$M7X_UPD\",\"scope\":\"all\",\"remindLayer\":true}"
expect_status 400 "PATCH personal with remindLayer"
expect_jq '.error == "Personal events can'"'"'t remind anyone else"' "the personal remindLayer sentence (PATCH)"

echo "--- layer moves ---"
m7x_post MV acct '{"title":"M7X Move me","layer":"company","allDay":true,"startDate":"2035-08-22","reminder":"morning","remindLayer":true}'
expect_jq '.remindLayer == true' "the company event reminds everyone"
req GET "/api/planner/events/${M7X_ID[MV]}" "$ADMIN"
expect_status 200 "admin sees the company event"
m7x_upd MV
req PATCH "/api/planner/events/${M7X_ID[MV]}" "$ADMIN" "{\"updatedAt\":\"$M7X_UPD\",\"layer\":\"personal\"}"
expect_status 403 "admin can't move acct's event to Personal"
req PATCH "/api/planner/events/${M7X_ID[MV]}" "$ACCT" "{\"updatedAt\":\"$M7X_UPD\",\"layer\":\"personal\"}"
expect_status 200 "acct moves its own company event to Personal"
expect_jq '.layer == "personal" and .remindLayer == false' "moved to Personal: remindLayer is off"
for M7X_W in admin acct2 dpm; do
  req GET "/api/planner/events/${M7X_ID[MV]}" "${M7X_JAR[$M7X_W]}"
  expect_status 404 "$M7X_W GET the event now Personal"
  req GET "/api/planner/events?from=2035-08-22&to=2035-08-22" "${M7X_JAR[$M7X_W]}"
  expect_jq "[.events[] | select(.eventId == ${M7X_ID[MV]})] | length == 0" "$M7X_W: no longer listed"
done
req GET "/api/audit?entityType=planner_event&entityId=${M7X_ID[MV]}&action=planner.event.update&limit=5" "$ADMIN"
expect_status 200 "the audit of the move"
expect_jq '[.rows[] | select(.action == "planner.event.update")] | length == 1 and (.[0].after | keys) == ["fields","layer"] and (.[0].after.layer == "personal") and (.[0].before == null or ((.[0].before | keys) == ["fields","layer"]))' \
  "a move to Personal is audited redacted"
m7x_upd MV
req PATCH "/api/planner/events/${M7X_ID[MV]}" "$ACCT" "{\"updatedAt\":\"$M7X_UPD\",\"layer\":\"accounts\"}"
expect_status 200 "the owner moves it back out of Personal"
req GET "/api/planner/events/${M7X_ID[MV]}" "$ACCT2"
expect_status 200 "acct2 sees it on Accounts"
m7x_upd AC
req PATCH "/api/planner/events/${M7X_ID[AC]}" "$ACCT2" "{\"updatedAt\":\"$M7X_UPD\",\"layer\":\"personal\"}"
expect_status 403 "acct2 can't move acct's Accounts event to Personal"
expect_jq '.error == "You can'"'"'t add events to that layer"' "the layer sentence on a move"
req PATCH "/api/planner/events/${M7X_ID[AC]}" "$ACCT2" "{\"updatedAt\":\"$M7X_UPD\",\"layer\":\"design_pm\"}"
expect_status 403 "acct2 can't move the Accounts event to Design/PM"
m7x_upd IN
req PATCH "/api/planner/events/${M7X_ID[IN]}" "$MULTI" "{\"updatedAt\":\"$M7X_UPD\",\"layer\":\"design_pm\"}"
expect_status 200 "multi (design_pm) moves the Install event to Design/PM"
req GET "/api/planner/events/${M7X_ID[IN]}" "$SCHED"
expect_status 404 "sched no longer sees it"
req GET "/api/planner/events/${M7X_ID[IN]}" "$WSHOP"
expect_status 404 "wshop no longer sees it"

echo "--- the job page route ---"
req POST /api/job-records "$ADMIN" '{"name":"CI M7X Job"}'
expect_status 201 "create the M7X job"
M7X_JOB=$(jqr '.id')
M7X_D1=$(date -u -d "$M7X_TODAY + 1 day" +%F)
M7X_D2=$(date -u -d "$M7X_TODAY + 2 days" +%F)
M7X_D3=$(date -u -d "$M7X_TODAY + 3 days" +%F)
m7x_post JP acct "{\"title\":\"M7X Private job visit\",\"notes\":\"M7X hush job note\",\"layer\":\"personal\",\"allDay\":true,\"startDate\":\"$M7X_D1\",\"jobId\":$M7X_JOB}"
m7x_post JA acct "{\"title\":\"M7X Job invoice check\",\"layer\":\"accounts\",\"allDay\":true,\"startDate\":\"$M7X_D2\",\"jobId\":$M7X_JOB}"
m7x_post JD dpm "{\"title\":\"M7X Job design sign-off\",\"layer\":\"design_pm\",\"allDay\":true,\"startDate\":\"$M7X_D3\",\"jobId\":$M7X_JOB}"
m7x_post JW sched "{\"title\":\"M7X Job saw slot\",\"layer\":\"workshop\",\"allDay\":true,\"startDate\":\"$M7X_D3\",\"jobId\":$M7X_JOB}"
declare -gA M7X_JOBSEES=(
  [admin]="JA JD JW"
  [acct]="JP JA"
  [acct2]="JA"
  [dpm]="JD"
  [sched]="JW"
  [wshop]="JW"
  [multi]="JA JD"
)
for M7X_W in "${M7X_PLANNERS[@]}"; do
  # shellcheck disable=SC2086
  M7X_WANT=$(m7x_idlist ${M7X_JOBSEES[$M7X_W]})
  req GET "/api/planner/job/$M7X_JOB" "${M7X_JAR[$M7X_W]}"
  expect_status 200 "$M7X_W GET /api/planner/job/:id"
  expect_jq "([.rows[].eventId] | sort) == [$M7X_WANT] and .more == false" "$M7X_W: the job's events under the layer rules"
  m7x_clean "$M7X_W GET /api/planner/job/:id" "$M7X_W"
done
req GET "/api/planner/job/$M7X_JOB" "$WSHOP"
expect_jq '[.rows[].link] | all(. == null)' "wshop (no jobs.view): no job links"
req GET "/api/planner/job/$M7X_JOB" "$SHOW"
expect_status 403 "show GET /api/planner/job/:id"
req GET "/api/planner/job/99999999" "$ADMIN"
expect_status 404 "an unknown job"
req GET "/api/planner/job/abc" "$ADMIN"
expect_status 404 "a job id that isn't a number"

echo "--- linking a job needs jobs.view ---"
req POST /api/planner/events "$WSHOP" "{\"title\":\"M7X Wshop link\",\"layer\":\"workshop\",\"allDay\":true,\"startDate\":\"2035-08-20\",\"jobId\":$M7X_JOB}"
expect_status 403 "wshop can't link a job (no planner.edit)"
req PUT "/api/users/$ACCT2_ID/overrides/jobs.view" "$ADMIN" '{"effect":"revoke"}'
expect_status 200 "admin revokes jobs.view from acct2"
req POST /api/planner/events "$ACCT2" "{\"title\":\"M7X Acct2 link\",\"layer\":\"accounts\",\"allDay\":true,\"startDate\":\"2035-08-20\",\"jobId\":$M7X_JOB}"
expect_status 403 "acct2 without jobs.view links a job"
expect_jq '.error == "You can'"'"'t link a job"' "the job sentence"
req POST /api/planner/events "$ACCT2" '{"title":"M7X Acct2 no link","layer":"accounts","allDay":true,"startDate":"2035-08-20"}'
expect_status 201 "acct2 without jobs.view still posts without a job"
m7x_upd AC
req PATCH "/api/planner/events/${M7X_ID[AC]}" "$ACCT2" "{\"updatedAt\":\"$M7X_UPD\",\"jobId\":$M7X_JOB}"
expect_status 403 "acct2 without jobs.view sets a job on an event"
expect_jq '.error == "You can'"'"'t link a job"' "the job sentence (PATCH)"
m7x_upd JA
req PATCH "/api/planner/events/${M7X_ID[JA]}" "$ACCT2" "{\"updatedAt\":\"$M7X_UPD\",\"title\":\"M7X Job invoice check, again\"}"
expect_status 200 "acct2 edits a job-linked event, leaving the job as it is"
expect_jq ".job.id == $M7X_JOB and .link == null" "the job stays; no link without jobs.view"
req DELETE "/api/users/$ACCT2_ID/overrides/jobs.view" "$ADMIN"
expect_status 200 "admin removes the override"

echo "--- planner.view by override only: Company-wide and Install & hardware ---"
req PUT "/api/users/${M7X_UID[show]}/overrides/planner.view" "$ADMIN" '{"effect":"grant"}'
expect_status 200 "admin grants planner.view to show"
req GET /api/planner/layers "$SHOW"
expect_status 200 "show GET /layers with the grant"
expect_jq '([.layers[] | [.id, .canPost]] == [["company",false],["install",false]]) and .default == null and .canEdit == false' \
  "show with planner.view: company and install, read-only"
req GET "/api/planner/events?from=$M7X_MON&to=$M7X_SUN" "$SHOW"
expect_status 200 "show GET the matrix week with the grant"
expect_jq "([.events[].layer] | unique) - [\"company\",\"install\"] == [] and ([.events[] | select(.source == \"event\") | .eventId] | index(${M7X_ID[CO]}) != null)" \
  "show sees only company and install"
m7x_clean "show GET the matrix week with the grant"
req POST /api/planner/events "$SHOW" '{"title":"M7X Show","layer":"company","allDay":true,"startDate":"2035-08-20"}'
expect_status 403 "show still can't post"
req DELETE "/api/users/${M7X_UID[show]}/overrides/planner.view" "$ADMIN"
expect_status 200 "admin removes the grant"
req GET /api/planner/layers "$SHOW"
expect_status 403 "show has no planner again"

echo "--- every planner route refuses show ---"
for M7X_R in "GET /api/planner/layers" "GET /api/planner/events?from=$M7X_MON&to=$M7X_SUN" \
  "GET /api/planner/events/${M7X_ID[CO]}" "POST /api/planner/events" "PATCH /api/planner/events/${M7X_ID[CO]}" \
  "DELETE /api/planner/events/${M7X_ID[CO]}" "GET /api/planner/job/$M7X_JOB" "POST /api/planner/reminders/run"; do
  M7X_M=${M7X_R%% *}; M7X_U=${M7X_R#* }
  case $M7X_M in POST | PATCH) req "$M7X_M" "$M7X_U" "$SHOW" '{}' ;; *) req "$M7X_M" "$M7X_U" "$SHOW" ;; esac
  expect_status 403 "show $M7X_R"
done
for M7X_W in acct sched wshop; do
  req POST /api/planner/reminders/run "${M7X_JAR[$M7X_W]}" '{}'
  expect_status 403 "$M7X_W can't run the reminder sweep"
done

echo "--- the bell ---"
# PA: weekly 09:15 from Thu 2035-08-09 (AEST, +10), hour1 -> 2035-08-08T22:15:00Z.
m7x_run "2035-08-08T22:15:30Z" 2
[ "$(jqr '.sent')" -ge 1 ] || fail "acct's personal hour1 reminder: expected sent >= 1, got $(jqr '.sent')"
ok
M7X_LINK="/planner.html?date=2035-08-09&event=e:${M7X_ID[PA]}:2035-08-09"
m7x_bell "$ACCT" "$M7X_LINK" 1 "the owner gets the personal reminder"
req GET "/api/notifications?limit=100" "$ACCT"
expect_jq "[.rows[] | select(.link == \"$M7X_LINK\")][0] | (.title | startswith(\"In 1 hour: M7X Private dentist\")) and ((.body // \"\") | contains(\"M7X hush\") | not)" \
  "the owner's reminder has the title and never the notes"
for M7X_W in admin acct2 dpm sched wshop multi; do
  req GET "/api/notifications?limit=100" "${M7X_JAR[$M7X_W]}"
  expect_status 200 "$M7X_W GET /api/notifications"
  expect_jq "[.rows[] | select((.link // \"\") | contains(\"e:${M7X_ID[PA]}:\"))] | length == 0" "$M7X_W has no alert for acct's personal event"
  m7x_clean "$M7X_W's alerts" "$M7X_W"
done
# Remind everyone on the Workshop layer: scheduling, workshop and admin; nobody else.
m7x_post WR sched '{"title":"M7X Floor clean-up","layer":"workshop","allDay":true,"startDate":"2035-08-21","reminder":"morning","remindLayer":true}'
m7x_run "2035-08-20T21:00:00Z" 1
M7X_LINK="/planner.html?date=2035-08-21&event=e:${M7X_ID[WR]}:2035-08-21"
for M7X_W in sched wshop admin; do m7x_bell "${M7X_JAR[$M7X_W]}" "$M7X_LINK" 1 "$M7X_W is reminded (Workshop layer)"; done
for M7X_W in acct acct2 dpm multi; do m7x_bell "${M7X_JAR[$M7X_W]}" "$M7X_LINK" 0 "$M7X_W is not reminded (can't see Workshop)"; done
m7x_run "2035-08-20T21:00:00Z" 1
expect_jq '.sent == 0' "the same window again sends nothing"

echo "--- the audit carries no personal content ---"
for M7X_K in PA PD JP; do
  req GET "/api/audit?entityType=planner_event&entityId=${M7X_ID[$M7X_K]}&limit=50" "$ADMIN"
  expect_status 200 "the audit of $M7X_K"
  expect_jq '(.rows | length) >= 1 and ([.rows[].action] | index("planner.event.create") != null)' "$M7X_K's rows exist"
  expect_jq '[.rows[] | (.after, .before) | select(. != null) | (keys - ["fields","layer","newEventId","scope"])] | all(. == [])' \
    "$M7X_K: before and after hold only layer and fields"
  expect_jq '[.rows[] | (.after, .before) | select(. != null) | .layer] | all(. == "personal")' "$M7X_K: the rows say personal"
  m7x_clean "the audit of $M7X_K"
  case $BODY in
    *'"09:'* | *'"10:'* | *"2035-08"* | *"$M7X_D1"*) fail "$M7X_K's audit carries a time or a date: ${BODY:0:600}" ;;
    *) ok ;;
  esac
done
req GET "/api/audit?entityType=planner_event&entityId=${M7X_ID[PA]}&action=planner.event.occurrence.update&limit=5" "$ADMIN"
expect_jq '(.rows | length) == 1 and (.rows[0].after | has("occurrence") | not)' "the one-off move is audited without its occurrence date"
req GET "/api/audit?entityType=planner_event&limit=500" "$ADMIN"
expect_status 200 "every planner audit row"
m7x_clean "every planner audit row"
req GET "/api/audit?limit=500" "$ADMIN"
expect_status 200 "the newest audit rows of any kind"
m7x_clean "the newest audit rows"
req GET "/api/audit?entityType=planner_event&limit=5" "$ACCT"
expect_status 403 "acct can't read the audit"

echo "--- the container log carries no personal content ---"
# Capture first, then grep (under pipefail an early grep -q exit would SIGPIPE docker logs).
M7X_LOGS=$(docker logs "$CONTAINER" 2>&1)
for M7X_S in "${M7X_SECRETS[@]}"; do
  if grep -qF "$M7X_S" <<<"$M7X_LOGS"; then fail "docker logs contain personal content: $M7X_S"; fi
  ok
done

echo "--- the page ---"
for M7X_W in "${M7X_PLANNERS[@]}"; do
  for M7X_P in /planner.html /planner.css /planner.js; do
    req GET "$M7X_P" "${M7X_JAR[$M7X_W]}"
    expect_status 200 "$M7X_W GET $M7X_P"
  done
done
req GET /planner.css "$ADMIN"
[[ $BODY == *"style-check: print-start"* && $BODY == *"@media print"* ]] || fail "planner.css lacks its print block"
ok
req GET /planner.html "$SHOW"
expect_status 403 "show GET /planner.html"
[[ $BODY == *"No access"* ]] || fail "show /planner.html: not the No access page: ${BODY:0:200}"
ok
req GET /planner.html
expect_status 302 "logged out GET /planner.html"
case $(hdr location) in
  /login.html\?next=*planner.html*) ok ;;
  *) fail "logged out /planner.html: bad Location '$(hdr location)'" ;;
esac

echo "--- Wave 2 D's wiring: menu, home tile, job page ---"
req GET /shell/shell.js "$ADMIN"
expect_status 200 "GET /shell/shell.js"
[[ $BODY == *"/planner.html"* ]] || fail "the menu (shell.js) has no Planner link"
ok
req GET /index.js "$ADMIN"
[[ $BODY == *"/api/planner/events"* ]] || fail "the home page (index.js) does not read the planner"
ok
req GET /job.js "$ADMIN"
[[ $BODY == *"/api/planner/job/"* ]] || fail "the job page (job.js) does not read the planner"
ok
