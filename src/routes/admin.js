const { Router } = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { adminAuth } = require("../middleware/adminAuth");
const { User } = require("../models/User");
const Drill = require("../models/Drill");

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
router.post("/drills", adminAuth, async (req, res) => {
  try {
    const drill = await Drill.create(req.body);
    res.status(201).json({ drill });
  } catch (error) {
    console.error("Create drill error:", error);
    res.status(500).json({ error: "Failed to create drill" });
  }
});

// ── Content Library: Update Drill ──
router.put("/drills/:id", adminAuth, async (req, res) => {
  try {
    const drill = await Drill.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!drill) {
      return res.status(404).json({ error: "Drill not found" });
    }
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

module.exports = router;
