# How to use the department notes in Crosscuts

For everyone in Scheduling, Projects, Ordering, Accounts and Admin. Each department has a **Notes** page that works like sticky notes on a wall: five week columns, and the people in that department stick signed notes in the week they are for, with an optional day.

## Open it

Open your department's menu (Scheduling, Projects, Ordering, Accounts or Admin). **Notes** is the first item. The page title says which department it is, for example **Accounts notes**.

Only the people in that department can open and use its notes. If you open another department's Notes page you get a short message and no notes.

Each department's notes have their own permission: `notes.scheduling`, `notes.design`, `notes.ordering`, `notes.accounts` and `notes.admin`. People get theirs with their role (Scheduling, Projects, Ordering and Workshop Manager, Accounts; admins have all five). To give someone another department's notes, or take theirs away, an admin opens them on the Users page and grants or revokes the key. Showroom and Workshop logins have none.

## The wall

The page shows five weeks at a time, one column per week, with this week in the middle (outlined in teal) and two weeks behind and two ahead. Each column is headed **Week of 9 Nov** with a small label under it (**2 weeks ago**, **Last week**, **This week**, **Next week**, **In 2 weeks**). Notes are cream paper notes. Inside a week, notes with no day come first, then notes by their day tag (a small **MON** to **FRI** at the top of the note), then in the order posted. Past weeks are slightly faded. Every note is signed at the bottom with the name of the person who wrote it and the time. You never type your name.

## Move between weeks

Above the wall: the dates the five weeks cover, and **Earlier**, **This week** and **Later**. **Earlier** and **Later** move the whole window one week. **This week** brings it back to the middle (it is dimmed when it is already there). The address of the page holds where the window starts when you have moved it, so you can send a link or refresh and stay on it.

Past weeks are read-only: you can read them and react to notes in them, but you can't add, change or remove notes there.

## Leave a note

1. Press **Add note**, or press **+ NEW NOTE** at the bottom of this week's column or a later week's.
2. Type the note. Pick the **Week** it is for (this week and the twelve after), and optionally a **Day** (the default is **Any day**: the note is for the whole week).
3. Press **Post note**.

A note belongs to a week, and the day is only a tag. You can tag any weekday of the week, even one that has passed this week. Notes can be up to 2,000 characters. Line breaks are kept. The text is shown as plain text: links and formatting are not turned into anything.

## Change or remove your note

Your own notes have **Edit** and **Remove**, as long as the note's week is this week or a later one.

- **Edit** opens the note in a box with **Week** and **Day** lists. Change the words, move it to another week (this week or later), or change or clear its day tag, then **Save**. Moving it to another week keeps its day tag on the same weekday. **Cancel** leaves it as it was. The note says "(edited)" afterwards.
- **Remove** asks "Remove this note?". **Remove** again takes it off the wall for good; **Keep** cancels.

Only the person who wrote a note can change it. Nobody else can change or remove it, admins included. Once the note's week is over it is locked: if you try, you get "That week is over, so the note can no longer be changed or removed."

## Reacts

Each note has four small drawn marks: thumbs-up, thumbs-down, laughing and sad. Press one to give it; press it again to take it back. You can give each react once per note. A mark with people behind it shows its count, and the names of who gave it sit under the note. Marks nobody has given show faintly until you point at the note. Your own count is bold. Reacts tell nobody; they only show on the note.

You can't react to your own note (the marks are greyed out). You can react to a note in any week, including past ones. Thumbs-ups from before this version kept their place as thumbs-up reacts.

## Looking up who changed what

Adding, editing, moving and removing a note are recorded in the audit log (Admin, Audit) as `note.create`, `note.update` and `note.remove`, with the text and day as they were and as they became. Thumbs-ups are recorded as `note.ack` and `note.unack`, and the other reacts as `note.react` and `note.unreact` (with the kind). A removed note is hidden on the page but its text is still in the audit log.

## Phones

On a narrow screen the five week columns stack one under another, earliest first, with each week's heading above its notes.

## Printing

The page prints black on white with just the wall: the menu, the buttons and the add form are left off.
