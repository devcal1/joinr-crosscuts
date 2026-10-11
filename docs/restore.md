# Backups and restoring Crosscuts

For Todd, at the Umbrel terminal, with Claude reading back each step's output. Read the whole case you need before typing anything. Every step that replaces data waits for Todd's go-ahead.

This repo is public. **The NAS's address, the rsync account and module names, the NAS password and the passphrase never go in this repo, a commit, a chat or a file on the PC.** This page uses placeholders: `<NAS Tailscale IP>`, `<account>`, `<module>`.

## How the backups work

- **Every night at 1:30 am** Crosscuts takes a snapshot of its database. It copies `photos.db`, checks the copy, and locks it into an encrypted 7-Zip archive (AES-256, with the names inside hidden). It then opens the archive again with the passphrase to prove it, and keeps it on the Umbrel in `data/db/backups/archives/`.
- **The archive also holds the `config/` folder** (the Joinr and Gemini keys, the Joinr address, `nas-url` and `nas-password`), so a restore can put them back. It never holds `backup-passphrase`, the key to the archives themselves.
- **Every Saturday at 1:30 am** Crosscuts copies to the NAS everything the NAS doesn't have yet, over Tailscale, then lists the NAS back to prove it all arrived. **Back up now** on the Users page does a snapshot and, when the NAS is set up, a copy straight away.
- **The NAS only ever gains files.** Crosscuts never deletes or changes anything there. Photos deleted in the app stay on the NAS.
- **Problems show as a bell alert** to admins and on the Users page, under **Backups**. There is no phone alert.

**The passphrase is the Joinr Backup passphrase**: the same one, already in the password manager and on paper. **A lost passphrase makes every archive useless.** Nothing can recover it.

### Where everything is

| What | On the Umbrel | On the NAS |
|---|---|---|
| Database archives (nightly, Back up now, and one per migration) | `data/db/backups/archives/crosscuts-db-….7z` and `crosscuts-premigrate-….7z` | `db/`, the same names |
| Photos and their thumbnails | `data/uploads/` | `photos/`, the same names, **not encrypted** |
| Private files (report library, task attachments) | `data/uploads/files/` | `files/<name>.7z`, one encrypted archive per file |
| The passphrase, NAS address and NAS password | `data/config/backup-passphrase`, `nas-url`, `nas-password` | never |

`data/` is `/home/umbrel/umbrel/app-data/tenon-joinr-crosscuts/data`. Archive names carry the Sydney date and time they were made, for example `crosscuts-db-20261012-013004+1100.7z`, so sorting by name sorts by date. A Back up now archive ends in `-manual.7z`.

**The Umbrel keeps** the newest archive of each of the 14 newest days, one a month for 12 months, and the newest 10 Back up now archives. **The NAS keeps everything** until you prune it by hand.

## Before you start any restore

**umbrelOS 2.0:** the `umbrel` user is no longer in the docker group, so every `docker` command needs `sudo`.

The restore tool is in the Crosscuts image, so the commands below need the **exact image the Umbrel is running**. While Crosscuts is installed, in the Umbrel terminal:

```
CC=/home/umbrel/umbrel/app-data/tenon-joinr-crosscuts/data
IMG=$(sudo docker ps -a --filter name=tenon-joinr-crosscuts_web --format '{{.Image}}' | head -1)
echo "$IMG"
```

☐ It prints `ghcr.io/devcal1/crosscuts-web:<version>`, perhaps followed by `@sha256:…`. That is fine. If it prints nothing, the container name differs: run `sudo docker ps -a` and use the Crosscuts line.

A shell forgets `CC` and `IMG` when it closes. Run those three lines again in every new terminal.

Every restore command has this shape. The app's data folder appears inside as `/data`, and the tool has no network:

```
sudo docker run --rm --network none -it -v $CC:/data $IMG node tools/restore.js <command>
```

| Command | What it does |
|---|---|
| `list` | the archives on the Umbrel (name, kind, size, when made). No passphrase. |
| `check <archive>` | opens the archive and checks it, then prints its manifest and counts. Changes nothing. |
| `db <archive>` | puts the archive's database in place (case A). `--config` also puts back the config files (case B). |
| `files <folder>` | decrypts every `<name>.7z` in the folder into `uploads/files/`. Skips files that are already there. |

