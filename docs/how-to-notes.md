# How to use the department notes in Crosscuts

For everyone in Scheduling, Design/PM, Ordering, Accounts and Admin. Each department has a **Notes** page that works like sticky notes on a wall: a column for each weekday, and the people in that department stick signed notes on the day they are for.

## Open it

Open your department's menu (Scheduling, Design/PM, Ordering, Accounts or Admin). **Notes** is the first item. The page title says which department it is, for example **Accounts notes**.

Only the people in that department can open and use its notes. If you open another department's Notes page you get a short message and no notes.

Each department's notes have their own permission: `notes.scheduling`, `notes.design`, `notes.ordering`, `notes.accounts` and `notes.admin`. People get theirs with their role (Scheduling, Design/PM, Ordering and Workshop Manager, Accounts; admins have all five). To give someone another department's notes, or take theirs away, an admin opens them on the Users page and grants or revokes the key. Showroom and Workshop logins have none.

## The wall

The page shows one week at a time, Monday to Friday, five columns. Each column is headed with the day and date (for example **Tue 13 Oct**); today's heading is teal and says **today**. Notes are cream paper notes stacked in the order they were posted. Every note is signed at the bottom with the name of the person who wrote it and the time, for example **Design Test A · 11:20 am**. You never type your name.

## Move between weeks

Above the wall: **Last week**, **This week** and **Next week**. Press **Last week** again and again to go back as far as you like; **Next week** goes forward without limit. The heading shows which week you are on ("Week of Mon 12 Oct"), and the address of the page holds the week, so you can send someone a link to a week or refresh and stay on it.

Past weeks are read-only: you can read them and thumbs-up notes in them, but you can't add, change or remove notes there.

## Leave a note

1. Press **Add note**, or press **+ NEW NOTE** at the bottom of a day's column (only today and later days have one).
2. Type the note. Pick the **Day** it is for. It starts on today (or, on a Saturday or Sunday, on Monday), or on the column you pressed.
3. Press **Post note**.

You can put a note on today or any later weekday, this week or in a future week. Go to **Next week** first to see that week's columns. Notes can be up to 2,000 characters. Line breaks are kept. The text is shown as plain text: links and formatting are not turned into anything.

## Change or remove your note

Your own notes have **Edit** and **Remove**, as long as the note's week is this week or a later one.

- **Edit** opens the note in a box with a **Day** list. Change the words, or move the note to another day (today or later, this week or the next), then **Save**. **Cancel** leaves it as it was. The note says "(edited)" afterwards.
- **Remove** asks "Remove this note?". **Remove** again takes it off the wall for good; **Keep** cancels.

Only the person who wrote a note can change it. Nobody else can change or remove it, admins included. Once the note's week is over it is locked: if you try, you get "That week is over, so the note can no longer be changed or removed."

## Thumbs-up

Each note has a small thumbs-up mark with a count, and the names of the people who gave one ("Todd, Sam"). Press it to say you have seen the note; press it again to take it back. When you have given one, your count is bold.

You can't give your own note a thumbs-up (your mark is greyed out). You can thumbs-up a note in any week, including past ones.

## Looking up who changed what

Adding, editing, moving and removing a note are recorded in the audit log (Admin, Audit) as `note.create`, `note.update` and `note.remove`, with the text and day as they were and as they became. Thumbs-ups are recorded as `note.ack` and `note.unack`. A removed note is hidden on the page but its text is still in the audit log.

## Phones

On a narrow screen the five columns stack one under another, Monday first, with each day's heading above its notes.

## Printing

The page prints black on white with just the wall: the menu, the buttons and the add form are left off.
