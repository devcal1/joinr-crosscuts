// Private file store for report library files and task attachments.
// See docs/plans/m4-contracts.md sections 2 and 8.
//
// Files live in <UPLOADS_DIR>/files, which the /photos static route never serves
// (server.js narrows /photos to top-level image files). The only way out is
// GET /api/files/:id, which checks access first and sends with send() below.
//
//   r.post("/:id/files", "tasks.use", files.single("file"), async (req, res) => {
//     const accepted = await files.accept(req.file);   // throws 400, file removed
//     try { db.transaction(() => { const id = files.insert(db, accepted, req.user.id); ... })(); }
//     catch (e) { files.discard(accepted); throw e; }
//   });
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { UPLOADS_DIR } = require("./config");
const { bad } = require("./httperror");

// Absolute, as res.sendFile needs (UPLOADS_DIR is relative in a bare dev run).
const FILES_DIR = path.resolve(UPLOADS_DIR, "files");
fs.mkdirSync(FILES_DIR, { recursive: true });

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const HEAD_BYTES = 8 * 1024;
const MAX_NAME = 200;

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}
const ZIP = [0x50, 0x4b, 0x03, 0x04];

// The whole allowlist. The stored extension and the served Content-Type come only
// from here; the client's declared mimetype is ignored.
const TYPES = {
  pdf: { mime: "application/pdf", inline: true, check: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) },
  png: {
    mime: "image/png",
    inline: true,
    check: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  jpg: { mime: "image/jpeg", inline: true, check: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    inline: false,
    check: (b) => startsWith(b, ZIP),
  },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    inline: false,
    check: (b) => startsWith(b, ZIP),
  },
  xls: {
    mime: "application/vnd.ms-excel",
    inline: false,
    check: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  },
  csv: {
    mime: "text/csv",
    inline: false,
    check: (b) => {
      if (b.includes(0)) return false;
      let s = b.toString("utf8");
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
      return !/^\s*</.test(s);
    },
  },
};
// Accepted spellings of an extension -> the TYPES key it is stored as.
const EXT_ALIAS = { jpeg: "jpg" };

function extOf(name) {
  const ext = path.extname(String(name || "")).slice(1).toLowerCase();
  return EXT_ALIAS[ext] || ext;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, FILES_DIR),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.part`),
  }),
  // Browsers send the file name as raw UTF-8.
  defParamCharset: "utf8",
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 20, fieldSize: 64 * 1024, parts: 25 },
});

// Multer single-file upload of `field`. Multer removes partial files on error.
// A file over the limit is refused (exactly 25 MB is allowed). Anything that isn't a
// MulterError (a full disk, a permissions problem) is a server fault: logged, 500.
function single(field) {
  const mw = upload.single(field);
  return function filesUpload(req, res, next) {
    mw(req, res, (err) => {
      if (!err) return next();
      if (!(err instanceof multer.MulterError)) {
        console.error("[files] upload failed:", err && err.message ? err.message : err);
        res.status(500).json({ error: "Server error" });
        return;
      }
      const msg =
        err.code === "LIMIT_FILE_SIZE"
          ? "That file is too big (25 MB at most)"
          : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
            ? "Send one file"
            : "Upload failed";
      res.status(400).json({ error: msg });
    });
  };
}

// Resolves once the file is gone (or couldn't be removed); never rejects.
function rmQuiet(p) {
  return fs.promises.rm(p, { force: true }).catch(() => {});
}

async function readHead(p) {
  const fh = await fs.promises.open(p, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function sha256Of(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(p)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

// A display name: no path, no control characters, at most MAX_NAME characters
// (cut before the extension so it survives).
function cleanName(name, ext) {
  let base = path.basename(String(name || "").replace(/\\/g, "/"));
  base = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!base) base = `file.${ext}`;
  if (base.length > MAX_NAME) {
    const dotExt = path.extname(base);
    base = base.slice(0, MAX_NAME - dotExt.length) + dotExt;
  }
  return base;
}

// Checks an uploaded file and gives it its final name. Throws 400 (file removed) when
// the extension isn't allowed or the bytes don't match it.
async function accept(file) {
  if (!file || !file.path) throw bad("Choose a file");
  const ext = extOf(file.originalname);
  const type = Object.prototype.hasOwnProperty.call(TYPES, ext) ? TYPES[ext] : null;
  let ok = false;
  try {
    ok = !!type && file.size > 0 && type.check(await readHead(file.path));
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    await rmQuiet(file.path);
    throw bad("That file type isn't allowed");
  }
  const storedName = `${path.basename(file.path, ".part")}.${ext}`;
  const finalPath = path.join(FILES_DIR, storedName);
  // Hash before the rename, so a failure at either step leaves only the .part to remove.
  let sha256;
  try {
    sha256 = await sha256Of(file.path);
    await fs.promises.rename(file.path, finalPath);
  } catch (e) {
    await rmQuiet(file.path);
    throw e;
  }
  return {
    storedName,
    originalName: cleanName(file.originalname, ext),
    mime: type.mime,
    size: file.size,
    sha256,
  };
}

// Synchronous; safe inside the caller's transaction. Returns the new files.id.
function insert(db, accepted, userId) {
  const info = db
    .prepare(
      `INSERT INTO files (stored_name, original_name, mime, size, sha256, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(accepted.storedName, accepted.originalName, accepted.mime, accepted.size, accepted.sha256, userId || null);
  return Number(info.lastInsertRowid);
}

