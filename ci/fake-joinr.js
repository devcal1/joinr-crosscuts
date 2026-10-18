#!/usr/bin/env node
// A stand-in Joinr for the M6 smoke tests (docs/plans/m6-contracts.md section 8). Implements
// the wire contract in docs/integrations/joinr-crosscuts-intake.md from an in-memory list of
// items. Dependency-free; listens on 127.0.0.1 only.
//
//   node fake-joinr.js <port> <key>
//
// The endpoint:
//   GET /api/integrations/crosscuts/won-quotes[?after=N][&backfill=won][&limit=N]
//     Bearer <key> required (401 otherwise); 400 for a bad limit, after or backfill.
//
// Control endpoints (no auth; test use only):
//   POST /_control/event     an item (JSON). Missing fields are filled with defaults (spec and
//                            raw merged); the fake assigns `cursor` (1, 2, 3 ...). With
//                            "_verbatim": true the body is stored as sent (cursor still
//                            assigned unless given), for invalid-item tests. Returns the item.
//                            `drawers` (M11, contract version 2: [{section, name, qty}]) is
//                            sent only when the body gives it, so an item without it is what an
//                            older Joinr sends; "drawers": null is sent as null.
//                            `quote` (J4, contract version 4) likewise: it is sent only when the body
//                            gives it (an object as given; null = "too large / can't price"). Or give
//                            "_quote": true (or {pricedAt, gstRate, boards, markup, extraLine,
//                            omitDrawers}) for a realistic two-room quote with money; its total
//                            becomes valueIncGstCents unless the body sets one.
//   POST /_control/fail      {"fail": 500 | 401 | 429 | "hang" | "garbage" | "html" | "big" | null,
//                             "count": N (default 1)}: the next N won-quotes calls fail that
//                            way. "garbage" is a 200 application/json body that is not JSON;
//                            "html" a 200 text/html page; "big" a ~3 MB JSON body sent in
//                            chunks; "hang" never answers. null or count 0 clears (and drops
//                            any hung request). {"fail": {"page": {...}}} answers with that
//                            envelope as-is (200); a "cursor" of "$after" is replaced by the
//                            `after` the caller sent (for the paging-stuck test).
//   POST /_control/pagesize  {"max": N | null}: pages hold at most N items whatever the
//                            caller's limit (to make many pages from few items).
//   Backfill pages that are not the last carry an opaque cursor "b.<event id>.<rootQuoteId>",
//   as the real Joinr does; the last page's cursor is a plain number. `after` accepts both.
//   GET  /_control/requests  {requests: [{method, path, query, auth, at}]}: what was asked,
//                            with the Authorization header reduced to "…" + its last 4.
//   GET /api/integrations/crosscuts/open-quotes  (J3, contract version 3; wire "contract": 3)
//     Bearer <key> required (401 otherwise); any query parameter -> 400; 404 until a test turns
//     the list on (a Joinr that has not released J3); then {contract:3, generatedAt, truncated,
//     quotes:[...]} from the list below.
//   POST /_control/openquotes  {"enabled": true|false, "quotes": [line...], "truncated": bool,
//                            "_verbatim": true}: turns the open-quotes list on or off and sets its
//                            lines. Missing line fields are filled with defaults (a sent quote with
//                            fresh uuids); with "_verbatim" the lines are stored as sent (for
//                            invalid-line tests). Returns the stored lines.
//   POST /_control/oqfail    {"fail": 400 | 401 | 404 | 429 | 500 | 503 | "garbage" | "badcontract" |
//                             null, "count": N (default 1), "retryAfter": seconds (429; default 60)}:
//                            the next N open-quotes calls fail that way. null or count 0 clears.
//   POST /_control/clear     forgets the request log.
//   POST /_control/stop      exits.
"use strict";
const http = require("http");
const crypto = require("crypto");

const port = Number(process.argv[2] || 4999);
const KEY = String(process.argv[3] || "");
if (!Number.isInteger(port) || port < 1 || KEY.length < 8) {
  console.error("usage: node fake-joinr.js <port> <key (8+ chars)>");
  process.exit(2);
}

