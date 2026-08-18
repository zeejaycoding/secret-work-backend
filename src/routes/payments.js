const express = require("express");
const { Router } = require("express");
const Stripe = require("stripe");
const { User } = require("../models/User");
const Plan = require("../models/Plan");
const Transaction = require("../models/Transaction");
const DiscountCode = require("../models/DiscountCode");
const { env } = require("../config/env");
const { authMiddleware } = require("../middleware/auth");
const { upsertTransaction } = require("../services/transactions");

const stripe = new Stripe(env.stripeSecretKey);

const PLAN_PRICES = {
  monthly: { amount: 950, interval: "month", label: "Monthly Pro" },
  annually: { amount: 7900, interval: "year", label: "Annual Pro" },
};

// Read the current price/interval/label for a checkout plan from the DB,
// falling back to the static defaults when not configured yet.
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

// Map Stripe/plan interval values to our billingInterval field
function toBillingInterval(value) {
  if (value === "year" || value === "annually") return "annual";
  if (value === "month" || value === "monthly") return "monthly";
  return undefined;
}

// Stripe stores the recurring interval on subscription items as plan.interval
// (and price.recurring.interval), not plan.recurring.interval.
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

// Some invoices (e.g. initial checkout invoices in newer Stripe API versions)
// don't carry the interval on the line item or top-level subscription field.
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

const checkoutRouter = Router();

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

    const selectedPlan = await getPlanConfig(plan);

    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user._id.toString() },
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await user.save();
    }

    let unitAmount = selectedPlan.amount;
    if (discountCode && plan === "annually") {
      const dc = await DiscountCode.findOne({
        code: discountCode.toUpperCase().trim(),
        active: true,
      });
      if (dc && (!dc.expiresAt || new Date(dc.expiresAt) >= new Date())) {
        if (!dc.usageLimit || dc.usedCount < dc.usageLimit) {
          unitAmount = Math.max(0, unitAmount - (dc.discountAmount * 100));
        }
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: selectedPlan.label,
              description: "Secret Work Pro Subscription",
            },
            unit_amount: unitAmount,
            recurring: { interval: selectedPlan.interval },
          },
          quantity: 1,
        },
      ],
      success_url: `${env.frontendUrl.split(",").pop()}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.frontendUrl.split(",").pop()}/payment-cancel`,
      metadata: { userId: user._id.toString(), plan, discountCode: discountCode || "" },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error("Checkout session error:", error.message || error);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ── Native PaymentSheet subscription (Apple Pay / Google Pay / Card) ──
// Step 1: Create a SetupIntent so PaymentSheet can collect the payment method
checkoutRouter.post("/setup-intent", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.auth.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user._id.toString() },
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await user.save();
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: setupIntent.client_secret, customerId });
  } catch (error) {
    console.error("Setup intent error:", error.message || error);
    res.status(500).json({ error: "Failed to create setup intent" });
  }
});

