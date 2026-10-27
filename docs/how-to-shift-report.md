# How to send the end-of-shift report

For workshop staff, and for whoever sets up their logins. From 0.2.4. The details are in `docs/plans/m25-contracts.md`.

## Setting up a workshop person

1. On **Admin > Users**, add a login for them with the **Workshop** role.
2. Pick their board name in the **Worker** picker on their row. Without it, their jobs for the day can't be listed (they can still search for a job).
3. They sign in on their own phone, at the Crosscuts address over Tailscale, and open **Workshop > End of shift**.

## At the end of the shift

1. Open **End of shift**. Today's jobs from the board are listed, with **Install** or **Manufacturing** on each.
2. On each job, tap **Add photos**. The phone offers the camera or the photo library; pick several at once if you like. Install photos are tagged *install*, others *shift*.
3. If something is wrong, tap **Raise an issue**, say what it is, tick **Attach today's photos** if they show it, and tap **Send issue**. The job's project manager and scheduling get an alert, and it goes to the Workshop channel.
4. Worked on a job that isn't listed? Use **Another job** to search for it.
5. Add a note if you want, then tap **Send report**. You can send it again later the same day to update it.

## The reminder

On weekdays at 4:00 pm, anyone on an install that day who hasn't sent their report gets a reminder in the bell. An admin can change the time, or clear it to turn the reminder off, under **Admin > Users**, Business details, **Shift report reminder**.

## Dealing with issues

Issues show on the job page and the project page (in **Issues**), on **My projects**, and on the Scheduling **Needs install date** list. The project owner, scheduling or an admin taps **Resolve**, with a note about what was done.
