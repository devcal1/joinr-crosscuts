// The rsync runner, its two argument shapes and the exit-code classifier
// (docs/plans/backup-contracts.md sections 6.3 and 6.8; Finance's runner.ts and sentences.ts ported).
//
// THE FLAGS ARE EXACTLY RSYNC_FLAGS, plus RSYNC_LIST_FLAG for a listing, and nothing else: never a
// delete, partial, in-place, append, recursive or remove-source flag (ci/backup-guard.js). rsync
// writes each file to a hidden temporary and renames it into place, so a killed transfer leaves
// nothing under a backup's name, and nothing on the NAS is ever deleted or changed.
//
// The password reaches rsync ONLY as RSYNC_PASSWORD in the child's environment, which tools.runTool
// builds from scratch (no HOME, no RSYNC_* from the parent). Never an argument, never a file. The
// address is only ever the final argument. runRsync checks the argument list against the two
// shapes below before anything starts, so no other call can be made through it.
//
// stderr is matched ONLY against the fixed patterns here, and is never stored, logged or returned.
const path = require("path");
const { RSYNC_FLAGS, RSYNC_LIST_FLAG, OUTPUT_LIMIT } = require("./constants");
const tools = require("./tools");

// The phases a failure can come from:
//   first-list  the copy's very first listing (a 10 there is a refused connection: unreachable)
//   list        a later folder's first listing
//   send        a send
//   relist      the listing after a send, for the proof (any failure: readback_failed)
const PHASES = Object.freeze(["first-list", "list", "send", "relist"]);

// A folder address: rsync://..., ending in a slash (a destination without one would be written AS
// that name), with no whitespace or control character.
function folderUrlOk(folderUrl) {
  return (
    typeof folderUrl === "string" &&
    folderUrl.startsWith("rsync://") &&
    folderUrl.endsWith("/") &&
    // eslint-disable-next-line no-control-regex
    !/[\s\u0000-\u001f\u007f]/.test(folderUrl)
  );
}

// A local source: an absolute path (so it can never read as an option or a remote), no newline.
function sourceOk(source) {
  return (
    typeof source === "string" &&
    source !== "" &&
    !source.startsWith("-") &&
    (path.isAbsolute(source) || path.posix.isAbsolute(source)) &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(source)
  );
}

function sameFlags(args) {
  return RSYNC_FLAGS.every((f, i) => args[i] === f);
}

// [...RSYNC_FLAGS, RSYNC_LIST_FLAG, '--', folderUrl]
function listArgs(folderUrl) {
  if (!folderUrlOk(folderUrl)) throw new TypeError("rsync: a listing needs a folder address");
  return [...RSYNC_FLAGS, RSYNC_LIST_FLAG, "--", folderUrl];
}

// [...RSYNC_FLAGS, '--', ...sources, folderUrl]   (sources: absolute local paths)
function sendArgs(sources, folderUrl) {
  if (!folderUrlOk(folderUrl)) throw new TypeError("rsync: a send needs a folder address");
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every(sourceOk)) {
    throw new TypeError("rsync: a send needs absolute local sources");
  }
  return [...RSYNC_FLAGS, "--", ...sources, folderUrl];
}

// True only for exactly one of the two shapes above.
function argsOk(args) {
  if (!Array.isArray(args) || args.length < RSYNC_FLAGS.length + 3 || !sameFlags(args)) return false;
  const rest = args.slice(RSYNC_FLAGS.length);
  const last = rest[rest.length - 1];
  if (!folderUrlOk(last)) return false;
  if (rest[0] === RSYNC_LIST_FLAG) return rest.length === 3 && rest[1] === "--";
  if (rest[0] !== "--") return false;
  const sources = rest.slice(1, -1);
  return sources.length > 0 && sources.every(sourceOk);
}

// Runs rsync once: {code, out, err, outTruncated} for any exit code. Rejects with ToolMissingError
// (rsync is not in the image), ToolAbortError (the signal: {why: 'deadline'|'stopped'}), or a
// TypeError when the argument list is not one of the two shapes (nothing is started then).
async function runRsync(args, { password, signal, outputLimit } = {}) {
  if (!argsOk(args)) throw new TypeError("rsync: the argument list is not one of the two allowed shapes");
  if (tools.RSYNC === null) throw new tools.ToolMissingError("rsync");
  const extraEnv = typeof password === "string" && password !== "" ? { RSYNC_PASSWORD: password } : {};
  return tools.runTool(tools.RSYNC, args, {
    extraEnv,
    signal,
    outputLimit: Number.isFinite(outputLimit) && outputLimit > 0 ? outputLimit : OUTPUT_LIMIT,
  });
}

const MAX_CONNECTIONS_RE = /max connections/i;
const READ_OR_WRITE_ONLY_RE = /read only|write only/i;
const AUTH_FAILED_RE = /auth failed/i;
const UNKNOWN_MODULE_RE = /unknown module/i;
const NO_SUCH_FILE_RE = /No such file or directory/;

// A folder's listing that failed with 23 and "No such file or directory": the folder doesn't
// exist on the NAS yet (the first send creates it), so it is empty.
function listingMeansEmpty(code, stderr) {
  return code === 23 && typeof stderr === "string" && NO_SUCH_FILE_RE.test(stderr);
}

// A non-zero exit -> a section 8 reason. A send's 23 and 24 go to the proof first, not here.
function classify(phase, code, stderr) {
  if (phase === "relist") return "readback_failed";
  const said = typeof stderr === "string" ? stderr : "";
  if (MAX_CONNECTIONS_RE.test(said)) return "other";
  if (READ_OR_WRITE_ONLY_RE.test(said)) return "nas_io";
  switch (code) {
    case 5:
      if (AUTH_FAILED_RE.test(said)) return "auth";
      if (UNKNOWN_MODULE_RE.test(said)) return "unknown_module";
      return "refused";
    case 35:
      return "unreachable";
    case 10:
      return phase === "first-list" ? "unreachable" : "broken";
    case 12:
      return "broken";
    case 30:
      return "timeout";
    case 11:
      return phase === "send" ? "nas_io" : "other";
    case 23:
      return phase === "send" ? "nas_io" : "other";
    default:
      return "other";
  }
}

module.exports = { PHASES, listArgs, sendArgs, argsOk, runRsync, classify, listingMeansEmpty };