// For when the caller's transaction failed after accept(). Never throws.
function discard(accepted) {
  if (accepted && accepted.storedName) rmQuiet(path.join(FILES_DIR, path.basename(accepted.storedName)));
}

// Soft remove; the file stays on disk.
function remove(db, fileId, userId) {
  db.prepare(
    "UPDATE files SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL"
  ).run(new Date().toISOString(), userId || null, fileId);
}

// row: files.* plus uploaded_by_name (LEFT JOIN users).
function toFile(row) {
  return {
    id: row.id,
    name: row.original_name,
    size: row.size,
    mime: row.mime,
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploaded_by == null ? null : { id: row.uploaded_by, name: row.uploaded_by_name || "Unknown" },
    url: `/api/files/${row.id}`,
  };
}

function contentDisposition(kind, name) {
  // ASCII fallback for old clients, RFC 5987 UTF-8 for everyone else.
  const ascii = String(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // RFC 5987 doesn't allow ' ( ) * unencoded, which encodeURIComponent leaves.
  const ext = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${ext}`;
}

// Streams a stored file with the section 8 headers. Never trusts a client value for the path.
function send(res, fileRow) {
  const ext = extOf(fileRow.stored_name);
  const type = Object.prototype.hasOwnProperty.call(TYPES, ext) ? TYPES[ext] : null;
  const name = path.basename(fileRow.stored_name);
  const full = path.join(FILES_DIR, name);
  if (!type || !fs.existsSync(full)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.setHeader("Content-Type", type.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  if (type.inline) {
    res.setHeader("Content-Disposition", contentDisposition("inline", fileRow.original_name));
    // Chrome's PDF viewer fails under a sandbox CSP; a PDF's type is fixed and checked.
    if (ext !== "pdf") {
      res.setHeader(
        "Content-Security-Policy",
        "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"
      );
    }
  } else {
    res.setHeader("Content-Disposition", contentDisposition("attachment", fileRow.original_name));
    res.setHeader("Content-Security-Policy", "sandbox");
  }
  const fail = (status, error) => {
    if (res.headersSent) return;
    for (const h of ["Content-Type", "Content-Disposition", "Content-Security-Policy"]) res.removeHeader(h);
    res.status(status).json({ error });
  };
  try {
    // root + a bare name: the dotfiles rule then applies to the name only, not FILES_DIR.
    res.sendFile(name, { root: FILES_DIR, dotfiles: "deny", cacheControl: false }, (err) => {
      if (err) fail(404, "Not found");
    });
  } catch (e) {
    console.error("[files] send failed:", e && e.message ? e.message : e);
    fail(500, "Server error");
  }
}

module.exports = {
  FILES_DIR,
  MAX_FILE_BYTES,
  TYPES,
  single,
  accept,
  insert,
  discard,
  remove,
  toFile,
  send,
};
