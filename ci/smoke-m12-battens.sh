# M12 smoke, Wave 1 C: the batten calculator (/battens.html and the shared maths in battens.js).
# Sourced by ci/smoke.sh after the M11 suites, so it shares that script's helpers (step, req,
# expect_status, expect_jq, expect_eq, jqr, fail, ok), the cookie jars ($DPM $ORDR $ACCT $SCHED)
# and $CONTAINER. No shebang and no `set`: the caller owns both. It stores nothing and assumes
# nothing about the database. Contract: docs/plans/m12-contracts.md sections 6, 9.5 and 10.3.

# ============================================================================
step "m12. batten calculator"
# ============================================================================

# --- access: design.view (admin, Projects, Ordering); the maths file is served to the page
req GET /battens.html "$DPM"
expect_status 200 "dpm GET /battens.html"
req GET /battens.html "$ORDR"
expect_status 200 "ordr GET /battens.html"
req GET /battens.html "$ACCT"
expect_status 403 "acct GET /battens.html"
req GET /battens.html "$SCHED"
expect_status 403 "sched GET /battens.html"
# --- 2026-10-18: the Tools page (design.view, same as battens) and the menu entries in shell.js
req GET /tools.html "$DPM"
expect_status 200 "dpm GET /tools.html"
case $BODY in *"/battens.html"*) ok ;; *) fail "GET /tools.html: no link to the batten calculator" ;; esac
req GET /tools.html "$ORDR"
expect_status 200 "ordr GET /tools.html"
req GET /tools.html "$ACCT"
expect_status 403 "acct GET /tools.html"
req GET /tools.html "$SCHED"
expect_status 403 "sched GET /tools.html"
req GET /battens.html "$DPM"
case $BODY in *'href="/tools.html"'*) ok ;; *) fail "GET /battens.html: no Back to Tools link" ;; esac
# The menu: Pipeline is in the Scheduling list (jobs.view, which Scheduling holds) as well as
# Projects; the Projects list has Tools, not the Batten calculator.
req GET /shell/shell.js "$SCHED"
expect_status 200 "sched GET /shell/shell.js"
M12_SHELL=$BODY
M12_SCHED_LIST=${M12_SHELL#*'id: "scheduling"'}
M12_SCHED_LIST=${M12_SCHED_LIST%%'id: "design"'*}
case $M12_SCHED_LIST in *'"/pipeline.html", key: "jobs.view"'*) ok ;; *) fail "shell.js: no Pipeline item in the Scheduling menu" ;; esac
case $M12_SHELL in *'label: "Tools", href: "/tools.html", key: "design.view"'*) ok ;; *) fail "shell.js: no Tools item in the Projects menu" ;; esac
case $M12_SHELL in *'label: "Batten calculator"'*) fail "shell.js: the Batten calculator is still a menu item" ;; *) ok ;; esac
case $M12_SHELL in *'"/battens.html": "/tools.html"'*) ok ;; *) fail "shell.js: battens.html does not light up Tools" ;; esac
# A scheduling login reads the pipeline but cannot move anything (smoke-m3-pipeline.sh has the
# POST /api/job-records/:id/stage 403 for sched); the page itself is 200.
req GET /pipeline.html "$SCHED"
expect_status 200 "sched GET /pipeline.html"
req GET /battens.js "$DPM"
expect_status 200 "dpm GET /battens.js"
case $BODY in *"Battens"*"solve"*) ok ;; *) fail "GET /battens.js: not the batten maths: ${BODY:0:200}" ;; esac

