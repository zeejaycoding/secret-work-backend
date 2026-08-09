const mongoose = require("mongoose");

const benefitSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    enabled: { type: Boolean, default: true },
  },
  { _id: false }
);

const planSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      enum: ["free", "monthly", "annual"],
      required: true,
      unique: true,
    },
    label: { type: String, default: "" },
    price: {
      amount: { type: Number, default: 0 },
      interval: { type: String, default: "" },
    },
    benefits: [benefitSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Plan", planSchema);
