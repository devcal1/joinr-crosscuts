const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const sharp = require("sharp");
const db = require("../db");
const { UPLOADS_DIR } = require("../lib/config");
const { suggestTagsForImage } = require("../lib/gemini");
const { defineRoutes } = require("../lib/routes");

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

function rowToPhoto(row) {
  return {
    id: row.id,
    url: `/photos/${row.filename}`,
    thumbUrl: `/photos/${row.thumb_filename}`,
    width: row.width,
    height: row.height,
    tags: row.tags,
    createdAt: row.created_at,
  };
}

r.get("/photos", ["photos.search", "photos.admin"], (req, res) => {
  const rows = db.prepare("SELECT * FROM photos ORDER BY created_at DESC, id DESC").all();
  res.json(rows.map(rowToPhoto));
});

r.post("/photos", "photos.admin", (req, res) => {
  upload.array("photos", 100)(req, res, async (err) => {
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    const files = req.files || [];
    if (files.length === 0) {
      res.status(400).json({ error: "No files uploaded" });
      return;
    }
    const tags = (req.body.tags || "").trim();

    const insert = db.prepare(
      "INSERT INTO photos (filename, thumb_filename, width, height, tags) VALUES (?, ?, ?, ?, ?)"
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

        const info = insert.run(
          file.filename,
          thumbFilename,
          transposed ? metadata.height : metadata.width,
          transposed ? metadata.width : metadata.height,
          tags
        );
        created.push(rowToPhoto(db.prepare("SELECT * FROM photos WHERE id = ?").get(info.lastInsertRowid)));
      } catch (e) {
        console.error(`Failed to process ${file.originalname}:`, e);
        failed.push({ filename: file.originalname, error: e.message });
        fs.rm(file.path, { force: true }, () => {});
        fs.rm(path.join(UPLOADS_DIR, thumbFilename), { force: true }, () => {});
      }
    }
    res.status(created.length > 0 ? 201 : 500).json({ created, failed });
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

r.patch("/photos/:id", "photos.admin", (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM photos WHERE id = ?").get(id);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const tags = typeof req.body.tags === "string" ? req.body.tags.trim() : row.tags;
  db.prepare("UPDATE photos SET tags = ? WHERE id = ?").run(tags, id);
  res.json(rowToPhoto(db.prepare("SELECT * FROM photos WHERE id = ?").get(id)));
});

r.delete("/photos/:id", "photos.admin", (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM photos WHERE id = ?").get(id);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Row first, files second: if the row delete fails the gallery keeps a
  // working entry, whereas files-first would leave a broken tile behind.
  db.prepare("DELETE FROM photos WHERE id = ?").run(id);
  for (const filename of [row.filename, row.thumb_filename]) {
    const filePath = path.join(UPLOADS_DIR, filename);
    fs.rm(filePath, { force: true }, () => {});
  }
  res.status(204).end();
});

module.exports = r.router;
