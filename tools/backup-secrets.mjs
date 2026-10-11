// The backup helper (docs/plans/backup-contracts.md section 12): places, checks or removes the
// three backup config files in Crosscuts' data folder on the Umbrel, over SSH.
//
//   node tools/backup-secrets.mjs [--host <ssh alias>]                 place the passphrase and both NAS files
//   node tools/backup-secrets.mjs --only nas|passphrase                place one group (e.g. after a refusal lock)
//   node tools/backup-secrets.mjs --check                              which files are there (mode, owner); never contents or size
//   node tools/backup-secrets.mjs --remove nas|passphrase|all [--yes]  delete them (the copy or the snapshots are off again)
//   node tools/backup-secrets.mjs --prompt-test                        rehearse the hidden prompt: read one entry, print only its length
//   node tools/backup-secrets.mjs ... --dry-run                        print every ssh command; no prompts, nothing sent
//
// A port of Joinr Finance's tools/deploy/nas-secrets.mjs. Todd runs it himself in PowerShell or
// Windows Terminal: every value is typed into this window and never passes through a chat, a tool
// call or a file on the PC. Values travel only on ssh's standard input; no value is ever in an
// argument, an environment variable, a file on the PC or a printed line (the dry run shows
// `<stdin: secret>`). No remote command asks for a file's size or contents. Every remote path is
// built from validated constants. No docker and no sudo: on umbrelOS 2.0 the `umbrel` user is not
// in the docker group, and writing into the app's data folder doesn't need it.
//
// This file holds no secret, address or account name, and must never hold one: the repo is public.
// It lives outside the Docker context (repo-root tools/), like tools/dev-sqlite-shim.js.
//
// Exit codes: 0 done; 1 failed (nothing changed, or the check named the problem); 2 usage, not a
// terminal, Crosscuts not installed, SSH unreachable; 130 aborted (Ctrl+C).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
// The address rule, shared with the app (pure, no requires).
const { checkNasUrl, isTailscaleIp } = require("../crosscuts/app/lib/backup/nasurl.js");

// ---- constants ------------------------------------------------------------------------------------

/** The Umbrel app id (permanent) and its config folder under the remote home. */
export const APP_ID = "tenon-joinr-crosscuts";
export const CONFIG_PARTS = Object.freeze(["umbrel", "app-data", APP_ID, "data", "config"]);

/** The three files (lib/backup/constants.js CONFIG_FILES). */
export const FILES = Object.freeze({
  passphrase: "backup-passphrase",
  nasUrl: "nas-url",
  nasPassword: "nas-password",
});

/** The groups `--only` and `--remove` name, each in commit order: the NAS password before the address. */
export const GROUPS = Object.freeze({
  passphrase: Object.freeze([FILES.passphrase]),
  nas: Object.freeze([FILES.nasPassword, FILES.nasUrl]),
});

// The app's rules (lib/backup/constants.js), mirrored here: that file requires lib/config.js,
// which this helper must not load.
export const PASSPHRASE_MIN = 12;
export const PASSPHRASE_MAX = 1024;
export const NAS_PASSWORD_MAX = 256;
export const SECRET_MAX_BYTES = 4096;

/** What every placed file must be: mode 600, owned by uid 1000 (the `umbrel` user). */
export const EXPECTED_UID = "1000";
export const FILE_MODE = "600";

const DEFAULT_HOST = "umbrel";
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const HOME_RE = /^\/[A-Za-z0-9._/-]+$/;
/** The remote home a dry run shows (no ssh is run to learn the real one). */
export const DRY_RUN_HOME = "/home/umbrel";

export const USAGE = [
  "Usage: node tools/backup-secrets.mjs [mode] [--host <ssh alias>] [--dry-run]",
  "  (no mode)                   place the backup passphrase and both NAS files (prompts)",
  "  --only nas|passphrase       place one group only (e.g. the NAS files after a refusal lock)",
  "  --check                     which files are on the Umbrel (mode and owner only; never contents or size)",
  "  --remove nas|passphrase|all delete them: the copy, or the snapshots, are off again (--yes: no question)",
  "  --prompt-test               rehearse the hidden prompt: read one entry, print only its length",
  "  --dry-run                   print every ssh command it would run; no prompts, nothing is sent",
  "  --host <alias>              the ssh alias of the Umbrel (default: umbrel, or CROSSCUTS_SSH_HOST)",
  "  --help                      this text",
  "",
  "Run it yourself in PowerShell or Windows Terminal. See docs/restore.md, 'Placing the files'.",
].join("\n");

