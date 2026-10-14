# How to order stone benchtops in Crosscuts

For Todd, Design/PM, Ordering, Accounts and Scheduling. A stone benchtop is ordered on a **stone order**: our own form, printed on our letterhead and sent to the stone supplier. Each job keeps its stone orders in a **Benchtops** section on the job page. The printed **benchtop sheet** goes to site to be drawn on. The **batten calculator** (at the end) is a separate Design/PM tool.

A stone order is **not an order line**. It doesn't appear on the job's Orders section, the Orders page or Deliveries. It never holds back the 50% progress invoice, and it has nothing to do with "materials in".

Who does what:
- **Design/PM** (and admin) makes stone orders, changes them, marks them sent, cancels and restores them.
- **Ordering** sees the Stone orders page and every order, read-only, and can print them.
- **Accounts** and **Scheduling** see a job's stone orders in its Benchtops section and can print them and the benchtop sheet. They don't have the Stone orders page.
- **Workshop**, **Workshop Manager** and **Showroom** see none of it.

Nothing about stone orders sends a notice. The Design/PM dashboard has a **Stone orders** tile instead (below).

## A job's Benchtops section

Open the job and go to its **Benchtops** section, after Orders. Each stone order shows its supplier, the stone (brand and colour), the edge, the measure date, the requested install date and its state:

- **Draft**: not sent yet.
- **Sent rev n, d Mon**: sent, with who sent it.
- **Changed since rev n** (in orange): sent, then changed. The supplier hasn't seen the change yet.
- **Cancelled**: hidden unless you press **Show cancelled**.

Each order has **Open** (Design/PM, admin and Ordering) and **Print**. Print gives the last sent revision when nothing has changed since, and otherwise the current form, marked as a draft.

The section's buttons are **New stone order** (Design/PM and admin, not on an archived job) and **Print benchtop sheet**.

When the job's benchtop is set to **stone** and it has no stone order (a cancelled one doesn't count), the section says **Stone benchtop: no stone order yet** in orange.

### From Joinr

When the job came from Joinr, its **From Joinr** box shows **Benchtop (as typed)**: each room's benchtop text from the quote, as it was typed in Joinr, joined with "; ". Joinr holds no benchtop sizes, edges, profiles or cut-outs, so the stone order is always typed in Crosscuts.

## Making a stone order

1. On the job's Benchtops section, press **New stone order**.
2. The form starts with the job's details filled in: the job reference (its name), quote number, site address, client and client phone, the promised install date as the cabinetry install, you as our contact, and the business phone. Change any of them on the order if they need to be different. That doesn't change the job.
3. Fill in the supplier, the stone brand and colour, the edge height and profile, the measure / template date and the **requested benchtop install** date. Supplier and stone brand suggest names used on earlier orders. Edge height and profile are lists; choose **Other…** to type a size or profile that isn't on the list.
4. Add the site access (an occupied home, a lockbox, parking, stairs and so on) and any notes.
5. Press **Save draft**. You can save a draft with anything missing.

A job can have more than one stone order (for example a second supplier, or a separate laundry top). The form says so when the job already has one.

## Sending it

Six things are needed before an order can be sent: **Supplier**, **Stone brand**, **Colour**, **Edge height**, **Edge profile** and **Requested benchtop install**. If any is empty, Crosscuts says "Fill in before sending: …" and marks those fields.

1. Press **Mark sent** and choose the date you're sending it. It defaults to today, can't be in the future, and can't be before the order was started. Any unsaved changes are saved first.
2. Press **Print** and send the print to the supplier (email it as a PDF, or hand it over).

Mark sent comes first: that makes **revision 1**, and the print then carries the revision and the **date sent**. A print made before Mark sent says **DRAFT – NOT SENT** and has neither, so don't send that one. A reprint always shows the date sent, never today's.

If someone else changed the order after you opened it, Mark sent stops with "This stone order was changed by someone else" and shows the order as it is now. Check it, then send again.

### Changing a sent order

