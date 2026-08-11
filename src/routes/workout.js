const { Router } = require("express");
const mongoose = require("mongoose");
const Drill = require("../models/Drill");
const Pro = require("../models/Pro");
const Follow = require("../models/Follow");

const router = Router();

function toVideoShape(drill) {
  return {
    id: String(drill._id),
    title: drill.title || "",
    category: drill.category || "",
    description: drill.description || "",
    level: drill.level || "",
    duration: drill.duration || "20 secs",
    reps: "5 Reps",
    image: drill.imageUrl || "",
    videoUrl: drill.videoUrl || "",
  };
}

// ── Workouts: Public Sections — real published drills grouped by their coach ──
router.get("/", async (req, res) => {
  try {
    const drills = await Drill.find({ status: "published" }).sort({
      createdAt: 1,
    });

    const groups = new Map();
    for (const drill of drills) {
      const coach = (drill.coach || "").trim();
      if (!coach) continue;
      if (!groups.has(coach)) groups.set(coach, []);
      groups.get(coach).push(drill);
    }

    const sections = Array.from(groups.entries())
      .filter(([, list]) => list.length > 0)
      .map(([coach, list]) => ({
        id: coach,
        title: coach,
        workouts: list.map((d) => ({
          id: String(d._id),
          name: d.title || "",
          level: d.level || "",
          duration: d.duration || "",
          image: d.imageUrl || "",
        })),
      }));

    res.json({ workouts: sections });
  } catch (error) {
    console.error("Public workouts list error:", error);
    res.status(500).json({ error: "Failed to fetch workouts" });
  }
});

// ── Workouts: Quick builder (level + categories → up to 5 drills) ──
router.get("/quick", async (req, res) => {
  try {
    const { level, categories } = req.query;
    const filter = { status: "published" };

    if (level && level !== "Random") {
      const levelMap = {
        "Youth/ High school": "Beginner",
        "Youth/High school": "Beginner",
        NCAA: "Intermediate",
        PRO: "Advanced",
      };
      const mapped = levelMap[level] || levelMap[String(level).trim()];
      if (mapped) filter.level = mapped;
    }

    if (categories) {
      const cats = String(categories)
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      const valid = cats.filter((c) => c !== "All" && c !== "Team workout");
      if (valid.length) {
        filter.category = { $in: valid };
      }
    }

    const drills = await Drill.find(filter)
      .sort({ createdAt: -1 })
      .limit(10);

    const mapped = drills.slice(0, 5).map((d) => ({
      id: String(d._id),
      title: d.title,
      subTitle: d.category || "Team workout",
      category: d.category,
      level: d.level,
      duration: d.duration,
      image: d.imageUrl || "",
      videoUrl: d.videoUrl || "",
      reps: "5 Reps",
    }));

    res.json({ drills: mapped });
  } catch (error) {
    console.error("Quick workout builder error:", error);
    res.status(500).json({ error: "Failed to build workout" });
  }
});

// ── Workouts: Coach Profile Detail (real published drills for that pro/coach) ──
router.get("/:id", async (req, res) => {
  try {
    const idOrName = String(req.params.id || "").trim();

    let pro = null;

    if (mongoose.isValidObjectId(idOrName)) {
      pro = await Pro.findById(idOrName);
    }

    if (!pro) {
      pro = await Pro.findOne({
        name: {
          $regex: `^${idOrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          $options: "i",
        },
      });
    }

    if (!pro) {
      // Legacy: id is a plain coach name — return drills whose coach field matches
      const legacyDrills = await Drill.find({
        status: "published",
        coach: idOrName,
      }).sort({ createdAt: 1 });

      if (legacyDrills.length === 0) {
        return res.status(404).json({ error: "Workout not found" });
      }

      const followers = await Follow.countDocuments({ coach: idOrName });

      return res.json({
        workout: {
          id: idOrName,
          coachName: idOrName,
          team: "Professional Trainer",
          description: "",
          image: legacyDrills[0].imageUrl || "",
          stats: {
            followers,
            videos: legacyDrills.length,
            yearsExp: 10,
          },
          videos: legacyDrills.map(toVideoShape),
        },
      });
    }

    const drills = await Drill.find({
      status: "published",
      $or: [
        { proId: pro._id },
        {
          coach: {
            $regex: `^${pro.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            $options: "i",
          },
        },
      ],
    }).sort({ createdAt: 1 });

    if (drills.length === 0) {
      return res.status(404).json({ error: "Workout not found" });
    }

    const followers = await Follow.countDocuments({ coach: pro.name });

    const stats = {
      followers,
      videos: drills.length,
      yearsExp: 10,
    };

    res.json({
      workout: {
        id: String(pro._id),
        coachName: pro.name,
        team: pro.team || "Professional Trainer",
        description: "",
        image: drills[0].imageUrl || pro.imageUrl || "",
        stats,
        videos: drills.map(toVideoShape),
      },
    });
  } catch (error) {
    console.error("Public workout detail error:", error);
    res.status(500).json({ error: "Failed to fetch workout" });
  }
});

module.exports = router;