export const NOT_A_TERMINAL_MESSAGE =
  "This needs a terminal that can hide what you type. Git Bash's mintty window is not a terminal Node can hide input in: use PowerShell or Windows Terminal, or `winpty node tools/backup-secrets.mjs`.";

export const NOT_TAILSCALE_WARNING =
  "This is not a Tailscale address (100.64.0.0/10): the rsync protocol is not encrypted, so the files would cross the network readable.";

export const PASSPHRASE_REMINDER =
  "Use the Joinr Backup passphrase from the password manager. A lost passphrase makes every archive useless.";

const ADDRESS_HELP = [
  "The NAS address has the form  rsync://<account>@<NAS Tailscale IP>/<module>  (optionally",
  "/<module>/<subfolder>, and the subfolder must already exist on the NAS). Use the NAS's Tailscale",
  "IP, not a name: names don't resolve inside the app's container, and the rsync protocol is not",
  "encrypted (Tailscale encrypts it). The address is not a secret, so it is shown as you type.",
  "The password goes in the next prompt, never in the address.",
].join("\n");

// ---- errors, output, quoting ----------------------------------------------------------------------

/** A refusal or failure with the exit code the helper ends with. Messages never hold a value. */
export class HelperError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "HelperError";
    this.exitCode = exitCode;
  }
}

/** Wraps a value in single quotes for a POSIX shell (`'` becomes `'\''`). */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** A C0 or C1 control character, or DEL (NUL included). */
function hasControl(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function charCount(text) {
  return [...text].length;
}

/** The bytes a file holding `value` and its line ending takes. */
function fileBytes(value) {
  return Buffer.byteLength(`${value}\n`, "utf8");
}

// ---- argument parsing -----------------------------------------------------------------------------

const FLAG_KINDS = {
  host: "string",
  only: "string",
  check: "boolean",
  remove: "string",
  yes: "boolean",
  "prompt-test": "boolean",
  "dry-run": "boolean",
  help: "boolean",
};

/** `{mode, group, host, yes, dryRun, help}`, or a HelperError (exit 2). */
export function parseArgs(argv, env = process.env) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    if (!a.startsWith("--")) throw new HelperError(`Unexpected argument.\n${USAGE}`, 2);
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    const kind = FLAG_KINDS[name];
    if (!kind) throw new HelperError(`Unknown option --${name}.\n${USAGE}`, 2);
    if (flags[name] !== undefined) throw new HelperError(`--${name} given twice.`, 2);
    if (kind === "boolean") {
      if (inline !== undefined) throw new HelperError(`--${name} takes no value.`, 2);
      flags[name] = true;
    } else {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith("--")) throw new HelperError(`--${name} needs a value.`, 2);
      flags[name] = v;
    }
  }
  if (flags.help) return { mode: "help" };

  const modes = ["check", "remove", "prompt-test"].filter((m) => flags[m] !== undefined);
  if (modes.length > 1) throw new HelperError(`Choose one mode.\n${USAGE}`, 2);
  const mode = modes[0] ?? "place";

  let group = null;
  if (flags.only !== undefined) {
    if (mode !== "place") throw new HelperError("--only goes with placing, not with another mode.", 2);
    if (!Object.hasOwn(GROUPS, flags.only)) throw new HelperError("--only takes nas or passphrase.", 2);
    group = flags.only;
  }
  if (mode === "remove") {
    if (flags.remove !== "all" && !Object.hasOwn(GROUPS, flags.remove)) {
      throw new HelperError("--remove takes nas, passphrase or all.", 2);
    }
    group = flags.remove;
  }
  if (flags.yes && mode !== "remove") throw new HelperError("--yes goes with --remove only.", 2);

  const fromEnv = env.CROSSCUTS_SSH_HOST;
  const host = flags.host ?? (fromEnv === undefined || fromEnv === "" ? DEFAULT_HOST : fromEnv);
  if (!HOST_RE.test(host)) {
    throw new HelperError("The ssh host must be a plain alias or name (letters, digits, dots, dashes).", 2);
  }
  return { mode, group, host, yes: flags.yes === true, dryRun: flags["dry-run"] === true };
}

