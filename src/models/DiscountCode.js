const mongoose = require("mongoose");

const discountCodeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    discountType: {
      type: String,
      enum: ["fixed_amount"],
      default: "fixed_amount",
    },
    discountAmount: {
      type: Number,
      default: 5,
    },
    applicablePlan: {
      type: String,
      enum: ["annual", "monthly", "all"],
      default: "annual",
    },
    active: {
      type: Boolean,
      default: true,
    },
    usageLimit: {
      type: Number,
      default: null,
    },
    usedCount: {
      type: Number,
      default: 0,
    },
    usedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

discountCodeSchema.index({ code: 1 }, { unique: true });

module.exports = mongoose.model("DiscountCode", discountCodeSchema);
