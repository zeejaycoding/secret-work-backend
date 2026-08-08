const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    userEmail: { type: String, default: "" },
    userName: { type: String, default: "" },
    plan: { type: String, enum: ["monthly", "annual", ""], default: "" },
    amount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["success", "failed", "refunded", "cancelled"],
      default: "success",
    },
    stripeInvoiceId: { type: String, default: "" },
    stripeChargeId: { type: String, default: "" },
    stripeSubscriptionId: { type: String, default: "" },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

transactionSchema.index({ stripeInvoiceId: 1 }, { unique: true, sparse: true });
transactionSchema.index({ stripeChargeId: 1 });
transactionSchema.index({ status: 1 });
transactionSchema.index({ date: -1 });

module.exports = mongoose.model("Transaction", transactionSchema);
