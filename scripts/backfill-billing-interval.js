const mongoose = require("mongoose");
require("dotenv").config();

const { env } = require("../src/config/env");
const { User } = require("../src/models/User");

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

(async () => {
  try {
    if (!env.stripeSecretKey) {
      console.error("STRIPE_SECRET_KEY not set in .env");
      process.exit(1);
    }
    const Stripe = require("stripe");
    const stripe = new Stripe(env.stripeSecretKey);

    await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 20000 });

    const users = await User.find({
      subscriptionTier: { $in: ["pro", "premium"] },
    }).select("email firstName lastName subscriptionTier billingInterval stripeCustomerId stripeSubscriptionId");

    console.log(`Found ${users.length} pro/premium users`);
    let updated = 0;

    for (const user of users) {
      if (user.billingInterval) {
        console.log(`SKIP ${user.email} (billingInterval=${user.billingInterval})`);
        continue;
      }
      let subscription = null;
      if (user.stripeSubscriptionId) {
        try {
          subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        } catch (e) {
          console.log(`  retrieve sub failed for ${user.email}: ${e.message}`);
        }
      }
      if (!subscription && user.stripeCustomerId) {
        try {
          const subs = await stripe.subscriptions.list({
            customer: user.stripeCustomerId,
            status: "all",
            limit: 3,
          });
          subscription = subs.data[0] || null;
        } catch (e) {
          console.log(`  list subs failed for ${user.email}: ${e.message}`);
        }
      }
      if (!subscription) {
        console.log(`NO SUB found for ${user.email} (cid=${user.stripeCustomerId})`);
        continue;
      }
      const interval = getInterval(subscription);
      const bi = toBillingInterval(interval);
      if (!bi) {
        console.log(`NO INTERVAL for ${user.email} (status=${subscription.status})`);
        continue;
      }
      user.billingInterval = bi;
      await user.save();
      updated++;
      console.log(`SET ${user.email} -> ${bi} (sub ${subscription.status})`);
    }

    console.log(`Done. Updated ${updated} users.`);
  } catch (err) {
    console.error("ERR:", err.message || err);
  } finally {
    await mongoose.disconnect();
  }
})();
