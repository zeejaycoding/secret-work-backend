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
  monthly: { amount: 950, interval: "month", label: "Monthly Pro" },
  annually: { amount: 7900, interval: "year", label: "Annual Pro" },
};

const MINIMUM_CHARGE_CENTS = 50;

async function getPlanConfig(key) {
  const planKey = key === "annually" ? "annual" : "monthly";
  const doc = await Plan.findOne({ key: planKey });
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
  if (value === "year" || value === "annually") return "annual";
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
  if (!discountCode || plan !== "annually") {
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
    console.error("Error cancelling abandoned subscriptions:", err.message);
  }
}

const checkoutRouter = Router();

// ── Checkout (web redirect) ──
checkoutRouter.post("/checkout", authMiddleware, async (req, res) => {
  try {
    const { plan, discountCode } = req.body;

    if (!plan || !PLAN_PRICES[plan]) {
      res.status(400).json({ error: "Invalid plan. Choose 'monthly' or 'annually'" });
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
    console.error("Checkout session error:", error.message || error);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ── SetupIntent (PaymentSheet / Apple Pay) ──
checkoutRouter.post("/setup-intent", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.auth.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const customerId = await getOrCreateCustomer(user);

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      automatic_payment_methods: { enabled: true },
    });

    res.json({
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
      customerId,
    });
  } catch (error) {
    console.error("Setup intent error:", error.message || error);
    res.status(500).json({ error: "Failed to create setup intent" });
  }
});

// ── Create Subscription (after SetupIntent confirmation via PaymentSheet) ──
// Accepts setupIntentId so we retrieve the exact payment_method instead of guessing.
// Uses payment_behavior: "default_incomplete" + expanded invoice PI so we can detect
// and return requires_action to the client when 3DS or other auth is needed.
checkoutRouter.post("/subscription", authMiddleware, async (req, res) => {
  try {
    const { plan, discountCode, setupIntentId } = req.body;

    if (!plan || !PLAN_PRICES[plan]) {
      res.status(400).json({ error: "Invalid plan. Choose 'monthly' or 'annually'" });
      return;
    }

    if (!setupIntentId) {
      res.status(400).json({ error: "setupIntentId is required" });
      return;
    }

    const user = await User.findById(req.auth.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (!user.stripeCustomerId) {
      res.status(400).json({ error: "No payment method on file" });
      return;
    }

    let setupIntent;
    try {
      setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    } catch {
      res.status(400).json({ error: "Invalid or expired setup intent" });
      return;
    }

    if (setupIntent.customer !== user.stripeCustomerId) {
      res.status(403).json({ error: "Setup intent does not belong to this customer" });
      return;
    }

    if (setupIntent.status !== "succeeded") {
      res.status(400).json({ error: "Setup intent has not been confirmed" });
      return;
    }

    const paymentMethodId = setupIntent.payment_method;
    if (!paymentMethodId) {
      res.status(400).json({ error: "No payment method attached to setup intent" });
      return;
    }

    const selectedPlan = await getPlanConfig(plan);
    const discount = await validateAndApplyDiscount(plan, selectedPlan.amount, discountCode);
    if (!discount.valid) {
      res.status(400).json({ error: discount.message });
      return;
    }

    await cancelAbandonedSubscriptions(user.stripeCustomerId);

    const existingSubsAll = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      status: "all",
      limit: 100,
    });
    const pendingSub = existingSubsAll.data.find(
      (sub) =>
        ["active", "trialing", "incomplete", "past_due"].includes(sub.status) &&
        sub.metadata?.source === "secret_work_app"
    );
    if (pendingSub) {
      if (pendingSub.status === "active" || pendingSub.status === "trialing") {
        if (user.subscriptionTier !== "pro") {
          user.subscriptionTier = "pro";
          user.stripeSubscriptionId = pendingSub.id;
          if (pendingSub.current_period_end) {
            user.subscriptionExpiry = new Date(pendingSub.current_period_end * 1000);
          }
          await user.save();
          console.log(`Subscription: self-healed ${user.email} to pro`);
        }
        return res.json({ subscriptionId: pendingSub.id, alreadyPaid: true });
      }
      // Incomplete sub exists — don't create another
      return res.json({ subscriptionId: pendingSub.id, alreadyPaid: false });
    }

    const priceId = await getOrCreatePrice(plan, discount.unitAmount);

    const subscription = await stripe.subscriptions.create({
      customer: user.stripeCustomerId,
      items: [{ price: priceId }],
      default_payment_method: paymentMethodId,
      payment_behavior: "default_incomplete",
      expand: ["latest_invoice.payment_intent"],
      metadata: {
        userId: user._id.toString(),
        plan,
        discountCode: discount.code || "",
        source: "secret_work_app",
      },
    });

    let invoice = subscription.latest_invoice;
    let pi = invoice?.payment_intent;

    // Basil API: check invoice.payments for the PI
    if (!pi?.client_secret && invoice?.payments?.data?.length) {
      const ip = invoice.payments.data.find(
        (p) => p.payment?.type === "payment_intent" && p.payment?.payment_intent
      );
      if (ip) {
        const piId = typeof ip.payment.payment_intent === "string"
          ? ip.payment.payment_intent
          : ip.payment.payment_intent?.id;
        if (piId) {
          try { pi = await stripe.paymentIntents.retrieve(piId); } catch {}
        }
      }
    }

    // If expansion didn't work, manually retrieve the invoice
    if (!pi?.client_secret && invoice) {
      const invoiceId = typeof invoice === "string" ? invoice : invoice.id;
      console.warn("Subscription: invoice missing PI, retrieving manually:", invoiceId);
      try {
        const retrievedInvoice = await stripe.invoices.retrieve(invoiceId, {
          expand: ["payments.payment_intent"],
        });
        invoice = retrievedInvoice;
        const ip = retrievedInvoice.payments?.data?.find(
          (p) => p.payment?.type === "payment_intent" && p.payment?.payment_intent
        );
        if (ip) {
          const piId = typeof ip.payment.payment_intent === "string"
            ? ip.payment.payment_intent
            : ip.payment.payment_intent?.id;
          if (piId) pi = await stripe.paymentIntents.retrieve(piId);
        }
      } catch (e) {
        console.error("Subscription: failed to retrieve invoice manually:", e.message);
      }
    }

    // Webhook (invoice.paid) is the single authoritative access grant.
    // Here we just report the subscription/PI state so the client knows
    // whether it needs to confirm additional authentication.
    if (subscription.status === "active") {
      if (user.subscriptionTier !== "pro") {
        user.subscriptionTier = "pro";
        user.stripeSubscriptionId = subscription.id;
        if (subscription.current_period_end) {
          user.subscriptionExpiry = new Date(subscription.current_period_end * 1000);
        }
        await user.save();
        console.log(`Subscription: self-healed ${user.email} to pro (created active)`);
      }
      res.json({ subscriptionId: subscription.id, alreadyPaid: true });
    } else if (pi?.status === "requires_action" && pi?.client_secret) {
      res.json({
        subscriptionId: subscription.id,
        requiresAction: true,
        clientSecret: pi.client_secret,
      });
    } else if (pi?.status === "requires_payment_method") {
      res.status(402).json({ error: "Payment method was declined. Please try a different card." });
    } else {
      // Incomplete but not actionable — webhook will handle eventual state
      res.json({ subscriptionId: subscription.id, alreadyPaid: false });
    }
  } catch (error) {
    console.error("Create subscription error:", error.message || error);
    res.status(500).json({ error: error.message || "Failed to create subscription" });
  }
});

