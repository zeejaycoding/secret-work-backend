const { Router } = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { env } = require("../config/env");
const { adminAuth, requirePermission } = require("../middleware/adminAuth");
const {
  upload,
  cloudinary,
  deleteCloudinaryFile,
  hasCloudinary,
} = require("../middleware/upload");
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
const Setting = require("../models/Setting");
const Follow = require("../models/Follow");
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
const {
  getSettingsDoc,
  DEFAULT_BRANDING,
  DEFAULT_NOTIFICATIONS,
} = require("../services/settings");

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
      { email: env.adminEmail, role: "admin", permissions: DEFAULT_ROLES.admin.permissions },
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
    // Disabled: public forgot-password-reset is a security risk.
    // Require the authenticated admin reset flow instead via /reset-password.
    return res.status(403).json({ error: "Endpoint disabled. Use authenticated reset." });
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

    const startOfYear = new Date();
    startOfYear.setMonth(0, 1);
    startOfYear.setHours(0, 0, 0, 0);

    const monthlySignups = await User.aggregate([
      { $match: { createdAt: { $gte: startOfYear } } },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.month": 1 } },
    ]);

    const totalDrills = await Drill.countDocuments();
    const publishedDrills = await Drill.countDocuments({ status: "published" });
    const totalViews = await Drill.aggregate([
      { $group: { _id: null, total: { $sum: "$views" } } },
    ]);

    const revenueAgg = await Transaction.aggregate([
      { $match: { status: "success" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const revenue = revenueAgg[0]?.total || 0;

    const monthlyRevenue = await Transaction.aggregate([
      { $match: { status: "success", date: { $gte: startOfYear } } },
      {
        $group: {
          _id: { year: { $year: "$date" }, month: { $month: "$date" } },
          total: { $sum: "$amount" },
        },
      },
      { $sort: { "_id.month": 1 } },
    ]);

    const watchTimeAgg = await User.aggregate([
      { $group: { _id: null, total: { $sum: "$watchTimeSec" } } },
    ]);
    const watchTimeHours =
      Math.round(((watchTimeAgg[0]?.total || 0) / 3600) * 10) / 10;

    const podcastPlaysAgg = await Podcast.aggregate([
      { $group: { _id: null, total: { $sum: "$plays" } } },
    ]);
    const podcastPlays = podcastPlaysAgg[0]?.total || 0;

    const recentActivity = await Activity.aggregate([
      { $sort: { updatedAt: -1 } },
      { $limit: 8 },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          kind: 1,
          date: 1,
          count: 1,
          updatedAt: 1,
          firstName: { $ifNull: ["$user.firstName", ""] },
          lastName: { $ifNull: ["$user.lastName", ""] },
          email: { $ifNull: ["$user.email", ""] },
        },
      },
    ]);

    const drillCompletionAgg = await User.aggregate([
      { $unwind: "$completedDrills" },
      { $group: { _id: "$completedDrills", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]);
    const drillDocs = await Drill.find({
      _id: { $in: drillCompletionAgg.map((d) => d._id) },
    }).select("title category");
    const drillById = {};
    drillDocs.forEach((d) => {
      drillById[String(d._id)] = d;
    });
    const topDrills = drillCompletionAgg.map((d) => {
      const drill = drillById[String(d._id)];
      return {
        title: drill?.title || "Unknown drill",
        category: drill?.category || "",
        completions: d.count,
        progress: totalUsers
          ? Math.min(100, Math.round((d.count / totalUsers) * 100))
          : 0,
      };
    });

    res.json({
      totalUsers,
      activeSubscribers,
      proUsers,
      freeUsers,
      totalDrills,
      publishedDrills,
      totalViews: totalViews[0]?.total || 0,
      revenue,
      monthlyRevenue,
      watchTimeHours,
      podcastPlays,
      recentUsers,
      providerCounts,
      monthlySignups,
      recentActivity,
      topDrills,
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

    const planDocs = await Plan.find();
    const planByKey = {};
    planDocs.forEach((p) => (planByKey[p.key] = p));

    const monthlyPrice = Number(planByKey.monthly?.price?.amount) || 9.5;
    const annualPrice = Number(planByKey.annual?.price?.amount) || 79;

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
    const startUtc = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate()
    );
    for (let i = 13; i >= 0; i--) {
      const dayStart = new Date(startUtc - i * 86400000);
      const next = new Date(dayStart.getTime() + 86400000);
      const agg = await Transaction.aggregate([
        {
          $match: {
            status: "success",
            date: { $gte: dayStart, $lt: next },
          },
        },
        { $group: { _id: null, revenue: { $sum: "$amount" } } },
      ]);
      dailyRevenue.push({
        date: dayStart.toISOString().slice(0, 10),
        label: `d${i + 1}`,
        revenue: Math.round((agg[0]?.revenue || 0) * 100) / 100,
      });
    }

    const planBreakdown = [
      {
        key: "free",
        plan: "Free",
        count: freeUsers,
        price: 0,
        interval: "",
        priceLabel: "$0",
      },
      {
        key: "monthly",
        plan: "Monthly Pro",
        count: monthlyPro,
        price: monthlyPrice,
        interval: planByKey.monthly?.price?.interval || "month",
        priceLabel: formatPriceLabel(planByKey.monthly?.price),
      },
      {
        key: "annual",
        plan: "Annual Pro",
        count: annualPro,
        price: annualPrice,
        interval: planByKey.annual?.price?.interval || "year",
        priceLabel: formatPriceLabel(planByKey.annual?.price),
      },
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
router.put("/roles/:key", adminAuth, requirePermission("manage_roles"), async (req, res) => {
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
router.post("/roles", adminAuth, requirePermission("manage_roles"), async (req, res) => {
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

// ── Roles & Permissions: Detail + assigned users ──
router.get("/roles/:key", adminAuth, async (req, res) => {
  try {
    const key = String(req.params.key || "");
    const def = DEFAULT_ROLES[key];
    const doc = await Role.findOne({ key });
    if (!def && !doc) {
      return res.status(404).json({ error: "Role not found" });
    }

    const permissions = {
      ...(def?.permissions || {}),
      ...(doc?.permissions || {}),
    };

    // Assigned users: users whose role matches, or whose assignedRoles list includes this role
    const users = await User.find({
      $or: [{ role: key }, { assignedRoles: key }],
    })
      .select("firstName lastName email avatarUrl role status subscriptionTier")
      .sort({ createdAt: 1 });

    res.json({
      role: {
        key,
        label: doc?.label || def?.label || key,
        granted: Object.values(permissions).filter(Boolean).length,
        total: DEFAULT_PERMISSIONS.length,
        permissions,
      },
      users: users.map((u) => ({
        _id: u._id,
        firstName: u.firstName,
        lastName: u.lastName,
        name: [u.firstName, u.lastName].filter(Boolean).join(" "),
        email: u.email,
        avatarUrl: u.avatarUrl,
        role: u.role,
        status: u.status,
        subscriptionTier: u.subscriptionTier,
      })),
    });
  } catch (error) {
    console.error("Role detail error:", error);
    res.status(500).json({ error: "Failed to fetch role" });
  }
});

// ── Roles & Permissions: Remove user from role ──
router.delete("/roles/:key/users/:userId", adminAuth, requirePermission("manage_roles"), async (req, res) => {
  try {
    const key = String(req.params.key || "");
    const userId = String(req.params.userId || "");

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const assignedRoles = (user.assignedRoles || []).filter(
      (r) => r !== key
    );

    // If the user's primary role matches, fall back to member
    let role = user.role;
    if (role === key) {
      role = "member";
    }

    user.assignedRoles = assignedRoles;
    user.role = role;
    await user.save();

    res.json({ success: true });
  } catch (error) {
    console.error("Remove user from role error:", error);
    res.status(500).json({ error: "Failed to remove user from role" });
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

// ── Content Library: Get Single Drill (with real analytics) ──
function formatDuration(sec) {
  sec = Math.round(sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

router.get("/drills/:id", adminAuth, async (req, res) => {
  try {
    const drill = await Drill.findById(req.params.id);
    if (!drill) {
      return res.status(404).json({ error: "Drill not found" });
    }

    const completions = await User.countDocuments({
      completedDrills: drill._id,
    });

    const totalViews = drill.views || 0;
    const completionRate =
      totalViews > 0
        ? Math.min(100, Math.round((completions / totalViews) * 100))
        : drill.completionRate || 0;

    const avgWatchSec =
      totalViews > 0 ? (drill.avgWatchSec || 0) / totalViews : 0;
    const avgWatchTime =
      totalViews > 0 ? formatDuration(avgWatchSec) : drill.avgWatchTime || "0 min";

    const viewsHistory = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const entry = (drill.viewsHistory || []).find(
        (vh) => vh.date && new Date(vh.date).getTime() === d.getTime()
      );
      viewsHistory.push({
        date: d.toISOString().slice(0, 10),
        count: entry ? entry.count || 0 : 0,
      });
    }

    res.json({
      drill: {
        ...drill.toObject(),
        completions,
        completionRate,
        avgWatchTime,
        viewsHistory,
      },
    });
  } catch (error) {
    console.error("Get drill error:", error);
    res.status(500).json({ error: "Failed to fetch drill" });
  }
});

// ── Content Library: Create Drill ──
router.post("/drills", adminAuth, requirePermission("upload_content"), upload.fields([
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
      const p = req.files.thumbnail[0].path || req.files.thumbnail[0].url || req.files.thumbnail[0].secure_url;
      if (typeof p === "string" && (p.includes("/uploads/") || p.includes("\\uploads\\"))) {
        // convert absolute path to server-relative URL
        const idx = p.indexOf("/uploads/") >= 0 ? p.indexOf("/uploads/") : p.indexOf("\\uploads\\");
        const rel = idx >= 0 ? p.slice(idx).replace(/\\\\/g, "/") : p;
        data.imageUrl = rel;
      } else {
        data.imageUrl = p;
      }
    }
    if (req.files?.video?.[0]) {
      const p = req.files.video[0].path || req.files.video[0].url || req.files.video[0].secure_url;
      if (typeof p === "string" && (p.includes("/uploads/") || p.includes("\\uploads\\"))) {
        const idx = p.indexOf("/uploads/") >= 0 ? p.indexOf("/uploads/") : p.indexOf("\\uploads\\");
        const rel = idx >= 0 ? p.slice(idx).replace(/\\\\/g, "/") : p;
        data.videoUrl = rel;
      } else {
        data.videoUrl = p;
      }
    }
    const drill = await Drill.create(data);
    res.status(201).json({ drill });
  } catch (error) {
    console.error("Create drill error:", error);
    if (error && error.name === "ValidationError") {
      const messages = Object.values(error.errors || {}).map((e) => e.message);
      return res.status(400).json({ error: "Validation failed", details: messages });
    }
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

router.put("/drills/:id", adminAuth, requirePermission("edit_content"), upload.fields([
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
router.delete("/drills/:id", adminAuth, requirePermission("edit_content"), async (req, res) => {
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

// ── Coaches: Get by name (with stats + published drills) ──
router.get("/coaches/:name", adminAuth, async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "Coach name is required" });
    }

    const allDrills = await Drill.find({
      coach: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") },
    }).sort({ createdAt: -1 });

    const published = allDrills.filter((d) => d.status === "published");

    const totalViews = allDrills.reduce((s, d) => s + (d.views || 0), 0);
    const completionRates = allDrills
      .map((d) => d.completionRate || 0)
      .filter((v) => v > 0);
    const avgCompletion = completionRates.length
      ? Math.round(
          (completionRates.reduce((a, b) => a + b, 0) / completionRates.length) * 100
        ) / 100
      : 0;

    const followers = await Follow.countDocuments({
      coach: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") },
    });

    // Match a coach user account (role = "coach") so we can surface a real avatar if one exists
    const stripped = name.replace(/^coach\s+/i, "");
    const nameParts = stripped.split(/\s+/).filter(Boolean);
    let user = null;
    if (nameParts.length >= 1) {
      const conditions = [
        { firstName: { $regex: new RegExp(`^${escapeRegex(nameParts[0])}$`, "i") } },
      ];
      if (nameParts.length > 1) {
        conditions.push({
          lastName: {
            $regex: new RegExp(`^${escapeRegex(nameParts[nameParts.length - 1])}$`, "i"),
          },
        });
      }
      user = await User.findOne({ role: "coach", $or: conditions });
    }

    res.json({
      coach: {
        name,
        description: "",
        imageUrl: user?.avatarUrl || "",
        role: user ? user.role : null,
      },
      stats: {
        drills: published.length,
        followers,
        avgCompletion,
        totalViews,
      },
      drills: published,
    });
  } catch (error) {
    console.error("Get coach error:", error);
    res.status(500).json({ error: "Failed to fetch coach" });
  }
});

// ── Coaches: Delete (drills, follows, program refs, user account, pro record) ──
router.delete("/coaches/:name", adminAuth, async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "Coach name is required" });
    }

    const coachMatch = {
      coach: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") },
    };

    const drills = await Drill.find(coachMatch);
    const drillIds = drills.map((d) => d._id);

    // Delete drill media from Cloudinary
    for (const d of drills) {
      if (d.imageUrl) deleteCloudinaryFile(d.imageUrl);
      if (d.videoUrl) deleteCloudinaryFile(d.videoUrl);
    }

    // Delete the coach's drills
    if (drillIds.length > 0) {
      await Drill.deleteMany({ _id: { $in: drillIds } });

      // Remove the deleted drills from every program
      await Program.updateMany(
        { "drills.drill": { $in: drillIds } },
        { $pull: { drills: { drill: { $in: drillIds } } } }
      );
      await Program.updateMany(
        { removedDrills: { $in: drillIds } },
        { $pull: { removedDrills: { $in: drillIds } } }
      );

      // Remove the deleted drills from users' completion history
      await User.updateMany(
        { completedDrills: { $in: drillIds } },
        { $pull: { completedDrills: { $in: drillIds } } }
      );
    }

    // Delete all follows for this coach
    await Follow.deleteMany(coachMatch);

    // Delete a matching pro athlete record (same name)
    const stripped = name.replace(/^coach\s+/i, "");
    await Pro.deleteMany({
      name: { $regex: new RegExp(`^${escapeRegex(stripped)}$`, "i") },
    });

    // Delete the matching coach user account (role = "coach")
    const nameParts = stripped.split(/\s+/).filter(Boolean);
    if (nameParts.length >= 1) {
      const conditions = [
        { firstName: { $regex: new RegExp(`^${escapeRegex(nameParts[0])}$`, "i") } },
      ];
      if (nameParts.length > 1) {
        conditions.push({
          lastName: {
            $regex: new RegExp(`^${escapeRegex(nameParts[nameParts.length - 1])}$`, "i"),
          },
        });
      }
      await User.deleteMany({ role: "coach", $or: conditions });
    }

    res.json({ success: true, deletedDrills: drillIds.length });
  } catch (error) {
    console.error("Delete coach error:", error);
    res.status(500).json({ error: "Failed to delete coach" });
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

    // Real enrolled users (from the app's enrolledPrograms field)
    const enrolledUsers = await User.find({ enrolledPrograms: program._id })
      .select("firstName lastName email")
      .sort({ createdAt: -1 })
      .limit(30);

    // Real per-drill completion counts from users' completedDrills
    const drillIds = (program.drills || [])
      .filter((d) => d.drill)
      .map((d) => String(d.drill._id || d.drill));
    const completionCounts = {};
    if (drillIds.length) {
      const agg = await User.aggregate([
        { $match: { completedDrills: { $in: drillIds } } },
        { $unwind: "$completedDrills" },
        { $match: { completedDrills: { $in: drillIds } } },
        { $group: { _id: "$completedDrills", count: { $sum: 1 } } },
      ]);
      agg.forEach((r) => {
        completionCounts[String(r._id)] = r.count;
      });
    }
    const totalUsers = await User.countDocuments();

    const plain = program.toObject();
    plain.drills = visibleProgramDrills(program).map((d) => {
      const doc = d.drill;
      return {
        drill: doc
          ? {
              _id: doc._id,
              title: doc.title || doc.name || "",
              imageUrl: doc.imageUrl || "",
              coach: doc.coach || "",
              category: doc.category || "",
              completions: completionCounts[String(doc._id)] || 0,
              completionRate: totalUsers
                ? Math.round(
                    ((completionCounts[String(doc._id)] || 0) / totalUsers) * 100
                  )
                : 0,
            }
          : null,
        order: d.order,
      };
    });
    plain.enrolled = enrolledUsers.length;
    plain.totalUsers = totalUsers;
    plain.enrolledUsers = enrolledUsers.map((u) => ({
      _id: u._id,
      name:
        [u.firstName, u.lastName].filter(Boolean).join(" ") ||
        u.email ||
        "User",
      email: u.email,
    }));

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

    // Return immediately with a pending status; transcription runs in the
    // background and the panel polls until it finishes.
    podcast.transcriptStatus = "pending";
    podcast.transcript = [];
    await podcast.save();
    res.json({ podcast });
    runTranscription(podcast).catch(() => {});
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

    const mediaReplaced = Boolean(req.files?.media?.[0]);

    const podcast = await Podcast.findByIdAndUpdate(req.params.id, updates, {
      new: true,
    });
    res.json({ podcast });

    // Re-transcribe when the media file is replaced
    if (mediaReplaced && podcast.mediaUrl) {
      podcast.transcriptStatus = "pending";
      await podcast.save();
      runTranscription(podcast).catch(() => {});
    }
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

router.post("/notifications", adminAuth, requirePermission("send_notifications"), async (req, res) => {
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
      let when;
      // Detect naive datetime-local input "YYYY-MM-DDTHH:mm" (no timezone)
      if (typeof scheduledAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(scheduledAt)) {
        // Prefer client-provided timezone offset in minutes (header: X-Client-Timezone-Offset)
        const hdr = req.get("X-Client-Timezone-Offset") || req.get("x-client-timezone-offset");
        const offsetMin = hdr ? parseInt(hdr, 10) : NaN;
        // Parse components in a timezone-agnostic way
        const m = scheduledAt.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
        if (!m) {
          return res.status(400).json({ error: "Invalid scheduledAt" });
        }
        const y = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10);
        const d = parseInt(m[3], 10);
        const hh = parseInt(m[4], 10);
        const mm = parseInt(m[5], 10);
        // Create UTC ms for the local components, then adjust by client's offset
        // UTC ms = Date.UTC(y, mo-1, d, hh, mm) - (offsetMin * 60000)
        const utcMillis = Date.UTC(y, mo - 1, d, hh, mm) - (isNaN(offsetMin) ? 0 : offsetMin * 60000);
        when = new Date(utcMillis);
      } else {
        when = new Date(scheduledAt);
      }
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

router.post("/notifications/:id/send", adminAuth, requirePermission("send_notifications"), async (req, res) => {
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

// ── Settings (branding + notification prefs) ──
router.get("/settings", adminAuth, requirePermission("access_settings"), async (req, res) => {
  try {
    const doc = await getSettingsDoc();
    res.json({
      branding: {
        appName: doc.branding?.appName || DEFAULT_BRANDING.appName,
        tagline: doc.branding?.tagline || DEFAULT_BRANDING.tagline,
        primaryColor: doc.branding?.primaryColor || DEFAULT_BRANDING.primaryColor,
        accentColor: doc.branding?.accentColor || DEFAULT_BRANDING.accentColor,
        displayFont: doc.branding?.displayFont || DEFAULT_BRANDING.displayFont,
        bodyFont: doc.branding?.bodyFont || DEFAULT_BRANDING.bodyFont,
        palette:
          doc.branding?.palette && doc.branding.palette.length
            ? doc.branding.palette
            : DEFAULT_BRANDING.palette,
      },
      notifications: {
        ...DEFAULT_NOTIFICATIONS,
        ...(doc.notifications || {}),
      },
      integrations: {
        stripe: Boolean(env.stripeSecretKey),
        sendgrid: Boolean(env.sendgridApiKey),
        clerk: Boolean(env.clerkSecretKey),
        cloudinary: Boolean(env.cloudinaryApiKey && env.cloudinaryApiSecret && env.cloudinaryCloudName),
        openai: Boolean(env.openaiApiKey),
      },
      storage: {
        configured: hasCloudinary,
        usedBytes: null,
        quotaBytes: null,
      },
      payments: {
        currency: doc.payments?.currency || "USD",
      },
    });
  } catch (error) {
    console.error("Get settings error:", error);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

// ── Settings: Cloudinary storage usage (live) ──
router.get(
  "/settings/storage",
  adminAuth,
  requirePermission("access_settings"),
  async (_req, res) => {
    try {
      if (!hasCloudinary) {
        return res.json({ configured: false, storage: null });
      }
      const usage = await cloudinary.api.usage();
      let byType = null;
      try {
        const [images, videos, raws] = await Promise.all(
          ["image", "video", "raw"].map((rt) =>
            cloudinary.search.expression(`resource_type:${rt}`).max_results(0).execute()
          )
        );
        byType = {
          images: images?.total_count || 0,
          videos: videos?.total_count || 0,
          raws: raws?.total_count || 0,
        };
      } catch (_e) {
        byType = null;
      }
      res.json({
        configured: true,
        cloudName: env.cloudinaryCloudName,
        plan: usage?.plan || null,
        storage: {
          usedBytes: usage?.storage?.usage || 0,
          bandwidthBytes: usage?.bandwidth?.usage || 0,
          creditsUsed: usage?.credits?.usage || 0,
          creditsLimit: usage?.credits?.limit || 0,
          creditsPercent: usage?.credits?.used_percent || 0,
          objects: usage?.objects?.usage || usage?.resources || 0,
          byType,
          updatedAt: usage?.last_updated || null,
        },
      });
    } catch (error) {
      console.error("Cloudinary usage error:", error);
      res.status(500).json({
        configured: true,
        error: error?.message || "Failed to fetch Cloudinary usage",
      });
    }
  }
);

router.put("/settings", adminAuth, requirePermission("access_settings"), async (req, res) => {
  try {
    const { branding, notifications } = req.body || {};

    const doc = await getSettingsDoc();

    if (branding && typeof branding === "object") {
      const clean = {
        appName:
          typeof branding.appName === "string" && branding.appName.trim()
            ? branding.appName.trim()
            : doc.branding?.appName || DEFAULT_BRANDING.appName,
        tagline:
          typeof branding.tagline === "string"
            ? branding.tagline.trim()
            : doc.branding?.tagline || DEFAULT_BRANDING.tagline,
        primaryColor:
          typeof branding.primaryColor === "string" && branding.primaryColor.trim()
            ? branding.primaryColor.trim()
            : doc.branding?.primaryColor || DEFAULT_BRANDING.primaryColor,
        accentColor:
          typeof branding.accentColor === "string" && branding.accentColor.trim()
            ? branding.accentColor.trim()
            : doc.branding?.accentColor || DEFAULT_BRANDING.accentColor,
        displayFont:
          typeof branding.displayFont === "string" && branding.displayFont.trim()
            ? branding.displayFont.trim()
            : doc.branding?.displayFont || DEFAULT_BRANDING.displayFont,
        bodyFont:
          typeof branding.bodyFont === "string" && branding.bodyFont.trim()
            ? branding.bodyFont.trim()
            : doc.branding?.bodyFont || DEFAULT_BRANDING.bodyFont,
      };
      if (Array.isArray(branding.palette) && branding.palette.length) {
        clean.palette = branding.palette
          .filter(
            (c) =>
              c &&
              typeof c === "object" &&
              typeof c.name === "string" &&
              typeof c.hex === "string"
          )
          .map((c) => ({ name: c.name, hex: c.hex }));
      }
      doc.branding = { ...(doc.branding || {}), ...clean };
    }

    if (notifications && typeof notifications === "object") {
      const clean = {};
      for (const key of Object.keys(DEFAULT_NOTIFICATIONS)) {
        if (typeof notifications[key] === "boolean") {
          clean[key] = notifications[key];
        }
      }
      doc.notifications = { ...(doc.notifications || {}), ...clean };
    }

    if (req.body.payments && typeof req.body.payments === "object") {
      const currency = typeof req.body.payments.currency === "string" && req.body.payments.currency.trim() ? req.body.payments.currency.trim() : doc.payments?.currency || "USD";
      doc.payments = { ...(doc.payments || {}), currency };
    }

    await doc.save();

    res.json({
      branding: {
        appName: doc.branding.appName,
        tagline: doc.branding.tagline,
        primaryColor: doc.branding.primaryColor,
        accentColor: doc.branding.accentColor,
        displayFont: doc.branding.displayFont,
        bodyFont: doc.branding.bodyFont,
        palette: doc.branding.palette || [],
      },
      notifications: { ...DEFAULT_NOTIFICATIONS, ...doc.notifications },
    });
  } catch (error) {
    console.error("Update settings error:", error);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

// Upload a branding asset (logo or icon) and persist URL in settings
router.post(
  "/settings/upload",
  adminAuth,
  upload.single("file"),
  async (req, res) => {
    try {
      const type = String(req.body.type || "").toLowerCase();
      if (!req.file || !req.file.path) {
        return res.status(400).json({ error: "No file uploaded" });
      }
      const url = req.file.path;
      const doc = await getSettingsDoc();
      doc.branding = doc.branding || {};
      if (type === "logo") {
        doc.branding.logoUrl = url;
      } else if (type === "icon") {
        doc.branding.iconUrl = url;
      } else {
        return res.status(400).json({ error: "Invalid type" });
      }
      await doc.save();
      res.json({ url, branding: doc.branding });
    } catch (error) {
      console.error("Upload branding asset failed:", error);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

module.exports = router;
