# Jobs as containers, Tradify style (plan)

Todd, 2026-10-30: the projects team is used to Tradify. A job is the container for its quote, notes, photos, invoices (later) and so on. Every new Joinr quote gets its own job, and project managers are assigned to jobs. This goes out together with 0.2.8 (Planner look and phone) when Todd says push.

## Todd's decisions (2026-10-30)

1. **New quotes:** every new Joinr quote creates its own job straight away, at stage Quoted. Revisions of the same quote update that job. The "New from Joinr" inbox is kept only for clashes, such as a quote number that already matches a job.
2. **PM:** one project manager per job. This reuses today's `project_owner_id`, renamed "Project manager" in the UI. Other people can still be added as job people.
3. **Default PM:** Todd chose the quote's author. **But the Joinr feed carries no author** (checked against `ci/fake-joinr.js`), and adding one is a Joinr change (rule 12). So new jobs start **unassigned** and show in an Unassigned filter. The author can come later through a Joinr change, after "THIS WILL TOUCH JOINR" and two yeses.
4. **Notes:** a running list of dated notes, newest first, each showing who wrote it, each able to carry photos or files. The existing `notes` and `project_notes` boxes become a pinned Job summary.
5. **Job page:** a fixed header with job number, name, stage, client, site and PM, then tabs:
   - Overview
   - Quote
   - Notes
   - Photos
   - Invoices
   - Orders & materials
   - Planner & tasks
   - Workshop (stone, stock, issues, inspection)

   Each person's last tab is remembered.
6. **Jobs list:** a table with columns for job number, name, client, stage, PM and last activity. Filters: My jobs (the default for a PM), Unassigned, stage, and search.
7. **Job number:** the Joinr quote number for a job from Joinr. Hand-made and board jobs take the next number in a J- series.
8. **Backlog:** quotes already in the inbox at release stay there and are handled by hand. No stored data changes at release.

## Build outline

- **Migration 051 (additive):**
  - a `job_notes` table: id, job_id, user_id, body, created_at, edited_at, deleted_at;
  - a `job_note_files` table, or a `note_id` on `photos`, chosen at contracts;
  - a `job_number` column with a J- sequence. Existing jobs get their number from the migration, as a computed backfill of a new column, not a change to existing data.
  - Todd signs off at contracts.
- **Intake** (`lib/intake.js` `autoDecide`): auto-create a job at stage Quoted for any new root quote, not only won ones, using the same clash rules as today. When a quote is later won, the stage moves to Won and the existing design team task is created then, as now.
- **API:**
  - notes: list, add, edit (own notes, within a time limit or always; to settle at contracts), delete (soft); declared with `defineRoutes` and access keys;
  - jobs list: `mine` and `unassigned` filters.
- **Pages:**
  - `job.html` and `job.js` restructured into the header and tabs. The existing section scripts are reused inside the tabs.
  - `jobs.html` becomes the table.
  - Phone layout: tabs become a scrolling strip; the header folds.
- **Alerts:** a new unassigned job alerts holders of `design.view`. Assigning a PM alerts that person.
- **Checks:** a new smoke file for auto-created jobs, notes and filters; the existing intake smokes are updated for the new rule; the style check; screenshots on PC and phone.

## Settled by Todd (2026-10-30)

- **Note edits:** people edit or delete only their own notes. An admin can soft-delete any note, recorded in the audit log.
- **Note photos:** they show on the note and in the job's Photos tab, but **not** in the photo library. They are stored apart from library photos (`job_note_files`, or a flag that the library excludes), settled at contracts.
- **Invoices tab:** a read-only list of the invoices already linked to the job (kind, amount, due date, paid), with a link to Accounts. Tradify-style invoicing comes later.
