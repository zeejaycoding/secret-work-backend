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
    authProvider: {
      type: String,
      enum: ["local", "google", "facebook", "apple"],
      default: "local",
    },
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
    billingInterval: {
      type: String,
      enum: ["monthly", "annual"],
    },
    status: {
      type: String,
      enum: ["active", "suspended"],
      default: "active",
    },
    role: {
      type: String,
      enum: ["member", "coach"],
      default: "member",
    },
    completedDrills: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Drill",
      },
    ],
    watchTimeSec: { type: Number, default: 0 },
    pushToken: { type: String, default: "" },
    notificationPrefs: {
      push: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
      inApp: { type: Boolean, default: true },
    },
    enrolledPrograms: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Program",
      },
    ],
    stripeCustomerId: { type: String },
    stripeSubscriptionId: { type: String },
    passwordResetCodeHash: { type: String },
    passwordResetCodeExpiresAt: { type: Date },
    passwordResetAttempts: { type: Number, default: 0 },
    passwordResetTokenHash: { type: String },
    passwordResetTokenExpiresAt: { type: Date },
    preferences: {
      darkMode: { type: Boolean, default: true },
      language: { type: String, default: "English" },
      autoplayVideos: { type: Boolean, default: true },
      dataSaver: { type: Boolean, default: false },
      videoQuality: { type: String, default: "Auto Play" },
      notifications: {
        push: { type: Boolean, default: true },
        email: { type: Boolean, default: true },
        inApp: { type: Boolean, default: true },
      },
    },
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);

module.exports = { User };
