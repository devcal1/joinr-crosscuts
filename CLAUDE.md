# CLAUDE.md: Crosscuts engineering rules

Read this before changing anything in this repo. The binding interface details are in `docs/plans/m1-contracts.md`, the reasoning is in `docs/plans/m1-plan.md`, and the product brief is `docs/crosscuts-brief.md`. Where this file and the brief disagree, the brief wins. If a contract looks wrong, report it instead of working around it.

**Start every session by reading `docs/plans/STATUS.md`** (where things stand and the next action), and work in the stages and clear points of `docs/plans/roadmap.md`.

## What Crosscuts is

Crosscuts (called Joinr Crosscuts in Umbrel) is the successor to the TH Cabinets Umbrel app. It runs on Todd's Umbrel home server, on the workshop LAN and over Tailscale. It serves the schedule board that runs on the workshop TV, the photo library, and (in later milestones) jobs, accounts, design and scheduling pages.

M1 adds personal logins, roles, user admin, jobs and an audit log. The board stays unchanged behind login.

Crosscuts runs alongside the old app until cutover. The old app is the schedule of record until then. Crosscuts starts empty for M1 testing; live data is copied in only at cutover.

## Layout

- This repo holds the code and the image build only. The Umbrel packaging lives in a second repo, `devcal1/tenon-umbrel-store` (store id `tenon`), in the folder `tenon-joinr-crosscuts/`: the manifest (`umbrel-app.yml`, app id `tenon-joinr-crosscuts`, port 4933), the compose file, the icon and the `data/` skeleton. The compose file pins the image by tag and digest. That app id is permanent.
- `crosscuts/app/`: the Docker build context. The `version` in `crosscuts/app/package.json` is the single source of truth for the release version and the image tag.
  - `db/`: `index.js`, `migrate.js` and `migrations/`.
  - `lib/`: shared modules (auth, permissions, pages, routes, audit, config, password, time).
  - `routes/`: one router per API area.
  - `public/`: HTML, CSS and JS. `public/shell/` holds the shared shell.
  - `server.js`.
- `tools/dev-sqlite-shim.js`: local dev only. Outside the Docker context.
- `ci/smoke.sh`: the smoke test script. `.github/workflows/publish.yml` runs it against the built image.
- `docs/`: the brief, plans, and the how-to and reference docs.

## Non-negotiables

