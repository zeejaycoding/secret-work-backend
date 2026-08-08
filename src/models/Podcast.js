const mongoose = require("mongoose");

const podcastSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    host: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ["Video", "Audio"],
      default: "Audio",
    },
    date: { type: String, default: "" },
    plays: { type: Number, default: 0 },
    completion: { type: Number, default: 0 },
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
  },
  { timestamps: true }
);

module.exports = mongoose.model("Podcast", podcastSchema);
