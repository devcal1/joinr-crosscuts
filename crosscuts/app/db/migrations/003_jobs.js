// 003_jobs: jobs lifecycle extension, photos.job_id, and the one-off stage backfill.
// See docs/plans/m1-plan.md section 2. Everything here is additive: existing
// columns are untouched. The runner wraps up(db) in a transaction and records
// a checksum, so this file must never be edited once applied.
const { sydneyMonday } = require("../../lib/time");

const STAGES = [
  "lead", "quoted", "won", "design_ordering", "ready_to_cut",
  "on_board", "complete", "invoiced", "lost", "archived",
];
const q = (list) => list.map((s) => `'${s}'`).join(",");

// SQLite: ADD COLUMN allows CHECK, and NOT NULL only with a non-null default.
const COLUMNS = [
  `stage TEXT CHECK (stage IN (${q(STAGES)}))`,
  "stage_changed_at TEXT",
  "source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','joinr','board_quick_add'))",
  "external_ref TEXT",
  "client_name TEXT",
  "client_phone TEXT",
  "client_email TEXT",
  "site_address TEXT",
  "sheet_count INTEGER",
  "is_two_pac INTEGER CHECK (is_two_pac IN (0,1))",
  "benchtop TEXT CHECK (benchtop IN ('laminate','stone','none'))",
  "job_type TEXT",
  "value_cents INTEGER",
  // Business dates: Australia/Sydney local YYYY-MM-DD.
  "enquiry_date TEXT",
  "quoted_date TEXT",
  "won_date TEXT",
  "design_signed_off_date TEXT",
  "materials_ordered_date TEXT",
  "ready_to_cut_date TEXT",
  "promised_install_date TEXT",
  "completed_date TEXT",
  "design_folder_url TEXT",
  "joinr_quote_url TEXT",
  "updated_at TEXT",
];

function up(db) {
  for (const col of COLUMNS) db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`);

  db.exec("CREATE UNIQUE INDEX idx_jobs_external_ref ON jobs(external_ref) WHERE external_ref IS NOT NULL");
  db.exec("CREATE INDEX idx_jobs_stage ON jobs(stage)");

  db.exec("ALTER TABLE photos ADD COLUMN job_id INTEGER REFERENCES jobs(id)");

  // Backfill (approved by Todd). M = this week's Monday in Sydney. In order:
  //   any week_rows with week_start >= M -> on_board
  //   else in backlog                    -> ready_to_cut
  //   else                               -> complete
  // Applies to every job, archived ones included. No business dates invented.
  const monday = sydneyMonday();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE jobs SET
       stage = CASE
         WHEN EXISTS (SELECT 1 FROM week_rows wr WHERE wr.job_id = jobs.id AND wr.week_start >= ?) THEN 'on_board'
         WHEN EXISTS (SELECT 1 FROM backlog b WHERE b.job_id = jobs.id) THEN 'ready_to_cut'
         ELSE 'complete'
       END,
       stage_changed_at = ?`
  ).run(monday, now);

  const counts = db.prepare("SELECT stage, COUNT(*) AS n FROM jobs GROUP BY stage ORDER BY stage").all();
  const total = counts.reduce((a, c) => a + c.n, 0);
  console.log(
    `[migrate] 003 backfill (week start ${monday}): ` +
      (counts.map((c) => `${c.stage}=${c.n}`).join(", ") || "no jobs") +
      ` (total ${total})`
  );
}

module.exports = { up };