const ENDPOINT = "/api/integrations/crosscuts/won-quotes";
const OQ_ENDPOINT = "/api/integrations/crosscuts/open-quotes";
const ORG = "00000000-0000-4000-8000-000000000001";

const events = []; // stored items, cursor ascending
let lastId = 0;
const requests = [];
let fail = { mode: null, count: 0 };
let pageMax = null;
const hung = new Set();
let oq = { enabled: false, quotes: [], truncated: false };
let oqFail = { mode: null, count: 0, retryAfter: 60 };

// J4 (contract version 4, "The quote object"): a realistic whole quote. `opts` (all optional):
//   pricedAt   'snapshot' (default) or 'live'
//   gstRate    0.1 (default); changing it re-prices the totals only, like a GST change in Joinr
//   boards     sheets of board in the Kitchen (default 12)
//   markup     the tier's material markup (default 1.3)
//   extraLine  true: one more Kitchen handle line ("Bar handle 160mm")
//   omitDrawers true: no drawer lines
//   padRooms   N extra rooms of 600 long-named lines (a quote over 1.5 MB but under the 2 MB response cap)
// Money is integer cents; room totals are computed from the lines so the figures add up.
function fullQuote(opts = {}) {
  const markup = opts.markup === undefined ? 1.3 : opts.markup;
  const gstRate = opts.gstRate === undefined ? 0.1 : opts.gstRate;
  const line = (section, sectionTitle, kind, costBucket, hoursBucket, unit, name, qty, rate, extra = {}) => ({
    section, sectionTitle, kind, costBucket, hoursBucket, unit, name, qty,
    unitRateCents: rate, lineTotalCents: Math.round(qty * rate), ...extra,
  });
  const kitchen = [
    line("officeLabour", "Office Labour", "labour", "labourOffice", "office", "hrs", "Design and drafting", 8, 9500),
    line("boardEdge", "Board & Edge", "board", "materials", null, "sheets", "White Melamine 18mm", opts.boards === undefined ? 12 : opts.boards, 8200, { boardCostCents: 7000, edgingCents: 600, cncCents: 600 }),
    line("boardEdge", "Board & Edge", "board", "materials", null, "sheets", "Oak Veneer 16mm", 4, 14500, { boardCostCents: 13200, edgingCents: 650, cncCents: 650 }),
    line("benchtops", "Benchtops", "simple", "materials", null, "m", "Laminate benchtop 33mm", 4.2, 21000),
    ...(opts.omitDrawers ? [] : [
      line("drawers", "Drawers", "simple", "materials", null, "ea", "Tandembox 450 Grey", 6, 4800),
      line("innerDrawers", "Inner Drawers", "simple", "materials", null, "ea", "Inner drawer 450", 3, 3600),
    ]),
    line("handles", "Handles", "simple", "materials", null, "ea", "Finger pull profile", 14, 1250),
    ...(opts.extraLine ? [line("handles", "Handles", "simple", "materials", null, "ea", "Bar handle 160mm", 6, 980)] : []),
    line("hardware", "Hardware", "simple", "materials", null, "ea", "Soft-close hinge", 28, 410),
    line("roomExtras", "Room Extras", "simple", "materials", null, "ea", "Bin pull-out 450", 1, 22000),
    line("factoryLabour", "Factory Labour", "labour", "labourWorkshop", "factory", "hrs", "Assembly", 24, 7800),
    line("siteLabour", "Site Labour", "labour", "labourWorkshop", "site", "hrs", "Install", 16, 8200),
    line("travel", "Travel", "travel", "overheads", "travel", "trips", "Site trips", 2, 3800, { perKmCents: 190 }),
  ];
  const laundry = [
    line("boardEdge", "Board & Edge", "board", "materials", null, "sheets", "White Melamine 18mm", 5, 8200, { boardCostCents: 7000, edgingCents: 600, cncCents: 600 }),
    line("hardware", "Hardware", "simple", "materials", null, "ea", "Soft-close hinge", 8, 410),
    line("factoryLabour", "Factory Labour", "labour", "labourWorkshop", "factory", "hrs", "Assembly", 8, 7800),
    line("siteLabour", "Site Labour", "labour", "labourWorkshop", "site", "hrs", "Install", 4, 8200),
  ];
  const custom = (description, qty, price) => {
    const total = Math.round(qty * price);
    return { description, qty, unitPriceCents: price, lineTotalCents: total, markup, markupFromTier: true, lineTotalWithMarkupCents: Math.round(total * markup) };
  };
  const rooms = [
    { id: "room-kitchen", name: "Kitchen", spec: { doorsPanels: "2-pac shaker doors", benchtop: "Laminate", jobType: "Kitchen" }, lines: kitchen, customItems: [custom("Pantry pull-out", 1, 45000)] },
    { id: "room-laundry", name: "Laundry", spec: { doorsPanels: "Melamine", benchtop: "", jobType: "Laundry" }, lines: laundry, customItems: [custom("Trade discount", 1, -5000)] },
  ].map((r) => {
    const sum = (f) => r.lines.filter(f).reduce((a, l) => a + l.lineTotalCents, 0);
    const labourOffice = sum((l) => l.costBucket === "labourOffice");
    const labourWorkshop = sum((l) => l.costBucket === "labourWorkshop");
    const matLines = sum((l) => l.costBucket === "materials");
    const customTotal = r.customItems.reduce((a, c) => a + c.lineTotalCents, 0);
    const materials = matLines + customTotal;
    const travel = sum((l) => l.hoursBucket === "travel");
    const overheadRecovery = Math.round((labourOffice + labourWorkshop) * 0.15);
    const overheads = overheadRecovery + travel;
    const markupCents = Math.round(materials * (markup - 1));
    const subtotal = labourOffice + labourWorkshop + materials + markupCents + overheads;
    const exGst = subtotal;
    const gst = Math.round(exGst * gstRate);
    const inc = exGst + gst;
    const cogs = Math.round((labourOffice + labourWorkshop) * 0.9 + materials + overheads);
    const ids = [];
    for (const l of r.lines) if (!ids.includes(l.section)) ids.push(l.section);
    return {
      id: r.id, name: r.name, adjust: 0, spec: r.spec, lines: r.lines, customItems: r.customItems,
      sections: ids.map((id) => {
        const ls = r.lines.filter((l) => l.section === id);
        return { id, title: ls[0].sectionTitle, totalCents: ls.reduce((a, l) => a + l.lineTotalCents, 0) };
      }),
      hours: {
        office: sum((l) => l.hoursBucket === "office") / 9500,
        factory: sum((l) => l.hoursBucket === "factory") / 7800 / 2,
        site: sum((l) => l.hoursBucket === "site") / 8200 / 2,
        travel: (sum((l) => l.hoursBucket === "travel") / 3800) * 38 / 60 * 2,
      },
      totals: {
        labourOfficeCents: labourOffice, labourWorkshopCents: labourWorkshop, materialsCents: materials,
        customItemsCents: customTotal, travelCents: travel, overheadRecoveryCents: overheadRecovery,
        overheadsCents: overheads, markupFactor: markup, markupCents, subtotalCents: subtotal, adjustCents: 0,
        roomAdjustCents: 0, exGstCents: exGst, gstCents: gst, incGstCents: inc, costOfGoodsCents: cogs,
        cogsRatio: inc ? cogs / inc : 0, marginCents: inc - cogs, cogsWarning: false,
      },
    };
  });
  const tot = (k) => rooms.reduce((a, r) => a + r.totals[k], 0);
  // padRooms: N extra rooms of 600 lines with 300-character names (to make a quote over Crosscuts'
  // 1.5 MB storage cap yet under its 2 MB response cap). Totals are left as they were.
  for (let i = 0; i < (opts.padRooms || 0); i++) {
    const lines = [];
    for (let j = 0; j < 600; j++) {
      lines.push(line("hardware", "Hardware", "simple", "materials", null, "ea", `Pad ${i}-${j} ` + "x".repeat(285), 1, 100));
    }
    rooms.push({
      id: `room-pad-${i}`, name: `Pad room ${i}`, adjust: 0, spec: { doorsPanels: "", benchtop: "", jobType: "" }, lines, customItems: [],
      sections: [{ id: "hardware", title: "Hardware", totalCents: 60000 }], hours: { office: 0, factory: 0, site: 0, travel: 0 },
      totals: { ...rooms[0].totals },
    });
  }
  const labourKind = (bucket, typed, rate) => ({ typed, hours: bucket === "office" ? typed : typed / 2, costCents: Math.round(typed * rate) });
  const incGst = tot("incGstCents");
  const cogs = tot("costOfGoodsCents");
  return {
    pricedAt: opts.pricedAt || "snapshot",
    gst: { registered: true, rate: gstRate },
    tier: { requested: "retail", code: "retail", label: "Retail", materialMarkup: markup, fallback: false },
    globalMarkup: 0,
    kmFromFactory: 38,
    cogsFactors: { labour: 0.9, materials: 1 },
    overheadRatePerHourCents: 1500,
    notes: "Client wants the pantry pull-out fitted before install week.",
    rooms,
    labour: {
      office: labourKind("office", 8, 9500),
      factory: labourKind("factory", 32, 7800),
      site: labourKind("site", 20, 8200),
      travel: { typed: 2, hours: 2 * 38 / 60 * 2, costCents: 7600 },
      overheadRecoveryCents: tot("overheadRecoveryCents"),
    },
    options: [
      { id: "opt-1", roomId: "room-kitchen", roomName: "Kitchen", label: "Stone benchtop instead of laminate", kind: "benchtop", priceIncGstCents: 480000, priceExGstCents: Math.round(480000 / (1 + gstRate)), computed: false },
    ],
    totals: {
      labourOfficeCents: tot("labourOfficeCents"), labourWorkshopCents: tot("labourWorkshopCents"),
      materialsCents: tot("materialsCents"), markupCents: tot("markupCents"), overheadsCents: tot("overheadsCents"),
      adjustCents: 0, exGstCents: tot("exGstCents"), gstCents: tot("gstCents"), incGstCents: incGst,
      costOfGoodsCents: cogs, cogsRatio: incGst ? cogs / incGst : 0, cogsWarning: false, marginCents: incGst - cogs,
      costs: { officeCents: tot("labourOfficeCents"), labourCents: tot("labourWorkshopCents"), labourFactoryCents: 187200, labourSiteCents: 164000, materialsCents: tot("materialsCents"), overheadsCents: tot("overheadsCents") },
    },
    warnings: [{ severity: "amber", message: "Materials are a high share of the Laundry price", roomName: "Laundry" }],
  };
}

