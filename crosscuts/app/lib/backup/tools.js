// Finding 7-Zip and rsync, and running one child (docs/plans/backup-contracts.md section 4.3).
//
// Every child is an argument array with NO shell (`shell: false`, never exec), and an environment
// built from scratch: a fixed PATH and LC_ALL (C for rsync, C.UTF-8 for 7-Zip) plus whatever the
// caller adds (rsync's password).
// No HOME, so rsync reads no ~/.popt; nothing RSYNC_* leaks in from the parent.
//
// No argument array, environment, `out` or `err` is ever logged, stored, returned outside
// lib/backup/, or put in an error message. The two error classes name the tool and nothing else.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { OUTPUT_LIMIT, STDERR_LIMIT, KILL_GRACE_MS } = require("./constants");

const IS_WINDOWS = process.platform === "win32";
const CHILD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// ---- safe error codes (Finance's errorCode.ts rule) -------------------------------------------
// A dependency's `code` or `name` is a free string that could carry a path or a value, so only
// the shape of a system code (EACCES, SQLITE_FULL) or an error class name (TypeError) is ever
// repeated in a log line.
const CODE_RE = /^[A-Z][A-Z0-9_]{0,39}$/;
const NAME_RE = /^[A-Z][A-Za-z]{0,38}Error$/;

// An allowlisted `code`, else an allowlisted `name`, else 'unknown'.
function safeErrorCode(err) {
  const code = err && typeof err === "object" ? err.code : undefined;
  if (typeof code === "string" && CODE_RE.test(code)) return code;
  const name = err && typeof err === "object" ? err.name : undefined;
  if (typeof name === "string" && NAME_RE.test(name)) return name;
  return "unknown";
}

// An allowlisted system `code` only, else `fallback`.
function safeSystemCode(err, fallback = "UNKNOWN") {
  const code = err && typeof err === "object" ? err.code : undefined;
  return typeof code === "string" && CODE_RE.test(code) ? code : fallback;
}

// ---- errors -------------------------------------------------------------------------------------
class ToolMissingError extends Error {
  constructor(tool, code) {
    super(`${tool} is not installed in this container.`);
    this.name = "ToolMissingError";
    this.tool = tool;
    this.code = code || "ENOENT";
  }
}

class ToolAbortError extends Error {
  // why: 'deadline' (the job's time limit) | 'stopped' (any other abort)
  constructor(tool, why) {
    super(why === "deadline" ? `${tool} was stopped at the time limit.` : `${tool} was stopped.`);
    this.name = "ToolAbortError";
    this.tool = tool;
    this.why = why === "deadline" ? "deadline" : "stopped";
  }
}

// ---- resolution ---------------------------------------------------------------------------------
function searchDirs() {
  if (!IS_WINDOWS) return CHILD_PATH.split(":");
  return String(process.env.PATH || "")
    .split(";")
    .filter(Boolean);
}

function isRunnableFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// The first directory on the child's PATH holding `name`; returns the name to spawn, or null.
function onPath(name) {
  const candidates = IS_WINDOWS && !/\.(exe|cmd|bat|com)$/i.test(name) ? [`${name}.exe`, name] : [name];
  for (const dir of searchDirs()) {
    for (const c of candidates) {
      if (isRunnableFile(path.join(dir, c))) return name;
    }
  }
  return null;
}

// BACKUP_7Z (local development only; never set in the compose file), else 7zz, else 7z on PATH.
function resolveSevenZip() {
  const override = process.env.BACKUP_7Z;
  if (typeof override === "string" && override.trim() !== "") {
    const o = override.trim();
    if (path.isAbsolute(o) || o.includes("/") || o.includes("\\")) return isRunnableFile(o) ? o : null;
    return onPath(o);
  }
  return onPath("7zz") || onPath("7z");
}

// Resolved once, at load.
const SEVEN_ZIP = resolveSevenZip();
const RSYNC = onPath("rsync");

let cachedStatus = null;
// {sevenZip: bool, rsync: bool}, cached after the first call.
function toolsStatus() {
  if (cachedStatus === null) cachedStatus = { sevenZip: SEVEN_ZIP !== null, rsync: RSYNC !== null };
  return { ...cachedStatus };
}

// The name used in error messages and logs: never a path.
function toolLabel(executable) {
  if (executable === SEVEN_ZIP || /^7z/i.test(path.basename(String(executable)))) return "7-Zip";
  if (executable === "rsync") return "rsync";
  return "a backup tool";
}

// ---- running a child ----------------------------------------------------------------------------
// The locale: rsync gets LC_ALL=C, so its messages (matched in rsync.js) stay in English. 7-Zip gets
// LC_ALL=C.UTF-8: it turns its arguments into Unicode by the locale, and under plain C a passphrase
// with any non-ASCII character would become a different key from the one Windows 7-Zip derives
// from the same text, so the archives would not open on Windows.
function localeFor(tool) {
  return tool === "7-Zip" ? "C.UTF-8" : "C";
}

