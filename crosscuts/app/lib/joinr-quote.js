// The whole Joinr quote (task J4, contract version 4: docs/integrations/joinr-crosscuts-intake.md,
// "The quote object"). Four jobs, all here so the rest of the app only calls in:
//
//   sanitize(raw)        validates a `quote` from a won-quotes item and returns a normalised copy
//                        holding only the contract's fields (numbers finite-or-null, strings capped,
//                        lists capped). Throws when the shape is wrong or the copy is over 1.5 MB:
//                        the caller drops the quote and keeps the item, so a bad quote can never
//                        refuse an item or stall the cursor.
//   readItemQuote(item)  the same, from an item: {kind: 'absent' | 'null' | 'ok' | 'bad', quote, problem}.
//   store / latest / forJob   the one snapshot per intake record (joinr_quote_snapshots, migration 035).
//   materialLines(quote) the quote's materials as Materials-list lines (labour is NOT materials).
//   view(snapshot, {money})   what the API sends. Money figures are left out of the object entirely
//                        unless money is true (the caller's jobs.value), not merely hidden by the page.
//
// The quote is never used to detect edits (Joinr prices it when it builds the item; GST or an unfrozen
// rate card can change it with no `changed` event), so it is kept out of joinr_intake.payload.
const MAX_STORED_BYTES = 1.5 * 1024 * 1024;
const MAX_ROOMS = 200;
const MAX_LINES = 600; // per room
const MAX_CUSTOM = 300; // per room
const MAX_SECTIONS = 60; // per room
const MAX_OPTIONS = 300;
const MAX_WARNINGS = 300;
const NAME_MAX = 300;
const ID_MAX = 100;
const TITLE_MAX = 200;
const UNIT_MAX = 30;
const SPEC_MAX = 300;
const NOTES_MAX = 20000;
const MESSAGE_MAX = 1000;
const NUM_MAX = 1e13;

const KINDS = ["board", "travel", "labour", "simple"];
const BUCKETS = ["labourOffice", "labourWorkshop", "materials", "overheads"];
const HOURS_BUCKETS = ["office", "factory", "site", "travel"];

// ---- the validator ----------------------------------------------------------------------------

function bad(reason) {
  return new Error(reason);
}

// A finite number (plain, not rounded), else null.
const num = (v) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= NUM_MAX ? v : null);
// A string capped to max, else null.
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
const bool = (v) => v === true;

function record(v, what) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(`${what} must be an object`);
  return v;
}
// A missing optional object reads as empty; anything else that is not an object is malformed.
function optRecord(v, what) {
  return v === undefined || v === null ? {} : record(v, what);
}
function list(v, what, max, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw bad(`${what} must be a list`);
    return [];
  }
  if (!Array.isArray(v)) throw bad(`${what} must be a list`);
  if (v.length > max) throw bad(`${what} holds more than ${max} entries`);
  return v;
}

const ROOM_TOTALS_NUMBERS = [
  "labourOfficeCents", "labourWorkshopCents", "materialsCents", "customItemsCents", "travelCents",
  "overheadRecoveryCents", "overheadsCents", "markupFactor", "markupCents", "subtotalCents", "adjustCents",
  "roomAdjustCents", "exGstCents", "gstCents", "incGstCents", "costOfGoodsCents", "cogsRatio", "marginCents",
];
const TOTALS_NUMBERS = [
  "labourOfficeCents", "labourWorkshopCents", "materialsCents", "markupCents", "overheadsCents", "adjustCents",
  "exGstCents", "gstCents", "incGstCents", "costOfGoodsCents", "cogsRatio", "marginCents",
];
const COST_NUMBERS = ["officeCents", "labourCents", "labourFactoryCents", "labourSiteCents", "materialsCents", "overheadsCents"];

function pick(src, names) {
  const out = {};
  for (const n of names) out[n] = num(src[n]);
  return out;
}

