const mongoose = require("mongoose");

const programSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    coach: { type: String, trim: true, default: "" },
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: "Pro" },
    description: { type: String, default: "" },
    level: {
      type: String,
      enum: ["Beginner", "Intermediate", "Advanced"],
      default: "Beginner",
    },
    category: { type: String, default: "" },
    duration: { type: String, default: "4 weeks" },
    status: {
      type: String,
      enum: ["published", "draft", "archived"],
      default: "draft",
    },
    drills: [
      {
        drill: { type: mongoose.Schema.Types.ObjectId, ref: "Drill" },
        order: { type: Number },
      },
    ],
    removedDrills: [
      { type: mongoose.Schema.Types.ObjectId, ref: "Drill" },
    ],
    imageUrl: { type: String, default: "" },
    enrolled: { type: Number, default: 0 },
    completionRate: { type: Number, default: 0 },
    reviews: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Program", programSchema);