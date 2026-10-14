# M12 Design/PM tools: plan

Status: **M12 · 1.3 done: Todd answered every question (2026-10-14); plan approved** (Decisions in section 5; every answer was the recommended option, so sections 2 and 4 stand as written).

Scope (Todd, 2026-10-12, `jobs-master-tabs.md`): three Design/PM tabs of the jobs master workbook: the **Stone Order** form (needs the design's edge and profile details), the **Benchtop Letterhead** (a printable benchtop drawing sheet with the edge key, attached to the job) and **Calc-Batons** (a small batten spacing calculator).

This repo is public: no client, supplier or job details from the workbook, no prices.

## 1. Audit (M12 · 1.1, 2026-10-14)

Three read-only surveys: the workbook tabs (read from a copy; the original was open in Excel), the Crosscuts code, and Joinr (`tenon-quotr`, read and searched only, CLAUDE.md rule 12).

### 1.1 The workbook tabs

**Stone Order** (one page, "Stone Benchtop Order Confirmation Form"):

- It is **the stone supplier's own form**, filled in from our side: their logo and their address, email, phone and ABN are typed into the header. "Customer" holds our own company name. So the form belongs to one supplier.
- **Order details:** Customer, Job Reference, Quote #, Revision (a list, 1 to 10); Stone Brand (a list of seven engineered-stone brands), Colour (free text), **Edge Height** (a list: 20, 36, 40, 50, 60 mm), **Edge Profile** (a list: Aris, 6x6 round, 10x10 round, Square).
- **Site:** Job Address; "Job Type", used for site-access notes (occupied home, lockbox and so on).
- **Contacts:** Orderer contact and phone (our staff); Client contact and phone.
- **Dates:** Estimated cabinetry install date; Estimated measure/template pickup date; **Requested benchtop install date** (the emphasised field).
- **Fixed text** (the supplier's terms): mark all details, cut-outs included, on site before the final measure; the supplier aims to install within 10 business days of the site measure and will say if it's delayed.
- **Notes:** a 12-line box. The saved sheet uses it for the sink (drop-off) and meeting on site.
- **Sign-off:** Ordered By (initials) and Date, which is `NOW()`, so it shows the day the sheet is opened or printed, **not the day it was ordered**. That is the tab's only formula.
- The saved sheet holds one real job, filled in end to end (private; not copied here). Print setup is Letter, not A4, and the lookup lists sit beside the form, so a plain print spills onto extra pages.

**Benchtop Letterhead** (one A4 page):

- Our banner logo (the same one as `public/assets/invoice-letterhead.png`), the website and street address, **Job Name** (blank), then a **blank drawing area** (no grid) filling most of the page.
- The **edge key** at the foot: `[]` square edge, `//` rolled edge, `X` raw edge.
- No formulas, no lists. The saved sheet is blank: it is printed and drawn on by hand. A "Print" cell beside it is only a coloured label.

**Calc-Batons** (a strip of cells, no print setup):

- One input, **Gap** (58 as saved). Then a picture of the run: 22 batten cells of **25** (shaded black) with 21 gap cells between them, and **Total** = the sum (1768 as saved).
- The maths: total = n × w + (n − 1) × g, with n = 22 battens of width w = 25 mm and gap g. It starts and ends on a batten (no end gaps) and has no rounding.
- **It doesn't solve for the gap:** you change the gap until the total fits the wall. The number of battens is fixed by the columns; changing it means adding or deleting columns by hand.
- Nothing links to it from the Main tab.

None of the three tabs has formulas that refer to another tab.

### 1.2 Crosscuts today

- **Jobs:** the job has `benchtop` (laminate, stone or none), `sheet_count`, `is_two_pac`, `job_type`, `quote_number`, `site_address`, the client's name, phone and email, `promised_install_date` and `design_signed_off_date` (a plain date, no logic). **No stone, colour, edge, profile, thickness or drawing fields.** Stone plus two-pac adds the "return visit" production stage (M5).
- **Joinr sends almost nothing about benchtops:** `spec.benchtop` (laminate, stone or none, worked out from the room text) and `raw.benchtops` (each room's benchtop text as typed, e.g. "Stone 20mm"). Accept writes the raw text into the job's notes. Joinr itself holds **no benchtop sizes, edges, profiles, cut-outs, splashbacks, colours or suppliers, and nothing about battens** (its benchtop lines are metres against a price). So the M12 forms are typed in Crosscuts; only the job's own details (name, quote number, address, client contact, the benchtop text) can be filled in for you. Prefilling more would need a Joinr change (rule 12).
- **The job page** has sections (form, From Joinr, Orders with M11's drawer grid, Inspection, Planner, Photos, Tasks, Comments, Invoices), each gated by a key. **Nothing prints from the job page today.** The From Joinr section doesn't show the raw benchtop text (only the Intake page does).
- **Design/PM:** the `design_pm` preset holds jobs.view, jobs.edit, design.view, orders.edit, orders.receive and others, but **not** `orders.mark_ordered` (M3 Q1: only Ordering and admin mark lines ordered). jobs.edit is held by admin and design_pm only; jobs.view also by accounts, scheduling and ordering. The Design/PM menu holds Design/PM (`/design.html`, a dashboard with one tile), Jobs, Pipeline and Intake. 27 keys; a new key needs no migration (touch points in `how-to-add-feature-key.md`).
- **Orders:** lines are free text. A line still "to order" holds back the job's **50% progress invoice** (it falls due when the job's last line is marked ordered). M11's drawer and paint lines are "managed" lines tied to their own page through side tables (`lib/orderlinks.js`).
- **Printing:** the paint order prints the letterhead banner and the business details (name, address, phone, email; no bank details) from `routes/paint.js`; payprint, the drawer sheet and invoices are the other paper forms. All A4, black on white, inside the style check's print markers.
- **Files:** photos (JPEG/PNG/WebP) can be linked to a job, so a phone photo of a hand drawing can go on the job today. PDFs can't be attached to a job (the private file store links only to reports, tasks and supplier statements).
- **Shared maths:** `public/paymaths.js`, `drawers.js` and `periods.js` are plain modules used by both server and page; a batten module fits the same pattern.
- **Version** 0.1.15; migrations end at 024.

## 2. Proposed shape

### 2.1 Stone order (questions 1 and 2)

- **A stone order belongs to a job.** On the job page, a new **Benchtops** section lists the job's stone orders and has **New stone order** (shown when the job has jobs.edit; it suits any job, but is offered first when the benchtop is stone).
- **The form** follows the workbook's fields, with what Crosscuts already knows filled in and still editable: job reference (job name), quote number, job address, client contact and phone, our contact (the person filling it in), the estimated cabinetry install date (the job's promised install date). Typed in: stone supplier, stone brand, colour, edge height, edge profile, site-access notes, estimated measure/template date, requested benchtop install date, notes.
- **Lists:** edge height and edge profile as the workbook's lists plus "Other" (typed); stone brand and supplier as free text that suggests names used before (as Orders' supplier names do).
- **Print** gives one A4 page in our house letterhead (the banner and business details, as the paint order), addressed to the supplier, with the fields above, the line "please mark all details, including cut-outs, on site before the final measure", and **Ordered by** and the **date it was sent** (fixed, not today's date).
- **Sent and revisions:** **Mark sent** freezes what was sent (revision 1). Changing a sent order and sending it again makes revision 2, and so on; each sent revision can be printed again as it was. Cancel keeps it for the record.
- **Not an Orders line** (recommended, question 1): a stone line on Orders would hold back the job's 50% progress invoice until someone with mark-ordered rights marked it, and stone is booked around the cabinetry install, well after the materials. So the stone order lives in its own section and doesn't touch the invoice rule, Deliveries or "materials in".
- **A Design/PM list page, Stone orders** (Design/PM menu): every open stone order (job, supplier, revision, sent date, measure date, requested install date), so Design/PM can see what's booked and what's still a draft.

### 2.2 Benchtop sheet (question 3)

- **Print benchtop sheet** in the job's Benchtops section: the workbook letterhead page in A4, with the job's details already on it (job name, client, site address, the benchtop text from Joinr), a large blank drawing area, and the edge key (square, rolled, raw). Drawn on by hand, as now.
- A **blank** sheet (no job) from the Stone orders page, for drawing before a job exists.
- The finished drawing goes on the job as a **photo** (already possible), and can be listed in the stone order's notes. No drawing on screen (that would be a much bigger tool).

### 2.3 Batten calculator (question 4)

- A **Batten calculator** page (Design/PM menu): type the **space to fill** (mm), the **batten width** (25 by default) and either the **number of battens** or the **gap you'd like**; it works out the other one and shows the result. Ends: starts and ends on a batten (as the workbook), or a gap at each end.
- It answers the **gap** to the nearest 0.5 mm, the **total** it gives (and any left over), and the **set-out**: where each batten starts, measured from the start, ready to mark out. A drawing of the run like the workbook's strip.
- **Print** gives the set-out on one A4 page. Nothing is saved (a scratch pad, like Joinr's timber calculator).

### 2.4 Keys and menu (question 5)

- **No new key** (recommended): seeing a job's stone orders needs jobs.view; making, editing, sending and cancelling needs jobs.edit (admin and Design/PM); the Stone orders page and the Batten calculator are gated by design.view (admin, Design/PM, Ordering).
- **Design/PM menu** gains Stone orders and Batten calculator; the Design/PM dashboard gains a "Stone orders" tile (drafts, and installs requested in the next two weeks).

### 2.5 Build size

- One additive migration 025 (stone orders and their sent revisions). One shared module `public/battens.js`. Pages: the job's Benchtops section, `stone.html` (list and the form), the two prints, `battens.html`. One smoke file `ci/smoke-m12-stone.sh`. Version 0.1.16.
- Small enough for **one build wave** of three tasks (A stone backend; B stone pages and prints; C batten calculator).

## 3. Questions for Todd (asked one at a time)

1. **Stone order and Orders:** keep the stone order in its own section, off the job's Orders, so it never holds back the 50% invoice? (Recommended.) Or make it an Orders line as well, so it shows on Orders/Deliveries?
2. **The printed stone form:** our letterhead, addressed to whichever stone supplier is chosen (recommended), or keep one usual stone supplier's details stored in Crosscuts and print their form as now?
3. **Benchtop sheet:** a printed sheet with the job's details filled in, drawn on by hand and photographed onto the job (recommended), or a drawing tool on screen?
4. **Batten calculator:** works out the gap from the space and the number of battens (or the number from a gap you'd like), with the set-out to mark from and a print (recommended); and who uses it: Design/PM only, or the workshop logins too?
5. **Keys:** no new key; stone orders with jobs.view to see and jobs.edit to change; the calculator and Stone orders page with design.view (recommended)?

## 4. Lead's defaults (unless Todd says otherwise)

1. The workbook's 10-business-day install promise is the supplier's term; it's left off our form.
2. "Customer" (our own name) is dropped: the letterhead says who we are.
3. Revision numbers count up by themselves on each send; there is no list of 1 to 10.
4. Starting fresh: nothing is imported from the workbook.
5. The requested benchtop install date is not put on the board or the Planner in M12.
6. The From Joinr section on the job page starts showing the raw benchtop text (it's already sent).

## 5. Decisions (Todd, 2026-10-14)

1. **Stone order: its own Benchtops section on the job**, off the job's Orders. It never holds back the 50% progress invoice and doesn't appear on Orders or Deliveries (§2.1).
2. **The printed stone form: our letterhead**, addressed to whichever stone supplier is chosen on the order (§2.1).
3. **Benchtop sheet: the printed sheet** with the job's details, drawn on by hand and photographed onto the job's Photos, plus a blank sheet (§2.2). **An on-screen drawing tool is flagged as a future development** (not in M12; listed in `roadmap.md`).
4. **Batten calculator: in the Design/PM menu, for design.view holders** (admin, Design/PM, Ordering); it solves the gap or the number of battens, shows the set-out and prints it; nothing is saved (§2.3).
5. **Keys: no new key.** jobs.view to see a job's stone orders, jobs.edit to make, edit, send and cancel; design.view for the Stone orders page and the calculator. The count stays at 27, no role changes (§2.4).

The lead's defaults in section 4 stand.
