const jwt = require("jsonwebtoken");
const { env } = require("../config/env");

function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid authorization header" });
      return;
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      res.status(401).json({ error: "Missing token" });
      return;
    }

    const decoded = jwt.verify(token, env.jwtSecret);

    req.auth = {
      userId: decoded.userId,
      email: decoded.email,
    };

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      res.status(401).json({ error: "Token expired" });
      return;
    }
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = { authMiddleware };
