const { Router } = require("express");
const bcrypt = require("bcryptjs");
const { User } = require("../models/User");
const { authMiddleware } = require("../middleware/auth");

const router = Router();

router.use(authMiddleware);

router.get("/me", async (req, res) => {
  try {
    const user = await User.findById(req.auth.userId);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ user });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Failed to get user" });
  }
});

router.patch("/me", async (req, res) => {
  try {
    const allowedFields = [
      "firstName",
      "lastName",
      "avatarUrl",
      "onboarded",
      "onboardingStep",
      "height",
      "heightUnit",
      "experienceLevel",
      "trainingGoal",
      "age",
      "gender",
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    const user = await User.findByIdAndUpdate(
      req.auth.userId,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ user });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({ error: "Failed to update user" });
  }
});

router.post("/onboarding/complete", async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.auth.userId,
      { $set: { onboarded: true } },
      { new: true }
    );

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ user });
  } catch (error) {
    console.error("Complete onboarding error:", error);
    res.status(500).json({ error: "Failed to complete onboarding" });
  }
});

router.delete("/me", async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.auth.userId);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    console.log(`User deleted: ${user.email}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

router.post("/password", async (req, res) => {
  try {
    const { password } = req.body;

    if (!password || password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters" });
      return;
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = await User.findByIdAndUpdate(
      req.auth.userId,
      { $set: { password: hashed } },
      { new: true }
    );

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    console.log(`Password set for user: ${user.email}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Set password error:", error);
    res.status(500).json({ error: "Failed to set password" });
  }
});

router.post("/password/change", async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      res.status(400).json({ error: "Old password and new password are required" });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ error: "New password must be at least 8 characters" });
      return;
    }

    const user = await User.findById(req.auth.userId);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (!user.password) {
      res.status(400).json({ error: "No password set. Use 'Forgot Password' to set one." });
      return;
    }

    const valid = await bcrypt.compare(oldPassword, user.password);
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    console.log(`Password changed for user: ${user.email}`);
    res.json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ error: "Failed to change password" });
  }
});

module.exports = router;
