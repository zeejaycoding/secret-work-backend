const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("cloudinary").v2;
const { env } = require("../config/env");

cloudinary.config({
  cloud_name: env.cloudinaryCloudName,
  api_key: env.cloudinaryApiKey,
  api_secret: env.cloudinaryApiSecret,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => {
    const field = file.fieldname;
    const isVideo = field === "video";
    const folder =
      field === "image"
        ? "pros"
        : field === "media"
        ? "podcasts/media"
        : isVideo
        ? "drills/videos"
        : "drills/thumbnails";
    const videoFormats = ["mp4", "mov", "m4v", "webm", "avi", "mkv"];
    const imageFormats = ["jpg", "jpeg", "png", "webp", "gif"];
    const mediaFormats = [
      ...videoFormats,
      "mp3",
      "wav",
      "m4a",
      "aac",
      "ogg",
    ];
    const formats =
      field === "media"
        ? mediaFormats
        : isVideo
        ? videoFormats
        : imageFormats;
    return {
      folder,
      resource_type: field === "image" ? "image" : "video",
      allowed_formats: formats,
      public_id: `${Date.now()}-${Math.round(Math.random() * 1e9)}`,
    };
  },
});

function fileFilter(req, file, cb) {
  if (file.fieldname === "media") {
    if (
      file.mimetype.startsWith("video/") ||
      file.mimetype.startsWith("audio/")
    ) {
      return cb(null, true);
    }
    return cb(new Error("Podcast media must be a video or audio file"));
  }
  if (file.fieldname === "video") {
    if (file.mimetype.startsWith("video/")) return cb(null, true);
    return cb(new Error("Drill video must be a video file"));
  }
  if (file.mimetype.startsWith("image/")) return cb(null, true);
  return cb(new Error("Uploaded file must be an image"));
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 1024 * 1024 * 100 },
});

function cloudinaryPublicIdFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (!u.hostname.includes("cloudinary.com")) return null;
    const segments = u.pathname.split("/");
    const versionIndex = segments.findIndex((s) => /^v\d+$/.test(s));
    if (versionIndex === -1) return null;
    const rest = segments.slice(versionIndex + 1).join("/");
    return rest.replace(/\.[a-z0-9]+$/i, "");
  } catch {
    return null;
  }
}

function deleteCloudinaryFile(url) {
  const publicId = cloudinaryPublicIdFromUrl(url);
  if (!publicId) return;
  const resourceType =
    url.includes("/video/") ||
    /\.(mp4|mov|webm|mkv|avi|m4v|mp3|wav|m4a|aac|ogg)$/i.test(url)
      ? "video"
      : "image";
  cloudinary.uploader
    .destroy(publicId, { resource_type: resourceType })
    .catch(() => {});
}

module.exports = { upload, cloudinary, deleteCloudinaryFile };
