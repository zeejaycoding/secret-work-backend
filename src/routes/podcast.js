const { Router } = require("express");
const Podcast = require("../models/Podcast");
const { authMiddleware } = require("../middleware/auth");
const { User } = require("../models/User");

const router = Router();

const proOnly = async (req, res, next) => {
  try {
    const user = await User.findById(req.auth.userId).select("subscriptionTier");
    if (!user) return res.status(401).json({ error: "User not found" });
    if (user.subscriptionTier !== "pro" && user.subscriptionTier !== "premium") {
      return res.status(403).json({ error: "Pro subscription required", requiresPro: true });
    }
    next();
  } catch (error) {
    console.error("Pro check error:", error);
    res.status(500).json({ error: "Failed to verify subscription" });
  }
};

// ── Podcasts: List (published only, pro only) ──
router.get("/", authMiddleware, proOnly, async (req, res) => {
  try {
    const podcasts = await Podcast.find({ status: "Published" }).sort({
      createdAt: -1,
    });
    res.json({ podcasts });
  } catch (error) {
    console.error("Public list podcasts error:", error);
    res.status(500).json({ error: "Failed to fetch podcasts" });
  }
});

// ── Podcasts: Get Single (pro only) ──
router.get("/:id", authMiddleware, proOnly, async (req, res) => {
  try {
    const podcast = await Podcast.findById(req.params.id);
    if (!podcast) return res.status(404).json({ error: "Podcast not found" });
    res.json({ podcast });
  } catch (error) {
    console.error("Public get podcast error:", error);
    res.status(500).json({ error: "Failed to fetch podcast" });
  }
});

// ── Podcasts: Increment plays (pro only) ──
router.post("/:id/play", authMiddleware, proOnly, async (req, res) => {
  try {
    const podcast = await Podcast.findById(req.params.id);
    if (!podcast) return res.status(404).json({ error: "Podcast not found" });
    podcast.plays = (podcast.plays || 0) + 1;
    await podcast.save();
    res.json({ podcast });
  } catch (error) {
    console.error("Increment podcast plays error:", error);
    res.status(500).json({ error: "Failed to update podcast" });
  }
});

// ── Podcasts: Report playback progress (pro only) ──
router.post("/:id/progress", authMiddleware, proOnly, async (req, res) => {
  try {
    const podcast = await Podcast.findById(req.params.id);
    if (!podcast) return res.status(404).json({ error: "Podcast not found" });

    const listenedSec = Math.max(0, Number(req.body.listenedSec) || 0);
    const completion = Number(req.body.completion);

    if (listenedSec > 0) {
      podcast.watchTimeSec = (podcast.watchTimeSec || 0) + listenedSec;
    }

    if (Number.isFinite(completion) && completion >= 0) {
      const c = Math.min(100, Math.round(completion));
      const count = podcast.completionCount || 0;
      podcast.completion = Math.round(
        ((podcast.completion || 0) * count + c) / (count + 1)
      );
      podcast.completionCount = count + 1;
    }

    await podcast.save();
    res.json({ podcast });
  } catch (error) {
    console.error("Podcast progress error:", error);
    res.status(500).json({ error: "Failed to update progress" });
  }
});

module.exports = router;
