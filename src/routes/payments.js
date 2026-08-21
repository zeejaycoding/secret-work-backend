const express = require("express");
const { Router } = require("express");
const Stripe = require("stripe");
const { User } = require("../models/User");
const Plan = require("../models/Plan");
const Transaction = require("../models/Transaction");
const DiscountCode = require("../models/DiscountCode");
const StripeEvent = require("../models/StripeEvent");
const { env } = require("../config/env");
const { authMiddleware } = require("../middleware/auth");
const { upsertTransaction } = require("../services/transactions");

const stripe = new Stripe(env.stripeSecretKey);

const PLAN_PRICES = {
  monthly: { amount: 599, interval: "month", label: "Monthly Pro" },
  annual: { amount: 6000, interval: "year", label: "Annual Pro" },
};

const MINIMUM_CHARGE_CENTS = 50;

async function getPlanConfig(key) {
  const doc = await Plan.findOne({ key });
  if (doc && doc.price && Number(doc.price.amount) > 0) {
    return {
      amount: Math.round(Number(doc.price.amount) * 100),
      interval: doc.price.interval || PLAN_PRICES[key].interval,
      label: doc.label || PLAN_PRICES[key].label,
    };
  }
  return PLAN_PRICES[key];
}

function toBillingInterval(value) {
  if (value === "year" || value === "annual") return "annual";
  if (value === "month" || value === "monthly") return "monthly";
  return undefined;
}

function getInterval(subscription) {
  const item = subscription?.items?.data?.[0];
  return (
    item?.plan?.interval ||
    item?.price?.recurring?.interval ||
    subscription?.plan?.interval ||
    null
  );
}

function getInvoiceInterval(invoice) {
  const line = invoice?.lines?.data?.[0];
  return line?.plan?.interval || line?.price?.recurring?.interval || null;
}

// getInterval returns "month"/"year" — Transaction.plan enum requires "monthly"/"annual"
// NOTE: toBillingInterval() already handles this conversion. Use it for plan fields.

async function resolveInvoiceInterval(invoice) {
  const fromLine = getInvoiceInterval(invoice);
  if (fromLine) return fromLine;

  const candidate =
    invoice.subscription ||
    invoice?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription;

  if (!candidate) return null;
  try {
    const sub = await stripe.subscriptions.retrieve(candidate);
    const item = sub?.items?.data?.[0];
    return (
      item?.plan?.interval ||
      item?.price?.recurring?.interval ||
      sub?.plan?.interval ||
      null
    );
  } catch {
    return null;
  }
}

// ── Helpers ──

async function getOrCreateCustomer(user) {
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { userId: user._id.toString() },
  });
  user.stripeCustomerId = customer.id;
  await user.save();
  return customer.id;
}

// Reuse Stripe Products/Prices by plan key instead of creating per customer.
async function getOrCreatePrice(planKey, unitAmount) {
  const planConfig = await getPlanConfig(planKey);
  const interval = planConfig.interval;
  const label = planConfig.label;

  const existing = await stripe.products.search({
    query: `metadata["planKey"]:"${planKey}"`,
    limit: 1,
  });

  let productId;
  if (existing.data.length > 0) {
    productId = existing.data[0].id;
  } else {
    const product = await stripe.products.create({
      name: label,
      metadata: { planKey },
    });
    productId = product.id;
  }

  const prices = await stripe.prices.list({
    product: productId,
    recurring: { interval },
    active: true,
    limit: 100,
  });
  const match = prices.data.find((p) => p.unit_amount === unitAmount);
  if (match) return match.id;

  const price = await stripe.prices.create({
    currency: "usd",
    unit_amount: unitAmount,
    recurring: { interval },
    product: productId,
  });
  return price.id;
}

// Validate discount code and compute final amount.
// Enforces minimum charge so price never drops below MINIMUM_CHARGE_CENTS.
async function validateAndApplyDiscount(plan, unitAmount, discountCode) {
  if (!discountCode || plan !== "annual") {
    return { valid: true, unitAmount, discountAmount: 0, code: null };
  }

  const dc = await DiscountCode.findOne({
    code: discountCode.toUpperCase().trim(),
    active: true,
  });

  if (!dc) {
    return { valid: false, unitAmount, discountAmount: 0, code: null, message: "Invalid discount code" };
  }

  if (dc.expiresAt && new Date(dc.expiresAt) < new Date()) {
    return { valid: false, unitAmount, discountAmount: 0, code: null, message: "Discount code has expired" };
  }

  if (dc.usageLimit && dc.usedCount >= dc.usageLimit) {
    return { valid: false, unitAmount, discountAmount: 0, code: null, message: "Discount code has been fully redeemed" };
  }

  const discountCents = (dc.discountAmount || 0) * 100;
  const finalAmount = Math.max(MINIMUM_CHARGE_CENTS, unitAmount - discountCents);

  return {
    valid: true,
    unitAmount: finalAmount,
    discountAmount: dc.discountAmount || 0,
    code: dc.code,
  };
}

