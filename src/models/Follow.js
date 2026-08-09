const mongoose = require("mongoose");

const followSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    coach: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

followSchema.index({ user: 1, coach: 1 }, { unique: true });

module.exports = mongoose.model("Follow", followSchema);
