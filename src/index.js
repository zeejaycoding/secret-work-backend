const express = require("express");
const path = require("path");
const { createServer } = require("http");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { env } = require("./config/env");
const { connectDB } = require("./config/db");
const { DEFAULT_PLANS } = require("./config/plans");
const { initSocket } = require("./socket");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const { checkoutRouter, webhookRouter } = require("./routes/payments");
const adminRoutes = require("./routes/admin");
const podcastRoutes = require("./routes/podcast");
const drillRoutes = require("./routes/drill");
const workoutRoutes = require("./routes/workout");
const planRoutes = require("./routes/plans");
const settingsRoutes = require("./routes/settings");
const Plan = require("./models/Plan");
const Notification = require("./models/Notification");
const { deliverCampaign } = require("./services/notifications");

const app = express();
const httpServer = createServer(app);

// Render sits behind a reverse proxy, so trust the first proxy hop.
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Webhook needs raw body BEFORE express.json()
app.use("/api/webhooks", webhookRouter);

// strict:false lets primitive JSON bodies (e.g. null) reach routes instead of
// being rejected with a 400 SyntaxError by body-parser's default strict mode.
app.use(express.json({ strict: false }));

app.use("/uploads", express.static(path.resolve(__dirname, "../uploads")));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/payments", checkoutRouter);
app.use("/api/admin", adminRoutes);
app.use("/api/podcasts", podcastRoutes);
app.use("/api/drills", drillRoutes);
app.use("/api/workouts", workoutRoutes);
app.use("/api/plans", planRoutes);
app.use("/api/settings", settingsRoutes);

app.get("/payment-success", (_req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Payment Successful</title><style>body{background:#000;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}div{text-align:center}h1{color:#E50914}p{color:#aaa}</style></head><body><div><h1>Payment Successful!</h1><p>You can close this tab and return to the app.</p><p>Your subscription will be activated automatically.</p></div></body></html>`);
});

app.get("/payment-cancel", (_req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Payment Cancelled</title><style>body{background:#000;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}div{text-align:center}h1{color:#aaa}p{color:#666}</style></head><body><div><h1>Payment Cancelled</h1><p>You can close this tab and return to the app.</p></div></body></html>`);
});

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

const { errorHandler } = require("./middleware/errorHandler");
app.use(errorHandler);

initSocket(httpServer);

async function seedPlans() {
  for (const key of Object.keys(DEFAULT_PLANS)) {
    const defaults = DEFAULT_PLANS[key];
    const existing = await Plan.findOne({ key });
    if (!existing) {
      await Plan.create(defaults);
      continue;
    }
    let changed = false;
    if (!existing.label) {
      existing.label = defaults.label;
      changed = true;
    }
    if (!existing.benefits || !existing.benefits.length) {
      existing.benefits = defaults.benefits;
      changed = true;
    }
    if (changed) await existing.save();
  }
}

async function processScheduledNotifications() {
  try {
    const due = await Notification.find({
      status: "scheduled",
      scheduledAt: { $lte: new Date() },
    });
    for (const campaign of due) {
      try {
        console.log(`Sending scheduled notification: ${campaign.title}`);
        await deliverCampaign(campaign);
      } catch (error) {
        console.error("Scheduled notification failed:", error);
        campaign.status = "failed";
        campaign.error = error.message || "Delivery failed";
        await campaign.save().catch(() => {});
      }
    }
  } catch (error) {
    console.error("Scheduled notifications scan error:", error);
  }
}

async function start() {
  await connectDB();
  await seedPlans();

  httpServer.listen(env.port, () => {
    console.log(`Server running on port ${env.port} in ${env.nodeEnv} mode`);
  });

  // Fire due scheduled notifications every minute.
  processScheduledNotifications();
  setInterval(processScheduledNotifications, 60 * 1000);
}

start().catch(console.error);