// ---- value rules ----------------------------------------------------------------------------------

/** Why a typed NAS password is refused, or null. */
export function passwordProblem(pw) {
  if (pw.length === 0) return "The password is empty.";
  if (charCount(pw) > NAS_PASSWORD_MAX) return `The password is longer than ${NAS_PASSWORD_MAX} characters.`;
  if (fileBytes(pw) > SECRET_MAX_BYTES) return "The password is too long.";
  if (hasControl(pw)) return "The password contains a control character.";
  // Crosscuts trims the password it reads, so one with a space at either end could never log in.
  if (pw.trim() !== pw) return "The password starts or ends with a space.";
  return null;
}

/** Why a typed passphrase is refused, or null. It is kept exactly as typed (never trimmed). */
export function passphraseProblem(pp) {
  const n = charCount(pp);
  if (n < PASSPHRASE_MIN) return `The passphrase is shorter than ${PASSPHRASE_MIN} characters.`;
  if (n > PASSPHRASE_MAX) return `The passphrase is longer than ${PASSPHRASE_MAX} characters.`;
  if (fileBytes(pp) > SECRET_MAX_BYTES) return "The passphrase is too long.";
  if (hasControl(pp)) return "The passphrase contains a control character.";
  return null;
}

/** The host part of a canonical address from checkNasUrl. */
export function hostOf(canonical) {
  const m = /^rsync:\/\/[^@]+@([^:/]+)/.exec(canonical);
  return m ? m[1] : "";
}

// ---- the terminal ---------------------------------------------------------------------------------

/** Per stream: the entry before ended on `\r`, so a `\n` arriving next belongs to it. */
const pendingLf = new WeakSet();

/**
 * Reads one line from a terminal in raw mode (Finance's readLine): `hidden` echoes nothing. Every
 * character of every chunk is handled (a paste arrives as one chunk): `\r` or `\n` ends the entry,
 * Backspace is 0x08 (conhost) or 0x7f (Windows Terminal), an ESC sequence is ignored whole, Ctrl+C
 * rejects with exit 130, and any other control character is dropped. On every exit path raw mode is
 * switched off, the stream is paused and a newline is printed.
 */
export function readLine(stream, out, { hidden = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    let value = "";
    let esc = 0; // 0 normal; 1 after ESC; 2 in a CSI sequence; 3 after ESC O
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      try {
        if (typeof stream.setRawMode === "function") stream.setRawMode(false);
      } finally {
        stream.pause();
        out.write("\n");
      }
      if (err) reject(err);
      else resolvePromise(value);
    };
    const onEnd = () => finish(new HelperError("Aborted: the input ended.", 130));
    const onError = () => finish(new HelperError("Aborted: the input could not be read.", 130));
    const onData = (chunk) => {
      const chars = [...String(chunk)];
      for (let i = 0; i < chars.length; i++) {
        if (done) return;
        const ch = chars[i];
        const code = ch.codePointAt(0);
        if (pendingLf.has(stream)) {
          pendingLf.delete(stream);
          if (ch === "\n") continue;
        }
        if (esc === 1) {
          esc = ch === "[" ? 2 : ch === "O" ? 3 : 0;
          if (esc !== 0) continue;
        } else if (esc === 2) {
          if (code >= 0x40 && code <= 0x7e) esc = 0;
          continue;
        } else if (esc === 3) {
          esc = 0;
          continue;
        }
        if (ch === "\x1b") {
          esc = 1;
        } else if (ch === "\r" || ch === "\n") {
          if (ch === "\r" && i === chars.length - 1) pendingLf.add(stream);
          finish();
          return;
        } else if (ch === "\x03") {
          finish(new HelperError("Aborted.", 130));
          return;
        } else if (ch === "\x08" || ch === "\x7f") {
          if (value.length > 0) {
            const kept = [...value];
            kept.pop();
            value = kept.join("");
            if (!hidden) out.write("\b \b");
          }
        } else if (code < 0x20 || (code >= 0x80 && code <= 0x9f)) {
          // any other control character is dropped
        } else {
          value += ch;
          if (!hidden) out.write(ch);
        }
      }
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    try {
      if (typeof stream.setRawMode === "function") stream.setRawMode(true);
      stream.setEncoding("utf8");
      stream.resume();
    } catch {
      finish(new HelperError("The terminal refused raw mode.", 2));
    }
  });
}

