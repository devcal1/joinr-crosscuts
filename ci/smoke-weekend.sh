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

echo "--- the page ---"
req GET /schedule.js "$ADMIN"
expect_status 200 "GET /schedule.js"
req DELETE "/api/rows/$WE_DUP" "$ADMIN"
expect_status 204 "tidy the copy"
req DELETE "/api/rows/$WE_ROW" "$ADMIN"
expect_status 204 "tidy the row"
