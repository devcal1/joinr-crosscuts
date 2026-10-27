# How to do the morning check and confirm installs

For the schedule manager and project managers. From 0.2.5. The details are in `docs/plans/m26-contracts.md`.

## The morning check (schedule manager)

1. Open **Scheduling** (the department notes wall). **Morning check** is under the week of notes, for whoever can edit the board.
2. It lists the previous working day's jobs (Monday's check covers Friday), with who was on each one.
3. For each job, pick the production stage it reached and add a short note if there's something to say. Each change saves itself. The stage you pick shows on the board's stage label, unless a later Finish week stage replaces it.
4. Underneath, check what needs attention: rows this week with nobody on them, Ready to cut jobs not on the board, installs this week with no promised install date, and open job issues from the workshop.
5. Press **Done for today**. Until someone does, the dashboard shows "Morning check not done today" to everyone who can edit the board.

## Installed, then complete

- In **Finish week**, the last choice is now **Installed** (it used to say Complete). It records the job as installed and alerts the job's project manager. It no longer completes the job or makes the final invoice due.
- The project manager opens the job or project page, where an orange line says it is waiting, and presses **Confirm complete**. That completes the job, and the final 40% (and any pending extras) falls due. Open issues on the job show as a warning but don't stop it.
- If the project manager is away, an admin can confirm instead.
- On the **Pipeline**, a job waiting for confirmation shows in Complete, marked **Awaiting PM confirm**.

## Waiting on you

The dashboard's **Waiting on you** tile lists what is waiting on you: steps to do, installs to confirm and open issues on your projects; lines to order and missing expected dates; the morning check, jobs that need an install date, and open issues; your end-of-shift report.
