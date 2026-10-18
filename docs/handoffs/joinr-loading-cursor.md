# Brief for the Joinr (tenon-quotr) session: the Joinr dot loading cursor

Written 18 October 2026 by the Crosscuts session, for a Claude Code session working in
`tenon-quotr`. Todd asked for Joinr to get the same loading cursor Crosscuts has just gained. This
file is a brief only. The Crosscuts session made no change in tenon-quotr, and this work is yours
to plan, build and release under tenon-quotr's own rules (its `CLAUDE.md`, `docs/runbooks.md` R1,
and Todd's go before any push or merge).

## What Todd wants

While something is loading, the mouse pointer becomes **the Joinr dot**, gently pulsing, so
people can see the app is working. "Loading" means:

1. **Moving between pages.** From the moment a link is clicked until the next page has its data.
2. **An action the user started that takes a moment.** A save, a move, an upload, or a load the
   user asked for (a refresh button, an "older" button, a dialog that fetches). Show it only if
   the action is still running after about 300 ms, so quick saves don't flicker.

It must never show for background work the user didn't start: polling, timers, live refresh or
revalidation.

Todd's words (18 October 2026): "When the user is navigating between pages and something is
loading, or when they click on a link and are waiting for loading, change the mouse cursor to the
joinr dot icon to represent 'loading'." He then chose:

- **A gently pulsing dot.** Browsers can't animate a cursor, so it swaps a few sizes. People who
  ask for reduced motion get one still frame.
- **Saves and other user-started actions too,** not only page loads.

## The asset

Use `docs/brand/logos/joinr-mark.svg`, the square mark that `docs/brand/README.md` names **the
Joinr dot**: the spectrum circle on the ink rounded tile. Keep the design unaltered. The brand
rules apply as written: the dot is never `currentColor`.

Crosscuts made four cursor frames from it. They are 32×32 SVGs with explicit `width` and `height`
(Chromium ignores an SVG cursor without them). Each draws the mark at 24, 26, 28 or 30 px,
centred, with the hotspot at 16 16. Each frame has its own gradient id. They are a good starting
point. Their source is in the Crosscuts repo:

- `crosscuts/app/public/shell/cursor-dot-1.svg` to `cursor-dot-4.svg`

The pulse steps through the frames 1, 2, 3, 4, 3, 2 every 110 ms. Frame 3 (28 px) is the still
frame. On a light background the ink tile shows clearly; on ink it blends in, and the circle
carries it.

## How Crosscuts did it, for reference only

Crosscuts is plain multi-page HTML, so its approach does not carry straight over to Joinr's
Next.js App Router (`next` ^16). The shape is still useful.

- **CSS.** A class on `<html>` sets the cursor on everything, with `progress` as the fallback:
  - `html.cc-busy, html.cc-busy *, ::before, ::after { cursor: url(frame.svg) 16 16, progress !important; }`
  - Frame classes `cc-f1` to `cc-f4` choose the image (`crosscuts/app/public/shell/shell.css`, around line 520).
- **Script.** `crosscuts/app/public/shell/busy.js` (about 200 lines) only toggles those classes. Busy has two reasons:
  - **nav:** a same-tab link to one of the app's own pages, a navigating form submit, or `beforeunload`. It skips new-tab and modifier clicks, `#` anchors, `javascript:`, `download` and `target` links, and clicks or submits that page code cancelled.
  - **load:** the new page, from first parse until the DOM is ready and no request the page started is in flight, held for a quiet 250 ms.
- **Stop conditions.** It clears on bfcache `pageshow`, when a leave-guard keeps the user on the page, and after a 20 s safety timeout, so it can never stick.
- **Request counting.** A wrapper on `window.fetch` counts requests in flight. A request can opt out with `{ ccBackground: true }`.
- **Coming in Crosscuts 0.1.22.** Being added now: after the load phase, a request counts if it starts within about 1 s of a user gesture (pointerdown, click, Enter or Space, submit, change), including `XMLHttpRequest` uploads. It shows after 300 ms and clears when every such request is done.
- **Tests.** A headless-browser check (CDP) covers every case above, including reduced motion and the safety timeout. A smoke check confirms the assets are served.

## What will be different in Joinr (for you to design)

- **Navigation is client-side.** There's no page unload between App Router pages, so the nav and
  load signals come from the router. Look at:
  - pending state on `next/link`, for example `useLinkStatus` in recent Next;
  - transitions (`useTransition`) and `loading.tsx` / Suspense boundaries;
  - full-page loads for hard navigations and server redirects.
  Pick what Joinr's current Next version supports. Don't hand-roll router internals.
- **Server actions and forms.** Most saves are server actions and plain forms that work with
  scripting off ("server-first, zero JavaScript by default"). Use `useFormStatus` or transition
  pending state where a client island exists. A plain form with no JavaScript still gets the
  browser's own loading behaviour; adding the dot there needs a little client script. Decide
  whether that fits Joinr's zero-JS rule, or keep the dot to where JavaScript already runs, and
  ask Todd if it conflicts.
- **Background work.** Find every client poll and live refresh (dashboards, the Messages desk's
  instant updates, notifications, chart refresh) and make sure none can set the cursor.
- **Which apps.** The portal (app.joinr.com.au) at least. Ask Todd about the admin console and the
  public website (the website probably shouldn't get it).
- **House style.** Joinr's own style rules (in its `CLAUDE.md` and the brand README) may treat a
  cursor image as an icon. Record Todd's approval there as Joinr's rules require. Crosscuts
  recorded it as its seventh named exception.
- **Tests.** Joinr's Playwright smoke and its unit suites. Prove that the dot appears while
  navigating and during a slow action after a click, and never for a background poll. Prove that
  reduced motion gives no timer, the safety timeout clears it, and the assets are served. CSP: if
  Joinr sets `img-src` or `default-src`, confirm the cursor images load.

## Release

Follow tenon-quotr's runbook R1: branch, CI green, Todd's go, merge, which is the production
deploy. No migration is expected. Crosscuts is unaffected either way: the two apps share no code
for this.
