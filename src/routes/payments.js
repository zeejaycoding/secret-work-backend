const express = require("express");
const { Router } = require("express");
const Stripe = require("stripe");
const { User } = require("../models/User");
const { env } = require("../config/env");
const { authMiddleware } = require("../middleware/auth");

const stripe = new Stripe(env.stripeSecretKey);

const PLAN_PRICES = {
  monthly: { amount: 950, interval: "month", label: "Monthly Pro" },
  annually: { amount: 7900, interval: "year", label: "Annual Pro" },
};

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

    const selectedPlan = PLAN_PRICES[plan];

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
      success_url: `${env.frontendUrl.split(",")[0]}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.frontendUrl.split(",")[0]}/payment-cancel`,
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

    // Upgrade user if Stripe shows an active subscription
    if (isActive && user.subscriptionTier !== "pro") {
      user.subscriptionTier = "pro";
      user.stripeSubscriptionId = subscription.id;
      if (subscription.current_period_end) {
        user.subscriptionExpiry = new Date(subscription.current_period_end * 1000);
      }
      await user.save();
      console.log(`User ${user.email} upgraded to pro via subscription check`);
    }

    // Downgrade if subscription expired
    if (user.subscriptionTier === "pro" && !isActive) {
      user.subscriptionTier = "free";
      user.stripeSubscriptionId = undefined;
      user.subscriptionExpiry = undefined;
      await user.save();
    }

    res.json({
      tier: user.subscriptionTier,
      expiry: user.subscriptionExpiry,
      isActive: !!isActive,
      plan:
        subscription?.items?.data?.[0]?.plan?.recurring?.interval || null,
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
            }
          }
          break;
        }

        case "customer.subscription.updated": {
          const subscription = event.data.object;
          const user = await User.findOne({ stripeSubscriptionId: subscription.id });
          if (user) {
            if (["active", "trialing"].includes(subscription.status)) {
              user.subscriptionTier = "pro";
              if (subscription.current_period_end) {
                user.subscriptionExpiry = new Date(subscription.current_period_end * 1000);
              }
            } else {
              user.subscriptionTier = "free";
              user.stripeSubscriptionId = undefined;
              user.subscriptionExpiry = undefined;
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
            await user.save();
            console.log(`User ${user.email} downgraded to free`);
          }
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          if (invoice.subscription) {
            const user = await User.findOne({ stripeSubscriptionId: invoice.subscription });
            if (user) {
              console.log(`Payment failed for ${user.email} - subscription ${invoice.subscription}`);
            }
          }
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