The tool asks for the passphrase in a hidden prompt and never prints it. It **never deletes**. The database it replaces is renamed `photos-before-restore-<stamp>.db` (with its `-wal` and `-shm` files, if any). It **refuses** an archive from a newer Crosscuts than the image ("This archive is from a newer Crosscuts…"). An older archive is fine: Crosscuts upgrades it on start, writing its usual pre-migration backup first.

## A. Restore the database from an archive on the Umbrel

Use this after a bad edit or a damaged database, when the Umbrel itself is fine.

**Warning: anything entered since that archive was made is lost.** That includes board edits, jobs, invoices, users and audit entries. Photos and files uploaded since then stay on disk, but the app no longer lists them.

**Rolling back a release instead?** Follow [rollback.md](rollback.md). Its rule still applies: never put a database under an older image than the one that made it. The tool refuses that case anyway.

1. **[Umbrel terminal]** Set `CC` and `IMG` (above), then list the archives:
   ```
   sudo docker run --rm --network none -it -v $CC:/data $IMG node tools/restore.js list
   ```
   Choose the newest archive from **before** the problem. Note its name.
2. **[Umbrel web UI]** Stop Crosscuts.
3. **[Umbrel terminal]** Check the archive first. It asks for the passphrase and changes nothing:
   ```
   sudo docker run --rm --network none -it -v $CC:/data $IMG node tools/restore.js check /data/db/backups/archives/<archive name>
   ```
   ☐ It opens, and the counts (users, jobs, board rows) look right for that date.
4. **[Umbrel terminal]** Restore it, on Todd's go-ahead:
   ```
   sudo docker run --rm --network none -it -v $CC:/data $IMG node tools/restore.js db /data/db/backups/archives/<archive name>
   ```
   It asks "Have you stopped Crosscuts in umbrelOS?" (type `YES`), then for the passphrase. ☐ It ends by printing the archive's counts and the restored file's counts side by side, and they match. Write them down.
5. **[Umbrel web UI]** Start Crosscuts.
6. **Check.** ☐ Log in. ☐ The board shows that date's rows. ☐ The users and jobs are the ones expected.

Notes:

- **Without `--config`, the config files are left as they are**, so a restore can't put back an older Joinr key.
- **A photo deleted since the archive** shows as a broken image: its file is gone from the Umbrel. Get it from the NAS (case C).
- Keep `photos-before-restore-<stamp>.db` until the restore is confirmed, and remove it only with Todd's say-so.

## B. The Umbrel is gone

Use this when the Umbrel has failed or been rebuilt, and everything comes back from the NAS. Allow an afternoon. Large photo folders take a while to copy.

**On the new Umbrel first:**
1. Install umbrelOS. Put it on Tailscale, and turn **key expiry off** for it in the Tailscale admin console.
2. Add the `tenon` community app store and install **Joinr Crosscuts**, the same version as before or newer. Open it once so its folders are made, then **stop it** in the Umbrel web UI.
3. On the PC, point the `umbrel` alias in `~/.ssh/config` at the new Umbrel, and add your SSH key to it. Check with `ssh umbrel true`.

**Fetch the backups (on the PC):**

4. Sign in to the NAS **with your own NAS user**, through the ASUSTOR file manager or the SMB share. The rsync account is only for Crosscuts' uploads. From the Crosscuts shared folder, copy to a folder on the PC, for example `C:\crosscuts-restore\`:
   - the **newest archive** in `db/` (the last `crosscuts-db-…` name);
   - the whole `files/` folder;
   - the whole `photos/` folder.
5. Copy that folder to the Umbrel. In PowerShell:
   ```
   scp -r C:\crosscuts-restore umbrel:/home/umbrel/crosscuts-restore
   ```

**Restore (Umbrel terminal):**

6. Set `CC` and `IMG` (above). Then put the photos in place, and the archive and `files/` where the tool can see them:
   ```
   sudo cp -a /home/umbrel/crosscuts-restore/photos/. $CC/uploads/
   sudo mkdir -p $CC/uploads/files $CC/restore-in
   sudo cp -a /home/umbrel/crosscuts-restore/files /home/umbrel/crosscuts-restore/crosscuts-db-*.7z $CC/restore-in/
   sudo chown -R --reference=$CC/db $CC/uploads
   ls $CC/restore-in
   ```
