const { Router } = require("express");
const Program = require("../models/Program");
const Drill = require("../models/Drill");
const Pro = require("../models/Pro");

const router = Router();

function visibleProgramDrills(program) {
  const removed = (program.removedDrills || []).map((r) => String(r._id || r));
  return (program.drills || [])
    .filter((d) => d.drill && !removed.has(String(d.drill._id || d.drill)))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function toSectionCard(program) {
  const plain = program._doc || program;
  const coachName = plain.coach || "";
  const title = coachName
    ? `${coachName} ${plain.name.replace(/^Workout:\s*/i, "")}`
    : plain.name;

  return {
    id: String(plain._id),
    title,
    workouts: (plain.drills || [])
      .map((item) => {
        const d = item.drill;
        if (!d) return null;
        const drill = d._doc || d;
        return {
          id: String(drill._id),
          name: drill.title || drill.name || "",
          level: drill.level || "",
          duration: drill.duration || "",
          image: drill.imageUrl || "",
        };
      })
      .filter(Boolean),
  };
}

// ── Workouts: Public Sections (published programs only) ──
router.get("/", async (req, res) => {
  try {
    const programs = await Program.find({ status: "published" })
      .populate("drills.drill")
      .sort({ createdAt: 1 });

    const sections = programs.map(toSectionCard).filter((s) => s.workouts.length);
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

// ── Workouts: Coach Profile Detail ──
router.get("/:id", async (req, res) => {
  try {
    const program = await Program.findById(req.params.id).populate("drills.drill");
    if (!program) {
      return res.status(404).json({ error: "Workout not found" });
    }

    const coachId = program.coachId;
    let pro = null;
    if (coachId) {
      pro = await Pro.findById(coachId);
    }

    const drills = visibleProgramDrills(program);
    const videos = drills
      .map((item) => {
        const d = item.drill;
        if (!d) return null;
        const drill = d._doc || d;
        return {
          id: String(drill._id),
          title: drill.title || "",
          category: drill.category || "",
          duration: drill.duration || "20 secs",
          reps: "5 Reps",
          image: drill.imageUrl || "",
          videoUrl: drill.videoUrl || "",
        };
      })
      .filter(Boolean);

    const stats = {
      followers: pro?.followersCount ? `${pro.followersCount}k` : "12k",
      videos: pro?.sessions || videos.length,
      yearsExp: pro?.yearsOfExperience || 10,
    };

    res.json({
      workout: {
        id: String(program._id),
        coachName: program.coach || pro?.name || "Coach",
        team: pro?.team || "Professional Trainer",
        description: program.description || "",
        image: program.imageUrl || "",
        stats,
        videos,
      },
    });
  } catch (error) {
    console.error("Public workout detail error:", error);
    res.status(500).json({ error: "Failed to fetch workout" });
  }
});

module.exports = router;
