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
    console.log("Error cancelling abandoned subscriptions:", err.message);
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
    console.log("Checkout session error:", error.message || error);
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
      payment_method_types: ["card"],
    });

    res.json({
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
      customerId,
    });
  } catch (error) {
    console.log("Setup intent error:", error.message || error);
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

    // Always save the subscription ID so GET /subscription can find it during polling.
    user.stripeSubscriptionId = subscription.id;
    await user.save();
    console.log(`Subscription: created ${subscription.id} for ${user.email} (status: ${subscription.status})`);

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
          expand: ["payments.data.payment_intent"],
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
        console.log("Subscription: failed to retrieve invoice manually:", e.message);
      }
    }

    // If subscription was created as active/trialing, we're done.
    if (["active", "trialing"].includes(subscription.status)) {
      if (user.subscriptionTier !== "pro") {
        user.subscriptionTier = "pro";
        if (subscription.current_period_end) {
          user.subscriptionExpiry = new Date(subscription.current_period_end * 1000);
        }
        await user.save();
        console.log(`Subscription: self-healed ${user.email} to pro (created ${subscription.status})`);
      }
      res.json({ subscriptionId: subscription.id, alreadyPaid: true });
      return;
    }

    // Subscription is incomplete — try to force-pay the invoice.
    // With default_payment_method set, Stripe should auto-charge, but basil API
    // sometimes needs an explicit trigger. invoices.pay() is safe to call even
    // if the payment is already in progress.
    const invoiceId = typeof invoice === "string" ? invoice : invoice?.id;
    if (invoiceId) {
      try {
        const paidInvoice = await stripe.invoices.pay(invoiceId, {
          payment_intent: pi?.id,
        });
        console.log(`Subscription: invoice ${invoiceId} pay result: ${paidInvoice.status}`);

        // If invoice paid, refresh subscription status
        if (paidInvoice.status === "paid") {
          const refreshed = await stripe.subscriptions.retrieve(subscription.id);
          if (["active", "trialing"].includes(refreshed.status)) {
            user.subscriptionTier = "pro";
            if (refreshed.current_period_end) {
              user.subscriptionExpiry = new Date(refreshed.current_period_end * 1000);
            }
            await user.save();
            console.log(`Subscription: ${user.email} activated after invoices.pay`);
            res.json({ subscriptionId: subscription.id, alreadyPaid: true });
            return;
          }
        }
      } catch (e) {
        console.log("Subscription: invoices.pay failed:", e.message);
      }
    }

    // Re-retrieve the PI after invoices.pay attempt to get fresh status
    if (pi?.id) {
      try { pi = await stripe.paymentIntents.retrieve(pi.id); } catch {}
    }

    if (pi?.status === "requires_action" && pi?.client_secret) {
      res.json({
        subscriptionId: subscription.id,
        requiresAction: true,
        clientSecret: pi.client_secret,
      });
    } else if (pi?.status === "requires_payment_method") {
      res.status(402).json({ error: "Payment method was declined. Please try a different card." });
    } else {
      // Still incomplete — polling or webhook will handle it
      console.log(`Subscription: ${subscription.id} still incomplete (PI status: ${pi?.status || "unknown"}), polling will catch it`);
      res.json({ subscriptionId: subscription.id, alreadyPaid: false });
    }
  } catch (error) {
    console.log("Create subscription error:", error.message || error);
    res.status(500).json({ error: error.message || "Failed to create subscription" });
  }
});

// ── Google Pay — returns a SetupIntent for the client to confirm with Google Pay.
// After confirmation, the frontend calls POST /subscription with the setupIntentId
// (same flow as the card/PaymentSheet path).
checkoutRouter.post("/google-pay-intent", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.auth.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const customerId = await getOrCreateCustomer(user);

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
    });

    res.json({
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
    });
  } catch (error) {
    console.log("Google Pay intent error:", error.message || error);
    res.status(500).json({ error: error.message || "Failed to create Google Pay intent" });
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
        billingInterval: getInterval(subscription),
        subscriptionExpiry: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : undefined,
        subscriptionAmount: subscription.items?.data?.[0]?.price?.unit_amount != null
          ? subscription.items.data[0].price.unit_amount / 100
          : undefined,
      });
      console.log("[sub-status] self-healed", user.email, "to pro");
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
              console.log("Failed to retrieve subscription from invoice.paid:", err.message);
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
              console.log("Failed to retrieve subscription from invoice.payment_failed:", err.message);
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
    console.log("Discount code validation error:", error.message);
    res.status(500).json({ error: "Failed to validate discount code" });
  }
});

module.exports = { checkoutRouter, webhookRouter, validateDiscountCodeRouter };