/** `{isTerminal(), visible(question), hidden(question)}` on the real terminal. */
export function createTerminalPrompt(stdin = process.stdin, stdout = process.stdout) {
  return {
    isTerminal: () => stdin.isTTY === true && stdout.isTTY === true,
    visible: (question) => {
      stdout.write(question);
      return readLine(stdin, stdout, { hidden: false });
    },
    hidden: (question) => {
      stdout.write(question);
      return readLine(stdin, stdout, { hidden: true });
    },
  };
}

// ---- ssh ------------------------------------------------------------------------------------------

/** The first `ssh` on PATH (on Windows only .exe/.com: a .cmd shim can't be spawned without a shell). */
export function findSsh(env = process.env, platform = process.platform, exists = existsSync) {
  const pathVar = env.PATH ?? env.Path ?? "";
  const exts = platform === "win32" ? [".exe", ".com"] : [""];
  for (const dir of pathVar.split(platform === "win32" ? ";" : delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `ssh${ext}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** The ssh arguments for one remote command (BatchMode: key auth only, never a password prompt). */
export function sshArgs(host, command) {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=30",
    host,
    "--",
    command,
  ];
}

/** How one ssh call reads when printed: the remote command raw; standard input never shown. */
export function renderCall(host, command, hasInput) {
  const shown = sshArgs(host, command).slice(0, -1).join(" ");
  return `ssh ${shown} ${command}${hasInput ? " < <stdin: secret>" : ""}`;
}

const OUTPUT_CAP = 64 * 1024;

/** Runs one ssh call for real: spawn with an argument array, no shell; the value on stdin only. */
function spawnSsh(sshPath, args, input) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(sshPath, args, {
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      if (stdout.length < OUTPUT_CAP) stdout += c;
    });
    child.stderr.on("data", (c) => {
      if (stderr.length < OUTPUT_CAP) stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.on("error", () => {}); // EPIPE when the remote side exits early
      // UTF-8 bytes and one LF: the app drops only the line ending.
      child.stdin.end(Buffer.from(input, "utf8"));
    }
  });
}

/**
 * The context: `run(command, {input})` runs one remote command (or, in a dry run, prints it and
 * answers code 0 with no output). `deps.runner` replaces the real ssh in tests.
 */
export function createContext(opts, deps = {}) {
  const out = deps.out ?? ((line) => process.stdout.write(`${line}\n`));
  const ctx = { ...opts, out, sshPath: null };
  ctx.run = async (command, { input } = {}) => {
    if (ctx.dryRun) {
      out(`[dry-run] ${renderCall(ctx.host, command, input !== undefined)}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    const args = sshArgs(ctx.host, command);
    try {
      return deps.runner ? await deps.runner(args, input) : await spawnSsh(ctx.sshPath, args, input);
    } catch (e) {
      const code = e && typeof e.code === "string" ? e.code : "unknown";
      throw new HelperError(`ssh could not be started (${code}).`, 2);
    }
  };
  return ctx;
}

/** Plain words for why ssh failed, from its own message; the message itself is never printed. */
export function sshProblem(stderr) {
  const t = String(stderr);
  if (/Permission denied/i.test(t)) return "the Umbrel refused the key";
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(t)) {
    return "the Umbrel's host key is not known or has changed (connect once with ssh to check it)";
  }
  if (/Could not resolve hostname/i.test(t)) return "the alias is not in your ~/.ssh/config, or the name does not resolve";
  if (/timed out|No route to host|Connection refused|Network is unreachable/i.test(t)) return "the Umbrel did not answer";
  return "ssh failed";
}

async function preflight(ctx) {
  const r = await ctx.run("true");
  if (r.code !== 0) {
    throw new HelperError(
      `Cannot reach ${ctx.host} over SSH with key auth: ${sshProblem(r.stderr)}. Check Tailscale (or the LAN) and the ssh alias in your ~/.ssh/config.`,
      2,
    );
  }
}

