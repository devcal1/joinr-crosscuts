# How to use the department notes in Crosscuts

For everyone in Scheduling, Design/PM, Ordering, Accounts and Admin. Each department has a **Notes** page: one shared sheet for the week where the people in that department leave signed notes for each other.

## Open it

Open your department's menu (Scheduling, Design/PM, Ordering, Accounts or Admin). **Notes** is the first item. The page title says which department it is, for example **Accounts notes**.

Only the people in that department can open and use its sheet. If you open another department's Notes page you get a short message and no notes.

Each department's sheet has its own permission: `notes.scheduling`, `notes.design`, `notes.ordering`, `notes.accounts` and `notes.admin`. People get theirs with their role (Scheduling, Design/PM, Ordering and Workshop Manager, Accounts; admins have all five). To give someone another department's sheet, or take theirs away, an admin opens them on the Users page and grants or revokes the key. Showroom and Workshop logins have none.

## Leave a note

1. In **This week**, type in the box.
2. Press **Add note**.

Your note appears at the top of this week, signed with your name and the day and time. Notes can be up to 2,000 characters. Line breaks are kept. The text is shown as plain text: links and formatting are not turned into anything.

## Change or remove your note

Your own notes in **This week** have **Edit** and **Remove**.

- **Edit** opens the note in a box. **Save** keeps the change (the note then says "(edited)"). **Cancel** leaves it as it was.
- **Remove** asks "Remove this note?". **Remove** again takes it off the sheet for good; **Keep** cancels.

Only the person who wrote a note can change it, and only during the week it was written. Nobody else can change or remove it, admins included. Once the week is over the note is locked: if you try, you get "That week is over, so the note can no longer be changed or removed."

## The weeks

Weeks start on Monday (Sydney time). On Monday morning the sheet starts blank under **This week**; last week's notes move down to **Last week**. Nothing needs doing for that to happen.

An empty week shows "No notes".

Press **Older weeks** under Last week to see earlier weeks, four at a time (weeks with no notes are skipped). Press it again for more; it disappears when there are no older notes. Nothing is ever deleted when a week rolls over, and older weeks can't be edited.

## Looking up who changed what

Adding, editing and removing a note are recorded in the audit log (Admin, Audit) as `note.create`, `note.update` and `note.remove`, with the text as it was and as it became. A removed note is hidden on the page but its text is still in the audit log.

## Printing

The page prints black on white with just the sheets: the menu, the box and the buttons are left off.