function defaults(body) {
  body = { ...body };
  // J4: "_quote": true | {opts} builds a realistic quote (above); valueIncGstCents follows its total
  // unless the body gives one. An explicit "quote" (an object, or null) is sent as given.
  if (body._quote !== undefined) {
    const q = fullQuote(body._quote === true ? {} : body._quote);
    delete body._quote;
    body.quote = q;
    if (body.valueIncGstCents === undefined) body.valueIncGstCents = q.totals.incGstCents;
  }
  const quoteId = body.quoteId || crypto.randomUUID();
  const base = {
    event: "won",
    quoteId,
    rootQuoteId: body.rootQuoteId || quoteId,
    revision: 0,
    quoteNumber: null,
    status: "won",
    standing: "active",
    deletedAt: null,
    wonAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    clientName: "Test Client",
    clientPhone: null,
    clientEmail: null,
    siteAddress: null,
    label: null,
    reference: null,
    quoteDate: null,
    valueIncGstCents: null,
    estimatedHours: null,
    spec: { sheetCount: null, twoPac: null, benchtop: null, jobType: null },
    raw: { doorsPanels: [], benchtops: [], jobTypes: [] },
  };
  const item = { ...base, ...body };
  item.spec = { ...base.spec, ...(body.spec || {}) };
  item.raw = { ...base.raw, ...(body.raw || {}) };
  item.url = body.url || `http://127.0.0.1:${port}/org/${ORG}/quotes/${item.quoteId}`;
  return item;
}

