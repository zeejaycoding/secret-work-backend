const { Router } = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { User } = require("../models/User");
const { env } = require("../config/env");

const router = Router();

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

module.exports = router;
