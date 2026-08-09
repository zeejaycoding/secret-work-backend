const Transaction = require("../models/Transaction");

const STATUS_PRIORITY = { failed: 1, success: 2, refunded: 3, cancelled: 1 };

async function upsertTransaction(payload) {
  const {
    invoiceId,
    chargeId,
    subscriptionId,
    status,
    amount,
  } = payload;

  let tx = null;
  if (invoiceId) tx = await Transaction.findOne({ stripeInvoiceId: invoiceId });
  if (!tx && chargeId)
    tx = await Transaction.findOne({ stripeChargeId: chargeId });
  if (!tx && subscriptionId && status === "cancelled") {
    tx = await Transaction.findOne({
      stripeSubscriptionId: subscriptionId,
      status: "cancelled",
    });
  }

  if (tx) {
    const current = STATUS_PRIORITY[tx.status] || 1;
    const next = STATUS_PRIORITY[status] || 1;
    let changed = false;
    if (next > current) {
      tx.status = status;
      if (status === "success" && amount != null) tx.amount = amount;
      changed = true;
    }
    if (payload.userEmail && tx.userEmail !== payload.userEmail) {
      tx.userEmail = payload.userEmail;
      changed = true;
    }
    if (payload.userName && tx.userName !== payload.userName) {
      tx.userName = payload.userName;
      changed = true;
    }
    if (payload.plan && tx.plan !== payload.plan) {
      tx.plan = payload.plan;
      changed = true;
    }
    if (changed) await tx.save();
    return tx;
  }

  try {
    return await Transaction.create({
      userId: payload.userId || null,
      userEmail: payload.userEmail || "",
      userName: payload.userName || "",
      plan: payload.plan || "",
      amount: amount || 0,
      status,
      stripeInvoiceId: invoiceId || "",
      stripeChargeId: chargeId || "",
      stripeSubscriptionId: subscriptionId || "",
      date: payload.date || new Date(),
    });
  } catch (error) {
    if (error.code === 11000) {
      if (invoiceId) return await Transaction.findOne({ stripeInvoiceId: invoiceId });
    }
    throw error;
  }
}

module.exports = { upsertTransaction };