async function remoteHome(ctx) {
  if (ctx.dryRun) {
    ctx.out(`(dry run: the remote home is shown as ${DRY_RUN_HOME})`);
    return DRY_RUN_HOME;
  }
  const r = await ctx.run('echo "$HOME"');
  const home = r.stdout.trim();
  if (r.code !== 0 || !HOME_RE.test(home) || home.split("/").some((s) => s === "." || s === "..")) {
    throw new HelperError("Could not read the remote home folder.", 2);
  }
  return home.replace(/\/+$/, "");
}

/** The remote config folder and its file paths, from validated constants only. */
export function remotePaths(home) {
  const dir = [home, ...CONFIG_PARTS].join("/");
  return {
    dir,
    file: (name) => `${dir}/${name}`,
    staged: (name) => `${dir}/.${name}.new`,
  };
}

async function requireConfigFolder(ctx, paths) {
  const r = await ctx.run(`test -d ${shq(paths.dir)}`);
  if (r.code === 255) throw new HelperError(`Lost the SSH connection to ${ctx.host}. Nothing was changed.`, 2);
  if (r.code !== 0) {
    throw new HelperError(
      "Crosscuts is not installed on the Umbrel: its data/config folder is not there. Install it in umbrelOS first.",
      2,
    );
  }
}

// ---- the stat report (mode and owner only) ---------------------------------------------------------

/**
 * One remote line per item: `<label> missing`, `<label> link`, or
 * `<label> <mode> <uid> <nonempty|empty> <file|dir|other>`. Mode and owner only: never a size and
 * never contents (`test -s` answers "empty or not" and nothing more). Labels are constants.
 */
export function statCommand(items) {
  const fn =
    'c() { if [ -L "$2" ]; then echo "$1 link"; elif [ -e "$2" ]; then ' +
    `echo "$1 $(stat -c '%a %u' -- "$2") $(test -s "$2" && echo nonempty || echo empty) ` +
    '$(if [ -f "$2" ]; then echo file; elif [ -d "$2" ]; then echo dir; else echo other; fi)"; ' +
    'else echo "$1 missing"; fi; }';
  return [fn, ...items.map(({ label, path }) => `c ${shq(label)} ${shq(path)}`)].join("; ");
}

/** Parses `statCommand` output into `{[label]: {state, mode?, uid?, nonempty?, type?}}`. */
export function parseStat(text, labels) {
  const found = {};
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    let m = /^(\S+) (missing|link)$/.exec(t);
    if (m) {
      found[m[1]] = { state: m[2] };
      continue;
    }
    m = /^(\S+) (\d{3,4}) (\d+) (nonempty|empty) (file|dir|other)$/.exec(t);
    if (m) found[m[1]] = { state: "present", mode: m[2], uid: m[3], nonempty: m[4] === "nonempty", type: m[5] };
  }
  for (const l of labels) if (!found[l]) found[l] = { state: "unknown" };
  return found;
}

/** What is wrong with a placed file, or null. */
export function fileProblem(entry) {
  if (entry.state === "missing") return "missing";
  if (entry.state === "link") return "a symbolic link (Crosscuts won't read it)";
  if (entry.state !== "present") return "could not be checked";
  if (entry.type !== "file") return "not a regular file (Crosscuts won't read it)";
  if (!entry.nonempty) return "empty";
  if (entry.mode !== FILE_MODE) return `mode ${entry.mode}, expected ${FILE_MODE}`;
  if (entry.uid !== EXPECTED_UID) return `owner uid ${entry.uid}, expected ${EXPECTED_UID}`;
  return null;
}

/** Whether Crosscuts can at least open a file: true usable, false missing, null present but not usable, undefined unknown. */
function usableOf(entry) {
  if (entry.state === "missing") return false;
  if (entry.state === "unknown") return undefined;
  if (entry.state === "present" && entry.type === "file" && entry.nonempty) return true;
  return null;
}

