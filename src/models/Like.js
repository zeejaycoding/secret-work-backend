const mongoose = require("mongoose");

const likeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    drill: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Drill",
      required: true,
    },
  },
  { timestamps: true }
);

likeSchema.index({ user: 1, drill: 1 }, { unique: true });

module.exports = mongoose.model("Like", likeSchema);
