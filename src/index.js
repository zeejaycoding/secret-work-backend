const express = require("express");
const { createServer } = require("http");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { env } = require("./config/env");
const { connectDB } = require("./config/db");
const { initSocket } = require("./socket");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const { checkoutRouter, webhookRouter } = require("./routes/payments");
const adminRoutes = require("./routes/admin");

const app = express();
const httpServer = createServer(app);

// Render sits behind a reverse proxy, so trust the first proxy hop.
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
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

app.use(express.json());

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

app.get("/payment-success", (_req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Payment Successful</title><style>body{background:#000;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}div{text-align:center}h1{color:#E50914}p{color:#aaa}</style></head><body><div><h1>Payment Successful!</h1><p>You can close this tab and return to the app.</p><p>Your subscription will be activated automatically.</p></div></body></html>`);
});

app.get("/payment-cancel", (_req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Payment Cancelled</title><style>body{background:#000;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}div{text-align:center}h1{color:#aaa}p{color:#666}</style></head><body><div><h1>Payment Cancelled</h1><p>You can close this tab and return to the app.</p></div></body></html>`);
});

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

initSocket(httpServer);

async function start() {
  await connectDB();

  httpServer.listen(env.port, () => {
    console.log(`Server running on port ${env.port} in ${env.nodeEnv} mode`);
  });
}

start().catch(console.error);
