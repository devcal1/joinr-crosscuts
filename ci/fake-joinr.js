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
const ORG = "00000000-0000-4000-8000-000000000001";

const events = []; // stored items, cursor ascending
let lastId = 0;
const requests = [];
let fail = { mode: null, count: 0 };
let pageMax = null;
const hung = new Set();

function defaults(body) {
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
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake-joinr listening on 127.0.0.1:${port}`);
});
