# How to do a pay run in Crosscuts

For Todd and the accounts team. Staff fill in a paper timesheet each fortnight; Accounts types each sheet into Crosscuts, which works out normal time, overtime and double time and gives a summary to key into MYOB. Staff never log in for this.

Anyone with Accounts access can see pay runs. Typing in, finalising and the MYOB tick need the Accounts edit access (the same as invoicing). Only an admin can reopen a finalised pay run.

## Before the first pay run (once)

Open **Accounts**, then **Pay runs**.

1. **Who's on the pay run.** Every worker on the board is listed. Untick **On the pay run** for anyone who isn't paid through it. Use **Add person** for someone who isn't on the board (office staff); they show as **Pay only** and can be renamed or removed here. Board workers are added and renamed on the Workers page.
2. **Public holidays.** The Victorian list is filled in to the end of 2027. Add local days (a show day or cup day) with **Add holiday**, and remove any that don't apply. Melbourne Cup is the statewide date; swap it if your area takes a different day.
3. **Pay rules.** Ordinary hours are 8.00 Mon–Thu and 6.00 Fri; the first 2.00 hours past ordinary are overtime, anything beyond is double time. Change them here if the award changes. The fortnight start (Monday 5 October 2026) locks once the first pay run exists.

## Each fortnight

1. **Print the sheets.** On **Pay runs**, press **Print timesheets** on the fortnight's card: one page per person with their name and the dates, otherwise blank. **Print overtime log** prints the blank log (date, name, hours, job) to go with them.
2. **Start the pay run.** Press **Start pay run** on the card. It makes a sheet for everyone on the pay run. (Started by mistake? **Delete** on the pay run works until a sheet is saved.)
3. **Type in each sheet.** Open the pay run and pick a person on the left. The screen is laid out like the paper:
   - Type **Start** and **Finish** on the 24-hour clock (`7`, `730`, `7:30` or `7.30`; half past three in the afternoon is `15:30` or `1530`), **Lunch** in minutes (`30`) or as `1:00`, and **P HOL**, **SICK**, **ARL** and **ON SITE** in hours (`7.5` or `7:30`). **Tab** moves across, **Enter** moves down.
   - **Total**, **OT** and **DT** work themselves out as you type, as do the totals and the summary block.
   - Grey values are suggestions from the board (the job), leave and public holidays. Check them against the paper; what you type wins. **Fill suggestions** fills only blank cells on a sheet already saved.
   - A cell outlined in orange has a problem (for example a finish before the start); the reason shows beside the row and the sheet won't save until it's fixed.
   - Weekend work has no row: write it in **Notes**, which print on the summary.
   - Tick **Signed** if the paper is signed and **Typed in** when you're done, then **Save** (or **Save and next**, or Ctrl+S).
   - If someone else saved the same sheet meanwhile, Crosscuts says so: press **Reload sheet** and type your changes again.
4. **Check the summary.** The **Summary** tab shows everyone's Normal Time, Over Time, Double Time, Public Holiday, Annual Leave, Personal Leave and On Site hours, with notes. **Print summary** gives a landscape page (marked DRAFT until finalised).
5. **Finalise.** Press **Finalise**. It warns you if any sheet isn't ticked as typed in. Finalising freezes the numbers: later changes to the pay rules don't touch it.
6. **Key it into MYOB** from the summary, then tick **Entered in MYOB**.

## Mistakes

- **A sheet was wrong after finalising:** untick **Entered in MYOB** (and fix MYOB), then ask an admin to **Reopen** the pay run. Fix the sheet, then finalise again. A pay run can't be reopened while Entered in MYOB is ticked.
- **A sheet for someone who wasn't paid this fortnight:** clear the sheet, save, then **Remove** it. **Add sheet** adds someone who's missing.
- Leave typed as hours (ARL, SICK, P HOL) doesn't count towards overtime: overtime starts only after the ordinary hours actually worked.