// Step 2: After PaymentSheet success, create the subscription with the saved payment method
checkoutRouter.post("/subscription", authMiddleware, async (req, res) => {
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

    if (!user.stripeCustomerId) {
      res.status(400).json({ error: "No payment method on file" });
      return;
    }

    const selectedPlan = await getPlanConfig(plan);

    let unitAmount = selectedPlan.amount;
    if (discountCode && plan === "annually") {
      const dc = await DiscountCode.findOne({
        code: discountCode.toUpperCase().trim(),
        active: true,
      });
      if (dc && (!dc.expiresAt || new Date(dc.expiresAt) >= new Date())) {
        if (!dc.usageLimit || dc.usedCount < dc.usageLimit) {
          unitAmount = Math.max(0, unitAmount - (dc.discountAmount * 100));
        }
      }
    }

    // Check for existing active subscription
    const existingSubs = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      status: "active",
      limit: 1,
    });
    if (existingSubs.data.length > 0) {
      const existing = existingSubs.data[0];
      console.log("User already has active subscription:", existing.id);
      user.subscriptionTier = "pro";
      user.stripeSubscriptionId = existing.id;
      user.billingInterval = toBillingInterval(getInterval(existing));
      if (existing.current_period_end) {
        user.subscriptionExpiry = new Date(existing.current_period_end * 1000);
      }
      await user.save();
      return res.json({ subscriptionId: existing.id, alreadyPaid: true });
    }

    const product = await stripe.products.create({
      name: selectedPlan.label,
      metadata: { userId: user._id.toString(), plan },
    });

    const price = await stripe.prices.create({
      currency: "usd",
      unit_amount: unitAmount,
      recurring: { interval: selectedPlan.interval },
      product: product.id,
    });

    const subscription = await stripe.subscriptions.create({
      customer: user.stripeCustomerId,
      items: [{ price: price.id }],
      default_payment_method: await getDefaultPaymentMethod(user.stripeCustomerId),
      metadata: { userId: user._id.toString(), plan, discountCode: discountCode || "" },
    });

    console.log("Subscription created:", subscription.id, "status:", subscription.status);

    // Subscription should be active since we charged the saved payment method
    if (subscription.status === "active") {
      user.subscriptionTier = "pro";
      user.stripeSubscriptionId = subscription.id;
      user.billingInterval = toBillingInterval(getInterval(subscription));
      if (subscription.current_period_end) {
        user.subscriptionExpiry = new Date(subscription.current_period_end * 1000);
      }
      const item = subscription.items?.data?.[0];
      const priceAmount = item?.price?.unit_amount || item?.plan?.amount;
      if (priceAmount != null) user.subscriptionAmount = priceAmount / 100;
      await user.save();
    }

    res.json({ subscriptionId: subscription.id, alreadyPaid: subscription.status === "active" });
  } catch (error) {
    console.error("Create subscription error:", error.message || error);
    res.status(500).json({ error: error.message || "Failed to create subscription" });
  }
});

async function getDefaultPaymentMethod(customerId) {
  try {
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
      limit: 1,
    });
    return paymentMethods.data[0]?.id || null;
  } catch {
    return null;
  }
}

checkoutRouter.get("/subscription", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.auth.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    let subscription = null;

    // If we already have a subscription ID, fetch it directly
    if (user.stripeSubscriptionId) {
      try {
        subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
      } catch {
        // subscription may have been deleted in Stripe
      }
    }

    // If no subscription found yet, search by customer (handles race condition
    // where webhook hasn't fired after checkout)
    if (!subscription && user.stripeCustomerId) {
      try {
        const subs = await stripe.subscriptions.list({
          customer: user.stripeCustomerId,
          status: "active",
          limit: 1,
        });
        if (subs.data.length > 0) {
          subscription = subs.data[0];
          // Sync to DB so we don't have to search next time
          user.stripeSubscriptionId = subscription.id;
        }
      } catch {
        // ignore
      }
    }

    const isActive =
      subscription && ["active", "trialing"].includes(subscription.status);

    const interval = getInterval(subscription);

    const subscriptionAmount =
      user.subscriptionAmount != null
        ? user.subscriptionAmount
        : subscription?.items?.data?.[0]?.price?.unit_amount != null
          ? subscription.items.data[0].price.unit_amount / 100
          : null;

    // Upgrade user if Stripe shows an active subscription
    if (isActive && user.subscriptionTier !== "pro") {
      user.subscriptionTier = "pro";
      user.stripeSubscriptionId = subscription.id;
      user.billingInterval = toBillingInterval(interval);
      if (subscriptionAmount != null) user.subscriptionAmount = subscriptionAmount;
      if (subscription.current_period_end) {
        user.subscriptionExpiry = new Date(subscription.current_period_end * 1000);
      }
      await user.save();
      console.log(`User ${user.email} upgraded to pro via subscription check`);
    } else if (isActive && user.subscriptionAmount == null && subscriptionAmount != null) {
      user.subscriptionAmount = subscriptionAmount;
      await user.save();
    }

    // Downgrade if subscription expired
    if (user.subscriptionTier === "pro" && !isActive) {
      user.subscriptionTier = "free";
      user.stripeSubscriptionId = undefined;
      user.subscriptionExpiry = undefined;
      user.billingInterval = undefined;
      await user.save();
    }

    // Fallback: record a transaction for an active subscription even if the
    // Stripe webhook never fired. The app polls this endpoint after checkout,
    // so this guarantees admin subscription history + revenue chart update.
    if (isActive && subscription) {
      try {
        const item = subscription?.items?.data?.[0];
        const priceAmount = item?.price?.unit_amount || item?.plan?.amount;
        const txAmount = priceAmount != null ? priceAmount / 100 : null;
        const invoiceId = subscription.latest_invoice || "";
        const txPlan = toBillingInterval(interval) || "";

        const existing = invoiceId
          ? await Transaction.findOne({ stripeInvoiceId: invoiceId })
          : await Transaction.findOne({
              stripeSubscriptionId: subscription.id || "",
              plan: txPlan,
              status: "success",
            });

        if (!existing) {
          await upsertTransaction({
            invoiceId: invoiceId || "",
            chargeId: "",
            subscriptionId: subscription.id || "",
            userId: user._id,
            userEmail: user.email,
            userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
            plan: txPlan,
            amount: txAmount,
            status: "success",
            date: subscription.current_period_start
              ? new Date(subscription.current_period_start * 1000)
              : new Date(),
          });
        }
      } catch (txErr) {
        console.error("Fallback transaction record error:", txErr.message || txErr);
      }
    }

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
    console.error("Subscription status error:", error.message || error);
    res.status(500).json({ error: "Failed to get subscription status" });
  }
});

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

