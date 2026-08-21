const Transaction = require("../models/Transaction");

const STATUS_PRIORITY = { failed: 1, success: 2, refunded: 3, cancelled: 1 };

async function upsertTransaction(payload) {
  const {
    invoiceId,
    chargeId,
    subscriptionId,
    status,
    amount,
    discountCode,
    paymentMethod,
  } = payload;

  console.log("[upsertTransaction] called:", JSON.stringify({ invoiceId, chargeId, subscriptionId, status, amount, paymentMethod, plan: payload.plan, userId: payload.userId }));

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
    console.log("[upsertTransaction] found existing tx:", tx._id, "status:", tx.status);
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
    if (discountCode && !tx.discountCode) {
      tx.discountCode = discountCode;
      changed = true;
    }
    if (paymentMethod && !tx.paymentMethod) {
      tx.paymentMethod = paymentMethod;
      changed = true;
    }
    if (changed) await tx.save();
    return tx;
  }

  try {
    const doc = await Transaction.create({
      userId: payload.userId || null,
      userEmail: payload.userEmail || "",
      userName: payload.userName || "",
      plan: payload.plan || "",
      amount: amount || 0,
      status,
      stripeInvoiceId: invoiceId || "",
      stripeChargeId: chargeId || "",
      stripeSubscriptionId: subscriptionId || "",
      discountCode: discountCode || "",
      paymentMethod: paymentMethod || "",
      date: payload.date || new Date(),
    });
    console.log("[upsertTransaction] CREATED tx:", doc._id, "invoice:", invoiceId);
    return doc;
  } catch (error) {
    console.error("[upsertTransaction] CREATE FAILED:", error.message, "code:", error.code, "invoice:", invoiceId, "charge:", chargeId);
    if (error.code === 11000) {
      if (invoiceId) {
        const existing = await Transaction.findOne({ stripeInvoiceId: invoiceId });
        if (existing) return existing;
      }
      if (chargeId) {
        const existing = await Transaction.findOne({ stripeChargeId: chargeId });
        if (existing) return existing;
      }
      console.error("[upsertTransaction] 11000 dedup fallback failed");
      return null;
    }
    return null;
  }
}

module.exports = { upsertTransaction };
