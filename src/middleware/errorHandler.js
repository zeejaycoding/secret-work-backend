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
    return res.status(500).json({ error: String(detail).slice(0, 300) });
  }

  res.status(500).json({ error: "Internal server error" });
}

module.exports = { errorHandler };
