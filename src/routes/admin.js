const { Router } = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { adminAuth } = require("../middleware/adminAuth");
const { upload, deleteCloudinaryFile } = require("../middleware/upload");
const { User } = require("../models/User");
const Drill = require("../models/Drill");
const Category = require("../models/Category");
const Program = require("../models/Program");
const Pro = require("../models/Pro");
const Podcast = require("../models/Podcast");

const router = Router();

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
    const { name, level, category, duration } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Program name is required" });
    }
    const cat = category || "";
    const allDrills = await Drill.find({}).sort({ createdAt: 1 });
    const drills = allDrills.map((d, i) => ({ drill: d._id, order: i + 1 }));
    const program = await Program.create({
      name: name.trim(),
      level: level || "Beginner",
      category: cat,
      duration: duration || "4 weeks",
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
  } catch (error) {
    console.error("Create podcast error:", error);
    res.status(500).json({ error: "Failed to create podcast" });
  }
});

// ── Podcasts: Update ──
const PODCAST_UPDATABLE_FIELDS = [
  "title",
  "host",
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

module.exports = router;