# --- the maths in the image: one node run of the section 10.3 cases (with the 4.3 additions);
# anything but "ok" fails
M12_B_OUT=$(docker exec "$CONTAINER" node -e '
const B = require("/app/public/battens.js");
const bad = [];
const check = (what, cond) => { if (!cond) bad.push(what); };
const same = (r, s) => r && r.ok === false && r.error === s;
const Q = String.fromCharCode(39); // an apostrophe, which the shell quoting cannot hold
let r;

// the workbook check, both ways
r = B.solve({ space: 1768, width: 25, count: 22 });
check("workbook from 22 battens: " + JSON.stringify(r && r.ok ? { gap: r.gap, total: r.total, leftOver: r.leftOver, s2: r.setOut[1], s22: r.setOut[21] } : r),
  r.ok && r.gap === 58 && r.total === 1768 && r.leftOver === 0 && r.setOut.length === 22 &&
  r.setOut[1].start === 83 && r.setOut[21].start === 1743 && r.setOut[21].end === 1768);
r = B.solve({ space: 1768, width: 25, gap: 58 });
check("workbook from a 58 mm gap: " + JSON.stringify(r.ok ? r.count : r), r.ok && r.count === 22);

// rounded down, with the left-over
r = B.solve({ space: 1770, count: 22 });
check("1770 mm, 22 battens: " + JSON.stringify(r.ok ? { gap: r.gap, total: r.total, leftOver: r.leftOver, exactGap: r.exactGap } : r),
  r.ok && r.gap === 58 && r.total === 1768 && r.leftOver === 2 && r.exactGap === 58.1);

// gap ends
r = B.solve({ space: 1000, width: 50, ends: "gap", count: 9 });
check("gap ends, 9 battens of 50 in 1000: " + JSON.stringify(r.ok ? { gaps: r.gaps, gap: r.gap, s1: r.setOut[0] } : r),
  r.ok && r.gaps === 10 && r.gap === 55 && r.setOut[0].start === 55);

// each refusal, with its sentence
check("space refused", same(B.solve({ space: 0, count: 3 }), "The space to fill must be from 1 to 20000 mm, in 0.5 mm steps"));
check("space in 0.5 mm steps", same(B.solve({ space: 1768.2, count: 3 }), "The space to fill must be from 1 to 20000 mm, in 0.5 mm steps"));
check("width refused", same(B.solve({ space: 1768, width: 0, count: 3 }), "The batten width must be from 1 to 1000 mm, in 0.5 mm steps"));
check("gap refused", same(B.solve({ space: 1768, gap: 0.2 }), "The gap must be from 0.5 to 10000 mm, in 0.5 mm steps"));
check("count refused", same(B.solve({ space: 1768, count: 1001 }), "The number of battens must be a whole number from 2 to 1000"));
check("neither count nor gap", same(B.solve({ space: 1768 }), "Give the number of battens or the gap you" + Q + "d like"));
check("both count and gap", same(B.solve({ space: 1768, count: 22, gap: 58 }), "Give the number of battens or the gap you" + Q + "d like"));
check("batten ends, 1 batten", same(B.solve({ space: 1768, count: 1 }), "Starting and ending on a batten needs at least 2 battens"));
check("no gap left", same(B.solve({ space: 1768, width: 25, count: 70 }), "70 battens of 25 mm don" + Q + "t leave a gap in 1768 mm"));
check("gap does not fit", same(B.solve({ space: 30, width: 25, gap: 10 }), "Battens of 25 mm with a 10 mm gap don" + Q + "t fit in 30 mm"));
// added at 4.3 (C-m5): the ends, more than 1000 battens from a gap, and one batten (singular)
check("ends refused", same(B.solve({ space: 1768, ends: "middle", count: 3 }), "The ends must be a batten at each end or a gap at each end"));
check("gap ends count refused", same(B.solve({ space: 1768, ends: "gap", count: 0 }), "The number of battens must be a whole number from 1 to 1000"));
check("more than 1000 from a gap", same(B.solve({ space: 20000, width: 1, gap: 0.5 }), "Battens of 1 mm with a 0.5 mm gap would take more than 1000 battens in 20000 mm"));
check("one batten, no gap left", same(B.solve({ space: 25.5, width: 25, ends: "gap", count: 1 }), "1 batten of 25 mm doesn" + Q + "t leave a gap in 25.5 mm"));

// a tie takes more battens
r = B.solve({ space: 100, width: 10, gap: 27.5 });
check("tie: " + JSON.stringify(r.ok ? r.count : r), r.ok && r.count === 4);

process.stdout.write(bad.length ? "failed: " + bad.join("; ") : "ok");
' 2>&1) || true
expect_eq "$M12_B_OUT" "ok" "the batten maths in the image"