1. **Bump `version`** in `crosscuts/app/package.json` on every change under `crosscuts/app/`. It is the image tag, and version tags are immutable: CI fails a push that changes app code without a bump, and the merge job fails if the tag already exists. Keep the root version in `package-lock.json` in step.
2. **Code ships as the published image** `ghcr.io/devcal1/crosscuts-web`. The compose file in tenon-umbrel-store points at it by tag and digest (`<version>@sha256:...`), never `latest`.
3. **Never rename `photos.db`.** It holds the live schedule.
4. **Data lives at `/data/db`, `/data/uploads` and `/data/config` inside the container.** Never mount anything at `/app/db`, because that is source code. The host layout (`data/db`, `data/uploads`, `data/config`) matches the old app, so cutover is a file copy.
5. **Schema changes are new numbered migrations only** (`NNN_name.sql` or `.js`). Keep them additive unless Todd signs off. Never edit an applied migration: a checksum mismatch stops boot. Before pending migrations run on an existing database, the runner writes a `VACUUM INTO` backup to `data/db/backups/`.
6. **Every `/api` route is declared through `defineRoutes` with an access value** (a feature key, an array of keys, `'login'` or `'public'`). The server refuses to boot if any `/api` route lacks one.
7. **The board layout is not redesigned.** In `schedule.html`, `schedule.css`, `schedule.js` and `workers.html`, only colours, type, buttons and shadows may change (house-style re-theme, approved by Todd 2026-10-10); structure, sizes, behaviour and layout stay as they are. Any visual change on the board must be mirrored in `exportJpg()`, and the print styles stay black on white. `alignPanels()` is shared by `renderWeeks` and `exportJpg`, and stays shared. `.nav` and `--nav-h` are untouched, except as the menu-bar exception below allows. **Menu-bar exception (approved by Todd 2026-10-13):** the board and `workers.html` carry the shared menu bar (`#cc-shell`) like every other page. On the board it replaces the old brand and Schedule/Workers links; `.nav` stays as the strip of week buttons, PDF and JPG, sticky just under the menu bar (`--shell-h`), and `--nav-h` now measures both. The menu bar, foot rule and dialogs are hidden in print; `exportJpg()` never drew the bar, so nothing to mirror. The pages without the menu bar are login, setup and photo search (`search.html`), by Todd's choice. **M5 exception (approved by Todd 2026-10-11), exactly these and no others:** a materials mark and a short production-stage label on each row's existing icon line; a grey "away" chip style for people on leave (and an over-days outline); a "Stage reached" select in the Finish week dialog; a leave/over-days warning in the "+" picker; and a 5-minute data reload when nothing is open. Each is mirrored in `exportJpg()` and print; rows, columns and sizes stay as they are (`docs/plans/m5-plan.md`).
8. **Shell CSS classes are prefixed `cc-`**, so they cannot collide with the board's global styles.
9. **Never push anything (any repo, docs included) without Todd's express permission for that push.** Commit locally. A push to joinr-crosscuts starts CI and publishes; a push to tenon-umbrel-store changes what Todd's Umbrel offers.
10. **The old app is frozen** (`thcabinets-umbrel-store` and `thcabinets-splash`) until cutover. Do not change its code, manifest, image or data, and do not uninstall it.
11. **Umbrel proxy login stays off.** `PROXY_AUTH_ADD: "false"` is set in the compose file in tenon-umbrel-store (with no whitelist), and umbrelOS's per-app "Require Umbrel login" toggle must stay off. Crosscuts does its own login.
12. **Hands off Joinr (Todd, 2026-10-13).** Joinr's code base is the GitHub repo https://github.com/devcal1/tenon-quotr (local checkout `C:\Users\todd\Desktop\Claude\code\tenon-quotr`, and its worktrees). It may be **read** and searched. Nothing in it may be **added or edited**: no code or doc changes, branches, commits, pushes, merges, migrations or deploys, and no subagent sent to change it. The only exception: warn Todd first with the exact words **THIS WILL TOUCH JOINR**, say what would be changed, and get his yes **twice**.

Pause and ask Todd before anything that touches stored data (migrations that delete rows, restores, cutover steps).

## Look and feel

New UI follows the company house style: the TH Cabinets Brand & Document Style Guide v1.0, the look of the joinr desktop wallpaper. When in doubt, the reference implementation is the Offcuts app (`C:\Users\todd\Desktop\Claude\code\joinr-offcuts`): its tokens are at the top of `src/styles.css`, and its rules are under "Look and feel — binding" in its `CLAUDE.md`.

- **Ground and text:** ink `#101019` ground; surface `#191A24`; raised `#262735`; hairline `#24252F`. Text is white, body `#D3D4DC`, labels `#9A9BA8`, muted `#6F7080`.
- **Colour roles:**
  - Teal `#17C8A0` is the only working accent (tint `#6EE7C9` for small text).
  - Orange `#F97316` means "attend to this".
  - Red `#EF4444` is only for overdue and destructive actions.
  - Violet `#8B5CF6` to fuchsia `#D946EF` is the gradient for numbered discs.
  - The four-colour spectrum (teal, violet, fuchsia, orange) appears only as thin rules.
