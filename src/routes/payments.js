const express = require("express");
const { Router } = require("express");
const Stripe = require("stripe");
const { User } = require("../models/User");
const Plan = require("../models/Plan");
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
    const { plan } = req.body;

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
            unit_amount: selectedPlan.amount,
            recurring: { interval: selectedPlan.interval },
          },
          quantity: 1,
        },
      ],
      success_url: `${env.frontendUrl.split(",").pop()}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.frontendUrl.split(",").pop()}/payment-cancel`,
      metadata: { userId: user._id.toString(), plan },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error("Checkout session error:", error.message || error);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

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
                });
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
            date: new Date((invoice.created || Date.now()) * 1000),
          });
          break;
        }

        case "charge.refunded": {
          const charge = event.data.object;
          const user = charge.customer
            ? await User.findOne({ stripeCustomerId: charge.customer })
            : null;
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
            amount: (charge.amount_refunded || 0) / 100,
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
            } else {
              user.subscriptionTier = "free";
              user.stripeSubscriptionId = undefined;
              user.subscriptionExpiry = undefined;
              user.billingInterval = undefined;
            }
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
            date: new Date((subscription.canceled_at || Date.now()) * 1000),
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

module.exports = { checkoutRouter, webhookRouter };
