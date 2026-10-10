# Cutover runbook: moving the live board from the old app to Crosscuts

Status: **approach agreed with Todd 2026-10-11 (decisions at the end). Not yet rehearsed. No date set.** This follows brief §9a. Nothing in this runbook runs until Todd sets a date, and every step that touches data waits for Todd's go-ahead on the day.

**In one paragraph.**
1. Edits on the old board stop.
2. A copy of the old app's database and photos is taken. The copy is the rollback: the old app itself is never touched.
3. The copy replaces Crosscuts' test data, and Crosscuts' migrations upgrade it.
4. Counts and the board are checked against the old app.
5. People log in, and the TV moves over.
6. The old app stays installed, unused, for two weeks as a fallback, and is only removed when Todd says so.

## What carries over and what doesn't

The live snapshot **replaces** Crosscuts' database. That is the design: Crosscuts started empty, and live data comes in only at cutover (decision on record).

| Carried over (from the old app) | Lost (entered in Crosscuts before cutover) |
|---|---|
| Workers, jobs, board rows, chips, day flags, backlog | Users, roles, overrides, PINs and remembered devices |
| Photos and their tags (`uploads/`) | Business details, bank details and the invoice prefix and start number |
| The Gemini key (`config/`) | Test jobs, test invoices and test alerts |

So:
- **Don't issue real invoices in Crosscuts before cutover.** Before then its jobs are test jobs.
- **Users and settings must be put back after the load.** Two ways to do it; Todd picks one (Q1 at the end):
  - **A. Re-create them by hand** (recommended). About 15 minutes: run setup, add the nine logins, re-enter the business details. No new code.
  - **B. Carry them across with a small tool.** It copies users, roles, overrides and settings from the pre-cutover Crosscuts database into the loaded one. That is new code that writes to the live database, so it needs Todd's sign-off and must pass the rehearsal first.

After the load, invoicing starts clean:
- Jobs already on the board at cutover get no automatic invoices (plan decision 5). Accounts add those by hand with **New invoice**.
- Jobs waiting in "To start" get their deposit prompt when first placed.

## Before cutover (all must be done)

1. **A released Crosscuts version carries everything** (M1.2 and M2 at least), installed on the Umbrel and checked on the device. Release is currently deferred.
2. **The carried LAN check has passed** (STATUS): logged out → 401 or login, login with "remember this device", and the board loads.
3. **The paths and names have been confirmed on the Umbrel.** They have not been verified yet. In an Umbrel terminal:
   ```
   docker ps --format '{{.Names}}' | grep -E 'thcabinets|crosscuts'
   ls -d /home/umbrel/umbrel/app-data/thcabinets-splash/data /home/umbrel/umbrel/app-data/tenon-joinr-crosscuts/data
   ```
   The expected container names are `thcabinets-splash_web_1` (old) and `tenon-joinr-crosscuts_web_1` (Crosscuts). Wherever this page says otherwise, use what these two commands show.
4. **Rehearsal** on a throwaway copy, one or two days before (next section), with every check passing.
5. **Agreed with Todd:**
   - the freeze time (suggested: Friday afternoon, straight after Finish week);
   - who is present;
   - who runs the Umbrel terminal;
   - Sam told the day before.

## Rehearsal (a throwaway copy; touches nothing live)

Brief §7 requires every migration to be proven on a fresh copy of the live `photos.db` before cutover.

1. Take a snapshot exactly as in **Cutover step 2**, but into `REH=/home/umbrel/crosscuts-rehearsal`.
2. Run the release image against it, on a spare port, outside Umbrel's proxy:
   ```
   docker run -d --name crosscuts-rehearsal -p 4999:3000 \
     -v $REH/db:/data/db -v $REH/uploads:/data/uploads -v $REH/config:/data/config \
     ghcr.io/devcal1/crosscuts-web:<version>
   docker logs crosscuts-rehearsal 2>&1 | grep -E 'migrate|foreign_key|roundup'
   ```
3. Run every check in **Cutover step 4** against `crosscuts-rehearsal`. Open `http://umbrel.local:4999`, run setup with a throwaway admin, and compare the board with the old app.
4. If Todd chose option B (Q1), run the carry-over tool here first, and check that the users can log in.
5. Remove it all. The copy holds customer data:
   ```
   docker rm -f crosscuts-rehearsal
   sudo rm -rf /home/umbrel/crosscuts-rehearsal
   ```

