// 060_board_weekend: a sixth board day column, "Weekend", after Friday (0.2.16, Todd 2026-11-11).
// assignments.day and day_flags.day carry a CHECK listing mon..fri (001), and SQLite can't alter a
// CHECK, so both tables are rebuilt by 021 and 043's method with 'wknd' added to the list: a new
// table from the live CREATE statement, every row copied (ids and timestamps included), the copy
// compared, the old table dropped, the new one renamed and its indexes made again. No row is added,
// changed or removed, and the AUTOINCREMENT counters are carried over so no id is ever reused.
// Both tables are leaves (nothing references them), so no ordering problem arises. The runner has
// already written its VACUUM INTO backup and wraps up(db) in a transaction, so any throw rolls the
// whole file back and stops boot with the database unchanged. Never require app code here.
const OLD_LIST = "'mon','tue','wed','thu','fri'";
const NEW_LIST = "'mon','tue','wed','thu','fri','wknd'";
const TABLES = ["assignments", "day_flags"];

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function up(db) {
  const info = {};
  for (const table of TABLES) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!row || !row.sql) throw new Error(`060: table ${table} not found; nothing was changed. Stop and ask Todd.`);
    const refs = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name <> ? AND sql LIKE ?")
      .get(table, `%REFERENCES ${table}%`).n;
    const trig = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('trigger','view') AND tbl_name = ?").get(table).n;
    if (refs || trig) throw new Error(`060: ${table} is referenced or has a trigger or view; nothing was changed. Stop and ask Todd.`);
    const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table);
    info[table] = {
      sql: row.sql,
      before: count(db, table),
      seq: seq ? seq.seq : null,
      indexes: db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
        .all(table)
        .map((r) => r.sql),
    };
  }

  for (const table of TABLES) {
    let sql = info[table].sql;
    const head = new RegExp(`^CREATE TABLE "?${table}"?\\s*\\(`);
    if (!head.test(sql)) throw new Error(`060: unexpected CREATE statement for ${table}; nothing was changed.`);
    if (sql.split(OLD_LIST).length - 1 !== 1) throw new Error(`060: ${table} does not hold the day list exactly once; nothing was changed.`);
    sql = sql.replace(head, `CREATE TABLE ${table}_new (`).replace(OLD_LIST, NEW_LIST);
    db.exec(sql);
    db.exec(`INSERT INTO ${table}_new SELECT * FROM ${table}`);
    const copied = count(db, `${table}_new`);
    const missing = db
      .prepare(`SELECT COUNT(*) AS n FROM (SELECT * FROM ${table} EXCEPT SELECT * FROM ${table}_new)`)
      .get().n;
    if (copied !== info[table].before || missing !== 0) {
      throw new Error(`060: ${table} copy does not match (${info[table].before} before, ${copied} copied, ${missing} missing)`);
    }
    if (info[table].seq != null) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(info[table].seq, `${table}_new`);
  }

  for (const table of TABLES) db.exec(`DROP TABLE ${table}`);
  for (const table of TABLES) db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
  for (const table of TABLES) for (const sql of info[table].indexes) db.exec(sql);

  for (const table of TABLES) {
    const after = count(db, table);
    if (after !== info[table].before) throw new Error(`060: ${table} has ${after} rows, expected ${info[table].before}`);
  }
}

module.exports = { up };
