# Weekend column smoke (0.2.16, migration 060): the board's sixth day cell, key "wknd", after Friday.
# Sourced by ci/smoke.sh after the AMEX suite, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok) and the cookie jars ($ADMIN $SCHED). No shebang
# and no `set`: the caller owns both. It does not assume a pristine database: it makes its own
# worker and board rows in April 2035 (2035-04-02 is a Monday) and checks only those.

# ============================================================================
step "weekend. the board's Weekend column"
# ============================================================================

WE_MON=2035-04-02
WE_NEXT=2035-04-09

req POST /api/workers "$ADMIN" '{"name":"CI Weekend Worker"}'
expect_status 201 "create the weekend worker"
WE_W=$(jqr '.id')
req POST /api/rows "$ADMIN" "{\"weekStart\":\"$WE_MON\",\"panel\":\"installing\",\"jobName\":\"CI Weekend Job\"}"
expect_status 201 "create the weekend board row"
WE_ROW=$(jqr '.rowId')
expect_jq '.cells | has("wknd") and (.wknd == [])' "a new row carries an empty Weekend cell"
expect_jq '.flags.wknd == false' "a new row's Weekend flag is false"

echo "--- assigning ---"
req POST "/api/rows/$WE_ROW/assignments" "$SCHED" "{\"day\":\"wknd\",\"workerId\":$WE_W}"
expect_status 201 "board.edit assigns the worker on the Weekend"
WE_A=$(jqr '.assignmentId')
expect_jq '.day == "wknd"' "the assignment echoes the Weekend key"
req POST "/api/rows/$WE_ROW/assignments" "$ADMIN" "{\"day\":\"wknd\",\"workerId\":$WE_W}"
expect_status 200 "assigning again is idempotent"
expect_eq "$(jqr '.assignmentId')" "$WE_A" "the same assignment comes back"
req POST "/api/rows/$WE_ROW/assignments" "$ADMIN" "{\"day\":\"sat\",\"workerId\":$WE_W}"
expect_status 400 "sat is not a board day"
req POST "/api/rows/$WE_ROW/assignments" "$ADMIN" "{\"day\":\"sun\",\"workerId\":$WE_W}"
expect_status 400 "sun is not a board day"

req GET "/api/schedule?week=$WE_MON" "$ADMIN"
expect_status 200 "GET /api/schedule for the weekend week"
expect_jq "[.weeks[0].installing[] | select(.rowId == $WE_ROW) | .cells.wknd[] | select(.workerId == $WE_W and .away == null and .overDays == false)] | length == 1" "the chip sits in the Weekend cell, not away, not over days"
expect_jq "[.weeks[0].installing[] | select(.rowId == $WE_ROW) | .cells.fri[]] | length == 0" "Friday is untouched"

echo "--- flags ---"
req POST "/api/rows/$WE_ROW/flags" "$SCHED" '{"day":"wknd"}'
expect_status 201 "flag the Weekend on the installing row"
req GET "/api/schedule?week=$WE_MON" "$ADMIN"
expect_jq "[.weeks[0].installing[] | select(.rowId == $WE_ROW) | .flags.wknd][0] == true" "the Weekend flag shows"
req POST "/api/rows/$WE_ROW/flags" "$ADMIN" '{"day":"sat"}'
expect_status 400 "a sat flag is refused"
req DELETE "/api/rows/$WE_ROW/flags/wknd" "$ADMIN"
expect_status 204 "unflag the Weekend"