- **Type and components:** Arial or Helvetica, bold and regular only, with uppercase always letterspaced. No icons, emoji or shadows. Buttons are outlined uppercase text. (The browser's own clock and calendar glyphs on time and date inputs are the browser's controls, not icons, and are allowed: Todd, 2026-10-16.)
- **Shell CSS:** uses these through `cc-` prefixed custom properties (non-negotiable 8). The re-theme of the whole app is M1.2 (`docs/plans/style-plan.md`).
- **Seven named exceptions, approved by Todd (the first two on 2026-10-10, the third on 2026-10-11, the fourth on 2026-10-12, the fifth and sixth on 2026-10-16, the seventh on 2026-10-18). There are no others.**
  - **Worker colours:** each worker keeps their own colour (the `hue` per worker, computed in `lib/schedule.js` and `public/shared.js`), wherever workers appear.
  - **Board icons:** the board keeps its small Phosphor icon buttons (`schedule.html`, `schedule.js`). The menu bar and every other page use text labels.
  - **Planner layer markers (approved by Todd 2026-10-11):** on the Planner page only (`planner.html`, `planner.css`, `planner.js`), each layer's events carry a small marker (a 3 px left edge on chips and bars, a 6 px dot in compact cells) in its layer colour: teal, violet, fuchsia, orange, two greys, and a hollow outline for Personal, from the `--layer-*` tokens. Event text stays white or body on the surface. Print shows the layer name in words, black on white.
  - **Menu department rules (approved by Todd 2026-10-12):** in the shell menu bar only (`public/shell/shell.css`), the Scheduling, Projects (was Design/PM), Ordering and Accounts department menus carry a thin 2 px rule in their Planner layer colour (`--layer-scheduling` fuchsia, `--layer-design` violet, `--layer-install` orange for Ordering (added by Todd 2026-10-12), `--layer-accounts` light grey) under the department name and down the edge of its open menu. Photos and Admin stay plain. Text stays white or grey; nothing else in the bar uses these colours (`docs/plans/menu-plan.md`).
  - **Notes paper (approved by Todd 2026-10-16):** on the department Notes page only (`notes.html`, `notes.css`, `notes.js`), each note is a cream paper sticky note (`#E9E4C9`) with ink (`#101019`) text, laid out as a week wall (a column per weekday). Everything else on the page (ground, headings, buttons) follows the house style.
  - **Notes thumbs-up (approved by Todd 2026-10-16):** on the same Notes page only, a small thumbs-up mark on each note acknowledges it, with the count and the names of who acknowledged. No other icon appears on the page.
  - **Loading cursor (approved by Todd 2026-10-18):** while a page is loading, a link has been clicked and the next page is on its way, or an action you started is in progress (a save, move or upload taking over 0.3 s), the mouse cursor becomes the Joinr dot (the mark from Joinr's `docs/brand/logos/joinr-mark.svg`: the spectrum circle on the ink tile, unaltered), gently pulsing by swapping a few sizes. Only the shared shell sets it, on every page that loads the shell and on login, setup and photo search. Nothing else on any page becomes an icon because of it.
- **The style check:** `ci/style-check.js` enforces this in CI. If it fails, fix the page, not the check.

## Local development

`better-sqlite3` does not build on the Windows dev box, so local runs use `node:sqlite` through a shim. From the repo root, in Git Bash:

```
cd crosscuts/app && DB_DIR=../../.dev/db UPLOADS_DIR=../../.dev/uploads CONFIG_DIR=../../.dev/config node -r ../../tools/dev-sqlite-shim.js server.js
```

`.dev/` is git-ignored. A local run is a quick check only. **CI smoke tests are the real verification.** A local pass does not prove the image works.

## Release flow

Releasing takes two repos. Umbrel only offers an update when `version:` in the manifest in tenon-umbrel-store changes, so both halves are needed.

1. Bump `version` in `crosscuts/app/package.json` (and the root version in `package-lock.json`) and commit. Todd says push, and the commits go to `main`.
2. CI builds each architecture on a native runner (`ubuntu-24.04` and the arm runner) and smoke-tests the exact image it will publish.
3. Each image is pushed by digest.
4. A final job reads the version from `package.json` and fails if `ghcr.io/devcal1/crosscuts-web:<version>` already exists. Otherwise it merges the digests into one manifest and sets three tags: `<version>`, `latest` and `sha-<full commit hash>`.
5. The job writes the line to paste into the run summary (GitHub, Actions, the run, Summary): `image: ghcr.io/devcal1/crosscuts-web:<version>@sha256:<digest>`.
6. In tenon-umbrel-store, paste that line over the `image:` line in `tenon-joinr-crosscuts/docker-compose.yml`, then bump `version:` (the same number as `package.json`) and `releaseNotes:` in `tenon-joinr-crosscuts/umbrel-app.yml`. Push that repo only when Todd says so.
7. Todd clicks **Update** in umbrelOS.

After every push (to either repo), rewrite `G:\My Drive\context\projects\crosscuts\status.md` in place. It is the plain-English project summary Todd's assistant reads aloud: what it is, status (complete, in progress, blocked), key design decisions, recent changes, next steps, and links. Never put secrets in it.

The version guard runs first and fails the build if app code changed without a version bump.