/** The `--check` report: one line per item and the state Crosscuts will derive. */
export function describe(found) {
  const lines = [];
  const folder = found.config ?? { state: "unknown" };
  if (folder.state === "present" && folder.type === "dir") {
    const note = folder.uid === EXPECTED_UID ? "" : ` (owner uid ${folder.uid}: the helper may not be able to write here)`;
    lines.push(`config folder: present (${folder.mode}, uid ${folder.uid})${note}`);
  } else {
    lines.push(`config folder: ${folder.state === "missing" ? "missing" : "could not be checked"}`);
  }
  for (const name of [FILES.passphrase, FILES.nasUrl, FILES.nasPassword]) {
    const e = found[name] ?? { state: "unknown" };
    if (e.state === "missing") lines.push(`${name}: missing`);
    else if (e.state === "unknown") lines.push(`${name}: could not be checked`);
    else {
      const problem = fileProblem(e);
      lines.push(problem === null ? `${name}: present (${e.mode}, uid ${e.uid})` : `${name}: present, but ${problem}`);
    }
  }

  const pp = usableOf(found[FILES.passphrase] ?? { state: "unknown" });
  let snapshots;
  if (pp === undefined) snapshots = "unknown (the file could not be checked)";
  else if (pp === false) snapshots = "off (the backup passphrase is not on the Umbrel)";
  else if (pp === null) snapshots = "not usable (the passphrase file is not a plain file with text in it)";
  else snapshots = "on (Crosscuts checks the passphrase's length itself: the Users page says if it is not usable)";

  const u = usableOf(found[FILES.nasUrl] ?? { state: "unknown" });
  const p = usableOf(found[FILES.nasPassword] ?? { state: "unknown" });
  let copy;
  if (u === undefined || p === undefined) copy = "unknown (a file could not be checked)";
  else if (u === false && p === false) copy = "not set up";
  else if (u === false || p === false) copy = `half set up (${u === false ? FILES.nasUrl : FILES.nasPassword} is missing: nothing is copied)`;
  else if (u === null || p === null) copy = "not usable (a file is not a plain file with text in it: nothing is copied)";
  else copy = "set up (Crosscuts checks the address itself: the Users page says if it is not usable)";

  return { lines, snapshots, copy };
}

// ---- prompts --------------------------------------------------------------------------------------

async function askAddress(ctx, prompt) {
  ctx.out(ADDRESS_HELP);
  for (;;) {
    const typed = (await prompt.visible("NAS address: ")).trim();
    const check = checkNasUrl(typed);
    if (!check.ok) {
      ctx.out(
        check.configured
          ? "That is not an rsync://<account>@<NAS Tailscale IP>/<module> address (an IP address, not a name; no password in it; no spaces). Try again."
          : "The address is empty. Try again.",
      );
      continue;
    }
    if (!isTailscaleIp(hostOf(check.url))) {
      ctx.out(NOT_TAILSCALE_WARNING);
      const answer = await prompt.visible("Type yes to use it anyway, or press Enter to type another: ");
      if (answer.trim() !== "yes") continue;
    }
    if (check.hasSubfolder) {
      ctx.out("Note: the subfolder must already exist on the NAS (rsync creates only one folder level).");
    }
    ctx.out("address accepted");
    return typed;
  }
}

async function askTwice(ctx, prompt, { label, problemOf }) {
  for (;;) {
    const first = await prompt.hidden(`${label} (hidden): `);
    const problem = problemOf(first);
    if (problem) {
      ctx.out(`${problem} Try again.`);
      continue;
    }
    const second = await prompt.hidden(`The same ${label.toLowerCase()} again (hidden): `);
    if (second !== first) {
      ctx.out("The two entries differ. Try again.");
      continue;
    }
    return first;
  }
}

async function askPassword(ctx, prompt) {
  const value = await askTwice(ctx, prompt, { label: "NAS password", problemOf: passwordProblem });
  ctx.out("password accepted");
  return value;
}

async function askPassphrase(ctx, prompt) {
  ctx.out(PASSPHRASE_REMINDER);
  ctx.out(`It must be at least ${PASSPHRASE_MIN} characters, and is kept exactly as typed (spaces included).`);
  const value = await askTwice(ctx, prompt, { label: "Passphrase", problemOf: passphraseProblem });
  ctx.out("passphrase accepted");
  return value;
}

// ---- modes ----------------------------------------------------------------------------------------

async function removeStaged(ctx, paths, names) {
  await ctx.run(`cd ${shq(paths.dir)} && rm -f -- ${names.map((n) => shq(`.${n}.new`)).join(" ")}`);
}

/** Checks a set of remote items; returns the problems as `name is problem` sentences. */
async function verify(ctx, items) {
  const r = await ctx.run(statCommand(items));
  if (ctx.dryRun) return [];
  const found = parseStat(r.stdout, items.map((i) => i.label));
  const problems = [];
  for (const { label } of items) {
    const problem = fileProblem(found[label]);
    if (problem) problems.push(`${label} is ${problem}`);
  }
  return problems;
}