function send(res, status, obj, headers = {}) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      if (!s) return resolve({});
      try {
        resolve(JSON.parse(s));
      } catch {
        resolve(null);
      }
    });
  });
}

function sameKey(header) {
  const m = /^Bearer (.+)$/.exec(header || "");
  if (!m) return false;
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

function redact(header) {
  if (!header) return null;
  return "…" + String(header).slice(-4);
}

function clearHung() {
  for (const res of hung) {
    try {
      res.socket && res.socket.destroy();
    } catch {
      // ignore
    }
  }
  hung.clear();
}

// Applies a forced failure; returns true when the request was answered (or left hanging).
function forcedFailure(res, url) {
  if (!fail.mode || fail.count <= 0) return false;
  fail.count--;
  const mode = fail.mode;
  if (fail.count <= 0) fail = { mode: null, count: 0 };
  if (mode && typeof mode === "object" && mode.page && typeof mode.page === "object") {
    const page = { ...mode.page };
    if (page.cursor === "$after") page.cursor = url.searchParams.get("after") || "0";
    send(res, 200, page);
    return true;
  }
  if (mode === "hang") {
    hung.add(res);
    res.on("close", () => hung.delete(res));
    return true;
  }
  if (mode === "garbage") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("this is not json {{{");
    return true;
  }
  if (mode === "html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>Oops</title>");
    return true;
  }
  if (mode === "big") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"contract":1,"cursor":"0","more":false,"items":[],"pad":"');
    const chunk = "x".repeat(64 * 1024);
    let sent = 0;
    const target = 3 * 1024 * 1024;
    const pump = () => {
      while (sent < target) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once("drain", pump);
      }
      res.end('"}');
    };
    res.on("error", () => {});
    pump();
    return true;
  }
  const status = Number(mode) || 500;
  send(res, status, { error: status === 401 ? "unauthorised" : "forced failure" }, status === 429 ? { "Retry-After": "60" } : {});
  return true;
}

