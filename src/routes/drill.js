const { Router } = require("express");
const Drill = require("../models/Drill");

const router = Router();

// ── Drills: Public List (published only) ──
router.get("/", async (req, res) => {
  try {
    const drills = await Drill.find({ status: "published" }).sort({
      createdAt: -1,
    });
    res.json({ drills });
  } catch (error) {
    console.error("Public list drills error:", error);
    res.status(500).json({ error: "Failed to fetch drills" });
  }
});

// ── Drills: Public Get Single ──
router.get("/:id", async (req, res) => {
  try {
    const drill = await Drill.findById(req.params.id);
    if (!drill) return res.status(404).json({ error: "Drill not found" });
    res.json({ drill });
  } catch (error) {
    console.error("Public get drill error:", error);
    res.status(500).json({ error: "Failed to fetch drill" });
  }
});

module.exports = router;
