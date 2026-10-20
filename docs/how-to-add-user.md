# How to add and manage users

For Todd. Users are managed on the **Users** page. Only admins can open it.

The steps below describe the screen as it is planned. Button and menu names may differ slightly once it is built. The rules behind them are in [auth.md](auth.md).

## Add a user

1. Open **Users** and choose **Add user**.
2. Enter a username (the name they type to log in), their display name, and a starting password. **A username can be a name or an email address** (Todd, 2026-10-20), for example `accounts@thcabinets.com.au`. It is not case-sensitive, and it is saved in lowercase. A name is 2 to 32 letters, numbers, dots, dashes or underscores; an email address is up to 64 characters.
3. Tick their roles. A person can have more than one. The list is below.
4. Save.
5. Tell them the username and starting password in person. They will be asked to choose their own password at first login, and again every six months.

## Roles, in plain English

- **Admin:** everything, including users and the audit log, **except the three owner-only pages** (Bonuses, Alarms and Loans), which only the owner has (below).
- **Accounts:** bookkeeping, invoices, job values, photo search.
- **Design/PM:** jobs, design, adding and receiving order lines, inspections, photo admin, scheduling view. From M11 it also **checks each job's drawer grid** (Joinr's drawer counts, or ones typed in) before the grid goes on the Drawer order. From M12 it makes and sends each job's **stone orders** (the job's Benchtops section and Design/PM, then **Stone orders**) and has the **Batten calculator**.
- **Scheduling:** the board (moving jobs, workers). Leave and part-time patterns are entered by an admin on the Availability page (Admin menu) since 2026-10-16. From M12 it can print a job's stone orders and benchtop sheet from the job page (as can Accounts).
- **Showroom:** photo search only. Used for the shared showroom account.
- **Workshop:** the board and the Planner (Company-wide, Install & hardware and Workshop, read-only). For workshop logins (the floor crew, if they get one). It can't edit the board.
- **Ordering:** places orders: adds order lines and marks them ordered (marking a job's last line ordered makes its progress invoice due), sees jobs and design, receives deliveries. Gets the delivery notes and the "materials in" alerts. **From M11 it also runs the Ordering pages:**
  - the **Drawer order** (adds up the checked drawer grids, places the order, keeps the drawer name list),
  - the monthly **Stock order** (types what to order and marks each supplier ordered),
  - **Paint orders**, and
  - the **Board stocktake** (keeps the board list and its prices, and can reopen a finished count).

  Ordering can count too, so it can fill in for the Workshop Manager. It sees board prices. From M12 it also sees the **Stone orders** page and the **Batten calculator**, and reads and prints stone orders, but can't change them.
- **Workshop Manager:** runs the workshop floor: the board to view, order lines to view and receive (the **Deliveries** page), the Planner (adds to Workshop), tasks and messages. No job pages, so no client details. **From M11 it also does the monthly counts:** it types **Have** on the **Stock order** and the sheet quantities on the **Board stocktake**, and finishes each count. It never sees board prices, and it has no Drawer order page and no Paint orders menu entry. It receives the stock, paint and drawer deliveries on **Deliveries**, and can open a paint order from there to receive it.

The office roles (Admin, Accounts, Design/PM, Scheduling, Ordering, Workshop Manager) also get the **Planner**, and can add events to the layers their role allows. Showroom has no Planner. Which planner layers a person sees follows their roles, not their overrides; the details are in [auth.md](auth.md).

## The owner (from M13)

One login is **the owner**: Todd's. The Users page shows an **OWNER** mark by its name. The owner is an admin who also holds the three **owner-only keys**, which no role gives, admin included (approved by Todd 2026-10-16):

| Key | Page | Menu |
|---|---|---|
| `bonuses.manage` | Bonuses ([how-to-bonuses.md](how-to-bonuses.md)) | Admin |
| `alarms.manage` | Alarms ([how-to-alarm-codes.md](how-to-alarm-codes.md)) | Admin |
| `loans.manage` | Loans ([how-to-loans.md](how-to-loans.md)) | Accounts |

**Who sees what:**
- **The owner** sees all three, and their rows in the audit log.
- **Another admin** sees none of them: no menu items, the pages refused, and their rows left out of the audit log. Users and Audit work as before. Their effective permissions read "(32 of 35)".
- **Someone the owner grants a key to** sees that page only. For example, an Accounts login granted `loans.manage` sees **Loans** under Accounts, and nothing else of the owner's.

**What another admin can't do:**
- Change anything on the owner's login. Opening it shows "Only the owner can change the owner's login." in place of its controls (the name, roles, disable, sign-out, password and overrides).
- Grant or revoke an owner-only key, for anyone, themselves included. Those lines in the override list have their buttons turned off, with "Only the owner can grant this".
- Reset the password of someone holding an owner-only key by a grant. The reset box is replaced by "Only the owner can reset this password (they hold <key>)." They can still disable that person or sign them out.

On the owner's own entry, the override list says "The owner holds every key." (overrides don't apply to the owner). An override left over from before shows with **Clear** only. The owner sees the owner-only keys in everyone else's override list marked "owner only", and grants them like any other key.

### Hand over ownership

Only the owner can do this, and only to another **enabled admin**.

1. Open that admin's entry and press **Transfer ownership** (under **Ownership**).
2. The dialog says what happens: they become the owner and get every key; you stay an admin without the owner-only keys unless they grant them back.
3. Type their username where it says **Type <username> to confirm**, and **Your password**.
4. Press **Transfer**. The page reloads.

