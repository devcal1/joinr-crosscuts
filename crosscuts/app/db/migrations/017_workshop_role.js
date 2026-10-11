// 017_workshop_role: allow the 'workshop' role (docs/plans/m7-contracts.md section 2; Todd's
// sign-off in docs/plans/m7-plan.md, Decisions 3). SQLite can't alter a CHECK, so user_roles is
// rebuilt: a new table with 'workshop' in the CHECK, every row copied, the copy compared, the old
// table dropped and the new one renamed. No row is added, changed or removed.
// The runner has already written its VACUUM INTO backup and wraps up(db) in a transaction, so
// any throw below rolls the whole file back and stops boot with the database unchanged.
// Foreign keys stay on (a PRAGMA can't change inside a transaction); nothing references
// user_roles, so the drop and rename are safe. Never require app code here (011's rule).
function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function up(db) {
  const orphans = db
    .prepare("SELECT COUNT(*) AS n FROM user_roles WHERE user_id NOT IN (SELECT id FROM users)")
    .get().n;
  if (orphans > 0) {
    throw new Error(`user_roles has ${orphans} row(s) for users that don't exist; nothing was changed. Stop and ask Todd.`);
  }
  const before = count(db, "user_roles");

  db.exec(`CREATE TABLE user_roles_new (
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('admin','accounts','design_pm','scheduling','showroom','workshop')),
    PRIMARY KEY (user_id, role)
  )`);
  db.exec("INSERT INTO user_roles_new (user_id, role) SELECT user_id, role FROM user_roles");

  const copied = count(db, "user_roles_new");
  const missing = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT user_id, role FROM user_roles EXCEPT SELECT user_id, role FROM user_roles_new)`
    )
    .get().n;
  if (copied !== before || missing !== 0) {
    throw new Error(`user_roles copy does not match (${before} before, ${copied} copied, ${missing} missing)`);
  }

  db.exec("DROP TABLE user_roles");
  db.exec("ALTER TABLE user_roles_new RENAME TO user_roles");

  const after = count(db, "user_roles");
  if (after !== before) throw new Error(`user_roles has ${after} row(s) after the rebuild, expected ${before}`);
  const fk = db.prepare("PRAGMA foreign_key_check(user_roles)").all();
  if (fk.length) throw new Error(`user_roles fails foreign_key_check after the rebuild (${fk.length} row(s))`);

  console.log(`[migrate] 017 user_roles rebuilt: ${after} row(s) kept, 'workshop' allowed`);
}

module.exports = { up };