async function place(ctx, paths, prompt) {
  const groups = ctx.group ? [ctx.group] : ["nas", "passphrase"];
  const names = groups.flatMap((g) => GROUPS[g]);
  const values = {};
  if (ctx.dryRun) {
    ctx.out("(dry run: no prompts; a real run asks for each value here and sends it only on ssh's standard input)");
    for (const n of names) values[n] = "";
  } else {
    if (groups.includes("nas")) {
      values[FILES.nasUrl] = await askAddress(ctx, prompt);
      values[FILES.nasPassword] = await askPassword(ctx, prompt);
    }
    if (groups.includes("passphrase")) values[FILES.passphrase] = await askPassphrase(ctx, prompt);
  }

  // 1. Stage each file under a hidden name (the value on stdin only). `rm -f` first: umask applies
  //    only when a file is created, so a stale `.new` left at 644 would otherwise keep 644.
  for (const name of names) {
    const staged = shq(`.${name}.new`);
    const r = await ctx.run(
      `cd ${shq(paths.dir)} && umask 077 && rm -f -- ${staged} && cat > ${staged} && chmod 600 -- ${staged}`,
      { input: `${values[name]}\n` },
    );
    values[name] = null;
    if (r.code !== 0) {
      await removeStaged(ctx, paths, names);
      throw new HelperError(`Could not write ${name} on the Umbrel. Nothing was changed.`, 1);
    }
  }

  // 2. Check what was staged: nothing goes live that would fail the check afterwards.
  const stagedProblems = await verify(
    ctx,
    names.map((n) => ({ label: `.${n}.new`, path: paths.staged(n) })),
  );
  if (stagedProblems.length > 0) {
    await removeStaged(ctx, paths, names);
    throw new HelperError(`${stagedProblems.join("; ")}. Nothing was changed.`, 1);
  }

  // 3. Move into place: the passphrase on its own, then the NAS password before the address, so
  //    Crosscuts never sees a new address without its password.
  for (const g of groups) {
    const moves = GROUPS[g].map((n) => `mv -f -- ${shq(`.${n}.new`)} ${shq(n)}`).join(" && ");
    const r = await ctx.run(`cd ${shq(paths.dir)} && ${moves}`);
    if (r.code !== 0) {
      await removeStaged(ctx, paths, names);
      throw new HelperError("Placing the files failed part way. Run --check, then this helper again.", 1);
    }
  }

  // 4. Check what is live.
  const liveProblems = await verify(
    ctx,
    names.map((n) => ({ label: n, path: paths.file(n) })),
  );
  if (liveProblems.length > 0) {
    throw new HelperError(`${liveProblems.join("; ")}. Run --check, then this helper again.`, 1);
  }

  ctx.out(`${ctx.dryRun ? "(dry run) Would place" : "Placed"}: ${names.join(", ")}.`);
  ctx.out("Crosscuts reads them on its next run: press Back up now on the Users page.");
  if (groups.includes("nas")) ctx.out("Placing the NAS files again also clears the refusal lock.");
  if (groups.includes("passphrase")) ctx.out(PASSPHRASE_REMINDER);
  return 0;
}

async function check(ctx, paths) {
  const items = [
    { label: "config", path: paths.dir },
    ...[FILES.passphrase, FILES.nasUrl, FILES.nasPassword].map((n) => ({ label: n, path: paths.file(n) })),
  ];
  const r = await ctx.run(statCommand(items));
  if (ctx.dryRun) {
    ctx.out("(dry run: nothing was checked)");
    return 0;
  }
  if (r.code !== 0) throw new HelperError("The check could not be run on the Umbrel.", 1);
  const { lines, snapshots, copy } = describe(parseStat(r.stdout, items.map((i) => i.label)));
  for (const l of lines) ctx.out(l);
  ctx.out(`Snapshots: ${snapshots}`);
  ctx.out(`Copy to the NAS: ${copy}`);
  return 0;
}

