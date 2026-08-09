const { Router } = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { env } = require("../config/env");
const { adminAuth } = require("../middleware/adminAuth");
const { upload, deleteCloudinaryFile } = require("../middleware/upload");
const { User } = require("../models/User");
const Drill = require("../models/Drill");
const Category = require("../models/Category");
const Program = require("../models/Program");
const Pro = require("../models/Pro");
const Podcast = require("../models/Podcast");
const Transaction = require("../models/Transaction");
const Activity = require("../models/Activity");
const Plan = require("../models/Plan");
const Role = require("../models/Role");
const Notification = require("../models/Notification");
const { DEFAULT_PLANS, formatPriceLabel } = require("../config/plans");
const { DEFAULT_PERMISSIONS, DEFAULT_ROLES } = require("../config/roles");
const { transcribePodcast } = require("../services/transcribe");
const {
  deliverCampaign,
  targetCount,
  CHANNELS,
  AUDIENCES,
} = require("../services/notifications");
const {
  sendPasswordResetEmail,
} = require("../services/email");

const router = Router();

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createOtpCode() {
  return crypto.randomInt(10000, 100000).toString();
}

// Drills visible in a program = all of its drills minus admin-removed ones (and dangling refs)
function visibleProgramDrills(program) {
  const removed = new Set(
    (program.removedDrills || []).map((r) => String(r._id || r))
  );
  return (program.drills || [])
    .filter((d) => d.drill && !removed.has(String(d.drill._id || d.drill)))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

// Normalize a category so case/whitespace/spelling variants match (Defense == Defence)
function normalizeCategory(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace("defense", "defence");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatPodcastDate(d) {
  if (!d) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

async function runTranscription(podcast) {
  if (!podcast.mediaUrl) {
    podcast.transcriptStatus = "none";
    await podcast.save();
    return;
  }
  podcast.transcriptStatus = "pending";
  podcast.transcript = [];
  await podcast.save();
  try {
    const transcript = await transcribePodcast(podcast.mediaUrl);
    podcast.transcript = transcript;
    podcast.transcriptStatus = "done";
  } catch (error) {
    console.error("Transcription failed:", error.message);
    podcast.transcriptStatus = "failed";
  }
  await podcast.save();
}

// Add every drill in the DB to a program, skipping ones an admin explicitly removed
async function backfillProgramDrills(program) {
  const allDrills = await Drill.find({}).sort({ createdAt: 1 });
  const removedSet = new Set(
    (program.removedDrills || []).map((r) => String(r._id || r))
  );
  const existingIds = new Set(
    (program.drills || [])
      .filter((d) => d.drill)
      .map((d) => String(d.drill._id || d.drill))
  );
  const missing = allDrills.filter(
    (d) => !removedSet.has(String(d._id)) && !existingIds.has(String(d._id))
  );
  if (missing.length > 0) {
    const base = program.drills && program.drills.length ? program.drills.length : 0;
    missing.forEach((d, i) =>
      program.drills.push({ drill: d._id, order: base + i + 1 })
    );
    await program.save();
  }
  return program;
}

// ── Admin Login ──
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (
      email !== env.adminEmail ||
      !password ||
      password !== env.adminPassword
    ) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { email: env.adminEmail, role: "admin" },
      env.adminJwtSecret,
      { expiresIn: "24h" }
    );

    res.json({ token, email: env.adminEmail });
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// ── Admin Forgot Password (just validates the fixed credentials) ──
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (email !== env.adminEmail) {
      return res.status(404).json({ error: "Admin account not found" });
    }
    res.json({ success: true, message: "Password reset is handled by the system administrator." });
  } catch (error) {
    res.status(500).json({ error: "Request failed" });
  }
});

// ── Admin Reset Password ──
router.post("/reset-password", async (req, res) => {
  try {
    const { email, currentPassword, newPassword } = req.body;

    if (email !== env.adminEmail || currentPassword !== env.adminPassword) {
      return res.status(401).json({ error: "Invalid current credentials" });
    }

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    env.adminPassword = newPassword;
    res.json({ success: true, message: "Admin password updated" });
  } catch (error) {
    console.error("Password reset failed:", error);
    res.status(500).json({ error: "Password reset failed" });
  }
});

// ── Admin Forgot Password Reset (no current password required) ──
router.post("/forgot-password-reset", async (req, res) => {
  try {
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    env.adminPassword = newPassword;
    res.json({ success: true, message: "Admin password updated" });
  } catch (error) {
    console.error("Forgot password reset error:", error);
    res.status(500).json({ error: "Password reset failed" });
  }
});

// ── Dashboard Stats ──
router.get("/dashboard", adminAuth, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeSubscribers = await User.countDocuments({
      subscriptionTier: { $in: ["pro", "premium"] },
    });
    const proUsers = await User.countDocuments({ subscriptionTier: "pro" });
    const freeUsers = await User.countDocuments({ subscriptionTier: "free" });

    const recentUsers = await User.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select("firstName lastName email createdAt subscriptionTier");

    const providerCounts = await User.aggregate([
      { $group: { _id: "$authProvider", count: { $sum: 1 } } },
    ]);

    const monthlySignups = await User.aggregate([
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
      { $limit: 12 },
    ]);

    const totalDrills = await Drill.countDocuments();
    const publishedDrills = await Drill.countDocuments({ status: "published" });
    const totalViews = await Drill.aggregate([
      { $group: { _id: null, total: { $sum: "$views" } } },
    ]);

    res.json({
      totalUsers,
      activeSubscribers,
      proUsers,
      freeUsers,
      totalDrills,
      publishedDrills,
      totalViews: totalViews[0]?.total || 0,
      recentUsers,
      providerCounts,
      monthlySignups,
    });
  } catch (error) {
    console.error("Dashboard stats error:", error);
    res.status(500).json({ error: "Failed to fetch dashboard stats" });
  }
});

