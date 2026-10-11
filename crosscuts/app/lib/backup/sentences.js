// Every fixed sentence a backup run or a Back up now answer can show (docs/plans/backup-contracts.md
// sections 7.7 and 8). Numbers are the only variables: no sentence ever holds a path, address,
// account, module, value or anything a tool printed. A run's sentence is built from its reason,
// exit code and detail when it is shown, so no sentence text is ever stored.

const SNAPSHOT_TAIL = "The live database is not affected.";
const COPY_TAIL = "The backups on the Umbrel are not affected.";
const FIX_FIRST =
  "The NAS refused the last copy's password or module. Place the NAS files again with the backup helper first: repeated refusals could make the NAS block the Umbrel.";
const DISABLED = "Backups are switched off on this server.";
const RUNNING = "Running now.";

// A non-negative whole number, or undefined (never a text, NaN or fraction).
function count(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Bytes for people: "512 bytes", "4.2 KB", "2.1 MB", "1.3 GB".
// "a 9.0 KB" but "an 8.9 KB", "an 11 MB", "an 18.2 KB" (said "eight", "eleven", "eighteen").
function article(size) {
  return (/^(8|1[18](?![0-9]))/.test(size) ? "an " : "a ") + size;
}

function formatBytes(bytes) {
  const n = count(bytes);
  if (n === undefined) return "an unknown size";
  if (n < 1024) return plural(n, "byte", "bytes");
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function detailOf(run) {
  return run && run.detail && typeof run.detail === "object" ? run.detail : {};
}

// ---- snapshots ----------------------------------------------------------------------------------
const SNAPSHOT_BODIES = {
  no_passphrase: "Snapshots are off: the backup passphrase is not on the server. Place it with the backup helper.",
  passphrase_unusable:
    "The backup passphrase file is not usable (one line, at least 12 characters). Place it again with the backup helper.",
  no_7zip: "7-Zip is missing from the app image, so no archive can be made.",
  copy_failed: "The database copy could not be written.",
  check_failed: "The database copy failed its integrity check, so it was not kept.",
  migrations_mismatch:
    "The database copy did not match the live database's migration level, so it was not kept.",
  timeout: "The snapshot took longer than 10 minutes and was stopped.",
  interrupted: "The snapshot was cut short when the app stopped.",
  other: "The snapshot failed.",
};

function snapshotBody(reason, exitCode, d) {
  const code = count(exitCode);
  switch (reason) {
    case "no_space":
      return `There is not enough free space on the Umbrel for a snapshot (${formatBytes(d.needBytes)} needed, ${formatBytes(
        d.freeBytes
      )} free). Nothing was pruned.`;
    case "archive_failed":
      return code === undefined
        ? "7-Zip could not make the archive."
        : `7-Zip could not make the archive (exit code ${code}).`;
    case "test_failed":
      return code === undefined
        ? "The archive was made but did not open again with the passphrase. It was set aside as unverified."
        : `The archive was made but did not open again with the passphrase (7-Zip exit code ${code}). It was set aside as unverified.`;
    default:
      return Object.prototype.hasOwnProperty.call(SNAPSHOT_BODIES, reason) ? SNAPSHOT_BODIES[reason] : SNAPSHOT_BODIES.other;
  }
}

// From {status, reason, exitCode, detail}.
function snapshotSentence(run) {
  const r = run || {};
  const d = detailOf(r);
  if (r.status === "running") return RUNNING;
  if (r.status === "succeeded") {
    const c = d.counts && typeof d.counts === "object" ? d.counts : {};
    return `Succeeded: ${article(formatBytes(d.archiveBytes))} archive (${plural(count(c.users) || 0, "user", "users")}, ${plural(
      count(c.jobs) || 0,
      "job",
      "jobs"
    )}, ${plural(count(c.weekRows) || 0, "board row", "board rows")}), tested with the passphrase.`;
  }
  return `${snapshotBody(r.reason, r.exitCode, d)} ${SNAPSHOT_TAIL}`;
}

// ---- the copy -----------------------------------------------------------------------------------
// Bodies without a full stop take "(rsync exit code N)" when a code is known, then the stop.
const COPY_WITH_CODE = {
  auth: "The NAS refused the password in nas-password. Check the rsync account on the NAS, then place the password again with the backup helper",
  unknown_module:
    "The NAS has no rsync module by the name in nas-url. Check the module on the NAS, then place the address again",
  refused: "The NAS refused the connection, usually because of a wrong password or module name",
  unreachable: "The NAS did not answer. Check it is switched on and reachable over Tailscale",
  stalled:
    "The copy to the NAS stalled and was stopped. No incomplete file is left under a backup's name on the NAS",
  broken:
    "The connection to the NAS broke part way through. No incomplete file is left under a backup's name on the NAS",
  nas_io:
    "The NAS could not store or list the files: it may be full, or the rsync account may not be allowed to write the folder",
  readback_failed: "The files were sent, but the NAS could not be read back, so the copy is not proved",
  other: "The copy to the NAS failed",
};
const COPY_FIXED = {
  nas_off: "The copy to the NAS is not set up.",
  encrypt_failed: "A private file could not be encrypted, so the copy stopped. It will be tried again.",
  // The copy's own deadline (COPY_DEADLINE_MS), not rsync's exit 30 ('stalled').
  timeout:
    "The copy took longer than 30 minutes and was stopped part way. What was sent is kept; the next run carries on.",
  no_rsync: "rsync is missing from the app image, so nothing can be copied.",
  no_7zip: "7-Zip is missing from the app image, so the private files can't be encrypted.",
  interrupted: "The copy was cut short when the app stopped.",
};

// detail.files = {nasUrl, nasPassword} ('missing'|'not_usable'|'set'), as status().copy.files.
function filesOf(d) {
  return d.files && typeof d.files === "object" ? d.files : {};
}

function copyBody(reason, exitCode, d) {
  if (reason === "nas_half") {
    const f = filesOf(d);
    const which =
      f.nasUrl === "missing" ? "nas-url" : f.nasPassword === "missing" ? "nas-password" : "nas-url or nas-password";
    return `The copy to the NAS is half set up: ${which} is missing. Run the backup helper again.`;
  }
  if (reason === "nas_invalid") {
    const f = filesOf(d);
    const urlBad = f.nasUrl === "not_usable";
    const passwordBad = f.nasPassword === "not_usable";
    let what;
    if (urlBad && passwordBad) {
      what = "nas-url is not an rsync://account@IP/module address and nas-password is not usable";
    } else if (passwordBad) {
      what = "nas-password is not usable";
    } else if (urlBad) {
      what = "nas-url is not an rsync://account@IP/module address";
    } else {
      what = "nas-url or nas-password is not usable";
    }
    // Starts with the file's name, lower case as it is on disk (as Finance's sentence does).
    return `${what}. Run the backup helper again.`;
  }
  if (reason === "no_space") {
    return `There is not enough free space on the Umbrel to encrypt the private files for the NAS (${formatBytes(
      d.needBytes
    )} needed, ${formatBytes(d.freeBytes)} free). It will be tried again.`;
  }
  if (reason === "not_verified") {
    const missing = count(d.missingAfter) || 0;
    // The files that had to be proved: detail.total when the copy gives it, else those sent.
    const total = count(d.total) !== undefined ? count(d.total) : count(d.sent) || 0;
    return `rsync reported success, but ${missing} of ${Math.max(missing, total)} files are not on the NAS at the right size.`;
  }
  if (Object.prototype.hasOwnProperty.call(COPY_FIXED, reason)) return COPY_FIXED[reason];
  const body = Object.prototype.hasOwnProperty.call(COPY_WITH_CODE, reason) ? COPY_WITH_CODE[reason] : COPY_WITH_CODE.other;
  const code = count(exitCode);
  return code === undefined ? `${body}.` : `${body} (rsync exit code ${code}).`;
}

// From {status, reason, exitCode, detail}.
function copySentence(run) {
  const r = run || {};
  const d = detailOf(r);
  if (r.status === "running") return RUNNING;
  if (r.status === "succeeded") {
    return `Succeeded: ${count(d.sent) || 0} sent, ${count(d.alreadyThere) || 0} already there, proved on the NAS.`;
  }
  return `${copyBody(r.reason, r.exitCode, d)} ${COPY_TAIL}`;
}

// ---- Back up now (section 7.7) ------------------------------------------------------------------
// The 429 answer within MANUAL_GAP_MS of a good snapshot.
function tooSoonSentence(minutes) {
  const n = Math.max(1, count(minutes) || 1);
  return `A good snapshot was taken less than 10 minutes ago. Try again in ${plural(n, "minute", "minutes")}.`;
}

module.exports = {
  SNAPSHOT_TAIL,
  COPY_TAIL,
  FIX_FIRST,
  DISABLED,
  snapshotSentence,
  copySentence,
  tooSoonSentence,
  formatBytes,
};
