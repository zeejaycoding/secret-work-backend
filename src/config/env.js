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
  sendgridApiKey: process.env.GRID_API_KEY || "",
  emailFrom: process.env.EMAIL_USER || "Darrylfinland@gmail.com",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  clerkSecretKey: process.env.CLERK_SECRET_KEY || "",
};

module.exports = { env };