// ── Subscriptions ──
router.get("/subscriptions", adminAuth, async (req, res) => {
  try {
    const { tab = "all", search = "" } = req.query;

    const proUsers = await User.countDocuments({ subscriptionTier: "pro" });
    const premiumUsers = await User.countDocuments({
      subscriptionTier: "premium",
    });
    const freeUsers = await User.countDocuments({ subscriptionTier: "free" });
    const activeSubscriptions = proUsers + premiumUsers;

    const monthlyPro = await User.countDocuments({
      subscriptionTier: { $in: ["pro", "premium"] },
      billingInterval: { $ne: "annual" },
    });
    const annualPro = await User.countDocuments({
      subscriptionTier: { $in: ["pro", "premium"] },
      billingInterval: "annual",
    });

    const monthlyPrice = 9.5;
    const annualPrice = 79;

    let mrr = 0;
    if (annualPro > 0) mrr += (annualPro * annualPrice) / 12;
    mrr += monthlyPro * monthlyPrice;

    const statsAgg = await Transaction.aggregate([
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$amount" },
          failedCount: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          refundedCount: { $sum: { $cond: [{ $eq: ["$status", "refunded"] }, 1, 0] } },
        },
      },
    ]);

    const totalRevenue = statsAgg[0]?.totalRevenue || 0;
    const failedCount = statsAgg[0]?.failedCount || 0;
    const refundedCount = statsAgg[0]?.refundedCount || 0;

    const churned = await Transaction.countDocuments({ status: "cancelled" });
    const churnRate = activeSubscriptions + churned
      ? (churned / (activeSubscriptions + churned)) * 100
      : 0;

    const today = new Date();
    const dailyRevenue = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(today);
      day.setDate(today.getDate() - i);
      day.setHours(0, 0, 0, 0);
      const next = new Date(day);
      next.setDate(day.getDate() + 1);
      const agg = await Transaction.aggregate([
        {
          $match: {
            status: "success",
            date: { $gte: day, $lt: next },
          },
        },
        { $group: { _id: null, revenue: { $sum: "$amount" } } },
      ]);
      dailyRevenue.push({
        date: day.toISOString().slice(0, 10),
        label: `d${i + 1}`,
        revenue: Math.round((agg[0]?.revenue || 0) * 100) / 100,
      });
    }

    const planBreakdown = [
      { key: "free", plan: "Free", count: freeUsers },
      { key: "monthly", plan: "Monthly Pro", count: monthlyPro },
      { key: "annual", plan: "Annual Pro", count: annualPro },
    ];

    const and = [];
    if (tab === "failed") and.push({ status: "failed" });
    if (tab === "refunds") and.push({ status: "refunded" });
    if (search) {
      and.push({
        $or: [
          { userEmail: { $regex: search, $options: "i" } },
          { userName: { $regex: search, $options: "i" } },
        ],
      });
    }
    const filter = and.length ? { $and: and } : {};

    const transactions = await Transaction.find(filter)
      .sort({ date: -1 })
      .limit(200);

    res.json({
      stats: {
        mrr: Math.round(mrr * 100) / 100,
        activeSubscriptions,
        churnRate: Math.round(churnRate * 100) / 100,
        failedCount,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
      },
      dailyRevenue,
      planBreakdown,
      transactions,
    });
  } catch (error) {
    console.error("Subscriptions stats error:", error);
    res.status(500).json({ error: "Failed to fetch subscriptions stats" });
  }
});

