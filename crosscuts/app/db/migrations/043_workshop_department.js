// 043_workshop_department: Workshop becomes a sixth department (0.2.2, Todd 2026-10-26;
// docs/plans/m23-contracts.md section 7). Five tables carry a CHECK listing the five departments:
// dept_notes (029), recurring_tasks and dept_tasks (036), and their children dept_note_acks and
// recurring_occurrences reference two of them. SQLite can't alter a CHECK, so each is rebuilt by
// 021's method, with 'workshop' added to the list (Todd's sign-off, 2026-10-26): a new table from
// the live CREATE statement, every row copied, the copy compared, the old table dropped and the new
// one renamed. No row is added, changed or removed.
//
// Foreign keys stay on (a PRAGMA can't change inside a transaction), so the order matters: the
// children are copied into new tables that reference the new parents, then the old children are
// dropped before the old parents (nothing references an old parent when it goes), then the new
// parents are renamed (SQLite rewrites the children's REFERENCES to the final names) and the
// children last. Indexes go with their tables and are made again from their saved statements.
// The runner has already written its VACUUM INTO backup and wraps up(db) in a transaction, so any
// throw rolls the whole file back and stops boot with the database unchanged. Never require app
// code here (011's rule).
const OLD_LIST = "'scheduling','design','ordering','accounts','admin'";
const NEW_LIST = "'scheduling','design','ordering','accounts','admin','workshop'";

// [table, parent it references (or null)], parents before children.
const TABLES = [
  ["dept_notes", null],
  ["recurring_tasks", null],
  ["dept_tasks", null],
  ["dept_note_acks", "dept_notes"],
  ["recurring_occurrences", "recurring_tasks"],
];
const PARENTS = new Set(TABLES.filter(([, p]) => !p).map(([t]) => t));

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function createSql(db, table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row || !row.sql) throw new Error(`043: table ${table} not found; nothing was changed. Stop and ask Todd.`);
  return row.sql;
}

function up(db) {
  const before = {};
  const indexes = [];
  for (const [table] of TABLES) {
    before[table] = count(db, table);
    for (const ix of db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table)) {
      indexes.push(ix.sql);
    }
    const trig = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('trigger','view') AND tbl_name = ?").get(table).n;
    if (trig) throw new Error(`043: ${table} has a trigger or view; nothing was changed. Stop and ask Todd.`);
  }

  for (const [table, parent] of TABLES) {
    let sql = createSql(db, table);
    const head = new RegExp(`^CREATE TABLE "?${table}"?\\s*\\(`);
    if (!head.test(sql)) throw new Error(`043: unexpected CREATE statement for ${table}; nothing was changed.`);
    sql = sql.replace(head, `CREATE TABLE ${table}_new (`);
    if (PARENTS.has(table)) {
      const n = sql.split(OLD_LIST).length - 1;
      if (n !== 1) throw new Error(`043: ${table} has ${n} department lists, expected 1; nothing was changed.`);
      sql = sql.replace(OLD_LIST, NEW_LIST);
    } else {
      const ref = new RegExp(`REFERENCES\\s+"?${parent}"?\\s*\\(id\\)`);
      if (!ref.test(sql)) throw new Error(`043: ${table} does not reference ${parent}(id); nothing was changed.`);
      sql = sql.replace(ref, `REFERENCES ${parent}_new(id)`);
    }
    db.exec(sql);
    db.exec(`INSERT INTO ${table}_new SELECT * FROM ${table}`);
    const copied = count(db, `${table}_new`);
    const missing = db
      .prepare(`SELECT COUNT(*) AS n FROM (SELECT * FROM ${table} EXCEPT SELECT * FROM ${table}_new)`)
      .get().n;
    if (copied !== before[table] || missing !== 0) {
      throw new Error(`043: ${table} copy does not match (${before[table]} before, ${copied} copied, ${missing} missing)`);
    }
  }

  // Children first, then parents: an old parent is referenced by nothing when it is dropped.
  for (const [table] of [...TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
  for (const [table] of TABLES) db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
  for (const sql of indexes) db.exec(sql);

  for (const [table, parent] of TABLES) {
    const after = count(db, table);
    if (after !== before[table]) throw new Error(`043: ${table} has ${after} row(s) after the rebuild, expected ${before[table]}`);
    const fk = db.prepare(`PRAGMA foreign_key_check(${table})`).all();
    if (fk.length) throw new Error(`043: ${table} fails foreign_key_check after the rebuild (${fk.length} row(s))`);
    if (parent && !new RegExp(`REFERENCES\\s+"?${parent}"?\\s*\\(id\\)`).test(createSql(db, table))) {
      throw new Error(`043: ${table} no longer references ${parent}(id) after the rebuild`);
    }
  }
  console.log(
    `[migrate] 043 department tables rebuilt with 'workshop' allowed: ${TABLES.map(([t]) => `${t} ${before[t]}`).join(", ")} row(s) kept`
  );
}

module.exports = { up };