echo "--- days a week: the Weekend counts as one worked day ---"
req POST "/api/rows/$WE_ROW/assignments" "$ADMIN" "{\"day\":\"mon\",\"workerId\":$WE_W}"
expect_status 201 "assign mon too"
req PATCH "/api/availability/workers/$WE_W" "$ADMIN" '{"daysPerWeek":1}'
expect_status 200 "daysPerWeek 1"
req GET "/api/schedule?week=$WE_MON" "$ADMIN"
expect_jq "[.weeks[0].installing[] | select(.rowId == $WE_ROW) | .cells.wknd[] | select(.workerId == $WE_W) | .overDays][0] == true" "the Weekend is the day beyond one a week"
expect_jq "[.weeks[0].installing[] | select(.rowId == $WE_ROW) | .cells.mon[] | select(.workerId == $WE_W) | .overDays][0] == false" "Monday is within the pattern"
req PATCH "/api/availability/workers/$WE_W" "$ADMIN" '{"regularDaysOff":["wknd"]}'
expect_status 400 "wknd is not a regular day off (days off stay Monday to Friday)"
req PATCH "/api/availability/workers/$WE_W" "$ADMIN" '{"daysPerWeek":null}'
expect_status 200 "clear the pattern"

echo "--- copying a week and removing ---"
req POST "/api/rows/$WE_ROW/duplicate" "$ADMIN" '{}'
expect_status 201 "duplicate the row to next week"
WE_DUP=$(jqr '.rowId')
req GET "/api/schedule?week=$WE_MON" "$ADMIN"
expect_jq "[.weeks[1].installing[] | select(.rowId == $WE_DUP) | .cells.wknd[] | select(.workerId == $WE_W)] | length == 1" "the Weekend chip is copied to next week"
req DELETE "/api/assignments/$WE_A" "$ADMIN"
expect_status 204 "remove the Weekend chip"
req GET "/api/schedule?week=$WE_MON" "$ADMIN"
expect_jq "[.weeks[0].installing[] | select(.rowId == $WE_ROW) | .cells.wknd[]] | length == 0" "the Weekend cell is empty again"

echo "--- migration 060 over a scratch database ---"
# Rows written before 060 are all kept (ids, days, timestamps), the ids are never reused, and the
# rebuilt tables take 'wknd' but still refuse anything else. Runs the real file over the real baseline.
WE_MIG=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const fs = require("fs");
const d = new D(":memory:");
d.pragma("foreign_keys = ON");
d.exec(fs.readFileSync("/app/db/migrations/001_baseline.sql", "utf8"));
d.prepare("INSERT INTO workers (name, hue) VALUES (?, 10)").run("A");
d.prepare("INSERT INTO workers (name, hue) VALUES (?, 20)").run("B");
d.prepare("INSERT INTO jobs (name) VALUES (?)").run("J");
d.prepare("INSERT INTO week_rows (job_id, week_start, panel) VALUES (1, ?, ?)").run("2024-01-01", "installing");
const ins = d.prepare("INSERT INTO assignments (week_row_id, day, worker_id, created_at) VALUES (1, ?, ?, ?)");
ins.run("mon", 1, "2024-01-01 01:00:00");
ins.run("fri", 2, "2024-01-01 02:00:00");
ins.run("fri", 1, "2024-01-01 03:00:00");
d.prepare("DELETE FROM assignments WHERE id = ?").run(3);
d.prepare("INSERT INTO day_flags (week_row_id, day, created_at) VALUES (1, ?, ?)").run("tue", "2024-01-01 04:00:00");
const snap = () => JSON.stringify([d.prepare("SELECT * FROM assignments ORDER BY id").all(), d.prepare("SELECT * FROM day_flags ORDER BY id").all()]);
const before = snap();
require("/app/db/migrations/060_board_weekend.js").up(d);
const after = snap();
const addA = (day) => d.prepare("INSERT INTO assignments (week_row_id, day, worker_id) VALUES (1, ?, 1)").run(day);
const addF = (day) => d.prepare("INSERT INTO day_flags (week_row_id, day) VALUES (1, ?)").run(day);
addA("wknd");
addF("wknd");
const next = d.prepare("SELECT id FROM assignments WHERE day = ?").get("wknd").id;
let refused = 0;
for (const f of [() => addA("sat"), () => addF("sun")]) { try { f(); } catch (e) { refused++; } }
let dupFlag = 0;
try { addF("wknd"); } catch (e) { dupFlag = 1; }
const idx = d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name IN (?, ?)").get("index", "idx_assignments_row", "idx_day_flags_row").n;
console.log([before === after, next, refused, dupFlag, idx].join(" "));
d.close();' | tr -d '\r') || fail "running migration 060 over a scratch database failed"
expect_eq "$WE_MIG" "true 4 2 1 2" "migration 060: every row kept, the id counter carried on (4, not 3), 'wknd' accepted, other days refused, the one-flag-per-day rule and both indexes kept"