Nobody's sessions end. A mistyped username or a wrong password is refused in the dialog.

## Overrides

An override gives one person one extra permission, or takes one away, without changing their role.

1. Open the person's entry on the Users page.
2. Choose a permission (a feature key such as `board.edit`) and pick **Grant** or **Revoke**.
3. To go back to the role's normal rights, press **Default** (this removes the override).

**The owner-only keys** (`bonuses.manage`, `alarms.manage`, `loans.manage`) are granted the same way, but only the owner can grant or revoke them. Example: to give an Accounts login the Loans page, the owner grants it `loans.manage`.

Example: to stop Michael moving rows on the board while keeping his other scheduling rights, add a **Revoke** override for `board.edit`.

**From M11, two keys cover the Ordering pages:** `stock.count` (type Have and board quantities; Workshop Manager, Ordering and admin) and `stock.order` (the lists, board prices, the stock order's Order column, the Drawer order, paint orders, and reopening a board count; Ordering and admin). To let one person count stock without the Workshop Manager role, grant them `stock.count`. No role was added, but the Ordering and Workshop Manager presets gained the stock keys (Ordering both, Workshop Manager `stock.count`), so nobody needs a new override because of M11. The pages and what gates them are in [auth.md](auth.md).

**From M10, orders have their own keys.** Seeing the Orders page is `orders.view` (not `jobs.view`), and receiving deliveries is `orders.receive` (not `orders.edit`). If you had set an override on `jobs.view` or `orders.edit` to control someone's access to orders, set it again on the new key.

## Link a login to a board worker

Logins and the board's workers (Workers page) are separate lists. Linking a login to a worker is what gives that person's name its colour on the Pipeline.

1. Open the person's entry on the Users page.
2. Under **Profile and roles**, pick their name in **Board worker** (or **None**). It saves straight away, and a small swatch shows the worker's colour.
3. A worker can be linked to one login only; a worker already linked to someone else is greyed out in the list.

Why it matters: anyone who can edit jobs can put their own name on a Pipeline job tile (the small **+ ME** button on the tile, or **Add me** on the job page) and take it off again. Their name appears as a small chip in their worker colour; a login with no worker gets a grey chip. Everyone who can see the Pipeline sees the names. An admin can remove anyone's name (click the chip, or the name on the job page). Changing a worker's colour on the Workers page changes the chip too.

## Change a username

Dated 2026-10-20. Use this to move someone onto their email address, or to fix a typo.

1. Open the person's entry and press **Change username** (under **Account**).
2. Type the new username (a name or an email address) and press **Save**.

Their password, roles, exceptions and board worker stay exactly as they were, and they stay signed in. From next time they sign in with the new username; the old one stops working at once. A username already used by anyone else (in any capitals) is refused in the dialog. Only the owner can change the owner's username. The change is written to the audit log (`user.username`, with the old and new name).

## Reset a password

1. Open the person's entry and choose **Reset password**.
2. Set a new starting password and tell them in person.

They are asked to change it at their next login. Their existing logins end, on every device.

Only the owner can reset the owner's password, or that of someone holding an owner-only key by a grant (above). **If the owner forgets their password, nobody else can reset it**, so keep it in the password manager ([auth.md](auth.md)).

## Sign someone out everywhere

Open the person's entry and choose **Sign out everywhere**. Every login for that person ends on every device. They can log in again with their password. Only the owner can sign the owner out.

## Disable a user

Open the person's entry and turn off **Enabled** (or choose **Disable**). Their logins end straight away, and they cannot log in until you enable them again.

- You cannot disable yourself, or the last enabled admin. Nobody can disable the owner (the owner can't disable themselves, and nobody else may change the owner's login): hand over ownership first.
- There is no delete option in M1. Disable people instead.

## Suggested setup

This is the plan from the brief (section 3.1).

| Person | Roles | Notes |
|---|---|---|
| Todd | Admin | The owner (M13): also Bonuses, Alarms and Loans |
| Chloe | Accounts | |
| Tracy | Accounts | |
| Jill | Accounts | |
| Aaron | Design/PM and Scheduling | |
| Jordan | Design/PM and Scheduling | |
| Sam | Scheduling | Chromebook drives the workshop TV |
| Michael | Scheduling | |
| Showroom | Showroom | One shared account for the showroom device |
| Ordering | Ordering | Whoever places the orders (M10), and runs the drawer, stock and paint orders and the board stocktake (M11) |
| Workshop Manager | Workshop Manager | Runs the floor, receives deliveries and does the monthly stock and board counts; not the Scheduler (M10, M11) |
| Floor crew | None (or Workshop) | They watch the TV. A floor login, if wanted, gets Workshop |

**Tip for Sam's Chromebook:** at login, tick **Remember this device**. The login then lasts 30 days and keeps sliding, so the TV device does not log out during daily use. Sam can also set a PIN, so that after pressing **Lock** he can unlock with the PIN instead of the password.

Use the same tick on the showroom device, so it stays logged in.

**The workshop TV runs on Sam's own login** (Scheduling; Todd, 2026-10-13). Don't give Sam the Workshop role or take his Scheduling role away for it. The TV shows the board, with the shared menu bar above it (from 0.1.14). **Workshop logins** for the floor crew, if wanted, see the board and the Planner and change nothing.
