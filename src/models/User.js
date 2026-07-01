const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    avatarUrl: { type: String },
    age: { type: Number },
    gender: { type: String, trim: true },
    onboarded: { type: Boolean, default: false },
    onboardingStep: { type: Number, default: 0 },
    height: { type: Number },
    heightUnit: { type: String, enum: ["cm", "ft"] },
    experienceLevel: {
      type: String,
      enum: ["beginner", "intermediate", "advanced"],
    },
    trainingGoal: { type: String },
    subscriptionTier: {
      type: String,
      enum: ["free", "premium", "pro"],
      default: "free",
    },
    subscriptionExpiry: { type: Date },
    passwordResetCodeHash: { type: String },
    passwordResetCodeExpiresAt: { type: Date },
    passwordResetAttempts: { type: Number, default: 0 },
    passwordResetTokenHash: { type: String },
    passwordResetTokenExpiresAt: { type: Date },
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);

module.exports = { User };
