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
        : isVideo
        ? "drills/videos"
        : "drills/thumbnails";
    return {
      folder,
      resource_type: isVideo ? "video" : "image",
      allowed_formats: isVideo
        ? ["mp4", "mov", "m4v", "webm", "avi", "mkv"]
        : ["jpg", "jpeg", "png", "webp", "gif"],
      public_id: `${Date.now()}-${Math.round(Math.random() * 1e9)}`,
    };
  },
});

function fileFilter(req, file, cb) {
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
    url.includes("/video/") || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(url)
      ? "video"
      : "image";
  cloudinary.uploader
    .destroy(publicId, { resource_type: resourceType })
    .catch(() => {});
}

module.exports = { upload, cloudinary, deleteCloudinaryFile };
