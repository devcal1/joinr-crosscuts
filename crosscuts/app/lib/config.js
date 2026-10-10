// Runtime directories. The container always sets these (see Dockerfile); the
// fallbacks only matter for a bare `node server.js` on a dev machine, and they
// sit under git-ignored folders next to the app, never inside db/ (which holds
// source: db/index.js and the migrations).
const path = require("path");
const fs = require("fs");

const APP_ROOT = path.join(__dirname, "..");

const DB_DIR = process.env.DB_DIR || path.join(APP_ROOT, "data", "db");
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(APP_ROOT, "uploads");
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(APP_ROOT, "config");

fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });

module.exports = { APP_ROOT, DB_DIR, UPLOADS_DIR, CONFIG_DIR };