7. Decrypt the private files (passphrase asked):
   ```
   sudo docker run --rm --network none -it -v $CC:/data $IMG node tools/restore.js files /data/restore-in/files
   ```
   ☐ It reports how many files it restored, and none failed.
8. Restore the database **and the config files** (`YES`, then the passphrase):
   ```
   sudo docker run --rm --network none -it -v $CC:/data $IMG node tools/restore.js db /data/restore-in/<archive name> --config
   ```
   ☐ The two sets of counts match. The Joinr and Gemini keys, the Joinr address and the NAS files are back, each with mode 600.
9. **On the PC**, place the passphrase with the helper. It is never in an archive, so it must always be placed again. Running the helper with no option also places the NAS files freshly, which does no harm. See [Placing the files](#placing-the-files).
10. **[Umbrel web UI]** Start Crosscuts.
11. **Check.** ☐ Log in with your usual login (the users come back with the database). ☐ The board, a job page and the invoices look right. ☐ A recent photo opens. ☐ A file in the report library opens.
12. **Users page, Backups:** press **Back up now**. ☐ The snapshot succeeds. ☐ The copy says "proved on the NAS" and sends little more than the new archive: the NAS already holds everything else.
13. Remove the copies, which hold customer data:
    ```
    sudo rm -rf $CC/restore-in /home/umbrel/crosscuts-restore
    ```
    Then delete `C:\crosscuts-restore\` on the PC.

## C. One photo or file

Use this when the database is fine but one file is missing or damaged on the Umbrel, for example a broken image.

**A photo.** Its file name is the end of the image's address in the app (right-click the broken image, copy the image address: `/photos/<file name>`). Its thumbnail is the same name ending `-thumb.webp`.
1. With your own NAS user, copy `photos/<file name>` (and the thumbnail, if it is missing too) from the NAS to the PC.
2. Copy it to the Umbrel and into place:
   ```
   scp <file name> umbrel:/home/umbrel/
   ```
   then in the Umbrel terminal:
   ```
   sudo cp /home/umbrel/<file name> /home/umbrel/umbrel/app-data/tenon-joinr-crosscuts/data/uploads/
   rm /home/umbrel/<file name>
   ```

A photo **deleted in the app** has lost its database row as well. Putting its file back doesn't bring it back into the app. Ask Claude: restoring it needs its row from an older archive.

**A private file** (report library, task attachment). Its stored name is not the name people see. Claude finds it, read-only:
```
sudo docker exec tenon-joinr-crosscuts_web_1 node -e "
const db=require('better-sqlite3')('/data/db/photos.db',{readonly:true});
console.log(db.prepare('SELECT stored_name, original_name, removed_at FROM files WHERE original_name LIKE ?').all('%'+process.argv[1]+'%'));" "<part of the file's name>"
```
1. With your own NAS user, copy `files/<stored name>.7z` from the NAS.
2. Either:
   - **Just to read it:** on Windows, right-click it, then **7-Zip**, **Extract files**, and enter the passphrase. It is the original file. Double-clicking won't work: the names inside are encrypted, so Windows reports an unsupported format.
   - **To put it back in Crosscuts:** copy it to the Umbrel with `scp <stored name>.7z umbrel:/home/umbrel/` in PowerShell. Then, in the Umbrel terminal, set `CC` and `IMG` (above) and run:
     ```
     sudo mkdir -p $CC/restore-in/one && sudo cp /home/umbrel/<stored name>.7z $CC/restore-in/one/
     sudo docker run --rm --network none -it -v $CC:/data $IMG node tools/restore.js files /data/restore-in/one
     sudo rm -rf $CC/restore-in /home/umbrel/<stored name>.7z
     ```
     The app can stay running for this. The tool never overwrites a file that is already there.

## The restore drill

**Once now (Backup · 6.1), then once a quarter.** Record each drill in `docs/plans/STATUS.md`. A backup that has never been restored is a hope, not a backup. The drill also proves the passphrase in the password manager still opens the archives.

It restores the newest **NAS** archive (not one from the Umbrel) into a throwaway Crosscuts on a spare port, as the cutover rehearsal does. The live app is not touched.

1. **On the PC**, with your own NAS user, copy from the NAS into a new folder `C:\crosscuts-drill\`: the newest archive in `db/`, the whole `files/` folder, and, into a `photos\` subfolder, the ten newest photos in `photos/` with their `-thumb.webp` files. Copy it all to the Umbrel:
   ```
   scp -r C:\crosscuts-drill umbrel:/home/umbrel/crosscuts-drill-in
   ```
2. **[Umbrel terminal]** Set `IMG` (above). Then make a scratch data folder:
   ```
   DRILL=/home/umbrel/crosscuts-drill
   sudo mkdir -p $DRILL/db $DRILL/uploads/files $DRILL/config $DRILL/in
   sudo cp -a /home/umbrel/crosscuts-drill-in/. $DRILL/in/
   sudo cp $DRILL/in/photos/* $DRILL/uploads/
   ```
3. Restore into it (passphrase each time). Don't add `--config`: the keys inside would let the throwaway copy talk to Joinr.
   ```
   sudo docker run --rm --network none -it -v $DRILL:/data $IMG node tools/restore.js check /data/in/<archive name>
   sudo docker run --rm --network none -it -v $DRILL:/data $IMG node tools/restore.js files /data/in/files
   sudo docker run --rm --network none -it -v $DRILL:/data $IMG node tools/restore.js db /data/in/<archive name> --yes
   ```
   ☐ `check` prints the manifest. Its `config files:` line lists the config files, and not `backup-passphrase`. ☐ `db` prints matching counts. Write them down.
4. Start the throwaway copy, with backups switched off so it never copies to the NAS:
   ```
   sudo docker run -d --name crosscuts-drill -p 4999:3000 -e BACKUP_DISABLED=1 \
     -v $DRILL/db:/data/db -v $DRILL/uploads:/data/uploads -v $DRILL/config:/data/config $IMG
   ```
5. Open `http://umbrel.local:4999`. ☐ Log in with your usual login. ☐ The board matches the live one as of that archive's date. ☐ One of the recent photos opens. ☐ A report-library file opens (it came from the NAS's `files/`).
6. Remove it all. It holds customer data:
   ```
   sudo docker rm -f crosscuts-drill
   sudo rm -rf $DRILL /home/umbrel/crosscuts-drill-in
   ```
   Then delete `C:\crosscuts-drill\` on the PC.
7. In `docs/plans/STATUS.md`, write the date, the archive's name, the counts, and anything odd.

## Setting up the NAS (Todd, once)

Before the first copy, in ADM (the NAS's admin page, over Tailscale):

- ☐ **A new shared folder for Crosscuts, private.** Nothing else lives in it. It holds the board, client and payroll data, so only your own NAS user has access.
- ☐ **Your own NAS user has read access** to that folder. That is the user that fetches files for a restore.
- ☐ **The rsync server is on** (Settings, Services, Rsync Server).
- ☐ **A new rsync account** (Rsync Server, Manage Users), **allowed only on a new module** for that folder, with write access. **Never reuse another app's rsync account** (not Joinr Backup's, not Joinr Finance's). A wrong password or a block then affects only Crosscuts.
- ☐ **If ADM lets you set module options:** `refuse options = delete remove-source-files` on that module, so the NAS refuses deletes too.
- ☐ **Btrfs snapshots** on the share (Snapshot Center). Crosscuts never deletes there, and snapshots also cover a mistaken prune by hand.
- ☐ **ADM Defender still admits `100.64.0.0/10`** (Tailscale) in its trusted list. Otherwise a few wrong passwords could get the Umbrel blocked.
- ☐ **Tailscale key expiry is off for both the NAS and the Umbrel** (Tailscale admin console, each machine). An expired key stops the copy silently while the snapshots carry on.
- ☐ Note the address: `rsync://<account>@<NAS Tailscale IP>/<module>`. Use the NAS's Tailscale **IP**: names don't resolve inside the app's container, and the rsync protocol is not encrypted (Tailscale encrypts it). Keep the account and module names to yourself.

## Placing the files

The passphrase and the NAS files are placed with the backup helper, `tools/backup-secrets.mjs` in this repo. **Run it yourself** so nothing passes through a chat:

- Use **PowerShell or Windows Terminal**, opened from the Start menu. Not Git Bash's window: Node can't hide what you type there, and the helper refuses to run.
- Run it from the repo root. It needs Node on the PC, and the `umbrel` SSH alias with your key (or `--host <alias>`).
- It sends each value only on SSH's standard input, and never prints one. It writes hidden temporary files, checks them, then moves them into `data/config/` as mode 600, owned by the `umbrel` user. It needs no `sudo` or `docker`.

1. **Rehearse the hidden prompt:** `node tools/backup-secrets.mjs --prompt-test`. Type or paste anything **except** a real password, then press Enter. ☐ It prints only "read N characters, nothing was echoed", and nothing you typed appeared on screen. If anything was shown, or the window hangs, stop.
2. **See what it will do:** `node tools/backup-secrets.mjs --dry-run`. It prints every SSH command, with the values shown as `<stdin: secret>`, and sends nothing.
3. **Place them:** `node tools/backup-secrets.mjs`. It asks for:
   - **the NAS address**, shown as you type (it is not a secret). It must have the form above. An address outside Tailscale's range gets a warning and is used only if you type `yes`.
   - **the NAS password**, hidden, twice;
   - **the passphrase**, hidden, twice: **the Joinr Backup passphrase from the password manager**, exactly as stored, at least 12 characters.
4. **Check:** `node tools/backup-secrets.mjs --check`. ☐ All three files show `present (600, uid 1000)`. ☐ It reports "Snapshots: on" and "Copy to the NAS: set up". It shows only each file's mode and owner, never its contents or size.
5. **Users page, Backups:** press **Back up now**. ☐ The snapshot succeeds. ☐ The copy says "proved on the NAS". ☐ The NAS folder now has `db/`, `photos/` and `files/`.

Other options:
- `--only nas` or `--only passphrase` places one group. For example, use `--only nas` after changing the rsync password on the NAS.
- `--remove nas`, `--remove passphrase` or `--remove all` deletes files from the Umbrel (it asks first; `--yes` skips the question). Removing the NAS files stops the copy, and removing the passphrase stops the snapshots. Nothing on the NAS is touched, and the archives already made stay.
- `--help` lists them all.

## The refusal lock

If the NAS refuses the rsync password or the module name, **Crosscuts stops trying**. The Saturday timer and Back up now both wait until you fix it. Repeated wrong passwords could make ADM Defender block the Umbrel, which would also stop Joinr Backup and Joinr Finance from copying to the NAS.

The Users page shows **Locked**, Back up now explains why, and admins get a bell alert. To clear it:
1. Fix the account or module on the NAS, or find the right password.
2. If ADM Defender has already blocked the Umbrel, unblock its Tailscale address in ADM.
3. Place the NAS files again: `node tools/backup-secrets.mjs --only nas`. This clears the lock.
4. Press **Back up now** (or wait for the next run). Crosscuts tries once more.

## Removing a file from the NAS by hand

Crosscuts never deletes on the NAS. If a client asks for their photos or files to be removed, do it **with your own NAS user** in ADM's file manager:
- Photos: `photos/<file name>` and its `-thumb.webp`.
- A private file: `files/<stored name>.7z`. Claude can find the stored name (case C).
- **Their details are also inside the database archives in `db/`.** Each archive holds the whole database as it was that night. Old archives can be pruned by hand. Keep at least the newest few months, and every `crosscuts-premigrate-…` archive.
- Btrfs snapshots keep deleted files until the snapshots expire.

## If something looks wrong

- **An archive "won't open" on Windows:** double-clicking doesn't work, because the names inside are encrypted. Right-click it, then **7-Zip**, **Open archive**, and enter the passphrase.
- **Back up now says "The backup passphrase is not on the server":** place it with the helper (`--only passphrase`).
- **"The NAS did not answer":** the NAS is off or asleep, off Tailscale, its rsync server is off, its Tailscale key has expired, or ADM Defender has blocked the Umbrel.
- **No copy for 8 days, or no snapshot for 2 days:** admins get a bell alert, and the Users page says "Overdue". Look at the last run's sentence on the Users page.
