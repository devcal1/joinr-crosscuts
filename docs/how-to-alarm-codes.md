# How to keep the alarm codes in Crosscuts

For Todd. The **Alarms** page replaces the Alarms tab of the jobs master workbook: who holds each user slot on the alarm panel, their code, the alarm company's details and the weekly arm and disarm times.

Who can open it:
- **The owner** (Todd). Alarms needs the owner-only key `alarms.manage`, so other admins don't see it in the menu, can't open it, and don't see its rows in the audit log.
- Anyone the owner grants `alarms.manage` to on the Users page (see [how-to-add-user.md](how-to-add-user.md)). Only the owner can grant it.

Open **Admin**, then **Alarms**.

Crosscuts only keeps the record. Adding, changing or removing a code on the alarm panel itself is still done at the panel.

## How the codes are kept

- **Each code is encrypted** in the database (AES-256-GCM), with a key kept in a file beside it, `config/alarm-code-key`, never in the database. Crosscuts makes the key the first time a code is saved.
- **Codes are hidden on screen.** The Code column shows the same six dots for every code, whatever its length.
- **Show** shows one code for **30 seconds**, then hides it again. **Hide** hides it sooner. A shown code is also hidden when you switch to another tab, leave the page or print it. Nothing is copied to the clipboard.
- **Every Show is in the audit log**, naming the slot only, never the code. A code change is logged as "set", "changed" or "cleared", never the code.
- **Codes are never printed.** The Alarms page has no print: printing it gives only the line "The alarms page doesn't print."
- **The monitoring password isn't kept in Crosscuts.** Keep it in the password manager. The company form has nowhere to type it.

What this protects, plainly: the codes are safe **inside Crosscuts** (no other admin can see them) and in the plain database copies Crosscuts keeps on the Umbrel before each upgrade. It doesn't protect them from someone who has the Umbrel itself, or the backup passphrase: the key file sits beside the database and goes into the same backup archive.

## Leavers

A **leaver** is a slot still in use whose holder has left: a pay-only person archived on Pay runs, or a board worker archived. Crosscuts lists each one first, in orange:

> M13 Person has left: change or remove slot 4

The same line shows on the dashboard for whoever holds `alarms.manage`, at most five, then "and n more", each with **Open alarms**. A holder typed in as a name (a temp, a cleaner) is never flagged.

To clear it: change or remove the code at the panel, then either **Edit** the slot (a new holder, a new code) or **Remove** it.

## The slots

**Slots in use** lists each slot: Slot, Holder ("left" in orange for a leaver; "Not on the pay list" for a typed name), Type (Office, Staff or Temp), Given, Code, Note, and **Edit**, **Clear code** and **Remove**.

### Add a slot

1. Press **Add slot**.
2. Fill in:
   - **Slot number:** the panel's user number, 1 to 999. Two slots in use can't share a number.
   - **Holder:** a person from the pay list, or **Someone else…** and their **Name** (a temp, a cleaner or anyone not on the pay list).
   - **Type:** Office, Staff or Temp.
   - **Date given** (optional, not in the future).
   - **Code:** 1 to 12 digits, shown as dots while you type (a phone still shows the number pad). A leading 0 is kept. Leave it empty for no code.
   - **Note** (optional).
3. Press **Add slot**.

The code box is emptied after every save, whether it worked or not. If the save is refused, the message ends "The code wasn't saved: type it again." (or, when the page itself catches the mistake, "Type the code again.").

### Change a slot or its code

Press **Edit** on the slot. Change what you need and press **Save**. Leave **Code** empty to keep the saved code; type a new one to replace it.

**Clear code** (it asks first) removes the saved code from Crosscuts. The alarm panel isn't changed.

### Remove and restore

**Remove** asks for the **Date removed** (today unless you change it; not in the future, and not before the date given). It **clears the saved code**. The slot moves to **Removed slots** (folded away, under the table), so the history stays.

**Restore** on a removed slot brings it back into use, **with no code** (type it again with **Edit**). Its number must be free.

## The alarm company

**Company**, **Account number**, **Contact** and **Phone**, then **Save**. The monitoring password isn't kept here.

## Weekly times

For each day, Monday to Sunday: **Arms at** (evening) and **Disarms at** (morning), each optional. Press **Save**.

## If the alarm code key is missing

If the key file is lost (for example after a restore without the config files), the page shows an orange **Alarm code key missing** box:

> The alarm code key file is missing, so saved codes can't be shown or changed. Restore config/alarm-code-key from a backup (restore with --config), or clear the saved codes.

While it's missing, every saved code shows **can't be read** with no Show, and no new code can be saved. Everything else on the page still works, and clearing a code still works.

**What to do:** put the key back from a backup, with the database restore's `--config` option. See "Alarm codes and the key file" in [restore.md](restore.md). Ask Claude before restoring anything.

Crosscuts **never makes a new key while codes saved with the old one exist**, so a lost key can always be put back later and the codes read again. If the key can't be found, the other way out is to clear every saved code (or remove their slots) and type the codes again from the panel's records: the next code saved then makes a new key.

A single code that shows **can't be read** while the others are fine was saved with a different key (one from another backup). Restore the key it was saved with, or type that code again with **Edit**.

## When Crosscuts refuses

| It says | What it means |
|---|---|
| Slot n is already in use | Another slot in use has that number. Remove or renumber it first. |
| The slot number must be a whole number from 1 to 999 | Type the panel's user number. |
| Give the holder: a person or a name | Choose a person, or Someone else… and a name. |
| The code must be 1 to 12 digits | Digits only, at most 12. |
| Slot n was removed; restore it to change it | Restore it first. |
| Slot n is already removed | Someone removed it already. |
| The removed date can't be before the date given (d Mon yyyy) | Choose a later date. |
| Slot n has no code saved | There is nothing to show. |
| The alarm code key is missing, so codes can't be shown. Restore config/alarm-code-key from a backup. | See "If the alarm code key is missing" above. |
| The alarm code key is missing. Restore config/alarm-code-key from a backup, or clear every saved code, before saving a new one. | The same: no new code can be saved until the key is back, or until no saved codes are left. |
| This code can't be read with the current alarm code key. Restore the key it was saved with, or type the code again. | The code was saved with another key. |
| The alarm code key couldn't be created in the config folder | Crosscuts couldn't write the key file. Ask Claude to check the Umbrel's `data/config` folder. |

## At cutover

Crosscuts starts with no slots. At cutover, type in the holders and their codes, the company details and the weekly times.