// Atomically record discount usage. Uses $expr to compare usedCount < usageLimit
// within the same query so two concurrent requests can't both succeed past the limit.
async function recordDiscountUsage(code, userId) {
  const upperCode = code.toUpperCase().trim();

  const result = await DiscountCode.findOneAndUpdate(
    {
      code: upperCode,
      active: true,
      usedBy: { $ne: userId },
      $or: [
        { usageLimit: null },
        { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
      ],
    },
    {
      $inc: { usedCount: 1 },
      $push: { usedBy: userId },
    },
    { new: true }
  );

  if (!result) {
    const dc = await DiscountCode.findOne({ code: upperCode });
    if (dc && dc.usageLimit && dc.usedCount >= dc.usageLimit) {
      console.warn(`Discount ${upperCode} concurrent redemption blocked — limit reached`);
    }
  }

  return result;
}

// Cancel abandoned incomplete subscriptions created by our app only.
async function cancelAbandonedSubscriptions(customerId) {
  try {
    const incomplete = await stripe.subscriptions.list({
      customer: customerId,
      status: "incomplete",
      limit: 100,
    });

    for (const sub of incomplete.data) {
      const age = Date.now() - sub.created * 1000;
      if (
        age > 60 * 60 * 1000 &&
        sub.metadata?.source === "secret_work_app"
      ) {
        await stripe.subscriptions.cancel(sub.id);
        console.log(`Cancelled abandoned subscription ${sub.id} for ${customerId}`);
      }
    }
  } catch (err) {
    console.log("Error cancelling abandoned subscriptions:", err.message);
  }
}

const checkoutRouter = Router();

// ── Checkout (web redirect) ──
checkoutRouter.post("/checkout", authMiddleware, async (req, res) => {
  try {
    const { plan, discountCode } = req.body;

    if (!plan || !PLAN_PRICES[plan]) {
      res.status(400).json({ error: "Invalid plan. Choose 'monthly' or 'annual'" });
      return;
    }

    const user = await User.findById(req.auth.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const customerId = await getOrCreateCustomer(user);
    const selectedPlan = await getPlanConfig(plan);

    const discount = await validateAndApplyDiscount(plan, selectedPlan.amount, discountCode);
    if (!discount.valid) {
      res.status(400).json({ error: discount.message });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      automatic_payment_methods: { enabled: true },
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: selectedPlan.label,
              description: "Secret Work Pro Subscription",
            },
            unit_amount: discount.unitAmount,
            recurring: { interval: selectedPlan.interval },
          },
          quantity: 1,
        },
      ],
      success_url: `${env.frontendUrl.split(",").pop()}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.frontendUrl.split(",").pop()}/payment-cancel`,
      metadata: { userId: user._id.toString(), plan, discountCode: discount.code || "" },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.log("Checkout session error:", error.message || error);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ── Create Subscription → returns the first invoice's PaymentIntent for PaymentSheet ──
// Flow:  POST /subscription  →  Stripe creates sub + first invoice  →  returns invoice PI
//        Client opens PaymentSheet with PI  →  user pays  →  invoice.paid webhook → Pro
//
// This is Stripe's recommended architecture: one charge via the invoice's own PaymentIntent.
// No SetupIntent, no separate payment-intent endpoint, no double-charge risk.
checkoutRouter.post("/subscription", authMiddleware, async (req, res) => {
  try {
    const { plan, discountCode } = req.body;

    if (!plan || !PLAN_PRICES[plan]) {
      res.status(400).json({ error: "Invalid plan. Choose 'monthly' or 'annual'" });
      return;
    }

    const user = await User.findById(req.auth.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const customerId = await getOrCreateCustomer(user);

    const selectedPlan = await getPlanConfig(plan);
    const discount = await validateAndApplyDiscount(plan, selectedPlan.amount, discountCode);
    if (!discount.valid) {
      res.status(400).json({ error: discount.message });
      return;
    }

    // ── Check for existing active/trialing subscription ──
    const existingSubsAll = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    });

    const activeSub = existingSubsAll.data.find(
      (sub) =>
        ["active", "trialing"].includes(sub.status) &&
        sub.metadata?.source === "secret_work_app"
    );

    if (activeSub) {
      if (user.subscriptionTier !== "pro") {
        user.subscriptionTier = "pro";
        user.stripeSubscriptionId = activeSub.id;
        if (activeSub.current_period_end) {
          user.subscriptionExpiry = new Date(activeSub.current_period_end * 1000);
        }
        await user.save();
        console.log(`Subscription: self-healed ${user.email} to pro`);
      }
      const hasTx = await Transaction.findOne({ stripeSubscriptionId: activeSub.id, status: "success" }).lean();
      if (!hasTx) {
        const item = activeSub.items?.data?.[0];
        const subAmount = (item?.price?.unit_amount || 0) / 100;
        await upsertTransaction({
          invoiceId: "",
          chargeId: "",
          subscriptionId: activeSub.id,
          userId: user._id,
          userEmail: user.email,
          userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
          plan: plan,
          amount: subAmount,
          status: "success",
          date: new Date(),
        });
      }
      return res.json({ subscriptionId: activeSub.id, alreadyPaid: true });
    }

    // ── Cancel incomplete subscriptions — user may have changed payment method ──
    await cancelAbandonedSubscriptions(customerId);

    const incompleteSubs = existingSubsAll.data.filter(
      (sub) =>
        ["incomplete", "incomplete_expired"].includes(sub.status) &&
        sub.metadata?.source === "secret_work_app"
    );

    for (const sub of incompleteSubs) {
      try {
        await stripe.subscriptions.cancel(sub.id);
        console.log(`Subscription: cancelled incomplete sub ${sub.id} for ${user.email}`);
      } catch (e) {
        console.log(`Subscription: failed to cancel incomplete sub ${sub.id}:`, e.message);
      }
    }

    // ── Create subscription — default_incomplete so first invoice is created ──
    const priceId = await getOrCreatePrice(plan, discount.unitAmount);

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      metadata: {
        userId: user._id.toString(),
        plan,
        discountCode: discount.code || "",
        source: "secret_work_app",
      },
    });

    user.stripeSubscriptionId = subscription.id;
    await user.save();
    console.log(`Subscription: created ${subscription.id} for ${user.email} (status: ${subscription.status})`);

    // If subscription was created as active/trialing (e.g. free trial), grant immediately.
    if (["active", "trialing"].includes(subscription.status)) {
      if (user.subscriptionTier !== "pro") {
        user.subscriptionTier = "pro";
        if (subscription.current_period_end) {
          user.subscriptionExpiry = new Date(subscription.current_period_end * 1000);
        }
        await user.save();
        console.log(`Subscription: ${user.email} activated immediately (${subscription.status})`);
      }
      await upsertTransaction({
        invoiceId: typeof subscription.latest_invoice === "string" ? subscription.latest_invoice : subscription.latest_invoice?.id || "",
        chargeId: "",
        subscriptionId: subscription.id,
        userId: user._id,
        userEmail: user.email,
        userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
        plan: plan,
        amount: discount.unitAmount / 100,
        status: "success",
        date: new Date(),
      });
      res.json({ subscriptionId: subscription.id, alreadyPaid: true });
      return;
    }

    // ── Use SetupIntent instead of invoice PI — always reliable ──
    // After setup completes, the payment method attaches to the customer
    // and we manually pay the open invoice via the webhook or here.
    let clientSecret = null;

    // First: try invoice PI directly (fast path if it works)
    const invoiceId = subscription.latest_invoice;
    if (invoiceId) {
      try {
        const inv = await stripe.invoices.retrieve(typeof invoiceId === "string" ? invoiceId : invoiceId.id, {
          expand: ["payment_intent"],
        });
        clientSecret = inv.payment_intent?.client_secret || null;
        if (clientSecret) console.log(`Subscription: got PI from invoice retrieve`);
      } catch (e) {
        console.log(`Subscription: invoice PI retrieve failed: ${e.message}`);
      }
    }

    // Fallback: create a SetupIntent — guaranteed to always work
    if (!clientSecret) {
      const setupIntent = await stripe.setupIntents.create({
        customer: customerId,
        usage: "off_session",
        payment_method_types: ["card"],
        metadata: {
          userId: user._id.toString(),
          subscriptionId: subscription.id,
          plan,
          source: "secret_work_app",
        },
      });
      clientSecret = setupIntent.client_secret;
      console.log(`Subscription: created SetupIntent ${setupIntent.id} as fallback`);
    }

    if (clientSecret) {
      const isSetupIntent = clientSecret.startsWith("seti_");
      res.json({
        subscriptionId: subscription.id,
        clientSecret,
        clientSecretType: isSetupIntent ? "setup_intent" : "payment_intent",
        alreadyPaid: false,
      });
    } else {
      console.log(`Subscription: no clientSecret for ${subscription.id}`);
      res.status(500).json({ error: "Payment initialization failed. Please try again." });
    }
  } catch (error) {
    console.log("Create subscription error:", error.message || error);
    res.status(500).json({ error: error.message || "Failed to create subscription" });
  }
});

