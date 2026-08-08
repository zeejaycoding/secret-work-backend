const multer = require("multer");

function errorHandler(err, req, res, _next) {
  console.error("Unhandled error:", err && (err.stack || err));

  if (err instanceof multer.MulterError) {
    let message = err.message;
    let status = 400;
    if (err.code === "LIMIT_FILE_SIZE") {
      message = "File is too large (max 100 MB)";
      status = 413;
    }
    return res.status(status).json({ error: message });
  }

  const detail = err && (err.message || String(err));
  if (detail && detail !== "[object Object]") {
    const sizeMatch = String(detail).match(
      /File size too large\. Got (\d+)\. Maximum is (\d+)\./
    );
    if (sizeMatch) {
      const gotMB = (Number(sizeMatch[1]) / (1024 * 1024)).toFixed(1);
      const maxMB = Math.round(Number(sizeMatch[2]) / (1024 * 1024));
      return res.status(413).json({
        error: `File is too large (${gotMB} MB). Cloudinary allows at most ${maxMB} MB for thumbnails — use a smaller or compressed image.`,
      });
    }
    return res.status(500).json({ error: String(detail).slice(0, 300) });
  }

  res.status(500).json({ error: "Internal server error" });
}

module.exports = { errorHandler };
