const mongoose = require("mongoose");

const podcastSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    host: { type: String, required: true, trim: true },
    guest: { type: String, default: "", trim: true },
    type: {
      type: String,
      enum: ["Video", "Audio"],
      default: "Audio",
    },
    date: { type: String, default: "" },
    plays: { type: Number, default: 0 },
    watchTimeSec: { type: Number, default: 0 },
    completion: { type: Number, default: 0 },
    completionCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["Published", "Scheduled"],
      default: "Scheduled",
    },
    duration: { type: String, default: "0 min" },
    description: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    mediaUrl: { type: String, default: "" },
    mediaType: { type: String, default: "" },
    mediaName: { type: String, default: "" },
    scheduleDate: { type: Date, default: null },
    transcript: { type: [new mongoose.Schema({ time: String, text: String }, { _id: false })], default: [] },
    transcriptStatus: {
      type: String,
      enum: ["none", "pending", "done", "failed"],
      default: "none",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Podcast", podcastSchema);
