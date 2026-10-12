#!/usr/bin/env node
// House-style check for the Crosscuts front end. CI runs it before the image is built:
//
//   node ci/style-check.js
//
// It fails (exit 1) on anything in crosscuts/app/public (vendor/ excluded) that breaks the
// house style in CLAUDE.md "Look and feel":
//   - a literal colour (hex, rgb, hsl, or a named colour) outside tokens.css
//   - a shadow (box-shadow, text-shadow, drop-shadow) or a brightness filter
//   - a font weight other than 400 or 700
//   - the Inter font, or Phosphor icons outside the board
//
// Exceptions, all named in CLAUDE.md and approved by Todd on 2026-10-10 and 2026-10-11:
//   - tokens.css defines the colours
//   - worker colours: oklch() in shared.js (each worker's own hue)
//   - board icons: Phosphor in schedule.html and schedule.js
//   - planner layer markers: the --layer-* tokens, only in planner.html, planner.css and
//     planner.js (approved by Todd on 2026-10-11)
//   - menu department rules: --layer-scheduling, --layer-design, --layer-install (Ordering) and
//     --layer-accounts, only in
//     shell/shell.css (approved by Todd on 2026-10-12)
//   - print styles: the paper colours between the comments
//     "style-check: print-start" and "style-check: print-end"
// If this check fails, fix the page, not the check.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "crosscuts", "app", "public");
const TOKENS = "tokens.css";
const PHOSPHOR_OK = new Set(["schedule.html", "schedule.js"]);
const OKLCH_OK = new Set(["shared.js"]);
const LAYER_OK = new Set(["tokens.css", "planner.html", "planner.css", "planner.js"]);
const DEPT_FILE = "shell/shell.css";
const DEPT_LAYERS = new Set(["--layer-scheduling", "--layer-design", "--layer-install", "--layer-accounts"]);

const HEX = "(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})";
const NAMED = "white|black|red|green|blue|orange|purple|violet|gray|grey|yellow|pink|teal|navy|maroon|silver|gold|cyan|magenta|lime|olive|brown";

// [label, regex, applies to (file => bool)]
const RULES = [
  ["literal hex colour", new RegExp(`(?:[:\\s(,]#${HEX}(?![-\\w])|["'\`]#${HEX}["'\`])`), f => f !== TOKENS],
  ["literal rgb/hsl colour", /\b(?:rgba?|hsla?|hwb|lab|lch)\(/, f => f !== TOKENS],
  ["oklch colour outside the worker-colour code", /\boklch\(/, f => f !== TOKENS && !OKLCH_OK.has(path.basename(f))],
  ["named colour", new RegExp(`(?:^|[;{\\s])(?:color|background(?:-color)?|border(?:-[a-z]+)?-?color|border(?:-(?:top|right|bottom|left))?|outline(?:-color)?|fill|stroke|accent-color|caret-color)\\s*:[^;{}]*\\b(?:${NAMED})\\b`, "i"), f => /\.(css|html)$/.test(f) && f !== TOKENS],
  ["shadow", /\b(?:box-shadow|text-shadow)\s*:(?!\s*none\b)|drop-shadow\(/, () => true],
  ["brightness filter", /\bfilter\s*:[^;]*brightness\(/, () => true],
  ["font weight other than 400/700", /font-weight\s*:(?!\s*(?:400|700|normal|bold|inherit)\b)/, () => true],
  ["font weight other than 400/700 (canvas or shorthand)", /["'`](?:italic\s+)?(?:100|200|300|500|600|800|900)\s+\d+(?:\.\d+)?px/, f => /\.js$/.test(f)],
  ["Inter font", /\bInter\b|vendor\/inter/, () => true],
  ["icon (Phosphor) outside the board", /phosphor|["'\s]ph ph-|["'\s]ph-[a-z]/, f => !PHOSPHOR_OK.has(path.basename(f))],
];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "vendor") out.push(...walk(p)); }
    else if (/\.(css|html|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const problems = [];
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let inPrint = false;
  lines.forEach((raw, i) => {
    if (raw.includes("style-check: print-start")) inPrint = true;
    if (raw.includes("style-check: print-end")) { inPrint = false; return; }
    // Comments may mention colours and fonts; check code only.
    const code = raw.replace(/\/\*.*?\*\//g, "").replace(/^\s*(\/\/|\*|\/\*).*$/, "").replace(/<!--.*?-->/g, "");
    const layerOk = LAYER_OK.has(rel) ||
      (rel === DEPT_FILE && !/(?<!var\()--layer-/.test(code) &&
        (code.match(/--layer-[\w-]+/g) || []).every(t => DEPT_LAYERS.has(t)));
    if (/--layer-/.test(code) && !layerOk) {
      problems.push(`${rel}:${i + 1}: planner layer token outside the planner: ${raw.trim().slice(0, 140)}`);
    }
    // Token references (var(--orange)) are how colours should be used.
    const line = code.replace(/var\(--[\w-]+\)/g, "var()");
    for (const [label, re, applies] of RULES) {
      if (!applies(rel)) continue;
      if (inPrint && /colour|named/.test(label)) continue;
      if (re.test(line)) problems.push(`${rel}:${i + 1}: ${label}: ${raw.trim().slice(0, 140)}`);
    }
  });
}

if (problems.length) {
  console.error(`House-style check failed (${problems.length}). See CLAUDE.md "Look and feel"; fix the page, not the check.\n`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("House-style check passed.");
