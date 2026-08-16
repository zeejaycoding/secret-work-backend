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
  emailUser: process.env.EMAIL_USER || "",
  emailPass: process.env.EMAIL_PASS || "",
  sendgridApiKey: process.env.SENDGRID_API_KEY || process.env.GRID_API_KEY || "",
  emailFrom: process.env.EMAIL_FROM || process.env.EMAIL_USER || "noreply@secretwork.app",
  emailFromName: process.env.EMAIL_FROM_NAME || "Secret Work",
  replyToEmail: process.env.REPLY_TO_EMAIL || process.env.EMAIL_FROM || process.env.EMAIL_USER || "support@secretwork.app",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  clerkSecretKey: process.env.CLERK_SECRET_KEY || "",
  adminEmail: process.env.ADMIN_EMAIL || "zahabjahangir12@gmail.com",
  adminPassword: process.env.ADMIN_PASSWORD || "Admin123",
  adminJwtSecret: process.env.ADMIN_JWT_SECRET || "admin-secret-key-change-in-prod",
  cloudinaryCloudName:
    process.env.CLOUDINARY_CLOUD_NAME ||
    process.env.CLOUD_NAME ||
    process.env.Cloud_name ||
    "",
  cloudinaryApiKey:
    process.env.CLOUDINARY_API_KEY ||
    process.env.API_KEY ||
    process.env.API_key ||
    "",
  cloudinaryApiSecret:
    process.env.CLOUDINARY_API_SECRET ||
    process.env.API_SECRET ||
    process.env.API_secret ||
    "",
  cloudinaryUrl: process.env.CLOUDINARY_URL || process.env.CLOUDINARY || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
};

module.exports = { env };
