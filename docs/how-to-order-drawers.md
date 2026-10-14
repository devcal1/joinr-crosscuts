# How to order drawers in Crosscuts

For Todd, Design/PM, Ordering and the Workshop Manager. Drawers aren't ordered line by line. Each job has a **drawer grid**. The **Drawer order** page adds up every checked grid, per brand (EDGE and DTC), and Ordering places one order from it. The Workshop Manager receives the delivery on **Deliveries**.

Who does what:
- **Design/PM** (and admin) **checks** a job's grid. Only checked grids go on the Drawer order.
- **Ordering** and **Design/PM** (and admin) add and edit a job's grid.
- **Ordering** (and admin) uses the **Drawer order** page: the stock row, the name list, placing the order.
- **The Workshop Manager** (and Ordering, Design/PM and admin) receives the drawers on **Deliveries**.

Each brand has four heights and seven runner lengths (300 to 600 mm, in 50 mm steps). A count is a whole number from 1 to 999. A zero count is simply left empty.

## A job's drawer grid

Open the job (**Design/PM**, then **Jobs**) and go to its **Orders** section. The **Drawers** block under the order lines shows each drawer line: its brand, the grid (heights down, lengths across, only the rows and columns in use, with totals), where it came from (**From Joinr** or **Typed in**) and whether it's checked. A grid that Design/PM hasn't checked says **Not checked**.

A job has at most one grid per brand while it is waiting to be ordered.

### From Joinr

When a quote won in Joinr is accepted or linked to a job (Design/PM, **Intake**), Crosscuts reads the quote's **Drawers** and **Inner Drawers** lines and fills in a grid for each brand it finds. It works out the brand, height and length of each line from the **name list** (below). The new grid is **From Joinr** and **Not checked**, and Design/PM is told: "Drawers to check: <job>".

- **A name that isn't on the list** isn't counted. Ordering is told ("Drawer names to add: <job>"), and the Joinr box on the job page lists the name in orange as "not on the drawer name list". Once Ordering adds it, press **Fill from Joinr** on the job (when it has no grid for that brand yet) or **Refill from Joinr** (when it already has one; see below).
- **A job with no grid yet** can still be filled later: if the quote has mapped drawer lines for a brand and the job has no live grid for that brand (a cancelled one doesn't count), the Joinr box shows **Fill from Joinr**. It makes a grid for each such brand, **Not checked**, for Ordering, Design/PM and admin (anyone who can edit order lines). If there is nothing to fill it says "Nothing to fill from Joinr".
- **A job with no Joinr drawer lines** gets no grid. This covers jobs from before drawers came from Joinr, jobs that didn't come from Joinr, and quotes with no drawer lines. For a job that came from Joinr the box on the job page says Joinr sent no drawer lines (to people who can edit it, "so the grid is typed in here"); a job that didn't come from Joinr has no Joinr box at all. Either way, Design/PM types the grid in.

### Typing a grid in

1. On the job's **Orders** section, press **Add drawers**.
2. Choose the brand, type the count for each height and length, add a note if one helps (for example, "3 fronts"), and save.
3. To change it later, press **Edit grid**. It works only while the line is still **To order**.

Ticking **Checked** in the same dialog checks it at once. Only Design/PM (and admin) see that tick. When you open **Edit grid** on a grid that is already checked, **Checked** is ticked already: leave it ticked to keep the check after the save, or untick it to clear it.

### Checking at design sign-off

Design/PM checks each grid when the design is signed off: compare the counts with the design, correct them with **Edit grid**, then press **Check**. **Uncheck** takes the check back.

- **Changing the counts clears the check**, unless Checked stays ticked in the same save (Design/PM and admin see the tick). Ordering can fix a count, but Design/PM has to check it again.
- A checked grid shows "Checked by <name>, <date>".

### When Joinr changes: Refill from Joinr

Crosscuts never rewrites a grid by itself. If the quote's drawer lines change in Joinr after the grid was filled, the job page says **Changed in Joinr since the grid was filled**. Press **Refill from Joinr** to replace the counts with the quote's lines, as the name list maps them now. The check is cleared, so Design/PM checks the grid again. A confirmation says so first.

**Refill from Joinr** is shown only on a grid that is still **To order**, and only when the quote has drawer lines for that brand. It works on a grid that already exists; to make a grid for a brand the job has none for, use **Fill from Joinr** (above). Also use Refill after Ordering adds or changes a name on the list: a name-list change alone doesn't set the "Changed in Joinr" message.

### The grid on the Orders list

A drawer line is an ordinary order line ("Drawers (EDGE): 6 × Mid 126/500, …", labelled DRAWERS), with these differences:
- **Mark ordered isn't offered.** Drawer lines are ordered from the Drawer order page only.
- The grid sets the supplier and description. Change the grid to change them.
- **Edit** changes the notes and the expected date. It also offers the ordered and received dates, to whoever may mark ordered or receive (as on any other line).
- **Receive**, **Undo received** and **Cancel** work as on any other line.
- **Undo ordered isn't offered** on a drawer line that is on a placed drawer order (the Orders page and the job page both leave it out; if it were sent, Crosscuts answers "These drawers are on a placed drawer order. Use Undo order on the Drawer order page."). The way back is **Undo order** on the Drawer order page, under **Placed** (below).

## The name list (Ordering)

Open **Ordering**, then **Drawer order**, then the **Names** tab. Joinr's catalogue names mean nothing to Crosscuts until they're on this list.

- **Names from Joinr not on the list** are shown at the top, from jobs whose drawers aren't ordered yet. Press **Add** beside one to add it with the name filled in.
- **Add name** adds a name. Choose **A drawer size** (brand, height, length) or **Not a drawer (ignore it)**.
- **Ignore** is for lines that aren't drawers: runner sets, accessories and the like. An ignored name is dropped and Ordering isn't told about it again.
- A name can be on the list once ("That name is already on the list"). **Edit** and **Remove** change it.
- Changing the list doesn't touch grids already filled. Press **Refill from Joinr** on the job to use the change (or **Fill from Joinr** if the job has no grid for that brand yet).

## Ordering: the Drawer order page

Open **Ordering**, then **Drawer order**. The tabs are **EDGE**, **DTC**, **Placed**, **Names** and **Settings**.

### The sheet

Each brand's tab is the order sheet:
- One block per height, with the seven lengths across.
- A row per job (its note in small type under the name), then a **Stock** row, then the totals. The grand total is at the foot.
- **Stock** is for extra drawers to keep on the shelf. Type the counts in; each saves when you leave the box.
- Only **checked** grids are in the totals. Grids still **Waiting for Design/PM check** are listed underneath and aren't counted.

### Placing the order

1. **Print** the sheet and send it to the supplier. It's A4, black on white, with the supplier and the date.
2. Press **Mark ordered**. Set the date it was ordered (today, or earlier) and, if you know it, the expected date. The dialog lists the jobs whose drawer lines will be marked ordered.
3. Press **Mark ordered** in the dialog.

Placing needs the Drawer order page (Ordering) and the Mark ordered permission, because it can make a progress invoice fall due. Ordering and admin have both.

If anything on the sheet changes while you're looking (someone checks, unchecks or edits a grid, changes a job's note, recounts, or edits the Stock row), Crosscuts won't place it: "The drawer order changed while you were looking; reload it". The dialog then offers **Reload the order**. Look at the sheet again, and place it.