# ---------------------------------------------------------------------------
# 0.2.18 follow-ups: leave greys the Weekend chip, End of shift and the Planner at the weekend, the
# pay run's Friday hint. Same April 2035 week (Mon 04-02, Fri 04-06, Sat 04-07, Sun 04-08).
# ---------------------------------------------------------------------------

echo "--- leave greys the Weekend chip ---"
req POST "/api/rows/$WE_ROW/assignments" "$ADMIN" "{\"day\":\"wknd\",\"workerId\":$WE_W}"
expect_status 201 "book the worker on the Weekend again"
WE_A2=$(jqr '.assignmentId')

# we_leave FROM TO KIND: books leave for the worker; sets WE_L (the leave id).
we_leave() {
  req POST /api/availability/leave "$ADMIN" "{\"workerId\":$WE_W,\"from\":\"$1\",\"to\":\"$2\",\"kind\":\"$3\",\"note\":\"CI weekend leave\"}"
  expect_status 201 "leave $1 to $2 ($3)"
  WE_L=$(jqr '.id')
}
# we_unleave ID...: removes the leave.
we_unleave() {
  local id
  for id in "$@"; do
    req DELETE "/api/availability/leave/$id" "$ADMIN"
    expect_status 204 "remove leave $id"
  done
}
# we_away DAY [WEEK]: sets WE_CHIP (the day chip's .away on the row, week one only) and WE_WK
# (week.away for the worker on that day) from GET /api/schedule?week=WEEK.
we_away() {
  local week=${2:-$WE_MON}
  req GET "/api/schedule?week=$week" "$ADMIN"
  expect_status 200 "GET /api/schedule for $week"
  WE_CHIP=$(jqr "[.weeks[0].installing[] | select(.rowId == $WE_ROW) | .cells.$1[] | select(.workerId == $WE_W) | .away][0]")
  WE_WK=$(jqr ".weeks[0].away[\"$WE_W\"].$1")
}

we_away wknd
expect_eq "$WE_CHIP,$WE_WK" "null,null" "no leave: the Weekend chip is not away"

we_leave 2035-04-07 2035-04-07 leave; WE_L1=$WE_L
we_away wknd
expect_eq "$WE_CHIP,$WE_WK" "leave,leave" "Saturday-only leave greys the Weekend chip"
we_away fri
expect_eq "$WE_WK" "null" "Saturday-only leave leaves Friday alone"
req GET "/api/availability?from=2035-04-07&to=2035-04-07&workerId=$WE_W" "$ADMIN"
expect_status 200 "list the Saturday-only leave"
expect_jq "[.leave[] | select(.id == $WE_L1)] | length == 1 and .[0].days == 0" "a Saturday-only leave lists with days 0"
we_unleave "$WE_L1"

we_leave 2035-04-08 2035-04-08 leave; WE_L1=$WE_L
we_away wknd
expect_eq "$WE_CHIP,$WE_WK" "leave,leave" "Sunday-only leave greys the Weekend chip"
we_unleave "$WE_L1"

we_leave 2035-04-06 2035-04-06 leave; WE_L1=$WE_L
we_away wknd
expect_eq "$WE_CHIP,$WE_WK" "null,null" "Friday-only leave does not touch the Weekend chip"
we_away fri
expect_eq "$WE_WK" "leave" "Friday-only leave is Friday's"
we_unleave "$WE_L1"

we_leave 2035-04-02 2035-04-06 leave; WE_L1=$WE_L
we_away wknd
expect_eq "$WE_CHIP,$WE_WK" "null,null" "Monday to Friday leave does not touch the Weekend chip"
we_unleave "$WE_L1"