function sanitizeLine(l, where) {
  record(l, where);
  const name = str(l.name, NAME_MAX);
  if (name === null || !name.trim()) throw bad(`${where}.name must be text`);
  const section = str(l.section, ID_MAX);
  if (section === null || !section) throw bad(`${where}.section must be text`);
  const out = {
    section,
    sectionTitle: str(l.sectionTitle, TITLE_MAX),
    kind: KINDS.includes(l.kind) ? l.kind : str(l.kind, 30),
    costBucket: BUCKETS.includes(l.costBucket) ? l.costBucket : null,
    hoursBucket: HOURS_BUCKETS.includes(l.hoursBucket) ? l.hoursBucket : null,
    unit: str(l.unit, UNIT_MAX),
    name,
    qty: num(l.qty),
    unitRateCents: num(l.unitRateCents),
    lineTotalCents: num(l.lineTotalCents),
  };
  // Board-line and travel-line extras, only on those lines.
  for (const k of ["boardCostCents", "edgingCents", "cncCents", "perKmCents"]) if (k in l) out[k] = num(l[k]);
  return out;
}

function sanitizeCustom(c, where) {
  record(c, where);
  return {
    description: str(c.description, NAME_MAX),
    qty: num(c.qty),
    unitPriceCents: num(c.unitPriceCents),
    lineTotalCents: num(c.lineTotalCents),
    markup: num(c.markup),
    markupFromTier: bool(c.markupFromTier),
    lineTotalWithMarkupCents: num(c.lineTotalWithMarkupCents),
  };
}

function sanitizeRoom(r, i) {
  const where = `rooms[${i}]`;
  record(r, where);
  const spec = optRecord(r.spec, `${where}.spec`);
  const hours = optRecord(r.hours, `${where}.hours`);
  const totals = optRecord(r.totals, `${where}.totals`);
  const lines = list(r.lines, `${where}.lines`, MAX_LINES, { required: true }).map((l, j) => sanitizeLine(l, `${where}.lines[${j}]`));
  const customItems = list(r.customItems, `${where}.customItems`, MAX_CUSTOM).map((c, j) => sanitizeCustom(c, `${where}.customItems[${j}]`));
  const sections = list(r.sections, `${where}.sections`, MAX_SECTIONS).map((s, j) => {
    record(s, `${where}.sections[${j}]`);
    return { id: str(s.id, ID_MAX) || "", title: str(s.title, TITLE_MAX), totalCents: num(s.totalCents) };
  });
  return {
    id: str(r.id, ID_MAX),
    name: str(r.name, NAME_MAX),
    adjust: num(r.adjust),
    spec: {
      doorsPanels: str(spec.doorsPanels, SPEC_MAX) || "",
      benchtop: str(spec.benchtop, SPEC_MAX) || "",
      jobType: str(spec.jobType, SPEC_MAX) || "",
    },
    lines,
    customItems,
    sections,
    hours: pick(hours, HOURS_BUCKETS),
    totals: { ...pick(totals, ROOM_TOTALS_NUMBERS), cogsWarning: bool(totals.cogsWarning) },
  };
}

