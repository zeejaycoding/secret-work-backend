const mongoose = require("mongoose");

const stripeEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

stripeEventSchema.index({ eventId: 1 }, { unique: true });

module.exports = mongoose.model("StripeEvent", stripeEventSchema);