function childEnv(extraEnv, tool) {
  const LC_ALL = localeFor(tool);
  const base = IS_WINDOWS ? { PATH: process.env.PATH || "", LC_ALL } : { PATH: CHILD_PATH, LC_ALL };
  return { ...base, ...(extraEnv && typeof extraEnv === "object" ? extraEnv : {}) };
}

function abortWhy(signal) {
  const r = signal && signal.reason;
  return r && typeof r === "object" && r.name === "TimeoutError" ? "deadline" : "stopped";
}

// Runs one child. Resolves {code, out, err, outTruncated} for any exit code. Rejects only with
// ToolMissingError (the tool could not be started) or ToolAbortError ({why}).
// `input` (optional string): written to the child's stdin, which is then closed. 7-Zip takes the
// passphrase this way, so it never appears in a process list (0.1.8).
function runTool(executable, args, { cwd, extraEnv, signal, outputLimit, input } = {}) {
  const tool = toolLabel(executable);
  const limit = Number.isFinite(outputLimit) && outputLimit > 0 ? outputLimit : OUTPUT_LIMIT;
  return new Promise((resolve, reject) => {
    if (typeof executable !== "string" || executable === "") {
      reject(new ToolMissingError(tool));
      return;
    }
    if (signal && signal.aborted) {
      reject(new ToolAbortError(tool, abortWhy(signal)));
      return;
    }
    if (cwd !== undefined) {
      let isDir = false;
      try {
        isDir = fs.statSync(cwd).isDirectory();
      } catch {
        isDir = false;
      }
      // A missing working folder would otherwise look like a missing tool (both are ENOENT).
      if (!isDir) {
        reject(new Error(`${tool}: the working folder does not exist.`));
        return;
      }
    }

    let child;
    try {
      child = spawn(executable, Array.isArray(args) ? args : [], {
        shell: false,
        cwd,
        env: childEnv(extraEnv, tool),
        stdio: [typeof input === "string" ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      reject(new ToolMissingError(tool, safeSystemCode(e)));
      return;
    }

    if (typeof input === "string") {
      // A child that exits without reading (a bad archive, a missing file) closes the pipe: EPIPE
      // is expected then and changes nothing; the exit code tells the caller what happened.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }

    const outChunks = [];
    let outBytes = 0;
    let outTruncated = false;
    const errChunks = [];
    let errBytes = 0;

    child.stdout.on("data", (chunk) => {
      if (outBytes >= limit) {
        outTruncated = true;
        return;
      }
      const room = limit - outBytes;
      if (chunk.length > room) {
        outChunks.push(chunk.subarray(0, room));
        outBytes += room;
        outTruncated = true;
      } else {
        outChunks.push(chunk);
        outBytes += chunk.length;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (errBytes >= STDERR_LIMIT) return;
      const room = STDERR_LIMIT - errBytes;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      errChunks.push(part);
      errBytes += part.length;
    });

    let killer = null;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      killer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, KILL_GRACE_MS);
      if (typeof killer.unref === "function") killer.unref();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const finish = () => {
      if (killer !== null) clearTimeout(killer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      finish();
      // A failed spawn (ENOENT, EACCES): the tool can't be started. Only its code is kept.
      reject(new ToolMissingError(tool, safeSystemCode(e)));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      finish();
      if (aborted) {
        reject(new ToolAbortError(tool, abortWhy(signal)));
        return;
      }
      resolve({
        code: typeof code === "number" ? code : -1,
        out: Buffer.concat(outChunks).toString("utf8"),
        err: Buffer.concat(errChunks).toString("utf8"),
        outTruncated,
      });
    });
  });
}

// {sevenZip: string|null, rsync: string|null}: each tool's version line, for the start banner.
// Never throws.
async function probeVersions() {
  const out = { sevenZip: null, rsync: null };
  if (SEVEN_ZIP !== null) {
    for (const args of [[], ["i"]]) {
      try {
        const r = await runTool(SEVEN_ZIP, args, { outputLimit: 64 * 1024 });
        const line = r.out.split(/\r?\n/).find((l) => l.includes("7-Zip"));
        if (line !== undefined) {
          out.sevenZip = line.trim().slice(0, 200);
          break;
        }
      } catch {
        break;
      }
    }
  }
  if (RSYNC !== null) {
    try {
      // Every rsync child starts in rsync.js (ci/backup-guard.js). Required here, at run time, as
      // rsync.js requires this file.
      out.rsync = await require("./rsync").probeVersion();
    } catch {
      // not runnable: reported as missing
    }
  }
  return out;
}

module.exports = {
  SEVEN_ZIP,
  RSYNC,
  toolsStatus,
  probeVersions,
  runTool,
  ToolMissingError,
  ToolAbortError,
  safeErrorCode,
  safeSystemCode,
};
