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

const router = Router();

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
      filter.category = category;
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
    const { search, tier } = req.query;
    const filter = {};

    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }
    if (tier && tier !== "All") {
      filter.subscriptionTier = tier;
    }

    const users = await User.find(filter)
      .sort({ createdAt: -1 })
      .select("-password -passwordResetCodeHash -passwordResetTokenHash");

    res.json({ users });
  } catch (error) {
    console.error("List users error:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// ── Categories: List ──
router.get("/categories", adminAuth, async (req, res) => {
  try {
    const categories = await Category.find().sort({ name: 1 });
    const drillCounts = await Drill.aggregate([
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]);
    const countMap = {};
    drillCounts.forEach((d) => { countMap[d._id] = d.count; });
    const result = categories.map((c) => ({
      _id: c._id,
      name: c.name,
      description: c.description,
      drillCount: countMap[c.name] || 0,
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
    // Backfill programs that have a category but no drills
    for (const p of programs) {
      if (p.category && (!p.drills || p.drills.length === 0)) {
        const matchingDrills = await Drill.find({ category: { $regex: `^${p.category}$`, $options: "i" } }).sort({ createdAt: 1 });
        if (matchingDrills.length > 0) {
          p.drills = matchingDrills.map((d, i) => ({ drill: d._id, order: i + 1 }));
          await p.save();
        }
      }
    }
    // Refetch with populated drills after backfill
    programs = await Program.find(filter)
      .populate("drills.drill")
      .sort({ createdAt: -1 });
    res.json({ programs });
  } catch (error) {
    console.error("List programs error:", error);
    res.status(500).json({ error: "Failed to fetch programs" });
  }
});

// ── Programs: Get Single ──
router.get("/programs/:id", adminAuth, async (req, res) => {
  try {
    const program = await Program.findById(req.params.id).populate("drills.drill");
    if (!program) return res.status(404).json({ error: "Program not found" });
    res.json({ program });
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
    let drills = [];
    if (cat) {
      const matchingDrills = await Drill.find({ category: cat }).sort({ createdAt: 1 });
      drills = matchingDrills.map((d, i) => ({ drill: d._id, order: i + 1 }));
    }
    const program = await Program.create({
      name: name.trim(),
      level: level || "Beginner",
      category: cat,
      duration: duration || "4 weeks",
      drills,
    });
    const populated = await Program.findById(program._id).populate("drills.drill");
    res.status(201).json({ program: populated });
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
    res.json({ program });
  } catch (error) {
    console.error("Update program error:", error);
    res.status(500).json({ error: "Failed to update program" });
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

module.exports = router;