Write the counts and any surprises into `docs/plans/STATUS.md`. If anything fails, stop and fix it before setting a date.

## Cutover day

Allow about an hour. ☐ marks each check.

### 1. Freeze (Todd, Sam)
☐ Finish week is done on the old board. ☐ Sam stops editing; the old board stays on the TV, read-only by agreement.

### 2. Snapshot the old app (read-only for the old app)

This doesn't stop or change the old app. The database copy is written inside its container's `/tmp`, then copied out.
```
STAMP=$(date +%Y%m%d-%H%M)
SNAP=/home/umbrel/crosscuts-cutover/$STAMP
sudo mkdir -p $SNAP
OLD=/home/umbrel/umbrel/app-data/thcabinets-splash/data

# A consistent copy of the live database (SQLite VACUUM INTO, not a raw file copy).
docker exec thcabinets-splash_web_1 node -e "require('better-sqlite3')('/data/db/photos.db').exec(\"VACUUM INTO '/tmp/photos-snapshot.db'\")"
docker exec thcabinets-splash_web_1 node -e "console.log(require('better-sqlite3')('/tmp/photos-snapshot.db',{readonly:true}).pragma('integrity_check',{simple:true}))"
```
☐ The second command prints `ok`.

Record the counts. They are the yardstick for step 4:
```
docker exec thcabinets-splash_web_1 node -e "
const db=require('better-sqlite3')('/tmp/photos-snapshot.db',{readonly:true});
for (const t of ['workers','jobs','week_rows','assignments','day_flags','backlog','photos']) console.log(t, db.prepare('SELECT COUNT(*) n FROM '+t).get().n);
console.log('orphan day_flags', db.prepare('SELECT COUNT(*) n FROM day_flags WHERE week_row_id NOT IN (SELECT id FROM week_rows)').get().n);"
```
Copy it out, then tidy the container's `/tmp`. The photos and config are only read:
```
sudo docker cp thcabinets-splash_web_1:/tmp/photos-snapshot.db $SNAP/photos.db
docker exec thcabinets-splash_web_1 rm /tmp/photos-snapshot.db
sudo cp -a $OLD/uploads $SNAP/uploads
sudo cp -a $OLD/config $SNAP/config
ls -la $SNAP; du -sh $SNAP/uploads $OLD/uploads
```
☐ `photos.db` is there. ☐ The two `uploads` sizes match.

**Keep `$SNAP` until decommission and beyond: it is the rollback.** Once the offsite NAS backup exists, copy it there too.

### 3. Load it into Crosscuts
1. **[Umbrel web UI]** Stop Crosscuts.
2. Set the pre-cutover Crosscuts data aside. Move it; never delete it. Then put the snapshot in place:
   ```
   CC=/home/umbrel/umbrel/app-data/tenon-joinr-crosscuts/data
   sudo mkdir -p $SNAP/crosscuts-before
   sudo mv $CC/db/photos.db* $SNAP/crosscuts-before/
   sudo mv $CC/uploads $SNAP/crosscuts-before/uploads
   sudo cp $SNAP/photos.db $CC/db/photos.db
   sudo cp -a $SNAP/uploads $CC/uploads
   sudo cp -a $SNAP/config/. $CC/config/
   sudo chown --reference=$CC/db $CC/db/photos.db
   sudo chown -R --reference=$CC/db $CC/uploads $CC/config
   ls -la $CC/db $CC/config
   ```
   If Todd chose option B, `crosscuts-before/photos.db` is what the carry-over tool reads.
3. **[Umbrel web UI]** Start Crosscuts. Then read the migration log:
   ```
   docker logs tenon-joinr-crosscuts_web_1 2>&1 | grep -E 'migrate|foreign_key|roundup'
   ```
   ☐ It shows a `backup written: …photos-pre-002-…` line. ☐ 002 to the latest migration show `applied`. ☐ It shows the `003 backfill` line with the job count. ☐ `foreign_key_check: ok`. ☐ It shows the round-up `first start` line.

