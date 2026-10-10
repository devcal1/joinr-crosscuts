# How login works

The reference for Crosscuts' logins, sessions, roles and enforcement. `docs/plans/m1-contracts.md` is the source of truth. If this page disagrees with it, the contract wins and this page needs fixing.

## Sessions

- Cookie `crosscuts_sid`: HttpOnly, SameSite=Lax, no Secure flag (the LAN and Tailscale addresses are plain http).
- **Default:** 12 hours from login.
- **"Remember this device":** 30 days, sliding. Each use extends it (refreshed at most every 5 minutes).
- Logout, disabling a user, a password reset, or "sign out everywhere" ends sessions.
- **Lock** keeps the session but hides the screen until unlocked with PIN or password.

## PIN

- Optional, 4 to 6 digits. Set or clear it from the user menu, with the current password.
- Works only on a device that logged in with a password and "Remember this device", and only to unlock that device's locked session. Never on a fresh browser, after logout, or on a non-remembered session.
- 5 wrong PINs on one device disable PIN on that device until the next password login.
- 10 wrong PINs for one user within an hour disable PIN for that user until the next password login.

## Passwords and lockout

- A password a user chooses must be at least 8 characters.
- 10 failed logins for one username from one IP within 15 minutes triggers a lockout (HTTP 429 with a retry time).
- 30 failed password attempts from one IP within 15 minutes, across any usernames, also trigger a lockout (HTTP 429 with a retry time).
- An attempt is recorded in `auth_attempts` before the password is checked and marked successful afterwards, so a burst of simultaneous guesses counts against the limits while it is still running. Attempts are also written to the audit log.
- At most 4 password or PIN checks run at once across the whole app. Beyond that the server answers `429 {"error":"Busy, try again","retryAfterSec":2}` and records no attempt.
- Changing your own password signs out your other sessions and forgets your other remembered devices.

## Roles and feature keys

A role is a preset: a set of feature keys. A user's effective permissions are the union of their roles' keys, then each override is applied. A **grant** adds a key; a **revoke** removes it. Unknown keys in overrides are refused (400).

Keys marked † only gate a shell page so far. `accounts.view`, `invoices.edit` and `orders.mark_ordered` went live in M2 (Accounts): see `docs/plans/m2-contracts.md`.

| Feature key | Admin | Accounts | Design/PM | Scheduling | Showroom |
|---|:-:|:-:|:-:|:-:|:-:|
| `board.view` | Yes | Yes | Yes | Yes | |
| `board.edit` | Yes | | | Yes | |
| `workers.edit` | Yes | | | Yes | |
| `jobs.view` | Yes | Yes | Yes | Yes | |
| `jobs.edit` | Yes | | Yes | | |
| `jobs.value` | Yes | Yes | Yes | | |
| `photos.search` | Yes | Yes | Yes | Yes | Yes |
| `photos.admin` | Yes | | Yes | | |
| `accounts.view` | Yes | Yes | | | |
| `invoices.edit` | Yes | Yes | | | |
| `reports.upload` † | Yes | Yes | | | |
| `design.view` † | Yes | | Yes | | |
| `orders.edit` † | Yes | | Yes | | |
| `orders.mark_ordered` | Yes | | | | |
| `inspections.edit` † | Yes | | Yes | | |
| `scheduling.view` | Yes | | Yes | Yes | |
| `leave.edit` † | Yes | | | Yes | |
| `tasks.use` † | Yes | Yes | Yes | Yes | |
| `messages.use` † | Yes | Yes | Yes | Yes | |
| `users.admin` | Yes | | | | |
| `audit.view` | Yes | | | | |

Known M1 limit: the board does not hide edit controls from view-only users. The server refuses their edits with a 403.

## Enforcement

Enforcement is on the server. Screens only hide things for convenience.

- **API routes:** each route declares its access in `defineRoutes`.
  - Not logged in: `401 {"error":"Not logged in"}`.
  - Locked: `401 {"error":"Locked","locked":true}`.
  - No permission: `403 {"error":"Forbidden"}`.
- **HTML pages:** checked before the file is served. The list is in `lib/pages.js`. Unlisted `.html` pages need only a login.
  - Not logged in, or locked: `302` to `/login.html?next=<page>`.
  - No permission: a `403` page.
- **Photo images:** any login, otherwise `401`.
- **Always open:** `/healthz`, the login and setup pages and their assets, and the auth calls for login, setup, unlock and logout.

## CSRF

Cookies are SameSite=Lax. Every non-GET request must also send an `Origin` header matching `Host`. A mismatch gets `403`.

## First admin

`/setup.html` creates the first admin and logs them in with "remember" on. It works only while there are no users. After that, `/api/auth/setup` returns 404.

## Why scrypt

Passwords and PINs use Node's built-in `crypto.scrypt` (N=2^15, r=8, p=1). The parameters are stored with each hash, so they can be raised later. This departs on purpose from the brief's bcrypt-or-argon2 suggestion: those need a native package that could break the multi-arch build or the Windows dev box.

## If the admin forgets a password

There is **no email reset.**

- Another admin can reset the password on the Users page. The user must change it at next login, and their sessions end.
- If the only admin forgets their password, there is **no recovery path yet**. A recovery runbook, with a manual step on the Umbrel, is to be written. It is not yet available.
- Until then, keep a second admin account.