// ── Google Pay (PlatformPayButton) flow ──
checkoutRouter.post("/google-pay-intent", authMiddleware, async (req, res) => {
  try {
    const { plan, discountCode } = req.body;

    if (!plan || !PLAN_PRICES[plan]) {
      res.status(400).json({ error: "Invalid plan. Choose 'monthly' or 'annually'" });
      return;
    }

    const user = await User.findById(req.auth.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const customerId = await getOrCreateCustomer(user);

    await cancelAbandonedSubscriptions(customerId);

    // Check ALL pending/incomplete subscriptions, not just active ones,
    // to prevent duplicate subscriptions from race conditions.
    const existingSubs = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    });
    const pendingSub = existingSubs.data.find(
      (sub) =>
        ["active", "trialing", "incomplete", "past_due"].includes(sub.status) &&
        sub.metadata?.source === "secret_work_app"
    );
    if (pendingSub) {
      // If there's an incomplete sub, try to retrieve its invoice PI for the client
      if (pendingSub.status === "incomplete" && pendingSub.latest_invoice) {
        try {
          const invoiceId =
            typeof pendingSub.latest_invoice === "string"
              ? pendingSub.latest_invoice
              : pendingSub.latest_invoice.id;
          const invoice = await stripe.invoices.retrieve(invoiceId, {
            expand: ["payments.payment_intent"],
          });
          // Check both legacy and basil API for the PI
          let pi = invoice.payment_intent;
          if (!pi?.client_secret && invoice.payments?.data?.length) {
            const ip = invoice.payments.data.find(
              (p) => p.payment?.type === "payment_intent" && p.payment?.payment_intent
            );
            if (ip) {
              const piId = typeof ip.payment.payment_intent === "string"
                ? ip.payment.payment_intent
                : ip.payment.payment_intent?.id;
              if (piId) pi = await stripe.paymentIntents.retrieve(piId);
            }
          }
          if (pi?.client_secret) {
            return res.json({
              clientSecret: pi.client_secret,
              subscriptionId: pendingSub.id,
              amount: pendingSub.items.data[0]?.price?.unit_amount || 0,
            });
          }
        } catch (e) {
          console.error("Google Pay: failed to retrieve pending sub invoice:", e.message);
        }
        // PI expired/canceled — cancel the stale sub so we can create a fresh one
        try {
          await stripe.subscriptions.cancel(pendingSub.id);
          console.log("Google Pay: cancelled stale incomplete sub:", pendingSub.id);
        } catch (e) {
          console.error("Google Pay: failed to cancel stale sub:", e.message);
        }
      } else {
        // Active/trialing/past_due — already has access or pending payment
        const isPaid = pendingSub.status === "active" || pendingSub.status === "trialing";
        if (isPaid && user.subscriptionTier !== "pro") {
          user.subscriptionTier = "pro";
          user.stripeSubscriptionId = pendingSub.id;
          if (pendingSub.current_period_end) {
            user.subscriptionExpiry = new Date(pendingSub.current_period_end * 1000);
          }
          await user.save();
          console.log(`Google Pay: self-healed ${user.email} to pro (active sub found)`);
        }
        return res.json({ alreadyPaid: isPaid });
      }
    }

    const selectedPlan = await getPlanConfig(plan);
    const discount = await validateAndApplyDiscount(plan, selectedPlan.amount, discountCode);
    if (!discount.valid) {
      res.status(400).json({ error: discount.message });
      return;
    }

    const priceId = await getOrCreatePrice(plan, discount.unitAmount);

    // No idempotency key here — Stripe caches responses for 24h per key.
    // If the user retries after a network drop, the cached subscription's PI
    // may be expired. The pendingSub check above already prevents duplicates.
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent"],
      metadata: {
        userId: user._id.toString(),
        plan,
        discountCode: discount.code || "",
        source: "secret_work_app",
      },
    });

    // Extract the PaymentIntent from the expanded invoice.
    // Stripe basil API (v2025-03-31+) removed payment_intent from Invoice.
    // We check both the legacy field and the new payments array.
    let invoice = subscription.latest_invoice;
    let paymentIntent = invoice?.payment_intent;

    // Basil API: check invoice.payments for the PI
    if (!paymentIntent?.client_secret && invoice?.payments?.data?.length) {
      const invoicePayment = invoice.payments.data.find(
        (p) => p.payment?.type === "payment_intent" && p.payment?.payment_intent
      );
      if (invoicePayment) {
        const piId = typeof invoicePayment.payment.payment_intent === "string"
          ? invoicePayment.payment.payment_intent
          : invoicePayment.payment.payment_intent?.id;
        if (piId) {
          try {
            paymentIntent = await stripe.paymentIntents.retrieve(piId);
          } catch (e) {
            console.error("Google Pay: failed to retrieve PI from payments:", e.message);
          }
        }
      }
    }

    // If expansion didn't work, manually retrieve the invoice
    if (!paymentIntent?.client_secret && invoice) {
      const invoiceId = typeof invoice === "string" ? invoice : invoice.id;
      console.warn("Google Pay: invoice missing PI, retrieving manually:", invoiceId);
      try {
        const retrievedInvoice = await stripe.invoices.retrieve(invoiceId, {
          expand: ["payments.payment_intent"],
        });
        invoice = retrievedInvoice;
        const invoicePayment = retrievedInvoice.payments?.data?.find(
          (p) => p.payment?.type === "payment_intent" && p.payment?.payment_intent
        );
        if (invoicePayment) {
          const piId = typeof invoicePayment.payment.payment_intent === "string"
            ? invoicePayment.payment.payment_intent
            : invoicePayment.payment.payment_intent?.id;
          if (piId) {
            paymentIntent = await stripe.paymentIntents.retrieve(piId);
          }
        }
      } catch (e) {
        console.error("Google Pay: failed to retrieve invoice manually:", e.message);
      }
    }

    // No PaymentIntent on the invoice — create one and attach it.
    if (!paymentIntent?.client_secret && invoice) {
      const invoiceId = typeof invoice === "string" ? invoice : invoice.id;
      console.warn("Google Pay: no PI on invoice", invoiceId, "— creating one");
      try {
        paymentIntent = await stripe.paymentIntents.create({
          amount: invoice.amount_due,
          currency: invoice.currency,
          customer: customerId,
          automatic_payment_methods: { enabled: true },
          metadata: {
            subscriptionId: subscription.id,
            invoiceId,
            userId: user._id.toString(),
          },
        });
        // Attach PI to invoice so payment credits the invoice
        await stripe.invoices.attachPayment(invoiceId, {
          payment_intent: paymentIntent.id,
        });
        console.log("Google Pay: created and attached PI:", paymentIntent.id, "amount:", invoice.amount_due);
      } catch (e) {
        console.error("Google Pay: failed to create/attach PI:", e.message);
      }
    }

    if (!paymentIntent?.client_secret) {
      console.error("Google Pay: missing PaymentIntent client_secret", {
        subscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        invoiceId: invoice ? (typeof invoice === "string" ? invoice : invoice.id) : null,
        invoiceStatus: invoice?.status,
      });
      res.status(500).json({ error: "Failed to create payment intent" });
      return;
    }

    console.log("Google Pay intent ready:", subscription.id, "amount:", discount.unitAmount);

    // Save subscription ID so getSubscriptionStatus can find it during polling.
    user.stripeSubscriptionId = subscription.id;
    await user.save();

    res.json({
      clientSecret: paymentIntent.client_secret,
      subscriptionId: subscription.id,
      amount: discount.unitAmount,
    });
  } catch (error) {
    console.error("Google Pay intent error:", error.message || error);
    res.status(500).json({ error: error.message || "Failed to create Google Pay intent" });
  }
});