async function remove(ctx, paths, prompt) {
  // The address goes before the password, so Crosscuts never holds an address without its password.
  const names =
    ctx.group === "all"
      ? [FILES.nasUrl, FILES.nasPassword, FILES.passphrase]
      : ctx.group === "nas"
        ? [FILES.nasUrl, FILES.nasPassword]
        : [FILES.passphrase];
  const effects = [];
  if (names.includes(FILES.nasUrl)) effects.push("the copy to the NAS stops");
  if (names.includes(FILES.passphrase)) effects.push("the nightly snapshots stop");
  const effect = effects.join(" and ");
  if (!ctx.yes && !ctx.dryRun) {
    const answer = await prompt.visible(`Remove ${names.join(", ")} from ${ctx.host}? ${effect[0].toUpperCase()}${effect.slice(1)}. [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      ctx.out("Nothing was removed.");
      return 0;
    }
  }
  const targets = names.flatMap((n) => [shq(n), shq(`.${n}.new`)]).join(" ");
  const r = await ctx.run(`cd ${shq(paths.dir)} && rm -f -- ${targets}`);
  if (r.code !== 0) throw new HelperError("Could not remove the files. Run --check to see what is there.", 1);
  ctx.out(`${ctx.dryRun ? "(dry run) Would remove" : "Removed"}: ${names.join(", ")}. ${effect[0].toUpperCase()}${effect.slice(1)}.`);
  ctx.out("Nothing on the NAS was touched, and the archives already made stay on the Umbrel.");
  return 0;
}

async function promptTest(ctx, prompt) {
  if (ctx.dryRun) {
    ctx.out("(dry run: --prompt-test would read one hidden entry and print only its length; it never sends anything)");
    return 0;
  }
  if (!prompt.isTerminal()) throw new HelperError(NOT_A_TERMINAL_MESSAGE, 2);
  ctx.out("Type or paste anything EXCEPT the real password or passphrase, then Enter. Nothing should appear.");
  const entry = await prompt.hidden("Test entry (hidden): ");
  ctx.out(`read ${charCount(entry)} characters, nothing was echoed`);
  return 0;
}

// ---- main -----------------------------------------------------------------------------------------

export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const opts = parseArgs(argv, env);
  const out = deps.out ?? ((line) => process.stdout.write(`${line}\n`));
  if (opts.mode === "help") {
    out(USAGE);
    return 0;
  }
  const prompt = deps.prompt ?? createTerminalPrompt();
  const ctx = createContext(opts, { ...deps, out });

  if (opts.mode === "prompt-test") return promptTest(ctx, prompt);

  // A prompt needs a terminal that can hide input: refuse before anything runs.
  if (!ctx.dryRun) {
    if (opts.mode === "place" && !prompt.isTerminal()) throw new HelperError(NOT_A_TERMINAL_MESSAGE, 2);
    if (opts.mode === "remove" && !opts.yes && !prompt.isTerminal()) {
      throw new HelperError("--remove asks for confirmation: run it in PowerShell or Windows Terminal, or add --yes.", 2);
    }
  }

  if (!deps.runner) {
    const found = findSsh(env);
    if (found === null && !ctx.dryRun) {
      throw new HelperError(
        "ssh was not found on PATH. Windows includes it: Settings, System, Optional features, OpenSSH Client.",
        2,
      );
    }
    ctx.sshPath = found ?? "ssh";
    out(`Using ssh: ${found ?? "(not found on PATH; a real run would stop here)"}`);
  }
  out(`Umbrel: ${ctx.host}`);

  await preflight(ctx);
  const home = await remoteHome(ctx);
  const paths = remotePaths(home);
  await requireConfigFolder(ctx, paths);
  if (opts.mode === "check") return check(ctx, paths);
  if (opts.mode === "remove") return remove(ctx, paths, prompt);
  return place(ctx, paths, prompt);
}

/** Runs `main`; a HelperError becomes its exit code. An unexpected error is named, never quoted. */
export async function runMain(fn, err = (line) => process.stderr.write(`${line}\n`)) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HelperError) {
      err(`Error: ${e.message}`);
      return e.exitCode;
    }
    const code = e && typeof e.code === "string" ? e.code : e && e.name ? e.name : "unknown";
    err(`Error: the helper failed unexpectedly (${code}). Nothing more is shown, so no value can leak.`);
    return 1;
  }
}

function isEntry() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isEntry()) {
  process.exitCode = await runMain(() => main(process.argv.slice(2)));
}
