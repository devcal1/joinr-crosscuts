// The copy to the NAS (docs/plans/backup-contracts.md section 6; Finance's copy.ts and Joinr
// Backup's push.mjs ported).
//
// copyToNas runs one copy and returns an outcome {status, reason, exitCode, detail}. It NEVER
// THROWS, never writes backup_runs, raises no bell and decides nothing about when to run: the
// service (index.js) does all of that. `db` is passed in; nothing here requires the database at
// load. `runner` is injectable for tests (default: rsync.runRsync).
//
// Per folder, in NAS_FOLDERS order (db/, files/, photos/): list the NAS, plan, send what the NAS
// lacks (or holds at another size) newest first, list again and prove every file sent is there at
// its planned size. It only ever ADDS: the flags are RSYNC_FLAGS, nothing on the NAS is deleted or
// renamed, and a file somebody else put there is never listed as ours. Private files are encrypted
// one by one into staging just before their batch is sent, and the staging blobs are deleted after
// the batch whatever happened, so a private file is never kept twice on the Umbrel. Before each
// batch is encrypted, staging must have the batch's bytes plus SPACE_FLOOR_BYTES free (no_space).
// The proof judges each file against a fresh local lstat: a file whose size changed since the plan
// is counted `changed` (neither proved nor missing) and is sent again by the next run. The local
// walks are asynchronous, so a big uploads/ folder never holds the event loop.
//
// The NAS password and the passphrase live in this function's local scope only. Nothing rsync or
// 7-Zip printed, no path, address, account, module or value ever reaches the outcome or a log.
const fs = require("fs");
const path = require("path");
const C = require("./constants");
const tools = require("./tools");
const secrets = require("./secrets");
const archive = require("./archive");
const names = require("./names");
const rsync = require("./rsync");
const { parseListing } = require("./listing");
const { planFolder, batches } = require("./plan");
const ledger = require("./ledger");

// Absolute: rsync is handed absolute sources only (UPLOADS_DIR is relative in a bare dev run).
const ARCHIVES_DIR = path.resolve(C.ARCHIVES_DIR);
const FILES_DIR = path.resolve(C.UPLOADS_DIR, "files");
const PHOTOS_DIR = path.resolve(C.UPLOADS_DIR);
const STAGING_DIR = path.resolve(C.STAGING_DIR);
const BLOB_DIR = path.join(STAGING_DIR, "blobs");

// A failure found on the way: the reason and, where a tool gave one, its exit code.
class Stop extends Error {
  constructor(reason, exitCode) {
    super("backup copy: stopped at a failure");
    this.name = "CopyStop";
    this.reason = reason;
    this.exitCode = Number.isInteger(exitCode) ? exitCode : null;
  }
}

// ---- each folder's name rule ----------------------------------------------------------------------
function plainName(name) {
  return typeof name === "string" && !name.startsWith(".") && !/\.part$/i.test(name);
}
const dbNameOk = (n) => plainName(n) && names.parseArchiveName(n) !== null;
const photoNameOk = (n) => names.isUploadName(n, "photo");
const fileNameOk = (n) => names.isUploadName(n, "file");
// On the NAS a private file is <stored name>.7z.
const blobNameOk = (n) => typeof n === "string" && n.endsWith(".7z") && fileNameOk(n.slice(0, -3));

// ---- the local side --------------------------------------------------------------------------------
// The walks are asynchronous (fs.promises, LSTAT_CHUNK lstats at a time), so thousands of photos
// never hold the event loop: the board shares this process.
const LSTAT_CHUNK = 64;

// lstat, or null when the file is gone or unreadable.
async function lstatOrNull(file) {
  try {
    return await fs.promises.lstat(file);
  } catch {
    return null;
  }
}

