// The 7-Zip calls: create, test, extract (docs/plans/backup-contracts.md section 4.4).
//
// The passphrase reaches 7-Zip as the argument -p<passphrase>: the exposure Joinr Backup accepts
// (visible to root inside the container while 7-Zip runs; no shell ever sees it, section 18 item
// 2). It is never logged. Every create uses -mhe=on, so the names inside are hidden too.
//
// Each call resolves {code} only (never 7-Zip's output). Any non-zero code is a failure, 7-Zip's
// 1 ("warning") included. A missing 7-Zip rejects with ToolMissingError, a deadline with
// ToolAbortError; the caller turns both into a reason.
const path = require("path");
const { SEVEN_ZIP, runTool, ToolMissingError } = require("./tools");

function sevenZip() {
  if (SEVEN_ZIP === null) throw new ToolMissingError("7-Zip");
  return SEVEN_ZIP;
}

function passphraseArg(passphrase) {
  // An empty -p makes 7-Zip prompt for one; refuse it here instead.
  if (typeof passphrase !== "string" || passphrase === "") throw new TypeError("archive: a passphrase is required");
  return `-p${passphrase}`;
}

function fileArg(label, value) {
  if (typeof value !== "string" || value === "") throw new TypeError(`archive: ${label} is required`);
  return value;
}

// A bare relative name: no absolute path, no parent step, no option-looking name.
function entryOk(entry) {
  if (typeof entry !== "string" || entry === "" || entry.startsWith("-")) return false;
  if (path.isAbsolute(entry) || path.win32.isAbsolute(entry)) return false;
  return !entry.split(/[\\/]+/).includes("..");
}

// 7z a -t7z -mhe=on -mx=<level> -bsp0 -bso0 -p<pp> -- <archive> <entries...>, run with cwd so
// the entries are stored as bare relative names. A named folder is added with its contents.
async function create({ archive, cwd, entries, passphrase, level = 5, signal } = {}) {
  const exe = sevenZip();
  const pp = passphraseArg(passphrase);
  fileArg("an archive", archive);
  fileArg("a working folder", cwd);
  if (!Array.isArray(entries) || entries.length === 0 || !entries.every(entryOk)) {
    throw new TypeError("archive: entries must be bare relative names");
  }
  const mx = Number.isInteger(level) && level >= 0 && level <= 9 ? level : 5;
  const args = ["a", "-t7z", "-mhe=on", `-mx=${mx}`, "-bsp0", "-bso0", pp, "--", archive, ...entries];
  const r = await runTool(exe, args, { cwd, signal });
  return { code: r.code };
}

// 7z t -bsp0 -bso0 -p<pp> -- <archive>
async function test({ archive, passphrase, signal } = {}) {
  const exe = sevenZip();
  const pp = passphraseArg(passphrase);
  const args = ["t", "-bsp0", "-bso0", pp, "--", fileArg("an archive", archive)];
  const r = await runTool(exe, args, { signal });
  return { code: r.code };
}

// 7z x -bsp0 -bso0 -y -p<pp> -o<outDir> -- <archive>
async function extract({ archive, passphrase, outDir, signal } = {}) {
  const exe = sevenZip();
  const pp = passphraseArg(passphrase);
  const out = fileArg("an output folder", outDir);
  const args = ["x", "-bsp0", "-bso0", "-y", pp, `-o${out}`, "--", fileArg("an archive", archive)];
  const r = await runTool(exe, args, { signal });
  return { code: r.code };
}

module.exports = { create, test, extract };