Change the form and press **Save**. The order stays sent and shows **Changed since rev n** in orange, on the order, the job and the list, until you send it again. To send the change, press **Send revision n+1**, then **Print** and send the print. The sent date can't be before the previous revision's.

An order that hasn't changed since its last revision can't be sent again ("Nothing has changed since revision n was sent").

### Revisions

Each sent revision is kept exactly as it was sent. The order's **Revisions** list shows "Revision n, sent d Mon yyyy by Name", each with its own **Print**, so you can reprint what the supplier actually received.

## Cancelling and restoring

**Cancel order** (with a confirmation) cancels an order. Nothing is deleted. A cancelled order is read-only and hidden from the job and the list unless you ask for cancelled ones. **Restore** brings it back as it was: a draft, or sent at its last revision.

An **archived job** takes no new stone orders and no changes. Its orders can still be printed and cancelled.

## The Stone orders page

Open **Design/PM**, then **Stone orders** (Design/PM, Ordering and admin). It lists the open stone orders (drafts and sent orders, on jobs that aren't archived), soonest requested install first. The filter changes this to **Cancelled** or **All**. The **Requested install** column is orange when the install is within 14 days and the order is still a draft or has unsent changes.

There's no New button: a stone order always starts from its job's Benchtops section, so it belongs to a job. **Print blank benchtop sheet** is in the page header.

## The Design/PM dashboard

The **Stone orders** tile shows how many orders are drafts and how many have changed since they were sent, and, in orange, how many installs are requested in the next two weeks on orders that still need sending (drafts, and orders changed since they were sent), on jobs that aren't archived. **Open Stone orders** goes to the list.

## The prints

Both prints are A4, black on white, on our letterhead (the banner, then the business address, phone and email). They carry no ABN and no bank details, as the supplier reads them.

- **The stone order:** "Stone benchtop order", who it's to, the revision and date sent, then Job, Contacts, Stone, Dates (the requested benchtop install in bold), the line asking for all details, cut-outs included, to be marked on site before the final measure, the notes, and who ordered it. A print of a draft, or of an order changed since it was sent, says **DRAFT – NOT SENT** at the top, with no revision or sent date. On screen, the draft print of a changed order has a link **Print revision n as sent**, which prints the copy the supplier last received (handy for Accounts and Scheduling, who don't have the Stone orders page). A cancelled order prints with a **CANCELLED** box at the top.
- **The benchtop sheet:** the job, client, site address, quote and the Joinr benchtop text, then a large blank box to draw the benchtops in, and the edge key at the foot: `[ ]` square edge, `//` rolled edge, `X` raw edge. **Print benchtop sheet** on the job fills the job in; **Print blank benchtop sheet** on the Stone orders page leaves the lines empty to write on. Always one page: very long job details or benchtop text print in smaller type rather than being cut off.

An on-screen drawing tool for the benchtop sheet is a future development (`docs/plans/roadmap.md`).

## The batten calculator

Open **Design/PM**, then **Batten calculator** (Design/PM, Ordering and admin). It works out an even batten spacing. Nothing is saved.

1. Type the **space to fill** and the **batten width** (25 mm unless you change it), in millimetres.
2. Choose the ends: **Batten at each end** (the run starts and finishes on a batten) or **Gap at each end**.
3. Choose what to work out: **the gap** from the number of battens, or **the number of battens** from the gap you'd like (it picks the count whose gap comes closest; a tie takes more battens).

The result updates as you type: "<count> battens of <width> mm, <gaps> gaps of <gap> mm", the exact gap, the total and the left-over. The gap is rounded **down** to the half millimetre, so the run never comes out longer than the space. Any left-over sits at the far end.

Under the result are a drawing of the run (battens filled, gaps empty) and the **set-out**: where each batten starts and ends, in mm from the start. **Print** puts the inputs, the result, the drawing and the set-out on an A4 page.

If the numbers don't work (for example, the battens don't leave a gap in the space), it says why instead of giving a result.