// The latest item per rootQuoteId that is currently won and not deleted, by cursor.
function currentlyWon() {
  const latest = new Map();
  for (const e of events) latest.set(e.rootQuoteId, e);
  return [...latest.values()]
    .filter((e) => e.status === "won" && !e.deletedAt)
    .sort((a, b) => Number(a.cursor) - Number(b.cursor));
}

function wonQuotes(req, res, url) {
  const q = url.searchParams;
  if (!sameKey(req.headers.authorization)) return send(res, 401, { error: "unauthorised" });
  if (forcedFailure(res, url)) return;
  let limit = 50;
  if (q.has("limit")) {
    limit = Number(q.get("limit"));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return send(res, 400, { error: "bad limit" });
  }
  if (pageMax) limit = Math.min(limit, pageMax);
  const backfill = q.get("backfill") === "won";
  let after = null;
  if (q.has("after")) {
    const a = q.get("after");
    // Any b.<n>.<id>: the smoke also feeds deliberately invalid items whose ids are not uuids.
    const opaque = /^b\.(\d+)\.\S+$/.exec(a);
    if (/^\d+$/.test(a)) after = Number(a);
    else if (backfill && opaque) after = Number(opaque[1]);
    else return send(res, 400, { error: "bad after" });
  }
  if (q.has("backfill") && !backfill) return send(res, 400, { error: "bad backfill" });

  if (backfill) {
    const all = currentlyWon().filter((e) => after === null || Number(e.cursor) > after);
    const page = all.slice(0, limit);
    const more = all.length > limit;
    const lastItem = page[page.length - 1];
    const cursor = more ? `b.${lastItem.cursor}.${lastItem.rootQuoteId}` : String(lastId);
    return send(res, 200, { contract: 1, cursor, more, items: page });
  }
  if (after === null) return send(res, 200, { contract: 1, cursor: String(lastId), more: false, items: [] });
  const all = events.filter((e) => Number(e.cursor) > after);
  const page = all.slice(0, limit);
  const more = all.length > limit;
  const cursor = more ? page[page.length - 1].cursor : String(Math.max(after, lastId));
  return send(res, 200, { contract: 1, cursor, more, items: page });
}

function oqLine(body) {
  const quoteId = body.quoteId || crypto.randomUUID();
  const now = new Date().toISOString();
  const line = {
    quoteId,
    rootQuoteId: body.rootQuoteId || quoteId,
    quoteNumber: null,
    status: "sent",
    clientName: "Test Client",
    siteAddress: null,
    label: null,
    valueIncGstCents: null,
    sentAt: now,
    wonAt: null,
    updatedAt: now,
    ...body,
  };
  if (line.url === undefined) line.url = `http://127.0.0.1:${port}/org/${ORG}/quotes/${quoteId}`;
  return line;
}

