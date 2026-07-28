const mongoose = require("mongoose");

const drillSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    coach: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ["Dribbling", "Shooting", "Defence", "Passing", "Fitness"],
      default: "Dribbling",
    },
    status: {
      type: String,
      enum: ["published", "draft", "archived"],
      default: "draft",
    },
    imageUrl: { type: String, default: "" },
    duration: { type: String, default: "0 min" },
    views: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    completionRate: { type: Number, default: 0 },
    avgWatchTime: { type: String, default: "0 min" },
    viewsHistory: [
      {
        date: { type: Date },
        count: { type: Number, default: 0 },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Drill", drillSchema);
