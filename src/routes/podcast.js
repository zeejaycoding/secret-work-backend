const { Router } = require("express");
const Podcast = require("../models/Podcast");

const router = Router();

// ── Podcasts: Public List (published only) ──
router.get("/", async (req, res) => {
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

// ── Podcasts: Public Get Single ──
router.get("/:id", async (req, res) => {
  try {
    const podcast = await Podcast.findById(req.params.id);
    if (!podcast) return res.status(404).json({ error: "Podcast not found" });
    res.json({ podcast });
  } catch (error) {
    console.error("Public get podcast error:", error);
    res.status(500).json({ error: "Failed to fetch podcast" });
  }
});

// ── Podcasts: Increment plays ──
router.post("/:id/play", async (req, res) => {
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

module.exports = router;