// ── Plan Detail ──
router.get("/plans/:key", adminAuth, async (req, res) => {
  try {
    const key = String(req.params.key || "").toLowerCase();
    if (!DEFAULT_PLANS[key]) {
      return res.status(404).json({ error: "Plan not found" });
    }

    const doc = (await Plan.findOne({ key })) || DEFAULT_PLANS[key];

    const storedBenefits = (doc.benefits || []).filter(
      (b) => b && (b.text || b.benefit || b.name)
    );
    const benefits = (storedBenefits.length
      ? storedBenefits
      : DEFAULT_PLANS[key].benefits
    ).map((b) => ({
      text: String(b.text || b.benefit || b.name || "").trim(),
      enabled: !!b.enabled,
    }));

    let activeUsers = 0;
    if (key === "free") {
      activeUsers = await User.countDocuments({ subscriptionTier: "free" });
    } else if (key === "monthly") {
      activeUsers = await User.countDocuments({
        subscriptionTier: { $in: ["pro", "premium"] },
        billingInterval: { $ne: "annual" },
      });
    } else {
      activeUsers = await User.countDocuments({
        subscriptionTier: { $in: ["pro", "premium"] },
        billingInterval: "annual",
      });
    }

    const revenueAgg = await Transaction.aggregate([
      {
        $match: {
          status: "success",
          plan: key === "free" ? "" : key,
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const revenue = revenueAgg[0]?.total || 0;

    res.json({
      plan: {
        key: doc.key,
        label: doc.label,
        price: {
          amount: Number(doc.price?.amount) || 0,
          interval: doc.price?.interval || "",
          label: formatPriceLabel(doc.price),
        },
        benefits,
        activeUsers,
        revenue: Math.round(revenue * 100) / 100,
      },
    });
  } catch (error) {
    console.error("Plan detail error:", error);
    res.status(500).json({ error: "Failed to fetch plan" });
  }
});
// ── Plan Detail: Update (price, interval, label, benefits) ──
router.put("/plans/:key", adminAuth, async (req, res) => {
  try {
    const key = String(req.params.key || "").toLowerCase();
    if (!DEFAULT_PLANS[key]) {
      return res.status(404).json({ error: "Plan not found" });
    }

    const updates = {};
    if (req.body.label !== undefined) {
      updates.label = String(req.body.label).trim();
    }
    if (req.body.price !== undefined) {
      const price = req.body.price || {};
      const amount = Number(price.amount);
      if (Number.isFinite(amount) && amount >= 0) {
        const interval = price.interval;
        updates.price = {
          amount: Math.round(amount * 100) / 100,
          interval:
            interval === "year"
              ? "year"
              : interval === "month"
                ? "month"
                : "",
        };
      }
    }
    if (Array.isArray(req.body.benefits)) {
      updates.benefits = req.body.benefits.map((b) => {
        const text =
          typeof b === "string" ? b : String(b.text || b.benefit || b.name || "");
        return {
          text: text.trim() || "Benefit",
          enabled: typeof b === "string" ? true : !!b.enabled,
        };
      });
    }

    let plan = await Plan.findOne({ key });
    if (!plan) {
      plan = await Plan.create({ ...DEFAULT_PLANS[key], ...updates });
    } else {
      for (const field of Object.keys(updates)) {
        plan[field] = updates[field];
      }
      await plan.save();
    }

    res.json({
      plan: {
        key: plan.key,
        label: plan.label,
        price: {
          amount: Number(plan.price?.amount) || 0,
          interval: plan.price?.interval || "",
          label: formatPriceLabel(plan.price),
        },
        benefits: (
          (plan.benefits || []).length
            ? plan.benefits
            : DEFAULT_PLANS[key].benefits
        ).map((b) => ({
          text: String(b.text || b.benefit || b.name || "").trim(),
          enabled: !!b.enabled,
        })),
      },
    });
  } catch (error) {
    console.error("Update plan error:", error);
    res.status(500).json({ error: "Failed to update plan" });
  }
});

// ── Analytics ──
router.get("/analytics", adminAuth, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().slice(0, 10);

    // DAU: distinct users active today
    const dauAgg = await Activity.aggregate([
      { $match: { date: todayStr } },
      { $group: { _id: "$userId" } },
      { $count: "users" },
    ]);
    const dau = dauAgg[0]?.users || 0;

    // Active sessions: total activity events today
    const sessionAgg = await Activity.aggregate([
      { $match: { date: todayStr } },
      { $group: { _id: null, total: { $sum: "$count" } } },
    ]);
    const activeSessions = sessionAgg[0]?.total || 0;

    // Retention: users active in last 7 days vs last 14 days
    const daysAgo = (n) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return d.toISOString().slice(0, 10);
    };
    const weekStart = daysAgo(6);
    const twoWeekStart = daysAgo(13);

    const [weekActiveAgg, twoWeekActiveAgg] = await Promise.all([
      Activity.aggregate([
        { $match: { date: { $gte: weekStart } } },
        { $group: { _id: "$userId" } },
        { $count: "users" },
      ]),
      Activity.aggregate([
        { $match: { date: { $gte: twoWeekStart } } },
        { $group: { _id: "$userId" } },
        { $count: "users" },
      ]),
    ]);

    const weekActive = weekActiveAgg[0]?.users || 0;
    const twoWeekActive = twoWeekActiveAgg[0]?.users || 0;
    const retention = twoWeekActive
      ? Math.round((weekActive / twoWeekActive) * 1000) / 10
      : 0;

    // Top coach: most drill views by coach
    const topCoaches = await Drill.aggregate([
      { $group: { _id: "$coach", views: { $sum: "$views" } } },
      { $sort: { views: -1 } },
      { $limit: 1 },
    ]);
    const topCoach = topCoaches[0]
      ? { name: topCoaches[0]._id, views: topCoaches[0].views }
      : { name: "—", views: 0 };

    // Daily active users, last 14 days
    const dailyActive = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      const agg = await Activity.aggregate([
        { $match: { date: dayStr } },
        { $group: { _id: "$userId" } },
        { $count: "users" },
      ]);
      dailyActive.push({
        date: dayStr,
        label: `d${i + 1}`,
        users: agg[0]?.users || 0,
      });
    }

    // Most watched drills by views
    const mostWatchedDrills = await Drill.find({ status: "published" })
      .sort({ views: -1 })
      .limit(10)
      .select("title views");

    res.json({
      stats: {
        dau,
        activeSessions,
        retention,
        topCoach,
      },
      dailyActive,
      mostWatchedDrills: mostWatchedDrills.map((d) => ({
        name: d.title,
        views: d.views || 0,
      })),
    });
  } catch (error) {
    console.error("Analytics stats error:", error);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// ── Roles & Permissions: List ──
router.get("/roles", adminAuth, async (req, res) => {
  try {
    const roles = [];

    for (const key of Object.keys(DEFAULT_ROLES)) {
      const def = DEFAULT_ROLES[key];
      const doc = await Role.findOne({ key });

      let users = def.users ?? 0;
      if (key === "coach") {
        users = await User.countDocuments({ role: "coach" });
      } else if (key === "member") {
        users = await User.countDocuments({ role: "member" });
      } else if (doc && typeof doc.users === "number") {
        users = doc.users;
      }

      const permissions = { ...def.permissions, ...(doc?.permissions || {}) };
      roles.push({
        key,
        label: doc?.label || def.label,
        users,
        granted: Object.values(permissions).filter(Boolean).length,
        total: DEFAULT_PERMISSIONS.length,
        permissions,
      });
    }

    // Custom roles created via POST /roles
    const custom = await Role.find({ key: { $nin: Object.keys(DEFAULT_ROLES) } });
    for (const c of custom) {
      const permissions = c.permissions || {};
      roles.push({
        key: c.key,
        label: c.label || c.key,
        users: typeof c.users === "number" ? c.users : 0,
        granted: Object.values(permissions).filter(Boolean).length,
        total: DEFAULT_PERMISSIONS.length,
        permissions,
      });
    }

    res.json({
      permissions: DEFAULT_PERMISSIONS,
      roles,
    });
  } catch (error) {
    console.error("Roles error:", error);
    res.status(500).json({ error: "Failed to fetch roles" });
  }
});

// ── Roles & Permissions: Update ──
router.put("/roles/:key", adminAuth, async (req, res) => {
  try {
    const key = String(req.params.key || "");
    const def = DEFAULT_ROLES[key];

    let doc = await Role.findOne({ key });
    if (!def && !doc) {
      return res.status(404).json({ error: "Role not found" });
    }

    const updates = {};
    if (req.body.label !== undefined) {
      updates.label = String(req.body.label).trim();
    }
    if (req.body.users !== undefined && Number.isFinite(Number(req.body.users))) {
      updates.users = Math.max(0, Number(req.body.users));
    }
    if (req.body.permissions && typeof req.body.permissions === "object") {
      const base = { ...(def?.permissions || {}), ...(doc?.permissions || {}) };
      const merged = { ...base, ...(req.body.permissions || {}) };
      for (const key of Object.keys(merged)) {
        merged[key] = !!merged[key];
      }
      updates.permissions = merged;
    }

    if (!doc) {
      doc = await Role.create({
        key,
        label: updates.label ?? def.label,
        permissions: updates.permissions ?? def.permissions ?? {},
        users: updates.users ?? def.users ?? 0,
      });
    } else {
      for (const field of Object.keys(updates)) {
        doc[field] = updates[field];
      }
      await doc.save();
    }

    const permissions = {
      ...(def?.permissions || {}),
      ...(doc.permissions || {}),
    };
    res.json({
      role: {
        key: doc.key,
        label: doc.label || def?.label || key,
        users: typeof doc.users === "number" ? doc.users : def?.users ?? 0,
        granted: Object.values(permissions).filter(Boolean).length,
        total: DEFAULT_PERMISSIONS.length,
        permissions,
      },
    });
  } catch (error) {
    console.error("Update role error:", error);
    res.status(500).json({ error: "Failed to update role" });
  }
});

// ── Roles & Permissions: Create ──
router.post("/roles", adminAuth, async (req, res) => {
  try {
    const label = String(req.body.label || "").trim();
    if (!label) {
      return res.status(400).json({ error: "Role name is required" });
    }

    const key = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);

    if (!key) {
      return res.status(400).json({ error: "Invalid role name" });
    }

    const existing = await Role.findOne({ key });
    if (existing) {
      return res.status(409).json({ error: "Role already exists" });
    }

    const permissions = {};
    for (const p of DEFAULT_PERMISSIONS) {
      permissions[p.key] = false;
    }

    const doc = await Role.create({ key, label, permissions, users: 0 });

    res.status(201).json({
      role: {
        key: doc.key,
        label: doc.label,
        users: 0,
        granted: 0,
        total: DEFAULT_PERMISSIONS.length,
        permissions,
      },
    });
  } catch (error) {
    console.error("Create role error:", error);
    res.status(500).json({ error: "Failed to create role" });
  }
});

// ── Content Library: List Drills ──
router.get("/drills", adminAuth, async (req, res) => {
  try {
    const { search, category, status } = req.query;
    const filter = {};

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: "i" } },
        { coach: { $regex: search, $options: "i" } },
      ];
    }
    if (category && category !== "All") {
      const cat = String(category).trim();
      if (cat) {
        filter.category = {
          $regex: new RegExp(`^${escapeRegex(cat)}$`, "i"),
        };
      }
    }
    if (status && status !== "All") {
      filter.status = status;
    }

    const drills = await Drill.find(filter).sort({ createdAt: -1 });
    res.json({ drills });
  } catch (error) {
    console.error("List drills error:", error);
    res.status(500).json({ error: "Failed to fetch drills" });
  }
});