// The regular files directly in `dir` that `accept` takes: [{name, source, bytes, mtimeMs}].
// Skipped: dotfiles, *.part, anything that is not a regular file (lstat: a symlink is skipped).
async function localEntries(dir, accept) {
  let list;
  try {
    list = await fs.promises.readdir(dir);
  } catch (e) {
    const code = tools.safeSystemCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    console.error(`[backup] copy: a local folder could not be read (${code})`);
    throw new Stop("other");
  }
  const names = list.filter((name) => plainName(name) && accept(name));
  const out = [];
  for (let i = 0; i < names.length; i += LSTAT_CHUNK) {
    const chunk = names.slice(i, i + LSTAT_CHUNK);
    const stats = await Promise.all(chunk.map((name) => lstatOrNull(path.join(dir, name))));
    chunk.forEach((name, k) => {
      const st = stats[k];
      if (!st || !st.isFile()) return; // gone since the folder was read, or not a regular file
      out.push({ name, source: path.join(dir, name), bytes: st.size, mtimeMs: st.mtimeMs });
    });
  }
  return out;
}

// The local size of each file's source now (null: gone, or no longer a regular file).
async function sizesNow(files) {
  const out = new Map();
  for (let i = 0; i < files.length; i += LSTAT_CHUNK) {
    const chunk = files.slice(i, i + LSTAT_CHUNK);
    const stats = await Promise.all(chunk.map((f) => lstatOrNull(f.source)));
    chunk.forEach((f, k) => out.set(f, stats[k] && stats[k].isFile() ? stats[k].size : null));
  }
  return out;
}

// Free bytes on the filesystem holding `dir` (bavail x bsize).
function freeBytesAt(dir) {
  const st = fs.statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
}

function isRegularFile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    console.error(`[backup] copy: a staging file could not be removed (${tools.safeSystemCode(e)})`);
  }
}

function clearBlobDir() {
  try {
    fs.rmSync(BLOB_DIR, { recursive: true, force: true });
  } catch (e) {
    console.error(`[backup] copy: the staging folder could not be emptied (${tools.safeSystemCode(e)})`);
  }
}

function newFolder(extra) {
  return { local: 0, alreadyThere: 0, sent: 0, missingAfter: 0, vanished: 0, changed: 0, bytes: 0, ...extra };
}

function abortStop(signal) {
  const r = signal && signal.reason;
  return new Stop(r && typeof r === "object" && r.name === "TimeoutError" ? "timeout" : "interrupted");
}

function isNamed(err, cls, name) {
  return err instanceof cls || (err && typeof err === "object" && err.name === name);
}

