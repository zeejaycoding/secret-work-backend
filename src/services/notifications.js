const { User } = require("../models/User");
const UserNotification = require("../models/UserNotification");
const { sendNotificationEmail } = require("./email");

const CHANNELS = ["push", "inapp", "email"];
const AUDIENCES = ["all", "free", "monthly", "annual", "premium"];

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

function audienceQuery(audience) {
  switch (audience) {
    case "free":
      return { status: "active", subscriptionTier: "free" };
    case "monthly":
      return {
        status: "active",
        subscriptionTier: { $in: ["pro", "premium"] },
        billingInterval: { $ne: "annual" },
      };
    case "annual":
      return {
        status: "active",
        subscriptionTier: { $in: ["pro", "premium"] },
        billingInterval: "annual",
      };
    case "premium":
      return { status: "active", subscriptionTier: "premium" };
    case "all":
    default:
      return { status: "active" };
  }
}

function prefsEnabled(user, channel) {
  const prefs = user.preferences?.notifications || user.notificationPrefs;
  return prefs == null || prefs[channel] !== false;
}

async function resolveAudience(audience) {
  const query = audienceQuery(audience);
  const users = await User.find(query)
    .select("email firstName lastName pushToken notificationPrefs preferences")
    .lean();
  return users;
}

async function targetCount(audience) {
  return User.countDocuments(audienceQuery(audience));
}

async function deliverInApp(campaign, users) {
  const recipients = users.filter((u) => prefsEnabled(u, "inApp"));
  if (!recipients.length) return 0;

  const docs = recipients.map((u) => ({
    userId: u._id,
    title: campaign.title,
    message: campaign.message,
    campaignId: campaign._id,
  }));

  await UserNotification.insertMany(docs);
  return docs.length;
}

async function deliverEmail(campaign, users) {
  const recipients = users.filter(
    (u) => u.email && prefsEnabled(u, "email")
  );

  let delivered = 0;
  let failed = 0;
  await Promise.all(
    recipients.map(async (u) => {
      try {
        await sendNotificationEmail({
          toEmail: u.email,
          title: campaign.title,
          message: campaign.message,
        });
        delivered += 1;
      } catch (error) {
        failed += 1;
        console.error("Email delivery failed for", u.email, ":", error.message);
      }
    })
  );
  return { delivered, failed };
}

async function sendExpoPushBatch(payloads) {
  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payloads),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Expo push returned ${res.status} ${text}`);
  }

  const json = await res.json();
  return (json.data || []).map((item) => (item && item.status === "ok" ? "ok" : "error"));
}

async function deliverPush(campaign, users) {
  const recipients = users.filter(
    (u) => u.pushToken && prefsEnabled(u, "push")
  );
  if (!recipients.length) return { delivered: 0, failed: 0 };

  const payloads = recipients.map((u) => ({
    to: u.pushToken,
    title: campaign.title,
    body: campaign.message,
    sound: "default",
    data: { campaignId: String(campaign._id), channel: "push" },
  }));

  let delivered = 0;
  let failed = 0;

  // Expo accepts up to 100 tokens per request.
  for (let i = 0; i < payloads.length; i += 100) {
    const chunk = payloads.slice(i, i + 100);
    try {
      const results = await sendExpoPushBatch(chunk);
      results.forEach((status) => {
        if (status === "ok") delivered += 1;
        else failed += 1;
      });
    } catch (error) {
      failed += chunk.length;
      console.error("Push delivery error:", error.message || error);
    }
  }
  return { delivered, failed };
}

async function deliverCampaign(campaign) {
  const users = await resolveAudience(campaign.audience);
  campaign.reach = users.length;

  if (campaign.channel === "inapp") {
    campaign.delivered = await deliverInApp(campaign, users);
  } else if (campaign.channel === "email") {
    const result = await deliverEmail(campaign, users);
    campaign.delivered = result.delivered;
    campaign.failedCount = result.failed;
  } else if (campaign.channel === "push") {
    const result = await deliverPush(campaign, users);
    campaign.delivered = result.delivered;
    campaign.failedCount = result.failed;
  }

  campaign.status = "sent";
  campaign.sentAt = new Date();
  campaign.error = undefined;
  await campaign.save();
  return campaign;
}

module.exports = {
  deliverCampaign,
  resolveAudience,
  targetCount,
  audienceQuery,
  CHANNELS,
  AUDIENCES,
};