// ── Content Library: Get Single Drill ──
router.get("/drills/:id", adminAuth, async (req, res) => {
  try {
    const drill = await Drill.findById(req.params.id);
    if (!drill) {
      return res.status(404).json({ error: "Drill not found" });
    }
    res.json({ drill });
  } catch (error) {
    console.error("Get drill error:", error);
    res.status(500).json({ error: "Failed to fetch drill" });
  }
});

// ── Content Library: Create Drill ──
router.post("/drills", adminAuth, upload.fields([
  { name: "thumbnail", maxCount: 1 },
  { name: "video", maxCount: 1 },
]), async (req, res) => {
  try {
    const data = { ...req.body };
    const title = (data.title || "").trim();
    if (!title) {
      return res.status(400).json({ error: "Drill title is required" });
    }
    if (data.category) data.category = String(data.category).trim();
    const existing = await Drill.findOne({ title: { $regex: `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
    if (existing) {
      return res.status(409).json({ error: "A drill with this title already exists" });
    }
    if (req.files?.thumbnail?.[0]) {
      data.imageUrl = req.files.thumbnail[0].path;
    }
    if (req.files?.video?.[0]) {
      data.videoUrl = req.files.video[0].path;
    }
    const drill = await Drill.create(data);
    res.status(201).json({ drill });
  } catch (error) {
    console.error("Create drill error:", error);
    res.status(500).json({ error: "Failed to create drill" });
  }
});

// ── Content Library: Update Drill ──
const DRILL_UPDATABLE_FIELDS = [
  "title",
  "description",
  "coach",
  "category",
  "level",
  "equipment",
  "duration",
  "status",
  "completionRate",
  "avgWatchTime",
  "likes",
  "views",
];

router.put("/drills/:id", adminAuth, upload.fields([
  { name: "thumbnail", maxCount: 1 },
  { name: "video", maxCount: 1 },
]), async (req, res) => {
  try {
    const existing = await Drill.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Drill not found" });
    }

    const updates = {};
    for (const key of DRILL_UPDATABLE_FIELDS) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (req.files?.thumbnail?.[0]) {
      updates.imageUrl = req.files.thumbnail[0].path;
      deleteCloudinaryFile(existing.imageUrl);
    }
    if (req.files?.video?.[0]) {
      updates.videoUrl = req.files.video[0].path;
      deleteCloudinaryFile(existing.videoUrl);
    }

    const drill = await Drill.findByIdAndUpdate(req.params.id, updates, {
      new: true,
    });
    res.json({ drill });
  } catch (error) {
    console.error("Update drill error:", error);
    res.status(500).json({ error: "Failed to update drill" });
  }
});

// ── Content Library: Delete Drill ──
router.delete("/drills/:id", adminAuth, async (req, res) => {
  try {
    const drill = await Drill.findByIdAndDelete(req.params.id);
    if (!drill) {
      return res.status(404).json({ error: "Drill not found" });
    }
    deleteCloudinaryFile(drill.imageUrl);
    deleteCloudinaryFile(drill.videoUrl);
    res.json({ success: true });
  } catch (error) {
    console.error("Delete drill error:", error);
    res.status(500).json({ error: "Failed to delete drill" });
  }
});

// ── Users List ──
router.get("/users", adminAuth, async (req, res) => {
  try {
    const { search, plan, status } = req.query;
    const and = [];

    if (search) {
      and.push({
        $or: [
          { firstName: { $regex: search, $options: "i" } },
          { lastName: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ],
      });
    }
    if (plan && plan !== "all") {
      if (plan === "free") {
        and.push({ subscriptionTier: "free" });
      } else if (plan === "monthly") {
        and.push(
          { subscriptionTier: { $in: ["pro", "premium"] } },
          { billingInterval: { $ne: "annual" } }
        );
      } else if (plan === "annual") {
        and.push(
          { subscriptionTier: { $in: ["pro", "premium"] } },
          { billingInterval: "annual" }
        );
      }
    }
    if (status && status !== "all") {
      and.push({ status });
    }

    const filter = and.length ? { $and: and } : {};

    const users = await User.find(filter)
      .sort({ createdAt: -1 })
      .select("-password -passwordResetCodeHash -passwordResetTokenHash");

    res.json({ users });
  } catch (error) {
    console.error("List users error:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// ── Users: Get Single (with drill history + enrolled programs) ──
router.get("/users/:id", adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select(
      "-password -passwordResetCodeHash -passwordResetTokenHash"
    );
    if (!user) return res.status(404).json({ error: "User not found" });

    const drillHistory = await Drill.find({
      _id: { $in: user.completedDrills || [] },
    }).select("title coach category views imageUrl");

    const enrolledPrograms = await Program.find({
      _id: { $in: user.enrolledPrograms || [] },
    }).select("name");

    res.json({ user, drillHistory, enrolledPrograms });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// ── Users: Update (status, role) ──
const USER_UPDATABLE_FIELDS = ["status", "role"];

router.put("/users/:id", adminAuth, async (req, res) => {
  try {
    const updates = {};
    for (const key of USER_UPDATABLE_FIELDS) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.status !== undefined && !["active", "suspended"].includes(updates.status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    if (updates.role !== undefined && !["member", "coach"].includes(updates.role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true })
      .select("-password -passwordResetCodeHash -passwordResetTokenHash");
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({ user });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({ error: "Failed to update user" });
  }
});

// ── Users: Admin-triggered password reset email ──
router.post("/users/:id/reset-password", adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.status === "suspended") {
      return res.status(400).json({
        error: "Cannot reset the password of a suspended account",
      });
    }

    const otpCode = createOtpCode();
    user.passwordResetCodeHash = hashValue(otpCode);
    user.passwordResetCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    user.passwordResetAttempts = 0;
    user.passwordResetTokenHash = undefined;
    user.passwordResetTokenExpiresAt = undefined;
    await user.save();

    try {
      await sendPasswordResetEmail({ toEmail: user.email, otpCode });
    } catch (emailError) {
      console.error("Failed to send reset email:", emailError.message || emailError);
      res.status(502).json({
        error: "Unable to send reset email. The sender email may not be verified in SendGrid.",
      });
      return;
    }

    console.log(`Admin sent password reset email to: ${user.email}`);
    res.json({ success: true, message: `Reset email sent to ${user.email}` });
  } catch (error) {
    console.error("Admin reset user password error:", error);
    res.status(500).json({ error: "Failed to send reset email" });
  }
});

// ── Categories: List ──
router.get("/categories", adminAuth, async (req, res) => {
  try {
    const categories = await Category.find().sort({ name: 1 });
    const drills = await Drill.find({}, { category: 1 });
    const countMap = {};
    drills.forEach((d) => {
      const key = normalizeCategory(d.category);
      if (key) countMap[key] = (countMap[key] || 0) + 1;
    });
    const result = categories.map((c) => ({
      _id: c._id,
      name: c.name,
      description: c.description,
      drillCount: countMap[normalizeCategory(c.name)] || 0,
    }));
    res.json({ categories: result });
  } catch (error) {
    console.error("List categories error:", error);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// ── Categories: Create ──
router.post("/categories", adminAuth, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Category name is required" });
    }
    const existing = await Category.findOne({ name: name.trim() });
    if (existing) {
      return res.status(409).json({ error: "Category already exists" });
    }
    const category = await Category.create({ name: name.trim(), description });
    res.status(201).json({ category });
  } catch (error) {
    console.error("Create category error:", error);
    res.status(500).json({ error: "Failed to create category" });
  }
});

// ── Categories: Delete ──
router.delete("/categories/:id", adminAuth, async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) return res.status(404).json({ error: "Category not found" });
    res.json({ success: true });
  } catch (error) {
    console.error("Delete category error:", error);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

// ── Programs: List ──
router.get("/programs", adminAuth, async (req, res) => {
  try {
    const { search, category } = req.query;
    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
      ];
    }
    if (category && category !== "all") {
      filter.category = category;
    }
    let programs = await Program.find(filter)
      .populate("drills.drill")
      .sort({ createdAt: -1 });
    // Ensure every program lists ALL drills in the DB, unless a drill was specifically
    // removed by an admin for that program.
    for (const p of programs) {
      await backfillProgramDrills(p);
    }
    // Refetch with populated drills after backfill
    programs = await Program.find(filter)
      .populate("drills.drill")
      .sort({ createdAt: -1 });
    const visible = programs.map((p) => {
      const plain = p.toObject();
      plain.drills = visibleProgramDrills(p);
      return plain;
    });
    res.json({ programs: visible });
  } catch (error) {
    console.error("List programs error:", error);
    res.status(500).json({ error: "Failed to fetch programs" });
  }
});

// ── Programs: Get Single ──
router.get("/programs/:id", adminAuth, async (req, res) => {
  try {
    let program = await Program.findById(req.params.id).populate("drills.drill");
    if (!program) return res.status(404).json({ error: "Program not found" });
    await backfillProgramDrills(program);
    program = await Program.findById(req.params.id).populate("drills.drill");
    const plain = program.toObject();
    plain.drills = visibleProgramDrills(program);
    res.json({ program: plain });
  } catch (error) {
    console.error("Get program error:", error);
    res.status(500).json({ error: "Failed to fetch program" });
  }
});

// ── Programs: Create ──
router.post("/programs", adminAuth, async (req, res) => {
  try {
    const { name, coach, coachId, level, category, duration, description, imageUrl, status } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Program name is required" });
    }
    const cat = category || "";
    const allDrills = await Drill.find({}).sort({ createdAt: 1 });
    const drills = allDrills.map((d, i) => ({ drill: d._id, order: i + 1 }));
    const program = await Program.create({
      name: name.trim(),
      coach: coach || "",
      coachId: coachId || undefined,
      level: level || "Beginner",
      category: cat,
      duration: duration || "4 weeks",
      description: description || "",
      imageUrl: imageUrl || "",
      status: status || "published",
      drills,
    });
    const populated = await Program.findById(program._id).populate("drills.drill");
    const plain = populated.toObject();
    plain.drills = visibleProgramDrills(populated);
    res.status(201).json({ program: plain });
  } catch (error) {
    console.error("Create program error:", error);
    res.status(500).json({ error: "Failed to create program" });
  }
});

// ── Programs: Update ──
router.put("/programs/:id", adminAuth, async (req, res) => {
  try {
    const program = await Program.findByIdAndUpdate(req.params.id, req.body, { new: true }).populate("drills.drill");
    if (!program) return res.status(404).json({ error: "Program not found" });
    const plain = program.toObject();
    plain.drills = visibleProgramDrills(program);
    res.json({ program: plain });
  } catch (error) {
    console.error("Update program error:", error);
    res.status(500).json({ error: "Failed to update program" });
  }
});

// ── Programs: Remove one drill from a program ──
router.delete("/programs/:id/drills/:drillId", adminAuth, async (req, res) => {
  try {
    const program = await Program.findById(req.params.id);
    if (!program) return res.status(404).json({ error: "Program not found" });
    const drillId = req.params.drillId;
    program.removedDrills = program.removedDrills || [];
    if (!program.removedDrills.some((r) => String(r) === String(drillId))) {
      program.removedDrills.push(drillId);
    }
    program.drills = (program.drills || []).filter(
      (d) => String(d.drill) !== String(drillId)
    );
    await program.save();
    const populated = await Program.findById(program._id).populate("drills.drill");
    const plain = populated.toObject();
    plain.drills = visibleProgramDrills(populated);
    res.json({ program: plain });
  } catch (error) {
    console.error("Remove drill from program error:", error);
    res.status(500).json({ error: "Failed to remove drill from program" });
  }
});

// ── Programs: Delete ──
router.delete("/programs/:id", adminAuth, async (req, res) => {
  try {
    const program = await Program.findByIdAndDelete(req.params.id);
    if (!program) return res.status(404).json({ error: "Program not found" });
    res.json({ success: true });
  } catch (error) {
    console.error("Delete program error:", error);
    res.status(500).json({ error: "Failed to delete program" });
  }
});

// ── Learn from the Pros ──
const PRO_UPDATABLE_FIELDS = ["name", "team", "sessions", "featured", "homepageBanner"];

function parseProBool(value) {
  if (value === undefined) return undefined;
  return String(value) === "true";
}

function parseProSessions(value) {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// ── Pros: List ──
router.get("/pros", adminAuth, async (req, res) => {
  try {
    const pros = await Pro.find().sort({ createdAt: -1 });
    res.json({ pros });
  } catch (error) {
    console.error("List pros error:", error);
    res.status(500).json({ error: "Failed to fetch pros" });
  }
});

// ── Pros: Get Single ──
router.get("/pros/:id", adminAuth, async (req, res) => {
  try {
    const pro = await Pro.findById(req.params.id);
    if (!pro) return res.status(404).json({ error: "Athlete not found" });
    res.json({ pro });
  } catch (error) {
    console.error("Get pro error:", error);
    res.status(500).json({ error: "Failed to fetch pro" });
  }
});

// ── Pros: Create ──
router.post("/pros", adminAuth, upload.single("image"), async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "Athlete name is required" });
    }

    const featured = parseProBool(req.body.featured);
    const homepageBanner = parseProBool(req.body.homepageBanner);
    const sessions = parseProSessions(req.body.sessions);

    const data = {
      name,
      team: (req.body.team || "").trim(),
      sessions: sessions === undefined ? 0 : sessions,
      featured: featured === undefined ? false : featured,
      homepageBanner: homepageBanner === undefined ? false : homepageBanner,
    };
    if (req.file) data.imageUrl = req.file.path;

    if (data.homepageBanner) {
      await Pro.updateMany({ homepageBanner: true }, { homepageBanner: false });
    }

    const pro = await Pro.create(data);
    res.status(201).json({ pro });
  } catch (error) {
    console.error("Create pro error:", error);
    res.status(500).json({ error: "Failed to create pro" });
  }
});

// ── Pros: Update ──
router.put("/pros/:id", adminAuth, upload.single("image"), async (req, res) => {
  try {
    const existing = await Pro.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Athlete not found" });

    const updates = {};
    for (const key of PRO_UPDATABLE_FIELDS) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.name !== undefined) updates.name = String(updates.name).trim();
    if (updates.team !== undefined) updates.team = String(updates.team).trim();

    const sessions = parseProSessions(updates.sessions);
    if (sessions !== undefined) updates.sessions = sessions;

    const featured = parseProBool(updates.featured);
    const homepageBanner = parseProBool(updates.homepageBanner);
    if (featured !== undefined) updates.featured = featured;
    if (homepageBanner !== undefined) updates.homepageBanner = homepageBanner;

    if (req.file) {
      updates.imageUrl = req.file.path;
      deleteCloudinaryFile(existing.imageUrl);
    }

    if (updates.homepageBanner === true) {
      await Pro.updateMany(
        { _id: { $ne: existing._id }, homepageBanner: true },
        { homepageBanner: false }
      );
    }

    const pro = await Pro.findByIdAndUpdate(req.params.id, updates, { new: true });
    res.json({ pro });
  } catch (error) {
    console.error("Update pro error:", error);
    res.status(500).json({ error: "Failed to update pro" });
  }
});

// ── Pros: Delete ──
router.delete("/pros/:id", adminAuth, async (req, res) => {
  try {
    const pro = await Pro.findByIdAndDelete(req.params.id);
    if (!pro) return res.status(404).json({ error: "Athlete not found" });
    deleteCloudinaryFile(pro.imageUrl);
    res.json({ success: true });
  } catch (error) {
    console.error("Delete pro error:", error);
    res.status(500).json({ error: "Failed to delete pro" });
  }
});

// ── Podcasts: List ──
router.get("/podcasts", adminAuth, async (req, res) => {
  try {
    const podcasts = await Podcast.find().sort({ createdAt: -1 });
    res.json({ podcasts });
  } catch (error) {
    console.error("List podcasts error:", error);
    res.status(500).json({ error: "Failed to fetch podcasts" });
  }
});

// ── Podcasts: Get Single ──
router.get("/podcasts/:id", adminAuth, async (req, res) => {
  try {
    const podcast = await Podcast.findById(req.params.id);
    if (!podcast) return res.status(404).json({ error: "Podcast not found" });
    res.json({ podcast });
  } catch (error) {
    console.error("Get podcast error:", error);
    res.status(500).json({ error: "Failed to fetch podcast" });
  }
});

// ── Podcasts: Create ──
router.post("/podcasts", adminAuth, upload.fields([
  { name: "thumbnail", maxCount: 1 },
  { name: "media", maxCount: 1 },
]), async (req, res) => {
  try {
    const title = (req.body.title || "").trim();
    const host = (req.body.host || "").trim();
    if (!title) {
      return res.status(400).json({ error: "Episode title is required" });
    }
    if (!host) {
      return res.status(400).json({ error: "Host is required" });
    }

    const scheduled = req.body.status === "Scheduled";
    const scheduleDate = req.body.scheduleDate ? new Date(req.body.scheduleDate) : null;

    const data = {
      title,
      host,
      guest: (req.body.guest || "").trim(),
      type: req.body.type === "Video" ? "Video" : "Audio",
      duration: (req.body.duration || "").trim() || "0 min",
      description: (req.body.description || "").trim(),
      status: scheduled ? "Scheduled" : "Published",
      date: scheduleDate && !isNaN(scheduleDate) ? formatPodcastDate(scheduleDate) : formatPodcastDate(new Date()),
      scheduleDate: scheduleDate && !isNaN(scheduleDate) ? scheduleDate : null,
    };

    if (req.files?.thumbnail?.[0]) {
      data.imageUrl = req.files.thumbnail[0].path;
    }
    if (req.files?.media?.[0]) {
      const file = req.files.media[0];
      data.mediaUrl = file.path;
      data.mediaType = file.mimetype;
      data.mediaName = file.originalname || "";
      if (file.mimetype.startsWith("video/")) data.type = "Video";
      else if (file.mimetype.startsWith("audio/")) data.type = "Audio";
    }

    const podcast = await Podcast.create(data);
    res.status(201).json({ podcast });

    if (podcast.mediaUrl) {
      podcast.transcriptStatus = "pending";
      await podcast.save();
      runTranscription(podcast).catch(() => {});
    }
  } catch (error) {
    console.error("Create podcast error:", error);
    res.status(500).json({ error: "Failed to create podcast" });
  }
});

// ── Podcasts: Generate / Regenerate Transcript ──
router.post("/podcasts/:id/transcribe", adminAuth, async (req, res) => {
  try {
    const podcast = await Podcast.findById(req.params.id);
    if (!podcast) return res.status(404).json({ error: "Podcast not found" });
    if (!podcast.mediaUrl) {
      return res
        .status(400)
        .json({ error: "Podcast has no media file to transcribe" });
    }
    await runTranscription(podcast);
    res.json({ podcast });
  } catch (error) {
    console.error("Transcribe podcast error:", error);
    res.status(500).json({ error: "Failed to generate transcript" });
  }
});

// ── Podcasts: Update ──
const PODCAST_UPDATABLE_FIELDS = [
  "title",
  "host",
  "guest",
  "type",
  "duration",
  "description",
  "status",
  "completion",
  "plays",
];

router.put("/podcasts/:id", adminAuth, upload.fields([
  { name: "thumbnail", maxCount: 1 },
  { name: "media", maxCount: 1 },
]), async (req, res) => {
  try {
    const existing = await Podcast.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Podcast not found" });

    const updates = {};
    for (const key of PODCAST_UPDATABLE_FIELDS) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.title !== undefined) updates.title = String(updates.title).trim();
    if (updates.host !== undefined) updates.host = String(updates.host).trim();
    if (updates.guest !== undefined) updates.guest = String(updates.guest).trim();
    if (updates.status === "Published") updates.date = formatPodcastDate(new Date());

    const scheduleDate = req.body.scheduleDate
      ? new Date(req.body.scheduleDate)
      : null;
    if (scheduleDate && !isNaN(scheduleDate)) {
      updates.date = formatPodcastDate(scheduleDate);
      updates.scheduleDate = scheduleDate;
    }

    if (req.files?.thumbnail?.[0]) {
      updates.imageUrl = req.files.thumbnail[0].path;
      deleteCloudinaryFile(existing.imageUrl);
    }
    if (req.files?.media?.[0]) {
      const file = req.files.media[0];
      updates.mediaUrl = file.path;
      updates.mediaType = file.mimetype;
      updates.mediaName = file.originalname || "";
      if (file.mimetype.startsWith("video/")) updates.type = "Video";
      else if (file.mimetype.startsWith("audio/")) updates.type = "Audio";
      deleteCloudinaryFile(existing.mediaUrl);
    }

    const podcast = await Podcast.findByIdAndUpdate(req.params.id, updates, {
      new: true,
    });
    res.json({ podcast });
  } catch (error) {
    console.error("Update podcast error:", error);
    res.status(500).json({ error: "Failed to update podcast" });
  }
});

// ── Podcasts: Delete ──
router.delete("/podcasts/:id", adminAuth, async (req, res) => {
  try {
    const podcast = await Podcast.findByIdAndDelete(req.params.id);
    if (!podcast) return res.status(404).json({ error: "Podcast not found" });
    deleteCloudinaryFile(podcast.imageUrl);
    deleteCloudinaryFile(podcast.mediaUrl);
    res.json({ success: true });
  } catch (error) {
    console.error("Delete podcast error:", error);
    res.status(500).json({ error: "Failed to delete podcast" });
  }
});

// ── Notifications ──
router.get("/notifications", adminAuth, async (req, res) => {
  try {
    const notifications = await Notification.find()
      .sort({ createdAt: -1 })
      .limit(200);
    res.json({ notifications });
  } catch (error) {
    console.error("List notifications error:", error);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

router.post("/notifications", adminAuth, async (req, res) => {
  try {
    const { channel, audience, title, message, status = "sent", scheduledAt } =
      req.body || {};

    const channelKey = String(channel || "").toLowerCase();
    const audienceKey = String(audience || "").toLowerCase();

    if (!channelKey || !audienceKey || !title || !message) {
      return res
        .status(400)
        .json({ error: "Channel, audience, title and message are required" });
    }
    if (!CHANNELS.includes(channelKey)) {
      return res.status(400).json({ error: "Invalid channel" });
    }
    if (!AUDIENCES.includes(audienceKey)) {
      return res.status(400).json({ error: "Invalid audience" });
    }

    const mode = String(status || "sent").toLowerCase();
    let reach = 0;
    try {
      reach = await targetCount(audienceKey);
    } catch (err) {
      console.error("Target count error:", err.message);
    }

    const base = {
      channel: channelKey,
      audience: audienceKey,
      title: String(title).trim(),
      message: String(message).trim(),
      reach,
      createdBy: req.admin.email || "",
    };

    if (mode === "draft") {
      const notification = await Notification.create({ ...base, status: "draft" });
      return res.status(201).json({ notification });
    }

    if (mode === "scheduled") {
      if (!scheduledAt) {
        return res
          .status(400)
          .json({ error: "scheduledAt is required for scheduled notifications" });
      }
      const when = new Date(scheduledAt);
      if (isNaN(when.getTime())) {
        return res.status(400).json({ error: "Invalid scheduledAt" });
      }
      const notification = await Notification.create({
        ...base,
        status: "scheduled",
        scheduledAt: when,
      });
      return res.status(201).json({ notification });
    }

    const notification = await Notification.create({ ...base, status: "sent" });
    const delivered = await deliverCampaign(notification);
    return res.status(201).json({ notification: delivered });
  } catch (error) {
    console.error("Create notification error:", error);
    res.status(500).json({ error: "Failed to create notification" });
  }
});

router.post("/notifications/:id/send", adminAuth, async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }
    const delivered = await deliverCampaign(notification);
    res.json({ notification: delivered });
  } catch (error) {
    console.error("Send notification error:", error);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

router.delete("/notifications/:id", adminAuth, async (req, res) => {
  try {
    const notification = await Notification.findByIdAndDelete(req.params.id);
    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Delete notification error:", error);
    res.status(500).json({ error: "Failed to delete notification" });
  }
});

module.exports = router;