we_leave 2035-04-06 2035-04-09 leave; WE_L1=$WE_L
we_away wknd
expect_eq "$WE_CHIP,$WE_WK" "leave,leave" "Friday to Monday leave greys the Weekend chip"
we_away fri
expect_eq "$WE_WK" "leave" "Friday to Monday leave covers Friday"
we_away mon "$WE_NEXT"
expect_eq "$WE_WK" "leave" "Friday to Monday leave covers the next Monday"
we_unleave "$WE_L1"

we_leave 2035-04-07 2035-04-07 sick; WE_L1=$WE_L
we_leave 2035-04-08 2035-04-08 leave; WE_L2=$WE_L
we_away wknd
expect_eq "$WE_CHIP,$WE_WK" "sick,sick" "sick on Saturday plus leave on Sunday: Saturday's kind wins"
we_unleave "$WE_L1" "$WE_L2"

req PATCH "/api/availability/workers/$WE_W" "$ADMIN" '{"regularDaysOff":["wknd"]}'
expect_status 400 "wknd is still not a regular day off"
we_away wknd
expect_eq "$WE_CHIP,$WE_WK" "null,null" "every leave removed: the Weekend chip is no longer away"
req GET /availability.js "$ADMIN"
expect_status 200 "GET /availability.js"
case $BODY in *"Leave over a Saturday or Sunday greys that person's Weekend chips on the board."*) ok ;; *) fail "availability.js lacks the weekend leave hint" ;; esac

echo "--- End of shift at the weekend, no reminder; pay run Friday hint (clock-free) ---"
# A workshop login linked to the worker (an end-of-shift holder, as smoke-m25-shift.sh does it).
WE_TAG="weshift$(date +%s)"
create_user "$WE_TAG" "CI Weekend Shift" "Tmp-Weekend-Passw0rd-1" workshop
WE_U=$CREATED_ID
req PUT "/api/users/$WE_U/worker" "$ADMIN" "{\"workerId\":$WE_W}"
expect_status 200 "link the login to the weekend worker"