// ── Confirm subscription payment (called after Google Pay / Card succeeds) ──
checkoutRouter.post("/confirm-subscription", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.auth.userId);
    if (!user || !user.stripeSubscriptionId) {
      return res.json({ ok: false, error: "No active subscription found" });
    }

    const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    console.log(`[confirm-sub] sub ${sub.id} status: ${sub.status}`);

    // Already active — just ensure DB is synced
    if (["active", "trialing"].includes(sub.status)) {
      if (user.subscriptionTier !== "pro") {
        user.subscriptionTier = "pro";
        if (sub.current_period_end) {
          user.subscriptionExpiry = new Date(sub.current_period_end * 1000);
        }
        user.billingInterval = toBillingInterval(getInterval(sub));
        const item = sub.items?.data?.[0];
        const priceAmount = item?.price?.unit_amount || item?.plan?.amount;
        if (priceAmount != null) user.subscriptionAmount = priceAmount / 100;
        await user.save();
        console.log(`[confirm-sub] synced ${user.email} to pro (was already active)`);
      }

      // Always backfill transaction if missing (regardless of pro status)
      const invoiceIdStr = typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice?.id || "";
      const hasTx = invoiceIdStr
        ? await Transaction.findOne({ stripeInvoiceId: invoiceIdStr }).lean()
        : null;
      if (!hasTx && invoiceIdStr) {
        try {
          const item = sub.items?.data?.[0];
          const priceAmount = item?.price?.unit_amount || item?.plan?.amount;
          await upsertTransaction({
            invoiceId: invoiceIdStr,
            chargeId: "",
            subscriptionId: sub.id,
            userId: user._id,
            userEmail: user.email,
            userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
            plan: toBillingInterval(getInterval(sub)) || "",
            amount: priceAmount != null ? priceAmount / 100 : 0,
            status: "success",
            date: new Date(),
          });
          console.log(`[confirm-sub] backfilled transaction for ${user.email}`);
        } catch (txErr) {
          console.error("[confirm-sub] backfill upsertTransaction failed:", txErr.message);
        }
      }
      return res.json({ ok: true, alreadyActive: true });
    }

    // Subscription incomplete — need to pay the invoice
    const invoiceId = typeof sub.latest_invoice === "string"
      ? sub.latest_invoice
      : sub.latest_invoice?.id;

    if (!invoiceId) {
      console.log(`[confirm-sub] no invoice for sub ${sub.id}`);
      return res.json({ ok: false, error: "No invoice found" });
    }

    // Check if invoice is already paid (webhook may have handled it)
    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (invoice.status === "paid") {
      console.log(`[confirm-sub] invoice ${invoiceId} already paid`);
      // Webhook already paid it — sync DB
      if (user.subscriptionTier !== "pro") {
        user.subscriptionTier = "pro";
        if (sub.current_period_end) {
          user.subscriptionExpiry = new Date(sub.current_period_end * 1000);
        }
        user.billingInterval = toBillingInterval(getInterval(sub));
        const item = sub.items?.data?.[0];
        const priceAmount = item?.price?.unit_amount || item?.plan?.amount;
        if (priceAmount != null) user.subscriptionAmount = priceAmount / 100;
        await user.save();
      }
      // Always backfill transaction if missing
      const hasTx = await Transaction.findOne({ stripeInvoiceId: invoiceId }).lean();
      if (!hasTx) {
        await upsertTransaction({
          invoiceId: invoiceId,
          chargeId: "",
          subscriptionId: sub.id,
          userId: user._id,
          userEmail: user.email,
          userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
          plan: toBillingInterval(getInterval(sub)) || "",
          amount: (invoice.amount_paid || 0) / 100,
          status: "success",
          date: new Date(),
        });
      }
      return res.json({ ok: true, alreadyActive: true });
    }

    // Find payment methods — try card first, then any type
    let pmList = await stripe.paymentMethods.list({
      customer: user.stripeCustomerId,
      type: "card",
      limit: 1,
    });

    // Also check for Google Pay / Apple Pay tokenized cards
    if (!pmList.data.length) {
      pmList = await stripe.paymentMethods.list({
        customer: user.stripeCustomerId,
        limit: 5,
      });
    }

    if (!pmList.data.length) {
      console.log(`[confirm-sub] no payment methods for customer ${user.stripeCustomerId}`);
      return res.json({ ok: false, error: "No payment method found. Please try again." });
    }

    const pmId = pmList.data[0].id;

    // Attach payment method to customer if not already attached
    try {
      await stripe.paymentMethods.attach(pmId, { customer: user.stripeCustomerId });
    } catch (attachErr) {
      // Already attached — that's fine
      if (!attachErr.message?.includes("already")) {
        console.log(`[confirm-sub] attach PM failed: ${attachErr.message}`);
      }
    }

    // Pay the invoice with retry
    let paid = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await stripe.invoices.pay(invoiceId, { payment_method: pmId });
        paid = true;
        console.log(`[confirm-sub] paid invoice ${invoiceId} (attempt ${attempt})`);
        break;
      } catch (payErr) {
        console.log(`[confirm-sub] invoices.pay attempt ${attempt} failed: ${payErr.message}`);
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
    }

    // Refresh subscription status after payment
    const refreshed = await stripe.subscriptions.retrieve(sub.id);
    const isNowActive = ["active", "trialing"].includes(refreshed.status);

    // Sync user pro status regardless of race — upsertTransaction handles dedup
    if (isNowActive && user.subscriptionTier !== "pro") {
      user.subscriptionTier = "pro";
      if (refreshed.current_period_end) {
        user.subscriptionExpiry = new Date(refreshed.current_period_end * 1000);
      }
      user.billingInterval = toBillingInterval(getInterval(refreshed));
      const item = refreshed.items?.data?.[0];
      const priceAmount = item?.price?.unit_amount || item?.plan?.amount;
      if (priceAmount != null) user.subscriptionAmount = priceAmount / 100;
      await user.save();
      console.log(`[confirm-sub] ${user.email} upgraded to pro`);
    }

    // Always create transaction if we paid (dedup by invoice ID)
    if (paid) {
      // Re-retrieve invoice to get actual amount_paid after payment
      const paidInvoice = await stripe.invoices.retrieve(invoiceId);
      const txAmount = (paidInvoice.amount_paid || 0) / 100 || (refreshed.items?.data?.[0]?.price?.unit_amount || 0) / 100;
      console.log(`[confirm-sub] paid=true, creating transaction for invoice ${invoiceId}, amount: ${txAmount}`);
      await upsertTransaction({
        invoiceId: invoiceId,
        chargeId: "",
        subscriptionId: sub.id,
        userId: user._id,
        userEmail: user.email,
        userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
        plan: toBillingInterval(getInterval(refreshed)) || "",
        amount: txAmount,
        status: "success",
        date: new Date(),
      });
    }

    res.json({ ok: true, isActive: isNowActive, status: refreshed.status, paid });
  } catch (error) {
    console.log("[confirm-sub] error:", error.message || error);
    res.status(500).json({ ok: false, error: error.message || "Confirmation failed" });
  }
});

