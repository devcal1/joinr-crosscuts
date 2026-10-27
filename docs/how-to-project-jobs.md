# How to run a job through Projects

A won job comes to Projects with one owner. The owner pins down the colours, finishes and exact hardware, finalises the order list, and sends the job on to Ordering.

## Give the job an owner

- **When you accept it from Joinr:** on Projects > Intake, pick the owner beside **Accept**, then click Accept. You can leave it as "No owner yet" and set it later.
- **Later:** open the job. Under the name, **Project owner** has a picker. Choose a name or "No owner".

Anyone with Projects access can be the owner. Admins can set the owner, and so can anyone who edits jobs and has Projects access.

Giving a **Won** job an owner moves it to **Projects** straight away.

A Won job with no owner sends one alert (the bell) to every admin: "X needs a project owner". It links to the project page, where the owner picker is. On the Pipeline, **No owner** narrows the Won, Projects and Ordering columns to the jobs nobody owns yet.

On the Pipeline, tiles in the **Projects** and **Ordering** columns are filled with the owner's worker colour, with their name on the tile. A grey tile reads **No owner**, so you can see which jobs still need one. (The owner's colour comes from the board worker linked to their login: Admin > Users, Board worker. With no worker linked, the tile stays grey but shows the name.)

## Move a job into Projects

Drag the tile from **Won** to **Projects** on the Pipeline, or use **Move to…**. On the job page, the stage list has Projects and Ordering in place of the old "Design / ordering".

## Work on the project page

Click **Project** on the tile, or **Project page** on the job. The page has:

- **Hours:** the quoted factory and install hours from the Joinr quote (about how many 8-hour days that is), beside the days already booked on the board. The board books people by the day, not by the hour, so "booked" counts person-days: one person on one day. Days still to come show as "booked ahead".
- **Materials:** boards, edging, doors, benchtops and the rest. Each line has a **Colour**, **Finish** and **Supplier**. Type in a box and move on: it saves by itself. Add a line at the bottom. If the job came from Joinr, **Update from Joinr** brings in any changes from the quote. Setting a colour, finish or supplier doesn't stop a Joinr line from updating; changing its name or quantity does.
- **Hardware:** the hardware and handles lines, with **Brand**, **Code** and **Supplier**, so you can name exactly what to buy.
- **Job notes:** anything else. Click **Save notes**.

## Tick the steps

The **Steps** panel at the top of the project page has the owner's four steps:

- **Drawn**, **Check measured** and **Nested**: click **Tick** when it's done. The page shows who ticked it and when. **Untick** takes a tick back (it is kept in the audit log).
- **Order list ready**: not a tick. It is done when the order list is finalised and nothing has changed since (see below).

To book a check measure ahead, fill in the date (a time and notes if you like) under **Check measure** and click **Book check measure**. It shows on the Planner on the Projects layer. **Mark done** when it's been done (that ticks Check measured too), or **Cancel booking**.

Ticking and booking need the same rights as setting the owner: an admin, or someone who edits jobs and has Projects access.

On the Pipeline, Projects tiles show the steps as **D CM N O**: done ones in full text, missing ones faded. Ordering tiles show how many order lines are ordered ("1/3 ordered").

## Requested install date

Under the steps, enter the **Requested install** date: when you'd like it installed. It is also on the job page under Dates. **Promised install** stays the confirmed date, set by scheduling. You can't send to Ordering without a requested install date.

## My projects

Click **Projects** in the menu (the Projects notes wall). **My projects** lists the jobs you own, one line each: the step marks, the requested install date, the current order list revision, how much is ordered (and the latest delivery date expected), and what's waiting on you next. Admins can click **Show all owners** to see everyone's.

## Finalise the order list

When every line has a supplier and a quantity, click **Finalise order list**. Lines still missing either are outlined in orange and listed under the button. Finalising freezes the list as **revision A**. **Print revision A** gives an A4 sheet grouped by supplier, with a tick box per line.

If you change anything afterwards (a colour, a quantity, a new line), the page says **Changed since revision A**. Finalise again to make revision B. Old revisions stay printable from the link under the status line.

## Send to Ordering

Click **Send to Ordering** (you need to be able to create order lines). It is only offered for a finalised list with no changes since, and needs a requested install date. It:

- makes an order line for each line, under its supplier, ready for Ordering to place (Ordering > Orders);
- moves the job to the **Ordering** column;
- tells the order managers (the bell): "Order list for X sent: N lines, M suppliers", linking to Orders showing just that job.

It also (0.2.3):

- puts the job on the board, in Manufacturing, two weeks out (the week starting two Mondays from now), with nobody on it, ready for scheduling to add people. Admins set how many weeks on Admin > Users, Business details, **Board lead (weeks)**; 0 turns this off. A job already on the board this week or later isn't placed again.
- makes the **10% deposit** due (Accounts is told). It is raised once only: sending a later revision doesn't raise another.

While the job is on the board and lines are still to order, it shows as **On board (ordering)**, with how many lines are ordered.

When Ordering orders the last line, the **50%** falls due (as before). A job not yet on the board moves to **Ready to cut**. Scheduling is asked to set the install date: the Scheduling notes page lists **Needs install date** (jobs with everything ordered and no promised install date, with your requested date and the latest delivery date). **Confirm install date** sets the promised install date.

Every weekday at 7:00, Ordering gets one alert if any ordered lines have no expected date, or any lines are past their expected date.

If you add lines after sending, finalise again and send again: only the new lines become order lines. A change to a line that is already ordered doesn't change its order line, so tell Ordering, who can edit it on the Orders page.

A job can also be dragged between Projects and Ordering by hand; that moves it but makes no order lines.