// ── Confirm Google Pay payment (called by frontend after PI confirmation) ──
// Forces the invoice to be paid and activates the subscription.
checkoutRouter.post("/confirm-google-pay", authMiddleware, async (req, res) => {
  try {
    const { subscriptionId } = req.body;
    const user = await User.findById(req.auth.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const subId = subscriptionId || user.stripeSubscriptionId;
    if (!subId) {
      return res.json({ activated: false });
    }

    let sub;
    try {
      sub = await stripe.subscriptions.retrieve(subId);
    } catch {
      return res.json({ activated: false });
    }

    // Already active — just sync DB
    if (["active", "trialing"].includes(sub.status)) {
      if (user.subscriptionTier !== "pro") {
        user.subscriptionTier = "pro";
        user.stripeSubscriptionId = sub.id;
        if (sub.current_period_end) {
          user.subscriptionExpiry = new Date(sub.current_period_end * 1000);
        }
        const item = sub.items?.data?.[0]?.price?.unit_amount;
        if (item != null) user.subscriptionAmount = item / 100;
        await user.save();
        console.log(`Confirm GP: self-healed ${user.email} to pro (already active)`);
      }
      return res.json({ activated: true });
    }

    // Still incomplete — try to rescue by finding and paying the invoice
    if (sub.status === "incomplete") {
      const invId =
        typeof sub.latest_invoice === "string"
          ? sub.latest_invoice
          : sub.latest_invoice?.id;
      if (!invId) return res.json({ activated: false });

      try {
        const inv = await stripe.invoices.retrieve(invId, {
          expand: ["payments.payment_intent"],
        });

        // Find succeeded PI (basil or legacy)
        let succeededPiId = null;
        if (inv.payments?.data?.length) {
          for (const p of inv.payments.data) {
            if (p.payment?.type === "payment_intent" && p.payment?.payment_intent) {
              const piId =
                typeof p.payment.payment_intent === "string"
                  ? p.payment.payment_intent
                  : p.payment.payment_intent?.id;
              if (piId) {
                const pi = await stripe.paymentIntents.retrieve(piId);
                if (pi.status === "succeeded") {
                  succeededPiId = piId;
                  break;
                }
              }
            }
          }
        }
        // Legacy fallback
        if (!succeededPiId && inv.payment_intent?.status === "succeeded") {
          succeededPiId = inv.payment_intent.id;
        }

        if (succeededPiId) {
          // Manually pay the invoice with the succeeded PI
          await stripe.invoices.pay(invId, { payment_intent: succeededPiId });
          console.log(`Confirm GP: paid invoice ${invId} with PI ${succeededPiId}`);
          sub = await stripe.subscriptions.retrieve(sub.id);
        }
      } catch (e) {
        console.error("Confirm GP: invoice rescue failed:", e.message);
      }
    }

    const isNowActive = ["active", "trialing"].includes(sub.status);
    if (isNowActive && user.subscriptionTier !== "pro") {
      user.subscriptionTier = "pro";
      user.stripeSubscriptionId = sub.id;
      if (sub.current_period_end) {
        user.subscriptionExpiry = new Date(sub.current_period_end * 1000);
      }
      const item = sub.items?.data?.[0]?.price?.unit_amount;
      if (item != null) user.subscriptionAmount = item / 100;
      await user.save();
      console.log(`Confirm GP: ${user.email} activated to pro`);
    }

    res.json({ activated: isNowActive });
  } catch (error) {
    console.error("Confirm GP error:", error.message || error);
    res.json({ activated: false });
  }
});

// ── Subscription status (read-only) ──
// Returns the current state from the database.  Does NOT mutate any user
// fields — the webhook is the sole source of truth for access/subscription state.
checkoutRouter.get("/subscription", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.auth.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    let subscription = null;

    if (user.stripeSubscriptionId) {
      try {
        subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
      } catch {
        // subscription may have been deleted in Stripe
      }
    }

    // If no subscription found yet, search by customer (handles race condition
    // where webhook hasn't fired after checkout).
    if (!subscription && user.stripeCustomerId) {
      try {
        const subs = await stripe.subscriptions.list({
          customer: user.stripeCustomerId,
          limit: 10,
        });
        // Prefer active/trialing
        subscription = subs.data.find(
          (s) => ["active", "trialing"].includes(s.status)
        ) || subs.data[0] || null;
      } catch {
        // ignore
      }
    }

    const isActive =
      subscription && ["active", "trialing"].includes(subscription.status);

    // Self-heal: if Stripe says active but DB says free, sync the DB.
    // This covers the gap between payment confirmation and webhook delivery.
    if (isActive && user.subscriptionTier !== "pro") {
      user.subscriptionTier = "pro";
      user.stripeSubscriptionId = subscription.id;
      user.billingInterval = getInterval(subscription);
      if (subscription.current_period_end) {
        user.subscriptionExpiry = new Date(subscription.current_period_end * 1000);
      }
      const price = subscription.items?.data?.[0]?.price?.unit_amount;
      if (price != null) {
        user.subscriptionAmount = price / 100;
      }
      await user.save();
      console.log(`Self-heal: ${user.email} upgraded to pro via subscription status check`);
    }

    const interval = getInterval(subscription);

    const subscriptionAmount =
      user.subscriptionAmount != null
        ? user.subscriptionAmount
        : subscription?.items?.data?.[0]?.price?.unit_amount != null
          ? subscription.items.data[0].price.unit_amount / 100
          : null;

    res.json({
      tier: user.subscriptionTier,
      expiry: user.subscriptionExpiry,
      isActive: !!isActive,
      plan: interval || null,
      amount: subscriptionAmount,
      label:
        interval === "month"
          ? "Monthly Pro"
          : interval === "year"
            ? "Annual Pro"
            : "Pro",
    });
  } catch (error) {
    console.error("Subscription status error:", error.message || error, error.stack);
    res.status(500).json({ error: "Failed to get subscription status" });
  }
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
    console.error("Portal session error:", error.message || error);
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
      console.error("Webhook signature verification failed:", err.message);
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
          const user = invoice.customer
            ? await User.findOne({ stripeCustomerId: invoice.customer })
            : null;
          const interval = await resolveInvoiceInterval(invoice);

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
              console.error("Failed to retrieve subscription from invoice.paid:", err.message);
            }
          }

          await upsertTransaction({
            invoiceId: invoice.id,
            chargeId: invoice.payment_intent || "",
            subscriptionId: invoice.subscription || "",
            userId: user?._id,
            userEmail: user?.email || invoice.customer_email || "",
            userName: user
              ? `${user.firstName || ""} ${user.lastName || ""}`.trim()
              : "",
            plan: toBillingInterval(interval) || "",
            amount: (invoice.amount_paid || 0) / 100,
            status: "success",
            date: new Date(
              (invoice.status_transitions?.paid_at || invoice.created) * 1000
            ),
          });
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          const user = invoice.customer
            ? await User.findOne({ stripeCustomerId: invoice.customer })
            : null;
          const interval = await resolveInvoiceInterval(invoice);

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
              console.error("Failed to retrieve subscription from invoice.payment_failed:", err.message);
            }
          }

          await upsertTransaction({
            invoiceId: invoice.id,
            chargeId: invoice.payment_intent || "",
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
      console.error(`Error handling webhook event ${event.type}:`, err.message || err);
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

    if (plan !== "annually") {
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
    console.error("Discount code validation error:", error.message);
    res.status(500).json({ error: "Failed to validate discount code" });
  }
});

module.exports = { checkoutRouter, webhookRouter, validateDiscountCodeRouter };
