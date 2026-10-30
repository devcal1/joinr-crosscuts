# Planner look and phone plan (version 0.2.8)

Todd, 2026-10-30: make the Planner nicer on a PC and work properly on a phone. It is the main page people use every day.

## Todd's decisions (2026-10-30)

1. **PC:** a Fortnight / Month switch at the top of the page. Each person's choice is remembered in their browser.
2. **Phone:** the page opens on today's agenda. A strip of dates you can swipe sits at the top, then today's events and the next few days as a list. The month is a picker that folds out.

## Problems found (local screenshots at 1440 and 375 px)

- **PC:**
  - The day columns are narrow. Every card repeats "All day", its source and its layer.
  - A multi-day job shows as one card per day.
  - The month repeats the fortnight in a different style.
  - The seven layer buttons are heavy.
  - There are 14 ADD buttons.
- **Phone:**
  - The page is about 3,700 px long and does not open at today.
  - There is no way to jump to a date.
  - The buttons and month cells are too small for a thumb.
  - The event dialog has not been checked on a phone.

## Changes

**PC (720 px and wider)**

1. **Fortnight view:**
   - A multi-day event shows once, as a bar across its days.
   - A single event is a one-line chip: time, then title.
   - "All day" is dropped: no time shown means all day.
   - The source and layer name show on hover and in the event's details.
   - The 3 px layer edge stays (approved exception).
2. **Month view:**
   - A full-width month with the same bars and chips.
   - A day with more than fits shows "+n more", which opens the day.
3. **Switch:** Fortnight | Month, with Prev, Today and Next for whichever view is showing.
   - The choice is stored in `localStorage`.
   - Both views are kept on screen at the old side-by-side widths, so print stays as it is.
4. **Lighter controls:**
   - Layer filters become thin text toggles that keep their marker dot.
   - The per-day ADD buttons are replaced by double-clicking a day, plus an add link that shows on hover.
   - New event stays.

**Phone (below 720 px)**

5. **Agenda:**
   - The date strip shows today and the next 13 days, with a dot under any day that has events.
   - Tapping a date scrolls the list to that day.
   - The list starts at today.
6. **Month picker:** folds out from the page heading. Picking a date jumps the agenda to it.
7. **Bottom sheet:** holds the layer filters and New event. Every tap target is at least 44 px.
8. **Event dialog:**
   - It fits the phone screen and scrolls inside itself.
   - Create, edit, repeat and delete are checked at 375 px.

**Unchanged**

- The data, the API, migrations, permissions and print (black on white, layer names in words).
- No new colours, icons or shadows. The style check must pass.

## Files

`public/planner.html`, `planner.css`, `planner.js` only. The version goes to 0.2.8 in `package.json` and `package-lock.json`.

## Checks

- Before and after screenshots at 1920, 1440, 1100 and 375 px, using `tools/screenshots/shoot.js`.
- No page overflow from 375 to 1920 px.
- The style check passes.
- The planner smokes pass locally: `smoke-m7-*`.
- Print preview is unchanged.
- Commit locally. Nothing is pushed until Todd says so.
