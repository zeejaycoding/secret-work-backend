const DEFAULT_PLANS = {
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
    price: { amount: 5.99, interval: "month" },
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
    price: { amount: 60, interval: "year" },
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

function formatPriceLabel(price) {
  const amount = Number(price?.amount) || 0;
  if (!amount) return "$0";
  const num = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const interval = price?.interval === "year" ? "/yr" : price?.interval === "month" ? "/mo" : "";
  return `$${num}${interval}`;
}

module.exports = { DEFAULT_PLANS, formatPriceLabel };