const webhookRouter = Router();

webhookRouter.post(
  "/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    if (!env.stripeWebhookSecret) {
      console.warn("STRIPE_WEBHOOK_SECRET not set — skipping webhook verification");
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

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const userId = session.metadata?.userId;

          if (userId) {
            const user = await User.findById(userId);
            if (user) {
              user.subscriptionTier = "pro";
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
              console.log(`User ${user.email} upgraded to pro`);

              try {
                await upsertTransaction({
                  invoiceId: session.invoice || "",
                  chargeId: session.payment_intent || "",
                  subscriptionId: session.subscription || "",
                  userId: user._id,
                  userEmail: user.email,
                  userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
                  plan: toBillingInterval(session.metadata?.plan) || "",
                  amount: (session.amount_total || 0) / 100,
                  status: "success",
                  date: new Date(),
                  discountCode: session.metadata?.discountCode || "",
                });

                if (session.metadata?.discountCode) {
                  const dc = await DiscountCode.findOne({ code: session.metadata.discountCode.toUpperCase() });
                  if (dc && !dc.usedBy.includes(user._id)) {
                    dc.usedCount += 1;
                    dc.usedBy.push(user._id);
                    await dc.save();
                    console.log(`Discount code ${dc.code} used by ${user.email} (count: ${dc.usedCount})`);
                  }
                }
              } catch (txErr) {
                console.error("Record checkout transaction error:", txErr.message || txErr);
              }
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

          // Upgrade user to pro on successful payment
          if (user && invoice.subscription) {
            // Fetch the subscription to confirm its status
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
          // Use the latest individual refund amount, not cumulative amount_refunded
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
            if (["active", "trialing"].includes(subscription.status)) {
              user.subscriptionTier = "pro";
              user.billingInterval = toBillingInterval(getInterval(subscription));
              if (subscription.current_period_end) {
                user.subscriptionExpiry = new Date(subscription.current_period_end * 1000);
              }
            } else if (["canceled", "unpaid", "incomplete_expired"].includes(subscription.status)) {
              // Only remove pro access on definitive cancellation/failure states.
              // past_due keeps pro access while Stripe retries payment.
              user.subscriptionTier = "free";
              user.stripeSubscriptionId = undefined;
              user.subscriptionExpiry = undefined;
              user.billingInterval = undefined;
            }
            // past_due, incomplete — keep current tier, Stripe will retry
            await user.save();
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
    }

    res.json({ received: true });
  }
);

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
      message: `Discount ${dc.discountAmount} off applied to annual plan`,
    });
  } catch (error) {
    console.error("Discount code validation error:", error.message);
    res.status(500).json({ error: "Failed to validate discount code" });
  }
});

module.exports = { checkoutRouter, webhookRouter, validateDiscountCodeRouter };
