const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { env } = require("./config/env");
const Plan = require("./models/Plan");
const DiscountCode = require("./models/DiscountCode");

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/secret-work";

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log(`MongoDB connected: ${mongoose.connection.host}`);
  } catch (error) {
    console.error("MongoDB connection error:", error.message);
    process.exit(1);
  }
}

async function upsertPlan(key, defaults) {
  let plan = await Plan.findOne({ key });
  if (!plan) {
    plan = await Plan.create({ ...defaults, key });
    console.log(`Plan created: ${key}`);
  } else {
    if (!plan.label || plan.label === "") {
      plan.label = defaults.label;
      await plan.save();
      console.log(`Plan updated label: ${key} -> ${defaults.label}`);
    }
    if (!plan.price || plan.price.amount === 0) {
      plan.price = { amount: defaults.price.amount, interval: defaults.price.interval };
      await plan.save();
      console.log(`Plan updated price: ${key} -> $${defaults.price.amount}.${defaults.price.interval}`);
    }
    if (!plan.benefits || plan.benefits.length === 0) {
      plan.benefits = defaults.benefits;
      await plan.save();
      console.log(`Plan updated benefits: ${key} -> ${defaults.benefits.length} benefits`);
    }
    if (plan._id) {
      console.log(`Plan exists: ${key} — already configured`);
    }
  }
  return plan;
}

async function seedDiscountCodes() {
  const codes = [
    { code: "COOP20", discountAmount: 5, applicablePlan: "annual" },
    { code: "REDSHOE85", discountAmount: 5, applicablePlan: "annual" },
    { code: "CA10", discountAmount: 5, applicablePlan: "annual" },
    { code: "DESTBO", discountAmount: 5, applicablePlan: "annual" },
    { code: "JKENT20", discountAmount: 5, applicablePlan: "annual" },
    { code: "LW3", discountAmount: 5, applicablePlan: "annual" },
  ];

  for (const cd of codes) {
    const existing = await DiscountCode.findOne({ code: cd.code });
    if (!existing) {
      const dc = new DiscountCode({ ...cd, active: true });
      await dc.save();
      console.log(`Discount code created: ${cd.code} ($${cd.discountAmount} off annual)`);
    } else {
      console.log(`Discount code already exists: ${cd.code}`);
    }
  }
  console.log(`Total discount codes: ${await DiscountCode.countDocuments({ applicablePlan: "annual" })}`);
}

async function main() {
  await connectDB();
  console.log("=== PSS: Product Subscription Script ===\n");

  // Seed plans
  console.log("\n--- Planning ---");
  const planDefaults = {
    free: {
      key: "free",
      label: "Free",
      price: { amount: 0, interval: "" },
      benefits: [
        { text: "Access to Free Drills", enabled: true },
        { text: "Track Your Progress", enabled: true },
        { text: "Basic Profile", enabled: true },
      ],
    },
    monthly: {
      key: "monthly",
      label: "Monthly Pro",
      price: { amount: 9.5, interval: "month" },
      benefits: [
        { text: "Unlimited Access to All Drills", enabled: true },
        { text: "Structured Workouts That Actually Improve You", enabled: true },
        { text: "Learn From Real Game Situations", enabled: true },
        { text: "Faster Progress With Guided Sessions", enabled: true },
        { text: "New Drills Added Regularly", enabled: true },
      ],
    },
    annual: {
      key: "annual",
      label: "Annual Pro",
      price: { amount: 79, interval: "year" },
      benefits: [
        { text: "Unlimited Access to All Drills", enabled: true },
        { text: "Structured Workouts That Actually Improve You", enabled: true },
        { text: "Learn From Real Game Situations", enabled: true },
        { text: "Faster Progress With Guided Sessions", enabled: true },
        { text: "New Drills Added Regularly", enabled: true },
        { text: "Best Value — Save With Annual Billing", enabled: true },
      ],
    },
  };

  for (const [key, defaults] of Object.entries(planDefaults)) {
    await upsertPlan(key, defaults);
  }

  // Seed discount codes
  console.log("\n--- Discount Codes ---");
  await seedDiscountCodes();

  // Ensure webhook is configured for discount code tracking
  console.log("\n=== PSS Complete ===");
  console.log("Run again to confirm idempotency:");
  await connectDB();
}

main().catch((err) => {
  console.error("PSS failed:", err.message || err);
  process.exit(1);
});
