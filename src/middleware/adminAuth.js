const jwt = require("jsonwebtoken");
const { env } = require("../config/env");

function adminAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Admin token required" });
  }

  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, env.adminJwtSecret);
    if (decoded.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired admin token" });
  }
}

module.exports = { adminAuth };