// Returns the normalised quote or throws an Error naming the field (never quoting values).
function sanitize(raw) {
  const q = record(raw, "quote");
  const rooms = list(q.rooms, "rooms", MAX_ROOMS, { required: true }).map(sanitizeRoom);
  const gst = optRecord(q.gst, "gst");
  const tier = optRecord(q.tier, "tier");
  const factors = optRecord(q.cogsFactors, "cogsFactors");
  const labourIn = optRecord(q.labour, "labour");
  const totals = optRecord(q.totals, "totals");
  const costs = optRecord(totals.costs, "totals.costs");
  const labourKind = (k) => {
    const v = optRecord(labourIn[k], `labour.${k}`);
    return { typed: num(v.typed), hours: num(v.hours), costCents: num(v.costCents) };
  };
  const out = {
    pricedAt: q.pricedAt === "snapshot" || q.pricedAt === "live" ? q.pricedAt : null,
    gst: { registered: gst.registered !== false, rate: num(gst.rate) },
    tier: {
      requested: str(tier.requested, 100),
      code: str(tier.code, 100),
      label: str(tier.label, TITLE_MAX),
      materialMarkup: num(tier.materialMarkup),
      fallback: bool(tier.fallback),
    },
    globalMarkup: num(q.globalMarkup),
    kmFromFactory: num(q.kmFromFactory),
    cogsFactors: { labour: num(factors.labour), materials: num(factors.materials) },
    overheadRatePerHourCents: num(q.overheadRatePerHourCents),
    notes: str(q.notes, NOTES_MAX),
    rooms,
    labour: {
      office: labourKind("office"),
      factory: labourKind("factory"),
      site: labourKind("site"),
      travel: labourKind("travel"),
      overheadRecoveryCents: num(labourIn.overheadRecoveryCents),
    },
    options: list(q.options, "options", MAX_OPTIONS).map((o, i) => {
      record(o, `options[${i}]`);
      return {
        id: str(o.id, ID_MAX),
        roomId: str(o.roomId, ID_MAX),
        roomName: str(o.roomName, NAME_MAX),
        label: str(o.label, NAME_MAX) || "",
        kind: o.kind === "doorsPanels" || o.kind === "benchtop" ? o.kind : "other",
        priceIncGstCents: num(o.priceIncGstCents),
        priceExGstCents: num(o.priceExGstCents),
        computed: bool(o.computed),
      };
    }),
    totals: {
      ...pick(totals, TOTALS_NUMBERS),
      cogsWarning: bool(totals.cogsWarning),
      costs: pick(costs, COST_NUMBERS),
    },
    warnings: list(q.warnings, "warnings", MAX_WARNINGS).map((w, i) => {
      record(w, `warnings[${i}]`);
      return {
        severity: w.severity === "red" ? "red" : "amber",
        message: str(w.message, MESSAGE_MAX) || "",
        roomName: str(w.roomName, NAME_MAX),
      };
    }),
  };
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > MAX_STORED_BYTES) throw bad("the quote is over 1.5 MB");
  return out;
}

// What an item says about its quote:
//   absent  the field is missing/undefined (an older Joinr): nothing to store
//   null    Joinr sent null (could not price it, or too large to send)
//   ok      a valid quote
//   bad     present but malformed or too big: dropped, `problem` says why (no values in it)
function readItemQuote(item) {
  const v = item ? item.quote : undefined;
  if (v === undefined) return { kind: "absent", quote: null, problem: null };
  if (v === null) return { kind: "null", quote: null, problem: null };
  try {
    return { kind: "ok", quote: sanitize(v), problem: null };
  } catch (e) {
    return { kind: "bad", quote: null, problem: String((e && e.message) || "quote could not be read").slice(0, 200) };
  }
}

// validateItem's result is the object that gets stored as the payload, which must not carry the
// quote. The state is kept beside it (never inside it), keyed by that object.
const states = new WeakMap();
const attach = (validated, state) => states.set(validated, state);
const stateOf = (validated) => states.get(validated) || { kind: "absent", quote: null, problem: null };

// ---- the snapshot table -------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function snapshotRow(db, intakeId) {
  return db.prepare("SELECT * FROM joinr_quote_snapshots WHERE intake_id = ?").get(intakeId) || null;
}

// Writes the snapshot for an intake record from an item's quote state. `absent` and `bad` leave
// whatever is there. Returns true when a row was written.
function store(db, intakeId, quoteId, state) {
  if (state.kind !== "ok" && state.kind !== "null") return false;
  const json = state.kind === "ok" ? JSON.stringify(state.quote) : null;
  const card = state.kind === "ok" ? state.quote.pricedAt : null;
  db.prepare(
    `INSERT INTO joinr_quote_snapshots (intake_id, quote_id, quote_json, rate_card, received_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(intake_id) DO UPDATE SET quote_id = excluded.quote_id, quote_json = excluded.quote_json,
       rate_card = excluded.rate_card, received_at = excluded.received_at`
  ).run(intakeId, quoteId, json, card, nowIso());
  return true;
}

