const mongoose = require("mongoose");
require("dotenv").config();

const { env } = require("../src/config/env");
const { User } = require("../src/models/User");
const { upsertTransaction } = require("../src/services/transactions");

function toBillingInterval(value) {
  if (value === "year" || value === "annually") return "annual";
  if (value === "month" || value === "monthly") return "monthly";
  return undefined;
}

function getInvoiceInterval(invoice) {
  const line = invoice?.lines?.data?.[0];
  return line?.plan?.interval || line?.price?.recurring?.interval || null;
}

async function resolveInterval(stripe, invoice, user) {
  const fromLine = getInvoiceInterval(invoice);
  if (fromLine) return fromLine;

  const candidate =
    invoice.subscription ||
    invoice?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription ||
    user?.stripeSubscriptionId;

  if (candidate) {
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
  return null;
}

(async () => {
  try {
    if (!env.stripeSecretKey) {
      console.error("STRIPE_SECRET_KEY not set");
      process.exit(1);
    }
    const Stripe = require("stripe");
    const stripe = new Stripe(env.stripeSecretKey);

    await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 20000 });

    const users = await User.find({}).select(
      "email firstName lastName subscriptionTier stripeCustomerId stripeSubscriptionId"
    );

    let success = 0;
    let refunded = 0;
    let skipped = 0;

    for (const user of users) {
      if (!user.stripeCustomerId) {
        skipped++;
        continue;
      }

      const name = `${user.firstName || ""} ${user.lastName || ""}`.trim();

      // Paid invoices -> success transactions
      const invoices = await stripe.invoices.list({
        customer: user.stripeCustomerId,
        status: "paid",
        limit: 100,
      });

      for (const inv of invoices.data) {
        const amount = (inv.amount_paid || 0) / 100;
        if (amount <= 0) continue;
        const interval = await resolveInterval(stripe, inv, user);
        const resolvedSubId =
          inv.subscription ||
          inv?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription ||
          "";
        await upsertTransaction({
          invoiceId: inv.id,
          chargeId: inv.payment_intent || "",
          subscriptionId: resolvedSubId,
          userId: user._id,
          userEmail: user.email,
          userName: name,
          plan: toBillingInterval(interval) || "",
          amount,
          status: "success",
          date: new Date(
            (inv.status_transitions?.paid_at || inv.created) * 1000
          ),
        });
        success++;
        console.log(
          `SUCCESS ${user.email} invoice ${inv.id} $${amount.toFixed(2)} ${toBillingInterval(interval) || "?"}`
        );
      }

      // Charges with refunds -> refunded transactions
      const charges = await stripe.charges.list({
        customer: user.stripeCustomerId,
        limit: 100,
      });
      for (const ch of charges.data) {
        if (!ch.refunded) continue;
        const amount = (ch.amount_refunded || 0) / 100;
        if (amount <= 0) continue;
        await upsertTransaction({
          invoiceId: ch.invoice || "",
          chargeId: ch.id,
          subscriptionId: "",
          userId: user._id,
          userEmail: user.email,
          userName: name,
          plan: "",
          amount,
          status: "refunded",
          date: new Date((ch.refunded_at || ch.created) * 1000),
        });
        refunded++;
        console.log(`REFUND ${user.email} charge ${ch.id} $${amount.toFixed(2)}`);
      }
    }

    console.log(`Done. success=${success} refunded=${refunded} skippedNoCustomer=${skipped}`);
  } catch (err) {
    console.error("ERR:", err.message || err);
  } finally {
    await mongoose.disconnect();
  }
})();
