const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    channel: {
      type: String,
      enum: ["push", "inapp", "email"],
      required: true,
    },
    audience: {
      type: String,
      enum: ["all", "free", "monthly", "annual", "premium"],
      required: true,
    },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["draft", "scheduled", "sent", "failed"],
      default: "draft",
    },
    scheduledAt: { type: Date },
    sentAt: { type: Date },
    reach: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    error: { type: String },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

notificationSchema.index({ status: 1, scheduledAt: 1 });
notificationSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