### The 50% invoice rule

Placing marks each job's drawer line **Ordered** with the dates you gave, exactly as **Mark ordered** does on any line. **When a drawer line is the last of a job's lines still to order, the job's materials count as ordered and its 50% progress invoice falls due**, and Accounts are told. If the job still has other lines to order, nothing falls due until the last one is marked. The expected date goes on each job's line, so the drawers show on Deliveries.

### Placed orders

The **Placed** tab lists the newest 50 placed orders, with a **Brand** filter: the date, the supplier, the jobs, the total and whether the stock row has arrived. Press **Open** on one to see the sheet as it was sent, with each job's note as it was when you placed it. Later changes to a grid don't alter it.

- **Print again** prints the placed sheet, each job's note included (once, under its name), so a reprint matches what was sent.
- **Stock received** (see below) marks the stock row delivered.
- **Undo order** takes the order back. It's refused if anything on it has already been received ("Something on this order has already been received"): undo the receiving first. Undoing puts each job's drawer line back to **To order**, puts the stock row back on the sheet, and removes the placed order. **A progress invoice that already fell due stays due.**

### Settings

The **Settings** tab holds each brand's supplier name. It goes on new drawer lines and at the top of the printed sheet. Lines already made keep the supplier they were made with.

## Receiving drawers (Workshop Manager)

Open **Ordering**, then **Deliveries** (see [how-to-receive-deliveries.md](how-to-receive-deliveries.md)).

- **Each job's drawers** are an ordinary line with the job's name, listed by its expected date (**Overdue**, **Today**, **Next 7 days**, **Later** or **No date yet**). When they arrive, press **Received**, as for any line. If part is short or damaged, write a **Delivery note** and leave it ordered.
- **The stock row** is a separate item in the **Stock and paint** group, called "Drawer stock (EDGE)" or "Drawer stock (DTC)". Press **Received** when the shelf drawers arrive. It can also be marked on the order's page under **Placed**, with **Stock received**. **Undo** is under **Received recently**.
- When every line of a job has been received, the job's materials are in: the board's mark turns to "in" and Scheduling and Ordering are told.

## Notes

- Ordering sees "Drawers: N to order · N waiting for check" on the dashboard when there's anything to say.
- The Workshop Manager can't open the Drawer order page. They see the drawers on Deliveries only.
- A Drawer stock row shown on Deliveries has an **Open** link to the Drawer order page only for people who can use it.
