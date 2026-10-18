# Loading cursor smoke (Todd 2026-10-18, CLAUDE.md seventh named exception): the Joinr dot pointer
# while a page loads or a link is followed. Sourced by ci/smoke.sh with the M19 suites, so it shares
# that script's helpers (step, req, expect_status, fail, ok), the cookie jar $ADMIN and $HDR_FILE.
# No shebang and no `set`: the caller owns both. It reads static files only and changes nothing.
# The behaviour itself (click, load phase, actions in progress, bfcache, background fetches, reduced motion) is checked
# in a real browser by hand; this suite proves the pieces are served.

# ============================================================================
step "m19-busycursor. the dot cursor images, busy.js and the cc-busy rule are served"
# ============================================================================

for M19B_N in 1 2 3 4; do
  req GET "/shell/cursor-dot-$M19B_N.svg"
  expect_status 200 "logged out GET /shell/cursor-dot-$M19B_N.svg"
  grep -qi '^content-type: *image/svg+xml' "$HDR_FILE" || fail "cursor-dot-$M19B_N.svg is not image/svg+xml"
  ok
  printf '%s' "$BODY" | grep -q 'width="32" height="32"' || fail "cursor-dot-$M19B_N.svg has no explicit 32x32 size"
  ok
  printf '%s' "$BODY" | grep -q "id=\"joinr-dot-spectrum-$M19B_N\"" || fail "cursor-dot-$M19B_N.svg has no unique gradient id"
  ok
done

req GET /shell/busy.js
expect_status 200 "logged out GET /shell/busy.js"
printf '%s' "$BODY" | grep -q 'window.ccBusy' || fail "busy.js does not define window.ccBusy"
ok
# The "action in progress" reason (2026-10-18): fetches and XHR uploads that follow a user gesture.
printf '%s' "$BODY" | grep -q 'ACT_DELAY_MS' || fail "busy.js has no delay before an action shows the dot"
ok
printf '%s' "$BODY" | grep -q 'XMLHttpRequest.prototype.send' || fail "busy.js does not count XMLHttpRequest uploads"
ok
printf '%s' "$BODY" | grep -q 'ccBackground' || fail "busy.js has no ccBackground opt-out"
ok

req GET /shell/shell.css "$ADMIN"
expect_status 200 "GET /shell/shell.css"
printf '%s' "$BODY" | grep -q 'html.cc-busy' || fail "shell.css has no html.cc-busy cursor rule"
ok
for M19B_N in 1 2 3 4; do
  printf '%s' "$BODY" | grep -q "cursor-dot-$M19B_N.svg" || fail "shell.css does not use cursor-dot-$M19B_N.svg"
  ok
done
printf '%s' "$BODY" | grep -q 'progress !important' || fail "the cc-busy rule has no progress fallback"
ok

# Every kind of page loads busy.js: the sign-in page (public, no cookie), the menu-bar pages, the
# board and photo search (which have no bar). setup.html answers 404 once the first admin exists.
req GET /login.html
expect_status 200 "logged out GET /login.html"
printf '%s' "$BODY" | grep -q '/shell/busy.js' || fail "login.html does not load /shell/busy.js"
ok
for M19B_P in /search.html /schedule.html /workers.html /jobs.html /orders.html "/notes.html?dept=admin"; do
  req GET "$M19B_P" "$ADMIN"
  expect_status 200 "admin GET $M19B_P"
  printf '%s' "$BODY" | grep -q '/shell/busy.js' || fail "$M19B_P does not load /shell/busy.js"
  ok
done
