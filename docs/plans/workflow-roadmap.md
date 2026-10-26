# Workflow roadmap: Won to final invoice (Todd, 2026-10-26)

This roadmap makes Crosscuts run TH Cabinets' job workflow end to end, with one person clearly responsible at each step. It follows 0.2.1 (Project jobs, `m22-project-jobs.md`). Todd added the workshop manager and accounts roles the same day; they are M27 and M28.

Each milestone has its own self-contained plan, written so that a fresh session (after `/clear`) can build it from `CLAUDE.md`, `STATUS.md`, this file and that plan alone. Build in order: each milestone assumes the ones before it. Each is one release (0.2.2, 0.2.3, ...), with Todd's look before the push.

## The workflow (Todd's words, in substance)

1. A client enquiry becomes a quote in Joinr. When it is accepted, Joinr marks it **won** and the job moves to the **Projects** team.
2. One **project manager** (the job's project owner) draws the job, check measures it, nests it and prepares the order list. Each step is recorded in Crosscuts.
3. When the order list is ready, it is sent to the **order manager**. The job is placed on the board automatically to start manufacture **two weeks out** (configurable). The project manager enters a **requested install date**. The **10% deposit** falls due.
4. The order manager orders everything. Everyone can see the orders and their estimated delivery dates. When everything is ordered, the **50%** falls due and the **schedule manager** is asked to schedule an install date.
5. Every morning the schedule manager updates the board and records yesterday's job statuses.
6. At the end of every shift, each workshop person sends photos of the jobs they installed and flags any issues to that job's project manager and to the schedule manager.
7. When the board marks a job installed, the project manager is notified and confirms it complete. Only then does the **final 40%** fall due.

## Todd's decisions (2026-10-26)

| Question | Decision |
|---|---|
| Scope | Everything may change except the board layout (CLAUDE.md non-negotiable 7). |
| Milestone size | Fewer, larger milestones. |
| End-of-shift reports | Each workshop person, own login, own phone. |
| Auto-place on the board | A manufacturing row with nobody on it, the given number of weeks out; the schedule manager adds people. |
| Final 40% | Waits for the project manager to confirm completion; an admin can confirm if the project manager is away. |
| Morning update | A production stage plus an optional short note per job, per day. |
| Install dates | Two dates: **Requested install** (project manager) and the existing **Promised install**, which becomes the confirmed date the schedule manager sets. |
| Draw, check measure, nest | Each is a tick with who and when. Check measure can also be booked ahead with a date and time, and it shows on the Planner. |
| Ready to cut | A job moves to Ready to cut automatically when every line is ordered. |
| People | Plan around roles; Todd gives people their roles on the Users page. |

Review notes agreed in planning:
- A job placed on the board before everything is ordered still shows that it is in ordering, as **On board (ordering)** on the Pipeline and the job pages, until all its lines are ordered.
- Changing what Finish week's "complete" does (it becomes "installed", and the project manager confirms) is a change to board **behaviour**. Todd approved it by choosing PM confirmation; M26 adds it to CLAUDE.md non-negotiable 7 as a named exception, as M5's were.

## Milestones

| Milestone | Release | Plan | What it delivers |
|---|---|---|---|
| **M23 Projects steps and hand-offs** | 0.2.2 | `m23-plan.md` | Drawn / Check measured / Nested / Order list ready on each job, check measure booking, owner-needed alert and auto-move to Projects, My projects, requested install date at Send to Ordering, order manager alert, tile marks, Projects channel rename. |
| **M24 Board placement and money triggers** | 0.2.3 | `m24-plan.md` | Auto-place on the board N weeks out (admin setting), 10% at Send to Ordering, On board (ordering), all-ordered: Ready to cut, schedule manager alert and "Needs install date" list with a confirm dialog, daily missing/late ETA nudge. |
| **M25 Workshop end-of-shift report** | 0.2.4 | `m25-plan.md` | Phone page for each workshop person: today's jobs, photos, issues. Job issues routed to the project owner and schedule manager, shown on the job, project and dashboard pages. New feature key `shift.report`. |
| **M26 Morning check and completion** | 0.2.5 | `m26-plan.md` | Schedule manager's daily Morning check (stage + note per job per day), Finish week "complete" becomes installed, project manager Confirm complete, then the 40%; Dashboard "waiting on you" tiles per role. |
| **M27 Workshop manager** | 0.2.6 | `m27-plan.md` | Fortnightly stock count with targets and order amounts filled in (target minus have), the workshop manager keeps the list; Workshop > Maintenance on recurring tasks, confirmed by the workshop manager only; board and edge tape stock with reservations for jobs (order manager reserves, workshop manager labels and ticks Reserved, marks jobs cut 100% at end of shift). |
| **M28 Accounts and vehicles** | 0.2.7 | `m28-plan.md` | Vehicles register (rego, insurance, bookings; dates only); To pay list (admin ticks paid); invoices Mark sent with follow-up interval per invoice; Loans maintain access for Accounts. |

### Workshop manager and accounts (Todd, 2026-10-26)

- Workshop manager: fortnightly stock count against a kept list of target amounts, which makes the order list for the order manager; the maintenance schedule in the Planner, each item confirmed when actioned; vehicle maintenance bookings.
- Accounts: sends and follows up all invoices; keeps supplier accounts and non-account invoices for admin to pay; vehicle registrations and insurances; accuracy of the directors' loan balances.
- Decisions: true fortnightly cycle; maintenance confirmed by the workshop manager only; vehicles dates and bookings only; admin ticks bills paid; Mark sent plus follow-up interval set per invoice (client terms differ); Accounts may record loan payments and interest and tick months checked (changes M13 owner-only; openings, rates, plans stay owner-only); Workshop becomes a sixth department (in M23).

## Already done, not rebuilt

Joinr intake and auto-accept; project page, order list revisions and Send to Ordering (0.2.1); Orders and Deliveries pages with expected dates; the 10/50/40 invoice engine, Overdue accounts and the Friday round-up; bell alerts, tasks, team tasks, comments; Finish week production stages; Planner events for promised install and materials.

## Rules for every milestone

CLAUDE.md applies in full: bump the version; additive numbered migrations only; every `/api` route through `defineRoutes` with an access value; house style with text marks and no icons; board layout untouched; no Joinr changes; commit locally and never push without Todd's yes. Each milestone ships a contract (`mNN-contracts.md`), a how-to, a smoke suite (`ci/smoke-mNN-*.sh`) and a STATUS.md entry, and runs the full adapted smoke one at a time (fake Joinr ports are fixed).
