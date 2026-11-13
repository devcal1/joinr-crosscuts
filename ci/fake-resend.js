#!/usr/bin/env node
// A stand-in Resend for the invoice email smoke test (ci/smoke-invoice-send.sh). It sends nothing
// anywhere: it keeps the emails it is given in memory. Dependency-free; listens on 127.0.0.1 only.
//
//   node fake-resend.js <port> <key>
//
// Also used by ci/smoke-invoice-reminders.sh. An Idempotency-Key seen before answers the first email's id (200)
// and records nothing new, as Resend does for 24 hours; /_control/emails shows bcc (and hasBcc, whether the
// field was sent at all) and the key.
//
// The API (Bearer <key> required, 401 otherwise):
//   POST /emails        needs from, to[], subject, text and attachments; answers {id}
//   GET  /emails/:id    {id, last_event} (404 for an unknown id)
// Control endpoints (no auth; test use only):
//   POST /_control/fail    {status, message, count}: the next `count` (default 1) POST /emails answer
//                          that status with {message}; status 0 drops the connection
//   POST /_control/event   {id, last_event}: what GET /emails/:id will say for that id
//   GET  /_control/emails  what was received, newest last: the headers that matter, the fields, and for
//                          each attachment its filename, byte size, first five bytes and whether the
//                          content was valid base64 (never the content itself)
//   POST /_control/exit    ends the process
"use strict";
const http = require("http");

const port = Number(process.argv[2]);
const key = process.argv[3];
if (!port || !key) {
  console.error("usage: node fake-resend.js <port> <key>");
  process.exit(2);
}

const emails = [];
const events = new Map();
let failNext = null;
let seq = 0;

function send(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (p.startsWith("/_control/")) {
      if (p === "/_control/exit") {
        send(res, 200, { ok: true });
        return setTimeout(() => process.exit(0), 50);
      }
      if (p === "/_control/emails" && req.method === "GET") return send(res, 200, { emails });
      const b = (await readBody(req)) || {};
      if (p === "/_control/fail") {
        failNext = b.status === undefined ? null : { status: Number(b.status), message: String(b.message || ""), count: b.count === undefined ? 1 : Number(b.count) };
        return send(res, 200, { ok: true });
      }
      if (p === "/_control/event") {
        events.set(String(b.id), String(b.last_event));
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { message: "no such control" });
    }
    if (req.headers.authorization !== "Bearer " + key) return send(res, 401, { message: "API key is invalid", name: "validation_error" });
    if (p === "/emails" && req.method === "POST") {
      const b = await readBody(req);
      // Idempotency-Key: a repeated key is the same email (Resend does this for 24 hours): the first id, no new record.
      const idem = req.headers["idempotency-key"] || null;
      if (idem) {
        const prior = emails.find((e) => e.idempotencyKey === idem);
        if (prior) return send(res, 200, { id: prior.id });
      }
      if (failNext && failNext.count > 0) {
        failNext.count -= 1;
        const f = failNext;
        if (failNext.count <= 0) failNext = null;
        if (f.status === 0) return req.socket.destroy();
        return send(res, f.status, { message: f.message, name: "error" });
      }
      if (!b || typeof b.from !== "string" || !Array.isArray(b.to) || !b.to.length || typeof b.subject !== "string" || typeof b.text !== "string") {
        return send(res, 422, { message: "Missing required fields", name: "validation_error" });
      }
      const attachments = (Array.isArray(b.attachments) ? b.attachments : []).map((a) => {
        const raw = Buffer.from(String(a.content || ""), "base64");
        return {
          filename: a.filename,
          bytes: raw.length,
          magic: raw.subarray(0, 5).toString("latin1"),
          base64Ok: /^[A-Za-z0-9+/]+=*$/.test(String(a.content || "")),
        };
      });
      const id = "fake-" + ++seq;
      emails.push({
        id,
        from: b.from,
        to: b.to,
        cc: b.cc || [],
        bcc: b.bcc || [],
        hasBcc: b.bcc !== undefined,
        reply_to: b.reply_to || null,
        subject: b.subject,
        text: b.text,
        idempotencyKey: idem,
        attachments,
      });
      return send(res, 200, { id });
    }
    const m = /^\/emails\/([^/]+)$/.exec(p);
    if (m && req.method === "GET") {
      const id = decodeURIComponent(m[1]);
      if (!emails.some((e) => e.id === id)) return send(res, 404, { message: "Email not found", name: "not_found" });
      return send(res, 200, { id, last_event: events.get(id) || "sent" });
    }
    return send(res, 404, { message: "Not found" });
  })
  .listen(port, "127.0.0.1", () => console.log("fake Resend on 127.0.0.1:" + port));
