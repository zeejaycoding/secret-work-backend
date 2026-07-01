const { Router } = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { User } = require("../models/User");
const { env } = require("../config/env");
const {
  sendPasswordResetEmail,
} = require("../services/email");

const router = Router();
const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_RESET_ATTEMPTS = 5;

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createOtpCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function generateToken(user) {
  return jwt.sign(
    { userId: user._id.toString(), email: user.email },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
}

router.post("/register", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.trim()) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }

    const user = await User.create({ email: normalizedEmail });

    const token = generateToken(user);

    console.log(`User registered: ${user.email}`);
    res.status(201).json({ token, user });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !email.trim()) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (!user.password) {
      res.status(401).json({
        error: "No password set. Please use 'Forgot Password' to set one.",
      });
      return;
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const token = generateToken(user);

    console.log(`User logged in: ${user.email}`);
    res.json({ token, user });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.trim()) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    // Avoid account enumeration by always returning a success response.
    if (!user) {
      res.json({
        success: true,
        message: "If that email exists, a reset code has been sent",
      });
      return;
    }

    const otpCode = createOtpCode();
    user.passwordResetCodeHash = hashValue(otpCode);
    user.passwordResetCodeExpiresAt = new Date(Date.now() + RESET_CODE_TTL_MS);
    user.passwordResetAttempts = 0;
    user.passwordResetTokenHash = undefined;
    user.passwordResetTokenExpiresAt = undefined;
    await user.save();

    try {
      await sendPasswordResetEmail({ toEmail: user.email, otpCode });
    } catch (emailError) {
      console.error("Failed to send reset verification code:", emailError.message);
    }

    res.json({
      success: true,
      message: "If that email exists, a reset code has been sent",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ error: "Failed to process forgot password request" });
  }
});

router.post("/verify-reset-otp", async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !email.trim() || !code || !code.trim()) {
      res.status(400).json({ error: "Email and code are required" });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user || !user.passwordResetCodeHash || !user.passwordResetCodeExpiresAt) {
      res.status(400).json({ error: "Invalid or expired code" });
      return;
    }

    if (user.passwordResetCodeExpiresAt.getTime() < Date.now()) {
      res.status(400).json({ error: "Code expired. Please request a new one" });
      return;
    }

    const providedHash = hashValue(code.trim());
    const approved = providedHash === user.passwordResetCodeHash;

    if (!approved) {
      user.passwordResetAttempts = (user.passwordResetAttempts || 0) + 1;

      if (user.passwordResetAttempts >= MAX_RESET_ATTEMPTS) {
        user.passwordResetCodeHash = undefined;
        user.passwordResetCodeExpiresAt = undefined;
        await user.save();
        res.status(400).json({ error: "Too many attempts. Request a new code" });
        return;
      }

      await user.save();
      res.status(400).json({ error: "Invalid code" });
      return;
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    user.passwordResetTokenHash = hashValue(resetToken);
    user.passwordResetTokenExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    user.passwordResetAttempts = 0;
    await user.save();

    res.json({
      success: true,
      resetToken,
      message: "Code verified",
    });
  } catch (error) {
    console.error("Verify reset OTP error:", error);
    res.status(500).json({ error: "Failed to verify code" });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const { email, resetToken, newPassword } = req.body;

    if (!email || !email.trim() || !resetToken || !newPassword) {
      res
        .status(400)
        .json({ error: "Email, reset token, and new password are required" });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (
      !user ||
      !user.passwordResetTokenHash ||
      !user.passwordResetTokenExpiresAt ||
      user.passwordResetTokenExpiresAt.getTime() < Date.now()
    ) {
      res.status(400).json({ error: "Reset session expired. Verify OTP again" });
      return;
    }

    const tokenHash = hashValue(resetToken);
    if (tokenHash !== user.passwordResetTokenHash) {
      res.status(400).json({ error: "Invalid reset token" });
      return;
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.passwordResetCodeHash = undefined;
    user.passwordResetCodeExpiresAt = undefined;
    user.passwordResetAttempts = 0;
    user.passwordResetTokenHash = undefined;
    user.passwordResetTokenExpiresAt = undefined;
    await user.save();

    res.json({ success: true, message: "Password reset successful" });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

module.exports = router;