### 4. Verify
1. Run the same counts against Crosscuts:
   ```
   docker exec tenon-joinr-crosscuts_web_1 node -e "
   const db=require('better-sqlite3')('/data/db/photos.db',{readonly:true});
   for (const t of ['workers','jobs','week_rows','assignments','day_flags','backlog','photos']) console.log(t, db.prepare('SELECT COUNT(*) n FROM '+t).get().n);
   for (const r of db.prepare('SELECT stage, COUNT(*) n FROM jobs GROUP BY stage').all()) console.log('stage', r.stage, r.n);"
   ```
   ☐ Every count equals the snapshot's, except `day_flags`, which equals the snapshot's count minus the orphans (the approved migration 005 sweep).
2. The M1 promise (m1-plan decision 4): list any job the backfill marked `complete` whose last board week is within the last two weeks. Todd checks each one is really finished:
   ```
   docker exec tenon-joinr-crosscuts_web_1 node -e "
   const db=require('better-sqlite3')('/data/db/photos.db',{readonly:true});
   console.log(db.prepare(\"SELECT j.id, j.name, MAX(w.week_start) last_week FROM jobs j JOIN week_rows w ON w.job_id=j.id WHERE j.stage='complete' GROUP BY j.id HAVING last_week >= date('now','-14 days')\").all());"
   ```
3. **Set up access** (option A):
   - Open `http://umbrel.local:4933/setup.html` and create Todd's admin.
   - Add the users per brief §3.1: Chloe, Tracy and Jill (accounts); Aaron and Jordan (design_pm + scheduling); Sam and Michael (scheduling); Showroom (showroom).
   - Fill in **Business details and invoicing** on the Users page.
   - With option B, run the tool instead and check that Todd can log in.
4. **Compare the board.** Put the old app (`umbrel.local:4090`) and Crosscuts side by side, for this week and next week. ☐ Same rows, the same order in each panel, the same worker chips and the same flags. ☐ "To start" matches. ☐ The worker roster matches. ☐ A showroom photo search returns photos.

If any check fails and can't be explained, **stop and roll back** (below). Nothing has changed in the old app.

### 5. Switch
☐ Sam's Chromebook logs in to Crosscuts with "remember this device", and the TV shows the Crosscuts board. ☐ Bookmarks on the office machines and the showroom device point at `umbrel.local:4933`. ☐ Office staff log in. ☐ The first board edit in Crosscuts shows up in the audit log.

Write the time, the counts and anything odd into `docs/plans/STATUS.md`.

## Fallback window (two weeks, unless Todd says otherwise)

- The old app stays installed and untouched. Don't uninstall it, update it or edit on it.
- **If Crosscuts fails**, go back to the old app's board. **Any board edits made in Crosscuts since the cutover must be re-typed into the old app by hand.** Nothing syncs back. Crosscuts can stay installed for accounts and invoices while it is fixed.
- **To retry the cutover later**, repeat from step 1 with a fresh snapshot.

## Rolling back the cutover itself

The old app was never changed, so falling back means using it again: TV and bookmarks back to `umbrel.local:4090`. To put Crosscuts back as it was before the load:
1. Stop Crosscuts.
2. Move `$CC/db/photos.db*` and `$CC/uploads` aside.
3. Move the `$SNAP/crosscuts-before/` files back.
4. Fix the ownership as in step 3, and start Crosscuts.

## Decommission (only when Todd confirms)

1. Todd confirms that Crosscuts has run the workshop through the fallback window.
2. Check that `$SNAP` still holds `photos.db`, `uploads/` and `config/`, and copy it to the offsite NAS once that exists.
3. **[Umbrel web UI]** Uninstall the old app. **This deletes its data**, which is why step 2 matters.
4. Retire its store entry: `thcabinets-umbrel-store` is changed only now, and only with Todd's permission to push.
5. Release Crosscuts as `1.0.0`.

## Decisions from Todd (2026-10-11)
1. **Users and settings: re-created by hand (option A).** No carry-over tool. Ignore the option B notes above.
2. **Freeze: the Friday after Finish week.** Monday starts on Crosscuts, and the weekend is the buffer.
3. **Fallback window: two weeks.**
4. **Todd runs the Umbrel terminal**, with Claude guiding step by step and reading back the output.

Still to do before a date: a released version installed on the Umbrel, the LAN check, the paths confirmed, and a passing rehearsal.
