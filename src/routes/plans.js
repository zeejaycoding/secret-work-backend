const { Router } = require("express");
const Plan = require("../models/Plan");
const { DEFAULT_PLANS } = require("../config/plans");

const router = Router();

// ── Plans: Public List (used by the app to render pricing/benefits live) ──
router.get("/", async (req, res) => {
  try {
    const docs = await Plan.find().sort({ key: 1 });
    const byKey = {};
    docs.forEach((d) => (byKey[d.key] = d));

    const plans = Object.keys(DEFAULT_PLANS).map((key) => {
      const doc = byKey[key];
      const source = doc || DEFAULT_PLANS[key];
      return {
        key: source.key,
        label: source.label,
        price: {
          amount: Number(source.price?.amount) || 0,
          interval: source.price?.interval || "",
        },
        benefits: (source.benefits || []).map((b) => ({
          text: b.text,
          enabled: !!b.enabled,
        })),
      };
    });

    res.json({ plans });
  } catch (error) {
    console.error("List plans error:", error);
    res.status(500).json({ error: "Failed to fetch plans" });
  }
});

module.exports = router;
