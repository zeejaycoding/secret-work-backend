const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { DEFAULT_ROLES } = require("../config/roles");

function adminAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Admin token required" });
  }

  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, env.adminJwtSecret);
    if (!decoded || !decoded.role) {
      return res.status(401).json({ error: "Invalid admin token" });
    }
    // Attach permissions (either from token or default role mapping)
    if (!decoded.permissions) {
      decoded.permissions = (DEFAULT_ROLES[decoded.role] && DEFAULT_ROLES[decoded.role].permissions) || {};
    }
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired admin token" });
  }
}

function requirePermission(permissionKey) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: "Admin token required" });
    const perms = req.admin.permissions || {};
    if (!perms[permissionKey]) return res.status(403).json({ error: "Forbidden: insufficient permissions" });
    next();
  };
}

module.exports = { adminAuth, requirePermission };