function hasSnapshot(db, intakeId) {
  return !!db.prepare("SELECT 1 FROM joinr_quote_snapshots WHERE intake_id = ?").get(intakeId);
}

function parseSnapshot(row) {
  if (!row) return null;
  let quote = null;
  if (row.quote_json) {
    try {
      quote = JSON.parse(row.quote_json);
    } catch {
      quote = null;
    }
  }
  return { intakeId: row.intake_id, quoteId: row.quote_id, quote, rateCard: row.rate_card, receivedAt: row.received_at };
}

// The latest snapshot for an intake record: {quote (object or null), rateCard, receivedAt} or null
// when Joinr has never sent one.
function latest(db, intakeId) {
  return parseSnapshot(snapshotRow(db, intakeId));
}

// The job's latest decided Joinr record with its snapshot: {intake: {id, quoteNumber, url...}, snapshot}.
function forJob(db, jobId) {
  const rec = db
    .prepare(
      `SELECT id, quote_number, payload FROM joinr_intake
        WHERE job_id = ? AND state IN ('accepted','linked') ORDER BY id DESC LIMIT 1`
    )
    .get(jobId);
  if (!rec) return null;
  let url = null;
  try {
    const p = JSON.parse(rec.payload);
    if (p && typeof p.url === "string" && /^https?:\/\/\S+$/i.test(p.url)) url = p.url;
  } catch {
    url = null;
  }
  return { intakeId: rec.id, quoteNumber: rec.quote_number, url, snapshot: latest(db, rec.id) };
}

// ---- materials lines ----------------------------------------------------------------------------

// Joinr section id -> the Materials list's section. Anything else priced as materials goes to
// 'other' with the section's title in the notes.
const SECTION_MAP = {
  boardEdge: "boards",
  benchtops: "benchtop",
  drawers: "drawers",
  innerDrawers: "drawers",
  handles: "handles",
  hardware: "hardware",
  roomExtras: "room_extras",
};

function isMaterialsLine(l) {
  if (l.costBucket) return l.costBucket === "materials";
  if (l.hoursBucket) return false;
  return l.kind !== "labour" && l.kind !== "travel";
}

const lower = (s) => String(s).trim().toLowerCase();

// [{key, section, name, qty, unit, notes}] for the Materials list. Labour, travel and overheads are
// not materials (they show in the quote section). A key is stable for the same room (its Joinr id,
// else its place in the quote), section and item, so a later sync matches the line it made before.
function materialLines(quote) {
  const out = [];
  if (!quote || !Array.isArray(quote.rooms)) return out;
  quote.rooms.forEach((room, i) => {
    const roomKey = room.id ? `r:${lower(room.id)}` : `n:${i}`;
    const roomName = room.name && room.name.trim() ? room.name.trim() : `Room ${i + 1}`;
    for (const l of room.lines || []) {
      if (!isMaterialsLine(l)) continue;
      if (typeof l.qty !== "number" || !(l.qty > 0)) continue;
      const section = SECTION_MAP[l.section] || "other";
      let notes = roomName;
      if (l.section === "innerDrawers") notes += " (inner drawers)";
      else if (!SECTION_MAP[l.section] && l.sectionTitle) notes += ` (${l.sectionTitle})`;
      out.push({ key: `q:${roomKey}:${l.section}:${lower(l.name)}`, section, name: l.name, qty: l.qty, unit: l.unit || null, notes });
    }
    // Additional items are materials too, bar a credit (a negative price takes something off).
    for (const c of room.customItems || []) {
      if (typeof c.qty !== "number" || !(c.qty > 0)) continue;
      if (typeof c.unitPriceCents === "number" && c.unitPriceCents < 0) continue;
      const name = c.description && c.description.trim() ? c.description.trim() : "Additional item";
      out.push({ key: `q:${roomKey}:custom:${lower(name)}`, section: "other", name, qty: c.qty, unit: null, notes: `${roomName} (additional item)` });
    }
  });
  return out;
}

