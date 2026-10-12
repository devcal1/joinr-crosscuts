# Menu bar reorganisation: plan

Todd's request (2026-10-12): group each page with similar pages; colour-coordinate the groups where appropriate; every page has at least a link back to the user's dashboard; remove link redundancy; make it clear which pages belong to which department; keep the features common to every department (messages, planner and the like) in the same position for every user.

Ships as 0.1.10. The board's own bar (`.nav`, `--nav-h`, rule 7) is not touched; this is the shell bar (`public/shell/shell.js` `LINK_GROUPS`, `shell.css`, `cc-` classes).

## 1. Audit (today, 0.1.9)

**The bar, left to right:** the TH CABINETS / Crosscuts wordmark (goes to the dashboard, but is not labelled as such) · **Planner** · **Production:** Scheduling, Board, Workers · **Jobs and money:** Jobs, Pipeline, Orders, Design/PM, Accounts · **Photos:** Photos, Photo admin · **Admin:** Users, Audit · then on the right Tasks, Messages, the Alerts bell and the user's name. Group names are visible only in the collapsed Menu (below 1366 px).

**Problems found**

1. **Departments are mixed.** "Jobs and money" holds two departments (Design/PM and Accounts). "Production" on the bar is "Scheduling" on the dashboard and "Scheduling/Production" in the Planner.
2. **Common features are split.** Planner sits far left as its own group; Tasks, Messages and Alerts sit far right.
3. **Pages missing from the bar** (reachable only from a link inside another page): Lookahead and Availability (from Scheduling), Reports (from Accounts), Intake (from Design/PM).
4. **No way back to the dashboard from the Photos page** (`search.html` has no shell bar at all). Every other page has the wordmark link, but nothing says "Dashboard". Board and Workers have their own "TH Cabinets" link home (rule 7, unchanged).
5. **Redundant links.**
   - The dashboard repeats the whole menu as department cards, under different names ("Jobs and design", "Search photos", "Audit log").
   - Scheduling repeats Board and Workers.
   - Design/PM repeats Jobs, Pipeline, Orders and Scheduling.
   - Accounts repeats Tasks.
6. **No room left.** At 1440 px the full admin bar has 26 px to spare. Adding the four missing pages and a Dashboard link as flat links would not fit between 1366 and 1600 px.

**Who has what (role presets):** Accounts: Accounts, Jobs, Board, Photos. Design/PM: Design/PM, Jobs, Scheduling, Board, Photos, Photo admin. Scheduling: Scheduling, Board, Workers, Jobs, Photos. Showroom: Photos only. Workshop: Board and Planner only. Admin: everything. All but showroom and workshop have Tasks and Messages; all but showroom have the Planner.

## 2. Proposal (the recommended answers)

```
[TH CABINETS Crosscuts]  DASHBOARD | SCHEDULING ▾  DESIGN/PM ▾  ACCOUNTS ▾  PHOTOS ▾  ADMIN ▾ |   PLANNER  TASKS 3  MESSAGES 1  ALERTS  Todd ▾
```

- **Dashboard** always first, labelled, for every user.
- **Department menus** (each opens a short list), in a fixed order, shown only when the user has at least one page in it:
  - **Scheduling:** Board, Scheduling, Lookahead, Availability, Workers
  - **Design/PM:** Design/PM, Jobs, Pipeline, Orders, Intake
  - **Accounts:** Accounts, Reports
  - **Photos:** Photos, Photo admin
  - **Admin:** Users, Audit
- **Common features** in one fixed cluster on the right, the same order for everyone: Planner, Tasks, Messages, Alerts, then the user's name. Phones keep today's behaviour (Tasks and Messages move into the Menu).
- **Colour:** each department carries the colour it already has in the Planner, as a thin rule under its name: Scheduling fuchsia, Design/PM violet, Accounts light grey. Photos and Admin have no Planner layer, so they stay plain. This needs a **fourth named exception** in CLAUDE.md and `ci/style-check.js` (Todd's approval).
- **Redundancy removed:** the dashboard keeps its working tiles (this week, My tasks, Messages, Planner) and loses the department link cards; the in-page links that repeat the menu go (contextual links such as a job name or "back to invoice" stay).
- **Photos page gets the shell bar**, so it has Dashboard, the common cluster and the user menu like every other page.

## 3. Questions for Todd (one at a time)

1. Where the common features sit: one fixed cluster on the right (recommended) or on the left after Dashboard.
2. Department menus (recommended) or flat links with a department label (needs more width; the bar collapses to Menu sooner).
3. Where Jobs, Pipeline and Orders live: under Design/PM (recommended; that department owns jobs) or Jobs as a shared item in the common cluster.
4. Colour: the Planner's department colours as a thin rule (recommended, new named exception) or no colour (department names only).
5. Redundancy: remove the dashboard's department cards and the in-page repeat links (recommended), or keep the dashboard cards.
6. Photos page: add the shell bar (recommended) or only a Dashboard link on its own header.

## 3a. Decisions (Todd, 2026-10-12): all six recommended answers. Plan approved.

1. Common features in one fixed cluster on the right: Planner, Tasks, Messages, Alerts, then the user's name.
2. Department menus (each one button opening its list of pages).
3. Jobs, Pipeline and Orders under Design/PM.
4. Planner colours as a thin 2 px rule (fourth named exception, written into CLAUDE.md and `ci/style-check.js`: only `--layer-scheduling`, `--layer-design`, `--layer-accounts`, only in `shell/shell.css`).
5. Remove the repeats: the dashboard loses its department cards (keeps its working tiles); the in-page links that only repeat the menu go.
6. Photos page (`search.html`) stays free of the menu bar for customers (M1 decision) and gets one quiet outlined DASHBOARD button in its own header. This replaces the proposal's "Photos page gets the shell bar".

## 3b. After the build (Todd, 2026-10-12): all four recommended

1. The Design/PM page keeps its New from Joinr card with its Open New from Joinr button (to Intake): a link with a job to do, not a repeat of the menu.
2. Departments with one page stay as menus (the same layout for everyone).
3. The dashboard keeps its Accounts due/overdue line.
4. The brief section 4 is updated: the dashboard shows working tiles; departments are reached from the menu bar.

## 3c. Ordering department (Todd, 2026-10-12)

From the jobs master review (`docs/plans/jobs-master-tabs.md`): Ordering is its own department. Added to the menu before release: an **Ordering** menu after Design/PM holding **Orders** (moved out of Design/PM); the drawer, stock and paint orders and an Ordering role come later. Its rule is **orange** (`--layer-install`, the Planner's Install & hardware colour), added to the fourth named exception in CLAUDE.md and `ci/style-check.js`. Order: Scheduling, Design/PM, Ordering, Accounts, Photos, Admin.

## 4. Build outline (after the answers)

- Scaffold: bump 0.1.10; the colour exception in CLAUDE.md and `style-check.js` if approved.
- One build step (single agent: `shell.js`, `shell.css`, `index.js`/`index.html`, the in-page links, `search.html`).
- Checks: the menu as each role (admin, accounts, design_pm, scheduling, showroom, workshop) at 375, 1024, 1366, 1440, 1920 px with screenshots for Todd; keyboard and screen-reader names on the menus; `ci/style-check.js`; smoke assertions on any page whose links change.
- Review, fixes, then release with Todd's OK.
