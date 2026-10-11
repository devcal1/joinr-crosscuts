#!/usr/bin/env node
// The backup flag and logging guard (docs/plans/backup-contracts.md section 16.1). CI runs it
// beside the style check, before the image is built:
//
//   node ci/backup-guard.js
//
// It scans crosscuts/app/lib/backup/**/*.js, crosscuts/app/tools/restore.js and
// tools/backup-secrets.mjs, with comments stripped first (Joinr Backup's codeLines rule: block
// comments and whole-line // comments), and fails (exit 1, one line per problem) if:
//   - a string literal is a banned rsync flag (--delete and every --delete-*, --del, --partial,
//     --partial-dir, --inplace, --append, --append-verify, --remove-source-files,
//     --remove-sent-files, -a, --archive, -r, --recursive, --mkpath, --files-from,
//     --password-file, -e, --rsh, -P);
//   - RSYNC_FLAGS in constants.js is not exactly ['--times', '--contimeout=10', '--timeout=120'],
//     or --list-only appears anywhere but constants.js;
//   - `shell: true` appears, or exec, execSync, execFile or execFileSync is taken from
//     child_process (children are spawn with an argument array only; db.exec is not a child);
//   - a console. call mentions passphrase, password, nasUrl, RSYNC_PASSWORD, args, .out or .err.
// Missing files are skipped (later waves add them), except constants.js, which must exist.
// If this check fails, fix the code, not the guard.
"use strict";
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const BACKUP_DIR = path.join(REPO, "crosscuts", "app", "lib", "backup");
const EXTRA_FILES = [path.join(REPO, "crosscuts", "app", "tools", "restore.js"), path.join(REPO, "tools", "backup-secrets.mjs")];
const CONSTANTS = path.join(BACKUP_DIR, "constants.js");

const BANNED = new Set([
  "--del",
  "--partial",
  "--partial-dir",
  "--inplace",
  "--append",
  "--append-verify",
  "--remove-source-files",
  "--remove-sent-files",
  "-a",
  "--archive",
  "-r",
  "--recursive",
  "--mkpath",
  "--files-from",
  "--password-file",
  "-e",
  "--rsh",
  "-P",
]);
const PINNED_FLAGS = ["--times", "--contimeout=10", "--timeout=120"];
const EXEC_NAMES = ["exec", "execSync", "execFile", "execFileSync"];
const LOG_WORDS = /passphrase|password|nasUrl|RSYNC_PASSWORD|\bargs\b|\.out\b|\.err\b/i;

// Joinr Backup's codeLines: block comments become a newline, whole-line // comments go.
function codeLines(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "\n")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else if (e.isFile() && /\.(js|mjs|cjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

// Every quoted literal's text: '...', "..." and `...` (template text taken as written).
function stringLiterals(code) {
  const out = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let m;
  while ((m = re.exec(code)) !== null) out.push(m[2]);
  return out;
}

// The text of each console.<x>( ... ) call, to its matching parenthesis.
function consoleCalls(code) {
  const out = [];
  const re = /\bconsole\s*\.\s*[A-Za-z]+\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(code.slice(m.index, i + 1));
  }
  return out;
}

function lineOf(code, index) {
  return code.slice(0, index).split("\n").length;
}

// Problems with how child_process is used: exec* taken from it in any form.
function execProblems(code) {
  const problems = [];
  const mod = String.raw`["'](?:node:)?child_process["']`;
  const execAlt = EXEC_NAMES.join("|");
  // const { exec, spawn } = require("child_process")  /  import { execFile } from "node:child_process"
  const destructure = new RegExp(String.raw`\{([^}]*)\}\s*=\s*require\(\s*${mod}\s*\)`, "g");
  const importNamed = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${mod}`, "g");
  for (const re of [destructure, importNamed]) {
    let m;
    while ((m = re.exec(code)) !== null) {
      const names = m[1].split(",").map((s) => s.trim().split(/\s*(?::|\bas\b)\s*/)[0]);
      for (const n of names) if (EXEC_NAMES.includes(n)) problems.push(`${n} taken from child_process`);
    }
  }
  // require("child_process").exec(...)
  const direct = new RegExp(String.raw`require\(\s*${mod}\s*\)\s*\.\s*(${execAlt})\b`, "g");
  let m;
  while ((m = direct.exec(code)) !== null) problems.push(`${m[1]} taken from child_process`);
  // const cp = require("child_process") / import cp from / import * as cp from ... then cp.exec
  const aliases = [];
  const aliasReq = new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*${mod}\s*\)`, "g");
  const aliasImp = new RegExp(String.raw`import\s+(?:\*\s*as\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*${mod}`, "g");
  for (const re of [aliasReq, aliasImp]) {
    while ((m = re.exec(code)) !== null) aliases.push(m[1]);
  }
  for (const a of aliases) {
    const use = new RegExp(String.raw`(?<![\w$.])${a.replace(/\$/g, "\\$")}\s*\.\s*(${execAlt})\b`, "g");
    while ((m = use.exec(code)) !== null) problems.push(`${m[1]} taken from child_process`);
  }
  return problems;
}

