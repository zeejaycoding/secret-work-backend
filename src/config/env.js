const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const env = {
  port: parseInt(process.env.PORT || "4000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  mongoUri: process.env.MONGODB_URI || "mongodb://localhost:27017/secret-work",
  jwtSecret: process.env.JWT_SECRET || "fallback-secret-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:8081",
  emailFrom: process.env.EMAIL_FROM || "",
  mailtrapApiKey: process.env.MAILTRAP_API_KEY || "",
  smtpHost:
    process.env.SMTP_HOST ||
    process.env.MAILTRAP_SMTP_HOST ||
    (process.env.MAILTRAP_API_KEY ? "live.smtp.mailtrap.io" : ""),
  smtpPort: parseInt(process.env.SMTP_PORT || process.env.MAILTRAP_SMTP_PORT || "587", 10),
  smtpUser:
    process.env.SMTP_USER ||
    process.env.MAILTRAP_SMTP_USER ||
    (process.env.MAILTRAP_API_KEY ? "api" : ""),
  smtpPass:
    process.env.SMTP_PASS ||
    process.env.MAILTRAP_SMTP_PASS ||
    process.env.MAILTRAP_API_KEY ||
    "",
  smtpSecure:
    String(process.env.SMTP_SECURE || process.env.MAILTRAP_SMTP_SECURE || "false").toLowerCase() ===
    "true",
};

module.exports = { env };
