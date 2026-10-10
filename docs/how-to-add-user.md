# How to add and manage users

For Todd. Users are managed on the **Users** page. Only admins can open it.

The steps below describe the screen as it is planned. Button and menu names may differ slightly once it is built. The rules behind them are in [auth.md](auth.md).

## Add a user

1. Open **Users** and choose **Add user**.
2. Enter a username (the name they type to log in; it is not case-sensitive), their display name, and a starting password.
3. Tick their roles. A person can have more than one. The list is below.
4. Save.
5. Tell them the username and starting password in person. They will be asked to choose their own password at first login.

## Roles, in plain English

- **Admin:** everything, including users and the audit log.
- **Accounts:** bookkeeping, invoices, job values, photo search.
- **Design/PM:** jobs, design, orders, inspections, photo admin, scheduling view.
- **Scheduling:** the board (moving jobs, workers, leave).
- **Showroom:** photo search only. Used for the shared showroom account.

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
| Floor crew | None | No login. They only watch the TV |

**Tip for Sam's Chromebook:** at login, tick **Remember this device**. The login then lasts 30 days and keeps sliding, so the TV device does not log out during daily use. Sam can also set a PIN, so that after pressing **Lock** he can unlock with the PIN instead of the password.

Use the same tick on the showroom device, so it stays logged in.