// ── Subscription status (read-only) ──
checkoutRouter.get("/subscription", authMiddleware, async (req, res) => {
  let user;
  try {
    user = await User.findById(req.auth.userId).lean();
  } catch (e) {
    console.log("[sub-status] DB lookup failed:", e.message);
    return res.json({ tier: "free", isActive: false, plan: null, amount: null, label: "Pro" });
  }
  if (!user) {
    return res.json({ tier: "free", isActive: false, plan: null, amount: null, label: "Pro" });
  }

  let subscription = null;

  if (user.stripeSubscriptionId) {
    try {
      subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    } catch (e) {
      console.log("[sub-status] retrieve sub failed:", e.message);
    }
  }

  if (!subscription && user.stripeCustomerId) {
    try {
      const subs = await stripe.subscriptions.list({
        customer: user.stripeCustomerId,
        limit: 10,
      });
      subscription = subs.data.find(
        (s) => ["active", "trialing"].includes(s.status)
      ) || subs.data[0] || null;
    } catch (e) {
      console.log("[sub-status] list subs failed:", e.message);
    }
  }

  const isActive = subscription && ["active", "trialing"].includes(subscription.status);

  // Self-heal: Stripe says active but DB says free → sync.
  if (isActive && user.subscriptionTier !== "pro") {
    try {
      await User.findByIdAndUpdate(user._id, {
        subscriptionTier: "pro",
        stripeSubscriptionId: subscription.id,
        billingInterval: toBillingInterval(getInterval(subscription)),
        subscriptionExpiry: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : undefined,
        subscriptionAmount: subscription.items?.data?.[0]?.price?.unit_amount != null
          ? subscription.items.data[0].price.unit_amount / 100
          : undefined,
      });
      console.log("[sub-status] self-healed", user.email, "to pro");
      // Backfill missing Transaction so admin dashboard shows revenue
      const hasTx = await Transaction.findOne({ stripeSubscriptionId: subscription.id, status: "success" }).lean();
      if (!hasTx) {
        const subAmount = subscription.items?.data?.[0]?.price?.unit_amount != null
          ? subscription.items.data[0].price.unit_amount / 100
          : 0;
        await upsertTransaction({
          invoiceId: "",
          chargeId: "",
          subscriptionId: subscription.id,
          userId: user._id,
          userEmail: user.email,
          userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
          plan: toBillingInterval(getInterval(subscription)) || "",
          amount: subAmount,
          status: "success",
          date: new Date(),
        });
        console.log("[sub-status] backfilled transaction for", user.email);
      }
    } catch (e) {
      console.log("[sub-status] self-heal save failed:", e.message);
    }
    // Update local values for response
    user.subscriptionTier = "pro";
  }

  const interval = getInterval(subscription);
  const amount = user.subscriptionAmount != null
    ? user.subscriptionAmount
    : subscription?.items?.data?.[0]?.price?.unit_amount != null
      ? subscription.items.data[0].price.unit_amount / 100
      : null;

  res.json({
    tier: user.subscriptionTier || "free",
    expiry: user.subscriptionExpiry,
    isActive: !!isActive,
    plan: interval || null,
    amount,
    label: interval === "month" ? "Monthly Pro" : interval === "year" ? "Annual Pro" : "Pro",
  });
});

