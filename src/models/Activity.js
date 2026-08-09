const mongoose = require("mongoose");

const activitySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    date: { type: String, required: true },
    kind: { type: String, default: "session" },
    count: { type: Number, default: 1 },
  },
  { timestamps: true }
);

activitySchema.index({ date: 1 });
activitySchema.index({ userId: 1, date: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model("Activity", activitySchema);