# One node run over an in-memory copy of the live database, at fixed instants (April 2035 is AEST,
# +10): Saturday 12:00 Sydney, Sunday 12:00, Friday 12:00, and Saturday 16:30 for the reminder.
# The libs take db first and do not need ../db here. Prints one space-separated line.
WE_SHIFT=$(docker exec "$CONTAINER" node -e '
const D = require("better-sqlite3");
const fs = require("fs");
const tmp = "/tmp/ci-weekend-" + process.pid + ".db";
fs.mkdirSync(require("path").dirname(tmp), { recursive: true });
const db = new D("/data/db/photos.db", { readonly: true });
db.prepare("VACUUM INTO ?").run(tmp);
db.close();
const copy = new D(tmp);
const shift = require("/app/lib/shift.js");
const mywork = require("/app/lib/mywork.js");
const time = require("/app/lib/time.js");
const payroll = require("/app/lib/payroll.js");
const settings = require("/app/lib/settings.js");
const uid = Number(process.argv[1]), wid = Number(process.argv[2]);
const req = { user: { id: uid, perms: ["shift.report"] } };
const fri = new Date("2035-04-06T02:00:00Z"), sat = new Date("2035-04-07T02:00:00Z"), sun = new Date("2035-04-08T02:00:00Z");
const sat1630 = new Date("2035-04-07T06:30:00Z");
const weekendJob = (now) => shift.today(copy, req, [], now).jobs.filter((x) => x.name === "CI Weekend Job");
const card = (now) => {
  const t = shift.today(copy, req, [], now);
  const j = t.jobs.filter((x) => x.name === "CI Weekend Job");
  return j.length === 1 ? j[0].panels.join(",") + ":" + t.installDay : "none";
};
const out = [];
out.push(card(sat), card(sun), card(fri));
out.push(shift.photoTag(copy, req, weekendJob(sat)[0].id, sat));
out.push(shift.dueToRemind(copy, sat).length, shift.dueToRemind(copy, sun).length);
settings.set(copy, "shift.reminder_time", "16:00", null, { audit: false });
settings.set(copy, "shift.reminder_last_run", null, null, { audit: false });
out.push(shift.runReminder(copy, { now: sat1630 }).sent);
out.push(settings.get(copy, "shift.reminder_last_run") !== "2035-04-07");
const lines = (now) => mywork.linesFor(copy, req, now).items.filter((i) => i.key === "shiftReport").length;
out.push(lines(sat), lines(sun));
const sug = payroll.suggestionsFor(copy, { start_date: "2035-04-02" }, { workerId: wid });
const friSug = sug["2035-04-06"];
const weekendHas = typeof friSug.weekend === "string" && friSug.weekend.includes("CI Weekend Job");
const noSat = !Object.prototype.hasOwnProperty.call(sug, "2035-04-07");
const friJobEmpty = friSug.job === "";
// Control: the same worker on Friday too (in the copy only): weekdays still remind.
const rowId = copy.prepare("SELECT wr.id FROM week_rows wr JOIN jobs j ON j.id = wr.job_id WHERE j.name = ? AND wr.week_start = ? AND wr.panel = ?").get("CI Weekend Job", "2035-04-02", "installing").id;
copy.prepare("INSERT INTO assignments (week_row_id, day, worker_id) VALUES (?, ?, ?)").run(rowId, "fri", wid);
out.push(shift.dueToRemind(copy, fri).includes(uid));
out.push([6, 7, 1, 2, 3, 4, 5].map((n) => time.boardDayKey(n)).join(","));
out.push(weekendHas, noSat, friJobEmpty);
console.log(out.join(" "));
copy.close();
for (const f of [tmp, tmp + "-wal", tmp + "-shm"]) { try { fs.unlinkSync(f); } catch (e) {} }' "$WE_U" "$WE_W" | tr -d '\r') || fail "the weekend shift and pay run script failed"
expect_eq "$WE_SHIFT" "installing:true installing:true none install 0 0 0 true 0 0 true wknd,wknd,mon,tue,wed,thu,fri true true true" "weekend: the job is listed Saturday and Sunday (not Friday), photos tag install, no reminder or My work line, weekdays still remind, boardDayKey, and the pay run Friday hint lists the weekend job with no Saturday key and no Friday job"
req GET /payrun.js "$ADMIN"
expect_status 200 "GET /payrun.js"
case $BODY in *"Weekend on the board"*) ok ;; *) fail "payrun.js lacks the weekend hint" ;; esac

echo "--- the Planner shows both weekend days ---"
req GET "/api/planner/events?from=2035-04-02&to=2035-04-15" "$ADMIN"
expect_status 200 "GET /api/planner/events over the weekend week"
expect_jq "[.weeks[] | select(.weekStart == \"$WE_MON\") | .installing[] | select(.name == \"CI Weekend Job\") | .days] | length == 1 and (.[0] | index(\"2035-04-07\") != null and index(\"2035-04-08\") != null)" "the installing entry carries Saturday and Sunday"
req GET "/api/planner/events?from=2035-04-08&to=2035-04-08" "$ADMIN"
expect_status 200 "GET /api/planner/events for the Sunday alone"
expect_jq "[.weeks[] | select(.weekStart == \"$WE_MON\") | .installing[] | select(.name == \"CI Weekend Job\") | .days] == [[\"2035-04-08\"]]" "a Sunday-only range gives just Sunday"

echo "--- tidy the weekend follow-ups ---"
req PUT "/api/users/$WE_U/worker" "$ADMIN" '{"workerId":null}'
expect_status 200 "unlink the weekend login"
req PATCH "/api/users/$WE_U" "$ADMIN" '{"disabled":true}'
expect_status 200 "disable the weekend login"
req DELETE "/api/assignments/$WE_A2" "$ADMIN"
expect_status 204 "remove the Weekend booking"

echo "--- the page ---"
req GET /schedule.js "$ADMIN"
expect_status 200 "GET /schedule.js"
req DELETE "/api/rows/$WE_DUP" "$ADMIN"
expect_status 204 "tidy the copy"
req DELETE "/api/rows/$WE_ROW" "$ADMIN"
expect_status 204 "tidy the row"