// ---- what the API sends --------------------------------------------------------------------------

const LINE_MONEY = ["unitRateCents", "lineTotalCents", "boardCostCents", "edgingCents", "cncCents", "perKmCents"];

function viewLine(l, money) {
  const out = { name: l.name, qty: l.qty, unit: l.unit };
  if (money) for (const k of LINE_MONEY) if (k in l) out[k] = l[k];
  return out;
}

function viewRoom(room, money) {
  // Lines grouped by their section, in the order the quote has them.
  const groups = [];
  const byId = new Map();
  for (const l of room.lines) {
    let g = byId.get(l.section);
    if (!g) {
      const meta = room.sections.find((s) => s.id === l.section);
      g = { id: l.section, title: l.sectionTitle || (meta && meta.title) || l.section, labour: !isMaterialsLine(l), lines: [] };
      if (money) g.totalCents = meta ? meta.totalCents : null;
      byId.set(l.section, g);
      groups.push(g);
    }
    g.lines.push(viewLine(l, money));
  }
  const out = {
    id: room.id,
    name: room.name,
    spec: room.spec,
    hours: room.hours,
    sections: groups,
    customItems: room.customItems.map((c) => {
      const o = { description: c.description, qty: c.qty };
      if (money) Object.assign(o, { unitPriceCents: c.unitPriceCents, lineTotalCents: c.lineTotalCents, markup: c.markup, markupFromTier: c.markupFromTier, lineTotalWithMarkupCents: c.lineTotalWithMarkupCents });
      return o;
    }),
  };
  if (money) Object.assign(out, { adjust: room.adjust, totals: room.totals });
  return out;
}

// The object GET /api/job-records/:id/joinr-quote sends for a snapshot that holds a quote. With
// money false it has no money field at all: no rates, line or room totals, cost of goods, margin,
// markups, tier, GST, totals, option prices or warnings (those words are about profit and tier).
function view(snapshot, { money }) {
  const q = snapshot.quote;
  const out = {
    pricedAt: snapshot.rateCard,
    receivedAt: snapshot.receivedAt,
    kmFromFactory: q.kmFromFactory,
    notes: q.notes,
    rooms: q.rooms.map((r) => viewRoom(r, money)),
    labour: {},
    options: q.options.map((o) => {
      const v = { label: o.label, kind: o.kind, roomName: o.roomName, computed: o.computed };
      if (money) Object.assign(v, { priceIncGstCents: o.priceIncGstCents, priceExGstCents: o.priceExGstCents });
      return v;
    }),
  };
  for (const k of HOURS_BUCKETS) {
    out.labour[k] = { typed: q.labour[k].typed, hours: q.labour[k].hours };
    if (money) out.labour[k].costCents = q.labour[k].costCents;
  }
  if (money) {
    out.labour.overheadRecoveryCents = q.labour.overheadRecoveryCents;
    out.gst = q.gst;
    out.tier = q.tier;
    out.globalMarkup = q.globalMarkup;
    out.cogsFactors = q.cogsFactors;
    out.overheadRatePerHourCents = q.overheadRatePerHourCents;
    out.totals = q.totals;
    out.warnings = q.warnings;
  }
  return out;
}

module.exports = {
  MAX_STORED_BYTES,
  sanitize,
  readItemQuote,
  attach,
  stateOf,
  store,
  hasSnapshot,
  latest,
  forJob,
  materialLines,
  view,
};
