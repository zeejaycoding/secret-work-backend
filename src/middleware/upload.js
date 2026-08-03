const multer = require("multer");
const path = require("path");
const fs = require("fs");

const thumbDir = path.resolve(__dirname, "../../uploads/thumbnails");
const videoDir = path.resolve(__dirname, "../../uploads/videos");

fs.mkdirSync(thumbDir, { recursive: true });
fs.mkdirSync(videoDir, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    if (file.fieldname === "thumbnail") {
      cb(null, thumbDir);
    } else {
      cb(null, videoDir);
    }
  },
  filename(req, file, cb) {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || "";
    cb(null, `${file.fieldname}-${unique}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  if (file.fieldname === "thumbnail") {
    if (file.mimetype.startsWith("image/")) return cb(null, true);
    return cb(new Error("Thumbnail must be an image"));
  }
  if (file.fieldname === "video") {
    if (file.mimetype.startsWith("video/")) return cb(null, true);
    return cb(new Error("Drill video must be a video file"));
  }
  return cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 1024 * 1024 * 100 },
});

module.exports = { upload };
