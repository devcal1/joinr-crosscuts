// Stores uploaded photos: the multer upload (JPEG, PNG, WebP up to 25 MB each) and the step that
// makes each one's thumbnail and photos row. Shared by Photo admin (routes/photos.js) and the shift
// page (routes/shift.js, 0.2.4).
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const sharp = require("sharp");
const { UPLOADS_DIR } = require("./config");
const audit = require("./audit");

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

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    cb(new Error("Unsupported file type"));
    return;
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      cb(null, `${crypto.randomUUID()}${EXT_BY_MIME[file.mimetype] || ".jpg"}`);
    },
  }),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter,
});

const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES }, fileFilter });

function discard(files) {
  for (const file of files || []) fs.rmSync(file.path, { force: true });
}

// Makes the thumbnail and the photos row (audited photo.upload) for each file multer wrote.
// Returns {created: [ids], failed: [{filename, error}]}; a failed file is removed.
async function store(db, req, files, { tags, jobId }) {
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
      created.push(id);
    } catch (e) {
      console.error(`Failed to process ${file.originalname}:`, e);
      failed.push({ filename: file.originalname, error: e.message });
      fs.rm(file.path, { force: true }, () => {});
      fs.rm(path.join(UPLOADS_DIR, thumbFilename), { force: true }, () => {});
    }
  }
  return { created, failed };
}

module.exports = { upload, memoryUpload, store, discard, MAX_FILE_BYTES };
