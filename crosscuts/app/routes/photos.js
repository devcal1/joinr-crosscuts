const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const sharp = require("sharp");
const db = require("../db");
const { UPLOADS_DIR } = require("../lib/config");
const { suggestTagsForImage } = require("../lib/gemini");
const { defineRoutes } = require("../lib/routes");
const audit = require("../lib/audit");
const { can, bad, forbidden, notFound, sendError } = require("../lib/httperror");
const { normaliseTags, countTags } = require("../lib/tags");

const r = defineRoutes("/api");

// Kept in sync by hand with ALLOWED_EXT/MAX_BULK_FILE_BYTES in public/admin.js —
// those are a client-side pre-filter for a better UX, this is the real check.
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const THUMB_WIDTH = 700;

// The stored extension drives the Content-Type express.static serves from
// /photos, so it must come from the validated mimetype — never from the
// client-controlled original filename.
const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      cb(null, `${crypto.randomUUID()}${EXT_BY_MIME[file.mimetype] || ".jpg"}`);
    },
  }),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error("Unsupported file type"));
      return;
    }
    cb(null, true);
  },
});

const suggestUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error("Unsupported file type"));
      return;
    }
    cb(null, true);
  },
});

// Every photo query joins jobs, so toPhoto can name the job without a second query.
const SELECT_PHOTO = "SELECT p.*, j.name AS job_name FROM photos p LEFT JOIN jobs j ON j.id = p.job_id";

function selectPhoto(id) {
  return db.prepare(`${SELECT_PHOTO} WHERE p.id = ?`).get(id);
}

// The one place a photo becomes JSON. jobId and jobName are for jobs.view
// holders only: for everyone else (the showroom) the keys are absent, not null,
// so the response is exactly what it was before M3 (trap 7).
function toPhoto(req, row) {
  const out = {
    id: row.id,
    url: `/photos/${row.filename}`,
    thumbUrl: `/photos/${row.thumb_filename}`,
    width: row.width,
    height: row.height,
    tags: row.tags,
    createdAt: row.created_at,
  };
  if (can(req, "jobs.view")) {
    out.jobId = row.job_id == null ? null : row.job_id;
    out.jobName = row.job_name == null ? null : row.job_name;
  }
  return out;
}

function handle(label, fn) {
  return (req, res) => {
    try {
      fn(req, res);
    } catch (e) {
      sendError(res, e, label);
    }
  };
}

function jobExists(id) {
  return !!db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(id);
}

// Positive integer from a query/form string ("12"), or null.
function parseId(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

r.get("/photos", ["photos.search", "photos.admin"], handle("[photos]", (req, res) => {
  let jobId = null;
  if (req.query.jobId !== undefined) {
    if (!can(req, "jobs.view")) throw forbidden();
    jobId = parseId(req.query.jobId);
    if (jobId === null) throw bad("jobId must be a positive integer");
  }
  const rows =
    jobId === null
      ? db.prepare(`${SELECT_PHOTO} ORDER BY p.created_at DESC, p.id DESC`).all()
      : db.prepare(`${SELECT_PHOTO} WHERE p.job_id = ? ORDER BY p.created_at DESC, p.id DESC`).all(jobId);
  res.json(rows.map((row) => toPhoto(req, row)));
}));

// Counted over every photo on every call, so the numbers are never stale.
r.get("/photos/tags", ["photos.search", "photos.admin"], handle("[photos]", (req, res) => {
  res.json(countTags(db.prepare("SELECT tags FROM photos").all()));
}));

r.post("/photos", "photos.admin", (req, res) => {
  upload.array("photos", 100)(req, res, async (err) => {
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    const files = req.files || [];
    const discard = () => {
      for (const file of files) fs.rmSync(file.path, { force: true });
    };
    try {
      if (files.length === 0) {
        res.status(400).json({ error: "No files uploaded" });
        return;
      }

      // The job is checked before any file is processed; on a refusal the
      // files multer already wrote are removed.
      let jobId = null;
      const rawJob = typeof req.body.jobId === "string" ? req.body.jobId.trim() : "";
      if (rawJob !== "") {
        if (!can(req, "jobs.view")) throw forbidden();
        jobId = parseId(rawJob);
        if (jobId === null || !jobExists(jobId)) throw bad("No such job");
      }
      const tags = normaliseTags(req.body.tags);

      const insert = db.prepare(
        "INSERT INTO photos (filename, thumb_filename, width, height, tags, job_id) VALUES (?, ?, ?, ?, ?, ?)"
      );

      const created = [];
      const failed = [];
      for (const file of files) {
        const thumbFilename = `${path.parse(file.filename).name}-thumb.webp`;
        try {
          const image = sharp(file.path);
          const metadata = await image.metadata();
          // sharp doesn't auto-apply EXIF orientation: .rotate() bakes it
          // into the thumb, and orientations 5-8 are transposed, so the stored
          // dimensions must swap to describe the photo as it displays.
          const transposed = (metadata.orientation || 1) >= 5;
          await image
            .rotate()
            .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(path.join(UPLOADS_DIR, thumbFilename));

          const id = db.transaction(() => {
            const info = insert.run(
              file.filename,
              thumbFilename,
              transposed ? metadata.height : metadata.width,
              transposed ? metadata.width : metadata.height,
              tags,
              jobId
            );
            const newId = Number(info.lastInsertRowid);
            audit.log(req, {
              action: "photo.upload",
              entityType: "photo",
              entityId: newId,
              after: { filename: file.filename, tags, jobId },
            });
            return newId;
          })();
          created.push(toPhoto(req, selectPhoto(id)));
        } catch (e) {
          console.error(`Failed to process ${file.originalname}:`, e);
          failed.push({ filename: file.originalname, error: e.message });
          fs.rm(file.path, { force: true }, () => {});
          fs.rm(path.join(UPLOADS_DIR, thumbFilename), { force: true }, () => {});
        }
      }
      res.status(created.length > 0 ? 201 : 500).json({ created, failed });
    } catch (e) {
      discard();
      sendError(res, e, "[photos]");
    }
  });
});

r.post("/suggest-tags", "photos.admin", (req, res) => {
  suggestUpload.single("photo")(req, res, async (err) => {
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No photo uploaded" });
      return;
    }
    try {
      const tags = await suggestTagsForImage(req.file.buffer, req.file.mimetype);
      res.json({ tags });
    } catch (e) {
      if (e.code === "NOT_CONFIGURED") {
        res.status(501).json({ error: e.message, code: e.code });
        return;
      }
      console.error("Tag suggestion failed:", e);
      res.status(502).json({ error: `Tag suggestion failed: ${e.message}` });
    }
  });
});

