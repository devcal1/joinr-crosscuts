# Crosscuts

Crosscuts is the TH Cabinets operations app. It runs on the Umbrel home server, on the workshop LAN and over Tailscale. It is the successor to the TH Cabinets schedule app. The old app keeps running until Crosscuts takes over.

## What is in M1

- **Personal logins.** Each person has their own username and password. An optional 4 to 6 digit PIN can unlock a remembered device.
- **Roles.** Each person has one or more roles: Admin, Accounts, Design/PM, Scheduling or Showroom. Roles decide which pages and actions each person can use. See [docs/auth.md](docs/auth.md).
- **Schedule board.** Unchanged, now behind login.
- **Jobs.** A job list and job pages, with a stage for each job.
- **User admin.** Admins add users, set roles, and reset passwords. See [docs/how-to-add-user.md](docs/how-to-add-user.md).
- **Audit log.** A record of logins, user changes and job edits, for admins.
- **Department pages.** Accounts, Design/PM and Scheduling are placeholders in M1. Their real content comes in later milestones. The tasks and notifications tiles on the home screen are placeholders too.

## Install from the store

1. In umbrelOS, open the App Store and add a community app store with this URL: `https://github.com/devcal1/joinr-crosscuts`
2. Find **Crosscuts** in that store and install it.
3. Keep umbrelOS's **Require Umbrel login** toggle for Crosscuts **off**. Crosscuts does its own login, and the toggle would add a second one.

Until cutover, Crosscuts is for testing. The TH Cabinets board is still the schedule of record.

## First run

1. Open `http://<your-umbrel-address>:4091/setup.html` in a browser.
2. Enter a username, your display name and a password. This creates the admin account and logs you in.
3. The setup page stops working as soon as any user exists.
4. Add the other users from the Users page. Follow [docs/how-to-add-user.md](docs/how-to-add-user.md).

## Documentation

- [CLAUDE.md](CLAUDE.md): engineering rules, for engineers and agents.
- [docs/auth.md](docs/auth.md): how logins, sessions, roles and enforcement work.
- [docs/how-to-add-user.md](docs/how-to-add-user.md): for Todd, managing users.
- [docs/how-to-add-feature-key.md](docs/how-to-add-feature-key.md): for engineers, adding a permission.
- [docs/rollback.md](docs/rollback.md): undoing a release.
- [docs/crosscuts-brief.md](docs/crosscuts-brief.md): the product brief and decisions.