function checkFile(file, problems) {
  const rel = path.relative(REPO, file).split(path.sep).join("/");
  const code = codeLines(fs.readFileSync(file, "utf8"));
  const isConstants = path.resolve(file) === path.resolve(CONSTANTS);

  for (const lit of stringLiterals(code)) {
    if (BANNED.has(lit) || lit.startsWith("--delete")) problems.push(`${rel}: banned rsync flag literal "${lit}"`);
  }
  if (!isConstants) {
    let i = code.indexOf("--list-only");
    while (i !== -1) {
      problems.push(`${rel}:${lineOf(code, i)}: --list-only outside constants.js (use RSYNC_LIST_FLAG)`);
      i = code.indexOf("--list-only", i + 1);
    }
  }
  const shellRe = /\bshell\s*:\s*true\b/g;
  let m;
  while ((m = shellRe.exec(code)) !== null) problems.push(`${rel}:${lineOf(code, m.index)}: shell: true`);
  for (const p of execProblems(code)) problems.push(`${rel}: ${p}`);
  const callRe = /\bconsole\s*\.\s*[A-Za-z]+\s*\(/g;
  const calls = consoleCalls(code);
  let k = 0;
  while ((m = callRe.exec(code)) !== null) {
    const call = calls[k++] || "";
    const hit = LOG_WORDS.exec(call);
    if (hit) problems.push(`${rel}:${lineOf(code, m.index)}: a console call mentions "${hit[0]}"`);
  }
}

function checkPinnedFlags(problems) {
  let text;
  try {
    text = codeLines(fs.readFileSync(CONSTANTS, "utf8"));
  } catch {
    problems.push("crosscuts/app/lib/backup/constants.js is missing");
    return;
  }
  const defs = [...text.matchAll(/\bRSYNC_FLAGS\s*=\s*(?:Object\.freeze\(\s*)?\[([^\]]*)\]/g)];
  if (defs.length !== 1) {
    problems.push(`constants.js: RSYNC_FLAGS must be defined exactly once as an array literal (found ${defs.length})`);
    return;
  }
  const items = defs[0][1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const values = items.map((s) => {
    const q = /^(['"`])(.*)\1$/.exec(s);
    return q ? q[2] : null;
  });
  const same = values.length === PINNED_FLAGS.length && values.every((v, i) => v === PINNED_FLAGS[i]);
  if (!same) problems.push(`constants.js: RSYNC_FLAGS must be exactly ['${PINNED_FLAGS.join("', '")}']`);
}

function main() {
  const files = walk(BACKUP_DIR).concat(EXTRA_FILES.filter((f) => fs.existsSync(f)));
  const problems = [];
  checkPinnedFlags(problems);
  for (const f of files) checkFile(f, problems);
  if (problems.length > 0) {
    for (const p of problems) console.error(`backup-guard: ${p}`);
    console.error(`backup-guard: ${problems.length} problem(s) in ${files.length} file(s). Fix the code, not the guard.`);
    process.exit(1);
  }
  console.log(`backup-guard: ${files.length} file(s) checked, no problems.`);
}

main();
