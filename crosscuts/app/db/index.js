const path = require("path");
const Database = require("better-sqlite3");
const { DB_DIR } = require("../lib/config");
const { migrate } = require("./migrate");

// File is named photos.db from when this app only handled the photo library,
// but it now also holds the entire live schedule (workers/jobs/week_rows/
// assignments/day_flags) — a real business's daily-use data, not a demo.
// Do NOT rename this file: the deployed Umbrel volume stores data under this
// exact name, and a rename without migrating it boots the app with an empty
// schedule (the seed block below would then silently recreate a fresh
// six-worker roster, masking the loss until someone notices real data is gone).
const db = new Database(path.join(DB_DIR, "photos.db"));
db.pragma("journal_mode = WAL");

// Schema lives in db/migrations/NNN_name.sql|.js (see db/migrate.js).
migrate(db, { dbDir: DB_DIR });

// Foreign keys are enforced from here on (new writes only). Existing rows that
// violate a constraint are reported, not rejected.
db.pragma("foreign_keys = ON");
const fkProblems = db.pragma("foreign_key_check");
if (fkProblems.length === 0) {
  console.log("[db] foreign_key_check: ok");
} else {
  console.warn(
    `[db] foreign_key_check: ${fkProblems.length} violation(s)`,
    JSON.stringify(fkProblems.slice(0, 20))
  );
}

// Seed a starter worker roster on first run, so the schedule isn't blank on install.
const workerCount = db.prepare("SELECT COUNT(*) AS n FROM workers").get().n;
if (workerCount === 0) {
  const insertWorker = db.prepare(
    "INSERT INTO workers (name, hue, sort_order) VALUES (?, ?, ?)"
  );
  const starters = ["Blay", "Sam", "Darcy", "Shooter", "Moo", "Michael"];
  const insertMany = db.transaction((names) => {
    names.forEach((name, i) => insertWorker.run(name, (i * 137) % 360, i));
  });
  insertMany(starters);
}

module.exports = db;