// ---- the copy --------------------------------------------------------------------------------------
async function copyToNas(db, { trigger, signal, now = new Date(), runner } = {}) {
  void trigger; // the service records the trigger; the copy is the same whatever started it
  void now;
  const startedMs = Date.now();
  const detail = {
    attempted: false,
    folders: {},
    sent: 0,
    alreadyThere: 0,
    missingAfter: 0,
    bytes: 0,
    durationMs: 0,
  };

  const finish = (stop) => {
    let sent = 0;
    let alreadyThere = 0;
    let missingAfter = 0;
    let bytes = 0;
    for (const f of Object.values(detail.folders)) {
      sent += f.sent;
      alreadyThere += f.alreadyThere;
      missingAfter += f.missingAfter;
      bytes += f.bytes;
    }
    Object.assign(detail, { sent, alreadyThere, missingAfter, bytes });
    detail.durationMs = Math.max(0, Date.now() - startedMs);
    if (!stop) return { status: "succeeded", reason: null, exitCode: null, detail };
    return { status: "failed", reason: stop.reason, exitCode: stop.exitCode, detail };
  };

  let staged = false;
  try {
    // 0. The NAS files, and the tools.
    const nas = secrets.readNas();
    if (nas.state !== "ready") {
      detail.files = { ...nas.files };
      const reason = nas.state === "off" ? "nas_off" : nas.state === "half" ? "nas_half" : "nas_invalid";
      return finish(new Stop(reason));
    }
    const injected = typeof runner === "function";
    const run = injected ? runner : rsync.runRsync;
    const have = tools.toolsStatus();
    if (!injected && !have.rsync) return finish(new Stop("no_rsync"));
    if (!have.sevenZip) return finish(new Stop("no_7zip"));
    if (signal && signal.aborted) return finish(abortStop(signal));

    const base = nas.url; // canonical, ends in "/"
    const password = nas.password;
    const startMtimes = { ...nas.mtimes };

    // A refusal seen while the helper replaced a NAS file is recorded 'other', so a helper run
    // mid-copy never engages the refusal lock (section 6.8).
    const refusalOrOther = (reason) => {
      if (!C.REFUSAL_REASONS.includes(reason)) return reason;
      const m = secrets.nasStatus().mtimes;
      return m.url !== startMtimes.url || m.password !== startMtimes.password ? "other" : reason;
    };
    const failure = (phase, res) => new Stop(refusalOrOther(rsync.classify(phase, res.code, res.err)), res.code);

    const call = async (phase, args, outputLimit) => {
      if (signal && signal.aborted) throw abortStop(signal);
      detail.attempted = true;
      try {
        return await run(args, { password, signal, outputLimit });
      } catch (e) {
        if (isNamed(e, tools.ToolMissingError, "ToolMissingError")) throw new Stop("no_rsync");
        if (isNamed(e, tools.ToolAbortError, "ToolAbortError")) {
          throw new Stop(e.why === "deadline" ? "timeout" : "interrupted");
        }
        if (signal && signal.aborted) throw abortStop(signal);
        console.error(`[backup] copy: rsync could not run (${tools.safeErrorCode(e)})`);
        throw new Stop(phase === "relist" ? "readback_failed" : "other");
      }
    };

    let listed = 0;
    // A folder's listing: [{name, bytes}] of the names `nameOk` takes. A folder that doesn't exist
    // yet lists as empty (not for the proof's relisting: a folder just sent to must be there).
    const list = async (folder, nameOk, relist) => {
      const phase = relist ? "relist" : listed === 0 ? "first-list" : "list";
      listed += 1;
      const res = await call(phase, rsync.listArgs(`${base}${folder}/`), C.LIST_OUTPUT_LIMIT);
      if (res.code === 0) {
        // A cut-off listing never reads as "the NAS lacks these" (exit 0 explains nothing: no code).
        if (res.outTruncated) throw new Stop(relist ? "readback_failed" : "other");
        return parseListing(res.out, nameOk);
      }
      if (!relist && rsync.listingMeansEmpty(res.code, res.err)) return [];
      throw failure(phase, res);
    };

    // One send; resolves the exit code when rsync took it (0, 23 or 24), else stops.
    const send = async (folder, sources) => {
      const res = await call("send", rsync.sendArgs(sources, `${base}${folder}/`), C.OUTPUT_LIMIT);
      if (res.code === 0 || res.code === 23 || res.code === 24) return res.code;
      throw failure("send", res);
    };

    // Relist and prove: every intended file on the NAS at its expected size, judged against a
    // fresh local lstat taken now:
    //   - the source is gone: proved if the NAS has it at the expected size, else vanished;
    //   - the source's size changed since the plan (f.bytes): neither proved nor missing, counted
    //     `changed` (what the NAS holds is an older version; the next run sends it again);
    //   - else proved at the expected size, or missing.
    // `onProved(files)` hears the files proved even when others are missing (the ledger keeps what
    // it saw).
    const prove = async (folder, nameOk, intended, expected, F, saw23, onProved) => {
      const after = await list(folder, nameOk, true);
      const sizes = new Map(after.map((r) => [r.name, r.bytes]));
      const now = await sizesNow(intended);
      const proved = [];
      for (const f of intended) {
        const want = expected(f);
        const onNas = Number.isFinite(want) && sizes.get(f.name) === want;
        const local = now.get(f);
        if (local === null) {
          if (onNas) {
            F.sent += 1;
            F.bytes += want;
            proved.push(f);
          } else {
            F.vanished += 1;
          }
        } else if (local !== f.bytes) {
          F.changed += 1;
        } else if (onNas) {
          F.sent += 1;
          F.bytes += want;
          proved.push(f);
        } else {
          F.missingAfter += 1;
        }
      }
      if (typeof onProved === "function" && proved.length > 0) onProved(proved);
      if (F.missingAfter > 0) {
        detail.total = F.sent + F.missingAfter;
        throw saw23 ? new Stop("nas_io", 23) : new Stop("not_verified");
      }
    };

    // 1. db/: the verified archives, already encrypted, in one send.
    {
      const F = newFolder();
      detail.folders.db = F;
      const local = await localEntries(ARCHIVES_DIR, dbNameOk);
      F.local = local.length;
      const remote = await list("db", dbNameOk, false);
      const plan = planFolder(local, remote, (f) => f.bytes, { order: "archive" });
      F.alreadyThere = plan.alreadyThere;
      if (plan.toSend.length > 0) {
        const code = await send("db", plan.toSend.map((f) => f.source));
        await prove("db", dbNameOk, plan.toSend, (f) => f.bytes, F, code === 23);
      }
    }

    // 2. files/: each private file encrypted on its own, sent in batches, the staging blobs deleted.
    {
      const F = newFolder({ encrypted: 0 });
      detail.folders.files = F;
      const local = (await localEntries(FILES_DIR, fileNameOk)).map((f) => ({ ...f, stored: f.name, name: `${f.name}.7z` }));
      F.local = local.length;
      const rows = ledger.rowsByName(db);
      const remote = await list("files", blobNameOk, false);
      const nasSizes = new Map(remote.map((r) => [r.name, r.bytes]));
      // The ledger's blob size, when the row is for the file as it is now.
      const expected = (f) => {
        const row = rows.get(f.stored);
        return row && Number(row.source_bytes) === f.bytes ? Number(row.blob_bytes) : null;
      };
      const plan = planFolder(local, remote, expected, { order: "mtime" });
      F.alreadyThere = plan.alreadyThere;
      ledger.markProven(db, plan.present.map((f) => f.stored));

      if (plan.toSend.length > 0) {
        const pp = secrets.readPassphrase();
        if (pp.state !== "set") {
          // No key to encrypt with: the snapshot reports the passphrase itself.
          detail.passphraseState = pp.state;
          throw new Stop("encrypt_failed");
        }
        const passphrase = pp.value;
        const intended = [];
        let saw23 = false;
        clearBlobDir();
        try {
          fs.mkdirSync(BLOB_DIR, { recursive: true, mode: 0o700 });
        } catch (e) {
          console.error(`[backup] copy: the staging folder could not be made (${tools.safeSystemCode(e)})`);
          throw new Stop("encrypt_failed");
        }
        staged = true;

        for (const batch of batches(plan.toSend, C.BLOB_BATCH, C.BLOB_BATCH_BYTES)) {
          // Room for this batch's blobs in staging first: the batch's source bytes (a blob is
          // about its source's size) plus SPACE_FLOOR_BYTES, else stop (no_space, retryable).
          const needBytes = batch.reduce((n, f) => n + (Number(f.bytes) || 0), 0) + C.SPACE_FLOOR_BYTES;
          let freeBytes;
          try {
            freeBytes = freeBytesAt(BLOB_DIR);
          } catch (e) {
            console.error(`[backup] copy: free space could not be read (${tools.safeSystemCode(e)})`);
            throw new Stop("other");
          }
          if (!(freeBytes >= needBytes)) {
            detail.needBytes = needBytes;
            detail.freeBytes = freeBytes;
            throw new Stop("no_space");
          }
          const blobs = [];
          try {
            const toSend = [];
            for (const f of batch) {
              if (signal && signal.aborted) throw abortStop(signal);
              if (!isRegularFile(f.source)) {
                F.vanished += 1; // deleted since the plan: nothing to encrypt
                continue;
              }
              const blob = path.join(BLOB_DIR, f.name);
              removeQuietly(blob); // 7-Zip adds to an existing archive: always start from none
              blobs.push(blob);
              let code;
              try {
                const made = await archive.create({
                  archive: blob,
                  cwd: FILES_DIR,
                  entries: [f.stored],
                  passphrase,
                  level: 1,
                  signal,
                });
                code = made.code;
                if (code === 0) code = (await archive.test({ archive: blob, passphrase, signal })).code;
              } catch (e) {
                if (isNamed(e, tools.ToolMissingError, "ToolMissingError")) throw new Stop("no_7zip");
                if (isNamed(e, tools.ToolAbortError, "ToolAbortError")) {
                  throw new Stop(e.why === "deadline" ? "timeout" : "interrupted");
                }
                if (signal && signal.aborted) throw abortStop(signal);
                console.error(`[backup] copy: a private file could not be encrypted (${tools.safeErrorCode(e)})`);
                throw new Stop("encrypt_failed");
              }
              if (code !== 0) throw new Stop("encrypt_failed", code);
              let blobBytes;
              try {
                const st = fs.lstatSync(blob);
                if (!st.isFile()) throw new Error("not a file");
                blobBytes = st.size;
              } catch {
                throw new Stop("encrypt_failed");
              }
              const hadRow = rows.has(f.stored);
              ledger.recordEncrypted(db, f.stored, f.bytes, blobBytes);
              rows.set(f.stored, { stored_name: f.stored, source_bytes: f.bytes, blob_bytes: blobBytes });
              F.encrypted += 1;
              f.blobBytes = blobBytes;
              // A ledger lost with an older database: the NAS already holds this blob's size.
              if (!hadRow && nasSizes.get(f.name) === blobBytes) {
                F.alreadyThere += 1;
                ledger.markProven(db, [f.stored]);
                continue;
              }
              toSend.push(f);
            }
            if (toSend.length > 0) {
              const code = await send("files", toSend.map((f) => path.join(BLOB_DIR, f.name)));
              if (code === 23) saw23 = true;
              ledger.markSent(db, toSend.map((f) => f.stored));
              intended.push(...toSend);
            }
          } finally {
            for (const b of blobs) removeQuietly(b);
          }
        }

        if (intended.length > 0) {
          await prove(
            "files",
            blobNameOk,
            intended,
            (f) => f.blobBytes,
            F,
            saw23,
            (proved) => ledger.markProven(db, proved.map((f) => f.stored))
          );
        }
      }
    }

    // 3. photos/: plain, up to PHOTO_BATCH per send, newest first.
    {
      const F = newFolder();
      detail.folders.photos = F;
      const local = await localEntries(PHOTOS_DIR, photoNameOk);
      F.local = local.length;
      const remote = await list("photos", photoNameOk, false);
      const plan = planFolder(local, remote, (f) => f.bytes, { order: "mtime" });
      F.alreadyThere = plan.alreadyThere;
      if (plan.toSend.length > 0) {
        let saw23 = false;
        for (const batch of batches(plan.toSend, C.PHOTO_BATCH)) {
          const code = await send("photos", batch.map((f) => f.source));
          if (code === 23) saw23 = true;
        }
        await prove("photos", photoNameOk, plan.toSend, (f) => f.bytes, F, saw23);
      }
    }

    return finish(null);
  } catch (e) {
    if (e instanceof Stop) return finish(e);
    // Anything unexpected: 'other', logged by its code or class name only.
    try {
      console.error(`[backup] copy failed unexpectedly (${tools.safeErrorCode(e)})`);
    } catch {
      // a closed stderr must not turn into a throw
    }
    return finish(new Stop("other"));
  } finally {
    if (staged) clearBlobDir();
  }
}

module.exports = { copyToNas };
