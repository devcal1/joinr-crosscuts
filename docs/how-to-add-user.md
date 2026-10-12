# How to add and manage users

For Todd. Users are managed on the **Users** page. Only admins can open it.

The steps below describe the screen as it is planned. Button and menu names may differ slightly once it is built. The rules behind them are in [auth.md](auth.md).

## Add a user

1. Open **Users** and choose **Add user**.
2. Enter a username (the name they type to log in; it is not case-sensitive), their display name, and a starting password.
3. Tick their roles. A person can have more than one. The list is below.
4. Save.
5. Tell them the username and starting password in person. They will be asked to choose their own password at first login, and again every six months.

## Roles, in plain English

- **Admin:** everything, including users and the audit log.
- **Accounts:** bookkeeping, invoices, job values, photo search.
- **Design/PM:** jobs, design, adding and receiving order lines, inspections, photo admin, scheduling view.
- **Scheduling:** the board (moving jobs, workers, leave).
- **Showroom:** photo search only. Used for the shared showroom account.
- **Workshop:** the board and the Planner (Company-wide, Install & hardware and Workshop, read-only). For workshop logins (the floor crew, if they get one). It can't edit the board.
- **Ordering:** places orders: adds order lines and marks them ordered (marking a job's last line ordered makes its progress invoice due), sees jobs and design, receives deliveries. Gets the delivery notes and the "materials in" alerts.
- **Workshop Manager:** runs the workshop floor: the board to view, order lines to view and receive (the **Deliveries** page), the Planner (adds to Workshop), tasks and messages. No job pages, so no client details.

The office roles (Admin, Accounts, Design/PM, Scheduling, Ordering, Workshop Manager) also get the **Planner**, and can add events to the layers their role allows. Showroom has no Planner. Which planner layers a person sees follows their roles, not their overrides; the details are in [auth.md](auth.md).

## Overrides

An override gives one person one extra permission, or takes one away, without changing their role.

1. Open the person's entry on the Users page.
2. Choose a permission (a feature key such as `board.edit`) and pick **Grant** or **Revoke**.
3. To go back to the role's normal rights, remove the override.

Example: to stop Michael moving rows on the board while keeping his other scheduling rights, add a **Revoke** override for `board.edit`.

## Reset a password

1. Open the person's entry and choose **Reset password**.
2. Set a new starting password and tell them in person.

They are asked to change it at their next login. Their existing logins end, on every device.

## Sign someone out everywhere

Open the person's entry and choose **Sign out everywhere**. Every login for that person ends on every device. They can log in again with their password.

## Disable a user

Open the person's entry and turn off **Enabled** (or choose **Disable**). Their logins end straight away, and they cannot log in until you enable them again.

- You cannot disable yourself, or the last enabled admin.
- There is no delete option in M1. Disable people instead.

## Suggested setup

This is the plan from the brief (section 3.1).

| Person | Roles | Notes |
|---|---|---|
| Todd | Admin | |
| Chloe | Accounts | |
| Tracy | Accounts | |
| Jill | Accounts | |
| Aaron | Design/PM and Scheduling | |
| Jordan | Design/PM and Scheduling | |
| Sam | Scheduling | Chromebook drives the workshop TV |
| Michael | Scheduling | |
| Showroom | Showroom | One shared account for the showroom device |
| Ordering | Ordering | Whoever places the orders (M10) |
| Workshop Manager | Workshop Manager | Runs the floor and receives deliveries; not the Scheduler (M10) |
| Floor crew | None (or Workshop) | They watch the TV. A floor login, if wanted, gets Workshop |

**Tip for Sam's Chromebook:** at login, tick **Remember this device**. The login then lasts 30 days and keeps sliding, so the TV device does not log out during daily use. Sam can also set a PIN, so that after pressing **Lock** he can unlock with the PIN instead of the password.

Use the same tick on the showroom device, so it stays logged in.

**The workshop TV runs on Sam's own login** (Scheduling; Todd, 2026-10-13). Don't give Sam the Workshop role or take his Scheduling role away for it. The TV shows only the board: the board has no menu bar. **Workshop logins** for the floor crew, if wanted, see the board and the Planner and change nothing.