// ── Portal ──
checkoutRouter.post("/portal", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.auth.userId);
    if (!user || !user.stripeCustomerId) {
      res.status(400).json({ error: "No subscription found" });
      return;
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${env.frontendUrl.split(",")[0]}`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.log("Portal session error:", error.message || error);
    res.status(500).json({ error: "Failed to create portal session" });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  WEBHOOK — Sole authoritative source for payment & access state.
//
//  Mounted in index.js BEFORE express.json(), so req.body is the raw
//  Buffer required for Stripe signature verification.
// ══════════════════════════════════════════════════════════════════════

const webhookRouter = Router();

webhookRouter.post(
  "/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("[webhook] hit /api/webhooks/stripe");
    const sig = req.headers["stripe-signature"];

    if (!env.stripeWebhookSecret) {
      console.warn("STRIPE_WEBHOOK_SECRET not set — refusing webhook");
      res.status(503).json({ error: "Webhook not configured" });
      return;
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, env.stripeWebhookSecret);
    } catch (err) {
      console.log("Webhook signature verification failed:", err.message);
      res.status(400).json({ error: "Invalid signature" });
      return;
    }

    // Deduplicate: Stripe may deliver the same event more than once.
    // Atomic claim — only the first request wins.
    const claimed = await StripeEvent.findOneAndUpdate(
      { eventId: event.id },
      { $setOnInsert: { eventId: event.id, type: event.type, processedAt: new Date() } },
      { upsert: true, new: true, rawResult: true }
    );
    if (!claimed.value) {
      // Duplicate key error = another request claimed it first.
      return res.json({ received: true });
    }

    let processingError = null;

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const userId = session.metadata?.userId;

          if (userId) {
            const user = await User.findById(userId);
            if (user) {
              // Save subscription metadata only — do NOT grant Pro here.
              // invoice.paid is the single authoritative access grant.
              user.stripeSubscriptionId = session.subscription;
              user.billingInterval = toBillingInterval(session.metadata?.plan);
              if (session.amount_total != null) {
                user.subscriptionAmount = session.amount_total / 100;
              }

              if (session.subscription) {
                try {
                  const sub = await stripe.subscriptions.retrieve(session.subscription);
                  if (sub.current_period_end) {
                    user.subscriptionExpiry = new Date(sub.current_period_end * 1000);
                  }
                } catch {
                  if (session.expires_at) {
                    user.subscriptionExpiry = new Date(session.expires_at * 1000);
                  }
                }
              }

              await user.save();
              console.log(`Checkout session completed for ${user.email} — metadata saved`);
            }
          }
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object;
          console.log(`[invoice.paid] received: ${invoice.id}, status: ${invoice.status}, amount_paid: ${invoice.amount_paid}, customer: ${invoice.customer}`);
          const user = invoice.customer
            ? await User.findOne({ stripeCustomerId: invoice.customer })
            : null;
          const interval = await resolveInvoiceInterval(invoice);

          // Basil API removed invoice.payment_intent — extract charge ID from payments array
          let chargeId = invoice.payment_intent || "";
          if (!chargeId && invoice.payments?.data?.length) {
            const lastPayment = invoice.payments.data[invoice.payments.data.length - 1];
            const piRef = lastPayment?.payment?.payment_intent;
            if (piRef) {
              chargeId = typeof piRef === "string" ? piRef : piRef.id || "";
            }
          }

          // Extract payment method type from invoice charges
          let paymentMethodType = "";
          try {
            if (chargeId) {
              const pi = await stripe.paymentIntents.retrieve(chargeId);
              const pmType = pi?.charges?.data?.[0]?.payment_method_details?.type;
              if (pmType) paymentMethodType = pmType;
            }
            if (!paymentMethodType && invoice.account_name) {
              const acct = invoice.account_name.toLowerCase();
              if (acct.includes("apple")) paymentMethodType = "apple_pay";
              else if (acct.includes("google")) paymentMethodType = "google_pay";
            }
          } catch {
            // Best effort — don't block payment processing
          }

          // Grant Pro access on successful payment — this is the single
          // authoritative point for access grants after initial checkout.
          if (user && invoice.subscription) {
            try {
              const sub = await stripe.subscriptions.retrieve(invoice.subscription);
              if (["active", "trialing"].includes(sub.status) && user.subscriptionTier !== "pro") {
                user.subscriptionTier = "pro";
                user.stripeSubscriptionId = sub.id;
                user.billingInterval = toBillingInterval(interval);
                if (invoice.amount_paid != null) {
                  user.subscriptionAmount = invoice.amount_paid / 100;
                }
                if (sub.current_period_end) {
                  user.subscriptionExpiry = new Date(sub.current_period_end * 1000);
                }
                await user.save();
                console.log(`User ${user.email} upgraded to pro via invoice.paid`);
              } else if (["active", "trialing"].includes(sub.status)) {
                // Already pro — just sync subscription metadata
                if (sub.current_period_end) {
                  user.subscriptionExpiry = new Date(sub.current_period_end * 1000);
                }
                if (invoice.amount_paid != null) {
                  user.subscriptionAmount = invoice.amount_paid / 100;
                }
                user.billingInterval = toBillingInterval(interval);
                await user.save();
              }

              // Record discount usage — protected by usedBy $ne check,
              // so duplicate invoice.paid retries won't double-count.
              if (sub.metadata?.discountCode) {
                await recordDiscountUsage(sub.metadata.discountCode, user._id);
              }
            } catch (err) {
              console.log("Failed to retrieve subscription from invoice.paid:", err.message);
            }
          }

          try {
            await upsertTransaction({
              invoiceId: invoice.id,
              chargeId: chargeId,
              subscriptionId: invoice.subscription || "",
              userId: user?._id,
              userEmail: user?.email || invoice.customer_email || "",
              userName: user
                ? `${user.firstName || ""} ${user.lastName || ""}`.trim()
                : "",
              plan: toBillingInterval(interval) || "",
              amount: (invoice.amount_paid || 0) / 100,
              status: "success",
              paymentMethod: paymentMethodType,
              date: new Date(
                (invoice.status_transitions?.paid_at || invoice.created) * 1000
              ),
            });
          } catch (txErr) {
            console.error("[invoice.paid] upsertTransaction failed:", txErr.message);
          }
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          const user = invoice.customer
            ? await User.findOne({ stripeCustomerId: invoice.customer })
            : null;
          const interval = await resolveInvoiceInterval(invoice);

          // Basil API: extract charge ID from payments array
          let failedChargeId = invoice.payment_intent || "";
          if (!failedChargeId && invoice.payments?.data?.length) {
            const lastPayment = invoice.payments.data[invoice.payments.data.length - 1];
            const piRef = lastPayment?.payment?.payment_intent;
            if (piRef) {
              failedChargeId = typeof piRef === "string" ? piRef : piRef.id || "";
            }
          }

          // Downgrade access on failed payment.
          if (user && invoice.subscription) {
            try {
              const sub = await stripe.subscriptions.retrieve(invoice.subscription);
              if (["past_due", "unpaid", "canceled"].includes(sub.status)) {
                user.subscriptionTier = "free";
                await user.save();
                console.log(`User ${user.email} downgraded to free — invoice payment failed`);
              }
            } catch (err) {
              console.log("Failed to retrieve subscription from invoice.payment_failed:", err.message);
            }
          }

          await upsertTransaction({
            invoiceId: invoice.id,
            chargeId: failedChargeId,
            subscriptionId: invoice.subscription || "",
            userId: user?._id,
            userEmail: user?.email || invoice.customer_email || "",
            userName: user
              ? `${user.firstName || ""} ${user.lastName || ""}`.trim()
              : "",
            plan: toBillingInterval(interval) || "",
            amount: (invoice.amount_due || 0) / 100,
            status: "failed",
            date: invoice.created
              ? new Date(invoice.created * 1000)
              : new Date(),
          });
          break;
        }

        case "setup_intent.succeeded": {
          const setupIntent = event.data.object;
          const subId = setupIntent.metadata?.subscriptionId;
          const userId = setupIntent.metadata?.userId;

          console.log(`SetupIntent succeeded: ${setupIntent.id}, sub: ${subId}, user: ${userId}`);

          if (subId) {
            try {
              const sub = await stripe.subscriptions.retrieve(subId);
              console.log(`SetupIntent: subscription status = ${sub.status}`);

              if (["active", "trialing"].includes(sub.status)) {
                console.log(`SetupIntent: sub ${subId} already active, skipping invoice pay`);
                // Already paid — just sync DB if needed
                if (userId) {
                  const user = await User.findById(userId);
                  if (user && user.subscriptionTier !== "pro") {
                    user.subscriptionTier = "pro";
                    user.stripeSubscriptionId = subId;
                    if (sub.current_period_end) {
                      user.subscriptionExpiry = new Date(sub.current_period_end * 1000);
                    }
                    user.billingInterval = toBillingInterval(getInterval(sub));
                    const item = sub.items?.data?.[0];
                    const priceAmount = item?.price?.unit_amount || item?.plan?.amount;
                    if (priceAmount != null) user.subscriptionAmount = priceAmount / 100;
                    await user.save();
                    console.log(`SetupIntent: self-healed ${user.email} to pro (already active)`);
                  }
                  // Backfill transaction if missing
                  const invoiceIdStr = typeof sub.latest_invoice === "string"
                    ? sub.latest_invoice
                    : sub.latest_invoice?.id;
                  if (invoiceIdStr) {
                    const hasTx = await Transaction.findOne({ stripeInvoiceId: invoiceIdStr }).lean();
                    if (!hasTx) {
                      const item = sub.items?.data?.[0];
                      const priceAmount = item?.price?.unit_amount || item?.plan?.amount;
                      await upsertTransaction({
                        invoiceId: invoiceIdStr,
                        chargeId: "",
                        subscriptionId: subId,
                        userId: user?._id,
                        userEmail: user?.email || "",
                        userName: user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() : "",
                        plan: toBillingInterval(getInterval(sub)) || "",
                        amount: priceAmount != null ? priceAmount / 100 : 0,
                        status: "success",
                        date: new Date(),
                      });
                    }
                  }
                }
                break;
              }

              const invoiceId = typeof sub.latest_invoice === "string"
                ? sub.latest_invoice
                : sub.latest_invoice?.id;

              if (invoiceId && setupIntent.payment_method) {
                const pmId = typeof setupIntent.payment_method === "string"
                  ? setupIntent.payment_method
                  : setupIntent.payment_method.id;

                // Check if invoice already paid (confirm-sub endpoint may have handled it)
                const invoice = await stripe.invoices.retrieve(invoiceId);
                if (invoice.status === "paid") {
                  console.log(`SetupIntent: invoice ${invoiceId} already paid`);
                } else {
                  // Pay the invoice with the saved payment method
                  for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                      await stripe.invoices.pay(invoiceId, { payment_method: pmId });
                      console.log(`SetupIntent: paid invoice ${invoiceId} (attempt ${attempt})`);
                      break;
                    } catch (payErr) {
                      console.log(`SetupIntent: invoices.pay attempt ${attempt} failed: ${payErr.message}`);
                      if (attempt < 3) {
                        await new Promise(r => setTimeout(r, 2000 * attempt));
                      }
                    }
                  }
                }

                // Self-heal: sync subscription status
                const refreshedSub = await stripe.subscriptions.retrieve(subId);
                if (["active", "trialing"].includes(refreshedSub.status) && userId) {
                  const user = await User.findById(userId);
                  if (user && user.subscriptionTier !== "pro") {
                    user.subscriptionTier = "pro";
                    user.stripeSubscriptionId = subId;
                    if (refreshedSub.current_period_end) {
                      user.subscriptionExpiry = new Date(refreshedSub.current_period_end * 1000);
                    }
                    const item = refreshedSub.items?.data?.[0];
                    const priceAmount = item?.price?.unit_amount || item?.plan?.amount;
                    if (priceAmount != null) user.subscriptionAmount = priceAmount / 100;
                    user.billingInterval = toBillingInterval(getInterval(refreshedSub));
                    await user.save();
                    console.log(`SetupIntent: self-healed ${user.email} to pro`);
                  }

                  // Always backfill transaction if missing (dedup by invoice ID)
                  const hasTx = invoiceId ? await Transaction.findOne({ stripeInvoiceId: invoiceId }).lean() : null;
                  if (!hasTx && invoiceId) {
                    const userDoc = userId ? await User.findById(userId) : null;
                    const item = refreshedSub.items?.data?.[0];
                    const priceAmount = item?.price?.unit_amount || item?.plan?.amount;
                    await upsertTransaction({
                      invoiceId: invoiceId,
                      chargeId: "",
                      subscriptionId: subId,
                      userId: userDoc?._id,
                      userEmail: userDoc?.email || "",
                      userName: userDoc ? `${userDoc.firstName || ""} ${userDoc.lastName || ""}`.trim() : "",
                      plan: toBillingInterval(getInterval(refreshedSub)) || "",
                      amount: priceAmount != null ? priceAmount / 100 : 0,
                      status: "success",
                      date: new Date(),
                    });
                  }
                }
              }
            } catch (e) {
              console.log(`SetupIntent: error handling sub ${subId}: ${e.message}`);
            }
          }
          break;
        }

        case "charge.refunded": {
          const charge = event.data.object;
          const user = charge.customer
            ? await User.findOne({ stripeCustomerId: charge.customer })
            : null;
          const latestRefund = charge.refunds?.data?.[0];
          const refundAmount = latestRefund
            ? latestRefund.amount / 100
            : (charge.amount_refunded || 0) / 100;
          await upsertTransaction({
            invoiceId: charge.invoice || "",
            chargeId: charge.id,
            subscriptionId: "",
            userId: user?._id,
            userEmail: user?.email || charge.billing_details?.email || "",
            userName: user
              ? `${user.firstName || ""} ${user.lastName || ""}`.trim()
              : "",
            plan: "",
            amount: refundAmount,
            status: "refunded",
            date: new Date((charge.refunded_at || charge.created) * 1000),
          });
          break;
        }

        case "customer.subscription.updated": {
          const subscription = event.data.object;
          const user = await User.findOne({ stripeSubscriptionId: subscription.id });
          if (user) {
            if (["canceled", "unpaid", "incomplete_expired"].includes(subscription.status)) {
              // Definitive cancellation — downgrade
              user.subscriptionTier = "free";
              user.stripeSubscriptionId = undefined;
              user.subscriptionExpiry = undefined;
              user.billingInterval = undefined;
              await user.save();
              console.log(`User ${user.email} downgraded to free via subscription.updated`);
            } else {
              // Sync metadata only — do NOT independently grant Pro.
              // Access is granted by invoice.paid.
              user.billingInterval = toBillingInterval(getInterval(subscription));
              if (subscription.current_period_end) {
                user.subscriptionExpiry = new Date(subscription.current_period_end * 1000);
              }
              const item = subscription.items?.data?.[0];
              const priceAmount = item?.price?.unit_amount || item?.plan?.amount;
              if (priceAmount != null) user.subscriptionAmount = priceAmount / 100;
              await user.save();
            }
            console.log(`Subscription updated for ${user.email}: ${subscription.status}`);
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const user = await User.findOne({ stripeSubscriptionId: subscription.id });
          if (user) {
            user.subscriptionTier = "free";
            user.stripeSubscriptionId = undefined;
            user.subscriptionExpiry = undefined;
            user.billingInterval = undefined;
            await user.save();
            console.log(`User ${user.email} downgraded to free`);
          }
          const interval = getInterval(subscription);
          await upsertTransaction({
            invoiceId: "",
            chargeId: "",
            subscriptionId: subscription.id,
            userId: user?._id,
            userEmail: user?.email || "",
            userName: user
              ? `${user.firstName || ""} ${user.lastName || ""}`.trim()
              : "",
            plan: toBillingInterval(interval) || "",
            amount: 0,
            status: "cancelled",
            date: subscription.canceled_at
              ? new Date(subscription.canceled_at * 1000)
              : new Date(),
          });
          break;
        }
      }
    } catch (err) {
      console.log(`Error handling webhook event ${event.type}:`, err.message || err);
      processingError = err;
    }

    if (processingError) {
      res.status(500).json({ error: "Webhook processing failed" });
    } else {
      res.json({ received: true });
    }
  }
);

// ── Discount code validation ──
const validateDiscountCodeRouter = Router();

validateDiscountCodeRouter.post("/validate", authMiddleware, async (req, res) => {
  try {
    const { code, plan } = req.body;

    if (!code || !plan) {
      return res.status(400).json({ error: "Code and plan are required" });
    }

    if (plan !== "annual") {
      return res.status(400).json({ valid: false, message: "Discount code only applies to annual plan" });
    }

    const dc = await DiscountCode.findOne({
      code: code.toUpperCase().trim(),
      active: true,
    });

    if (!dc) {
      return res.status(400).json({ valid: false, message: "Invalid discount code" });
    }

    if (dc.expiresAt && new Date(dc.expiresAt) < new Date()) {
      return res.status(400).json({ valid: false, message: "Discount code has expired" });
    }

    if (dc.usageLimit && dc.usedCount >= dc.usageLimit) {
      return res.status(400).json({ valid: false, message: "Discount code has been fully redeemed" });
    }

    if (dc.usedBy && dc.usedBy.includes(req.auth.userId)) {
      return res.status(400).json({ valid: false, message: "Discount code already applied to your account" });
    }

    return res.json({
      valid: true,
      code: dc.code,
      discountAmount: dc.discountAmount,
      message: `Discount $${dc.discountAmount} off applied to annual plan`,
    });
  } catch (error) {
    console.log("Discount code validation error:", error.message);
    res.status(500).json({ error: "Failed to validate discount code" });
  }
});

module.exports = { checkoutRouter, webhookRouter, validateDiscountCodeRouter };