r.patch("/photos/:id", "photos.admin", handle("[photos]", (req, res) => {
  const id = Number(req.params.id);
  const row = selectPhoto(id);
  if (!row) throw notFound();
  const body = req.body || {};

  let tags = row.tags;
  if (body.tags !== undefined) {
    if (typeof body.tags !== "string" && !Array.isArray(body.tags)) throw bad("tags must be a string");
    tags = normaliseTags(body.tags);
  }

  let jobId = row.job_id;
  if (body.jobId !== undefined) {
    if (!can(req, "jobs.view")) throw forbidden();
    if (body.jobId === null) {
      jobId = null;
    } else {
      const n = body.jobId;
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) throw bad("jobId must be a positive integer or null");
      if (!jobExists(n)) throw bad("No such job");
      jobId = n;
    }
  }

  const tagsChanged = tags !== row.tags;
  const jobChanged = jobId !== row.job_id;
  if (tagsChanged || jobChanged) {
    db.transaction(() => {
      db.prepare("UPDATE photos SET tags = ?, job_id = ? WHERE id = ?").run(tags, jobId, id);
      if (tagsChanged) {
        audit.log(req, {
          action: "photo.tags",
          entityType: "photo",
          entityId: id,
          before: { tags: row.tags },
          after: { tags },
        });
      }
      if (jobChanged) {
        audit.log(req, {
          action: "photo.link",
          entityType: "photo",
          entityId: id,
          before: { jobId: row.job_id },
          after: { jobId },
        });
      }
    })();
  }
  res.json(toPhoto(req, selectPhoto(id)));
}));

r.delete("/photos/:id", "photos.admin", handle("[photos]", (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM photos WHERE id = ?").get(id);
  if (!row) throw notFound();
  // Row first, files second: if the row delete fails the gallery keeps a
  // working entry, whereas files-first would leave a broken tile behind.
  // The audit row goes in the same transaction, ahead of the delete.
  db.transaction(() => {
    audit.log(req, {
      action: "photo.delete",
      entityType: "photo",
      entityId: id,
      before: { filename: row.filename, thumbFilename: row.thumb_filename, tags: row.tags, jobId: row.job_id },
    });
    db.prepare("DELETE FROM photos WHERE id = ?").run(id);
  })();
  for (const filename of [row.filename, row.thumb_filename]) {
    const filePath = path.join(UPLOADS_DIR, filename);
    fs.rm(filePath, { force: true }, () => {});
  }
  res.status(204).end();
}));

module.exports = r.router;
