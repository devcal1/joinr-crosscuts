// The backup service (docs/plans/backup-contracts.md sections 7 and 11). SCAFFOLD STUB: Wave 2 D
// builds the timer, the single flight, recording in backup_runs, the bells and Back up now.
//
// The stub only prints the start banner. It runs nothing, seeds nothing, sweeps nothing and
// starts no timer. Nothing here requires the database at load: `db` arrives through start(db).
// Every export never throws.
const tools = require("./tools");
const secrets = require("./secrets");

const disabled = () => process.env.BACKUP_DISABLED === "1";
const scheduleDisabled = () => process.env.BACKUP_SCHEDULE_DISABLED === "1";

let started = false;

// After listen. BACKUP_DISABLED=1: nothing at all. Returns a promise that never rejects.
function start(db) {
  void db;
  if (disabled()) return Promise.resolve();
  if (started) return Promise.resolve();
  started = true;
  return tools
    .probeVersions()
    .then((v) => {
      console.log(
        `[backup] 7-Zip: ${v.sevenZip || "missing"}; rsync: ${v.rsync || "missing"}; schedule ${scheduleDisabled() ? "off" : "on"}`
      );
      console.log("[backup] service not built yet: no snapshot or copy will run");
    })
    .catch((e) => {
      console.error(`[backup] start failed (${tools.safeErrorCode(e)})`);
    });
}

function snapshotState(passphrase, sevenZip) {
  if (!sevenZip) return "no_7zip";
  if (passphrase === "set") return "ready";
  return passphrase === "missing" ? "off" : "invalid";
}

// The status shape of section 9, with nothing recorded yet (the stub reads no table).
function status(db) {
  void db;
  try {
    const t = tools.toolsStatus();
    const pp = secrets.passphraseStatus();
    const nas = secrets.nasStatus();
    const enabled = !disabled();
    return {
      enabled,
      scheduleOn: enabled && !scheduleDisabled(),
      tools: t,
      running: null,
      snapshot: {
        state: snapshotState(pp.state, t.sevenZip),
        passphrase: pp.state,
        last: null,
        lastSuccess: null,
        nextAt: null,
        retryAt: null,
        overdue: false,
      },
      copy: {
        state: nas.state,
        files: { nasUrl: nas.url, nasPassword: nas.password },
        locked: false,
        last: null,
        lastSuccess: null,
        nextAt: null,
        retryAt: null,
        overdue: false,
      },
      archives: [],
      totals: { archives: 0, archiveBytes: 0, unverified: 0, blobsTracked: 0, blobsProven: 0 },
      recent: [],
    };
  } catch (e) {
    console.error(`[backup] status failed (${tools.safeErrorCode(e)})`);
    return null;
  }
}

// Back up now (section 7.7). Not built yet: 501.
async function requestRun(db, req) {
  void db;
  void req;
  return { status: 501, body: { error: "Backups are not built yet." } };
}

module.exports = { start, status, requestRun };
