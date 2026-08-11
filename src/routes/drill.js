const { Router } = require("express");
const Drill = require("../models/Drill");
const Like = require("../models/Like");
const { authMiddleware } = require("../middleware/auth");

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

// ── Drills: Record a view (increments drill views) ──
router.post("/:id/view", async (req, res) => {
  try {
    const drill = await Drill.findById(req.params.id);
    if (!drill) return res.status(404).json({ error: "Drill not found" });

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    await Drill.updateOne(
      { _id: req.params.id },
      [
        {
          $set: {
            views: { $add: ["$views", 1] },
            viewsHistory: {
              $cond: [
                { $in: [dayStart, "$viewsHistory.date"] },
                {
                  $map: {
                    input: "$viewsHistory",
                    as: "vh",
                    in: {
                      $cond: [
                        { $eq: ["$$vh.date", dayStart] },
                        { date: dayStart, count: { $add: ["$$vh.count", 1] } },
                        "$$vh",
                      ],
                    },
                  },
                },
                {
                  $concatArrays: [
                    { $ifNull: ["$viewsHistory", []] },
                    [{ date: dayStart, count: 1 }],
                  ],
                },
              ],
            },
          },
        },
      ]
    );

    res.json({ success: true, views: drill.views + 1 });
  } catch (error) {
    console.error("Record drill view error:", error);
    res.status(500).json({ error: "Failed to record drill view" });
  }
});

// ── Drills: Toggle like for a drill (requires auth, per-user) ──
router.post("/:id/like", authMiddleware, async (req, res) => {
  try {
    const drill = await Drill.findById(req.params.id);
    if (!drill) return res.status(404).json({ error: "Drill not found" });

    const existing = await Like.findOne({
      user: req.auth.userId,
      drill: drill._id,
    });

    let liked;
    if (existing) {
      await Like.deleteOne({ _id: existing._id });
      await Drill.updateOne({ _id: drill._id }, { $inc: { likes: -1 } });
      liked = false;
    } else {
      await Like.create({ user: req.auth.userId, drill: drill._id });
      await Drill.updateOne({ _id: drill._id }, { $inc: { likes: 1 } });
      liked = true;
    }

    const updated = await Drill.findById(drill._id).select("likes");
    res.json({ liked, likes: updated ? updated.likes : 0 });
  } catch (error) {
    console.error("Toggle drill like error:", error);
    res.status(500).json({ error: "Failed to update drill like" });
  }
});

module.exports = router;