function openQuotes(req, res, url) {
  if (!sameKey(req.headers.authorization)) return send(res, 401, { error: "unauthorised" });
  if (oqFail.mode && oqFail.count > 0) {
    oqFail.count--;
    const mode = oqFail.mode;
    const retryAfter = oqFail.retryAfter;
    if (oqFail.count <= 0) oqFail = { mode: null, count: 0, retryAfter };
    if (mode === "garbage") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end("this is not json {{{");
    }
    if (mode === "badcontract") {
      return send(res, 200, { contract: 1, generatedAt: new Date().toISOString(), truncated: false, quotes: [] });
    }
    const status = Number(mode) || 500;
    return send(
      res,
      status,
      { error: status === 429 ? "rate_limited" : "forced failure" },
      status === 429 ? { "Retry-After": String(retryAfter) } : {}
    );
  }
  if (!oq.enabled) return send(res, 404, { error: "not found" });
  if ([...url.searchParams.keys()].length) return send(res, 400, { error: "open-quotes takes no query parameters" });
  return send(res, 200, { contract: 3, generatedAt: new Date().toISOString(), truncated: oq.truncated, quotes: oq.quotes });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (url.pathname.startsWith("/_control/")) {
      if (req.method === "GET" && url.pathname === "/_control/requests") return send(res, 200, { requests });
      if (req.method !== "POST") return send(res, 405, { error: "method" });
      const body = await readBody(req);
      if (body === null) return send(res, 400, { error: "bad json" });
      if (url.pathname === "/_control/event") {
        let item;
        if (body._verbatim) {
          item = { ...body };
          delete item._verbatim;
        } else {
          item = defaults(body);
        }
        if (item.cursor === undefined) item.cursor = String(++lastId);
        else lastId = Math.max(lastId, Number(item.cursor) || 0);
        events.push(item);
        return send(res, 201, item);
      }
      if (url.pathname === "/_control/fail") {
        const mode = body.fail !== undefined ? body.fail : body.status !== undefined ? body.status : body.mode;
        const count = body.count === undefined ? 1 : Number(body.count);
        if (mode === null || mode === undefined || !count) {
          fail = { mode: null, count: 0 };
          clearHung();
        } else {
          fail = { mode, count };
        }
        return send(res, 200, { fail });
      }
      if (url.pathname === "/_control/openquotes") {
        if (body.enabled !== undefined) oq.enabled = !!body.enabled;
        if (Array.isArray(body.quotes)) oq.quotes = body.quotes.map((q) => (body._verbatim ? q : oqLine(q)));
        if (body.truncated !== undefined) oq.truncated = !!body.truncated;
        return send(res, 200, { enabled: oq.enabled, truncated: oq.truncated, quotes: oq.quotes });
      }
      if (url.pathname === "/_control/oqfail") {
        const count = body.count === undefined ? 1 : Number(body.count);
        if (body.fail === null || body.fail === undefined || !count) {
          oqFail = { mode: null, count: 0, retryAfter: oqFail.retryAfter };
        } else {
          oqFail = { mode: body.fail, count, retryAfter: body.retryAfter === undefined ? 60 : Number(body.retryAfter) };
        }
        return send(res, 200, { oqFail });
      }
      if (url.pathname === "/_control/pagesize") {
        const max = Number(body.max);
        pageMax = Number.isInteger(max) && max > 0 ? max : null;
        return send(res, 200, { max: pageMax });
      }
      if (url.pathname === "/_control/clear") {
        requests.length = 0;
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/_control/stop") {
        send(res, 200, { ok: true });
        clearHung();
        setTimeout(() => process.exit(0), 50);
        return;
      }
      return send(res, 404, { error: "not found" });
    }

    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      auth: redact(req.headers.authorization),
      at: new Date().toISOString(),
    });
    if (req.method === "GET" && url.pathname === ENDPOINT) return wonQuotes(req, res, url);
    if (req.method === "GET" && url.pathname === OQ_ENDPOINT) return openQuotes(req, res, url);
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake-joinr listening on 127.0.0.1:${port}`);
});
