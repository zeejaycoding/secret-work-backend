const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { User } = require("../models/User");

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("[auth] missing/invalid auth header on", req.method, req.originalUrl);
      res.status(401).json({ error: "Missing or invalid authorization header" });
      return;
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      res.status(401).json({ error: "Missing token" });
      return;
    }

    const decoded = jwt.verify(token, env.jwtSecret);

    const user = await User.findById(decoded.userId).select("status");
    if (!user) {
      res.status(401).json({ error: "User no longer exists" });
      return;
    }
    if (user.status === "suspended") {
      res.status(403).json({ error: "Your account has been suspended" });
      return;
    }

    req.auth = {
      userId: decoded.userId,
      email: decoded.email,
    };

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      console.log("[auth] token expired on", req.method, req.originalUrl);
      res.status(401).json({ error: "Token expired" });
      return;
    }
    console.log("[auth] invalid token on", req.method, req.originalUrl, error.message);
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = { authMiddleware };
