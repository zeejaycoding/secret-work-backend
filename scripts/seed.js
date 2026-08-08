/**
 * Seed script — run with: node scripts/seed.js
 * Creates categories, sample drills, and programs in MongoDB
 */

const mongoose = require("mongoose");
require("dotenv").config({ path: __dirname + "/../.env" });

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/secretwork";

const Drill = require("../src/models/Drill");
const Category = require("../src/models/Category");
const Program = require("../src/models/Program");
const Podcast = require("../src/models/Podcast");

const CATEGORIES = [
  { name: "Dribbling", description: "Ball handling and dribbling drills" },
  { name: "Shooting", description: "Shooting mechanics and accuracy drills" },
  { name: "Defence", description: "Defensive positioning and footwork drills" },
  { name: "Passing", description: "Passing accuracy and vision drills" },
  { name: "Fitness", description: "Conditioning and agility drills" },
];

const SAMPLE_DRILLS = [
  {
    title: "Crossover Mastery",
    description: "Learn the basic crossover and develop your handle for driving past defenders.",
    coach: "LeBron James",
    category: "Dribbling",
    status: "published",
    imageUrl: "",
    duration: "12 min",
    views: 15420,
    likes: 1280,
    completionRate: 88,
    avgWatchTime: "5m 40s",
    viewsHistory: [
      { date: new Date("2026-01-15"), count: 2100 },
      { date: new Date("2026-02-15"), count: 3400 },
      { date: new Date("2026-03-15"), count: 4200 },
      { date: new Date("2026-04-15"), count: 5720 },
    ],
  },
  {
    title: "Pull-Up Jumper",
    description: "Develop a reliable mid-range pull-up jumper off the dribble.",
    coach: "Stephen Curry",
    category: "Shooting",
    status: "published",
    imageUrl: "",
    duration: "15 min",
    views: 23100,
    likes: 2150,
    completionRate: 92,
    avgWatchTime: "7m 0s",
    viewsHistory: [
      { date: new Date("2026-01-15"), count: 4500 },
      { date: new Date("2026-02-15"), count: 6200 },
      { date: new Date("2026-03-15"), count: 7100 },
      { date: new Date("2026-04-15"), count: 5300 },
    ],
  },
  {
    title: "Defensive Slide Drill",
    description: "Improve lateral quickness and defensive positioning on the perimeter.",
    coach: "Kawhi Leonard",
    category: "Defence",
    status: "published",
    imageUrl: "",
    duration: "10 min",
    views: 8900,
    likes: 720,
    completionRate: 75,
    avgWatchTime: "4m 40s",
    viewsHistory: [
      { date: new Date("2026-01-15"), count: 1200 },
      { date: new Date("2026-02-15"), count: 2100 },
      { date: new Date("2026-03-15"), count: 2800 },
      { date: new Date("2026-04-15"), count: 2800 },
    ],
  },
  {
    title: "Pocket Pass Workshop",
    description: "Master the pocket pass for finding cutters and open shooters.",
    coach: "Chris Paul",
    category: "Passing",
    status: "published",
    imageUrl: "",
    duration: "8 min",
    views: 6200,
    likes: 580,
    completionRate: 85,
    avgWatchTime: "3m 40s",
    viewsHistory: [
      { date: new Date("2026-01-15"), count: 800 },
      { date: new Date("2026-02-15"), count: 1400 },
      { date: new Date("2026-03-15"), count: 1900 },
      { date: new Date("2026-04-15"), count: 2100 },
    ],
  },
  {
    title: "Suicide Sprint Intervals",
    description: "High-intensity sprint intervals to build game-ready conditioning.",
    coach: "Jimmy Butler",
    category: "Fitness",
    status: "published",
    imageUrl: "",
    duration: "20 min",
    views: 11300,
    likes: 890,
    completionRate: 62,
    avgWatchTime: "8m 20s",
    viewsHistory: [
      { date: new Date("2026-01-15"), count: 1800 },
      { date: new Date("2026-02-15"), count: 2900 },
      { date: new Date("2026-03-15"), count: 3200 },
      { date: new Date("2026-04-15"), count: 3400 },
    ],
  },
  {
    title: "Behind-the-Back Combo",
    description: "Advanced combo move using behind-the-back dribbles to create space.",
    coach: "Kyrie Irving",
    category: "Dribbling",
    status: "draft",
    imageUrl: "",
    duration: "14 min",
    views: 3200,
    likes: 410,
    completionRate: 70,
    avgWatchTime: "5m 10s",
    viewsHistory: [
      { date: new Date("2026-03-15"), count: 1500 },
      { date: new Date("2026-04-15"), count: 1700 },
    ],
  },
  {
    title: "Catch-and-Shoot 3s",
    description: "Simulate game-speed catch-and-shoot three-pointers from various spots.",
    coach: "Klay Thompson",
    category: "Shooting",
    status: "published",
    imageUrl: "",
    duration: "12 min",
    views: 19800,
    likes: 1840,
    completionRate: 90,
    avgWatchTime: "6m 20s",
    viewsHistory: [
      { date: new Date("2026-01-15"), count: 3200 },
      { date: new Date("2026-02-15"), count: 5100 },
      { date: new Date("2026-03-15"), count: 6200 },
      { date: new Date("2026-04-15"), count: 5300 },
    ],
  },
  {
    title: "Closeout Drill",
    description: "Practice contesting shots without fouling using proper closeout technique.",
    coach: "Draymond Green",
    category: "Defence",
    status: "published",
    imageUrl: "",
    duration: "10 min",
    views: 5400,
    likes: 420,
    completionRate: 80,
    avgWatchTime: "4m 20s",
    viewsHistory: [
      { date: new Date("2026-02-15"), count: 1200 },
      { date: new Date("2026-03-15"), count: 1800 },
      { date: new Date("2026-04-15"), count: 2400 },
    ],
  },
];

const SAMPLE_PODCASTS = [
  {
    title: "Episode 45 – Ball Handling Basics",
    host: "Coach Adams",
    type: "Video",
    date: "Jul 28, 2026",
    plays: 18200,
    completion: 84,
    status: "Published",
    duration: "22 min",
    description:
      "A breakdown of core ball handling fundamentals — dribbling under pressure, change of pace, and protecting the rock against aggressive defenders.",
  },
  {
    title: "Episode 44 – Defense Wins Games",
    host: "Coach Marcus",
    type: "Audio",
    date: "Jul 21, 2026",
    plays: 12400,
    completion: 71,
    status: "Published",
    duration: "18 min",
    description:
      "Coach Marcus walks through defensive stance, sliding mechanics, and how to read offensive tendencies to stay a step ahead.",
  },
  {
    title: "Episode 43 – Shooting Mechanics",
    host: "Coach Rivera",
    type: "Video",
    date: "Jul 14, 2026",
    plays: 15800,
    completion: 63,
    status: "Published",
    duration: "25 min",
    description:
      "Coach Rivera breaks down the perfect shooting motion — footwork, release point, and follow-through for a more consistent jumper.",
  },
  {
    title: "Episode 42 – Recovery & Mobility",
    host: "Coach Lee",
    type: "Audio",
    date: "Jul 7, 2026",
    plays: 9100,
    completion: 55,
    status: "Published",
    duration: "20 min",
    description:
      "Practical recovery routines and mobility drills to keep players fresh and injury-free through a long season.",
  },
  {
    title: "Episode 41 – Transition Offense",
    host: "Coach Adams",
    type: "Video",
    date: "Jun 30, 2026",
    plays: 11300,
    completion: 46,
    status: "Scheduled",
    duration: "19 min",
    description:
      "How to push the pace and create easy looks in transition before the defense can get set.",
  },
  {
    title: "Episode 40 – Strength Training",
    host: "Coach Marcus",
    type: "Audio",
    date: "Jun 23, 2026",
    plays: 7600,
    completion: 49,
    status: "Scheduled",
    duration: "24 min",
    description:
      "A gym session focused on basketball-specific strength and power development for in-season athletes.",
  },
];

async function seed() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB");

    // Seed categories
    const catCount = await Category.countDocuments();
    if (catCount === 0) {
      await Category.insertMany(CATEGORIES);
      console.log(`Seeded ${CATEGORIES.length} categories.`);
    } else {
      console.log(`Categories already seeded (${catCount}).`);
    }

    // Seed drills
    const drillCount = await Drill.countDocuments();
    let drills;
    if (drillCount === 0) {
      drills = await Drill.insertMany(SAMPLE_DRILLS);
      console.log(`Seeded ${drills.length} drills.`);
    } else {
      drills = await Drill.find();
      console.log(`Drills already seeded (${drillCount}).`);
    }

    // Seed programs with drill references
    const progCount = await Program.countDocuments();
    if (progCount === 0 && drills.length > 0) {
      const dribblingDrills = drills.filter((d) => d.category === "Dribbling").map((d, i) => ({ drill: d._id, order: i + 1 }));
      const shootingDrills = drills.filter((d) => d.category === "Shooting").map((d, i) => ({ drill: d._id, order: i + 1 }));

      await Program.insertMany([
        {
          name: "Elite Guard Package",
          description: "A comprehensive program designed for elite-level guards. Focuses on ball handling, shot creation, and basketball IQ development.",
          level: "Advanced",
          category: "Dribbling",
          duration: "12 weeks",
          status: "published",
          drills: dribblingDrills,
          enrolled: 421,
          completionRate: 87,
          reviews: 4.5,
          views: 4800,
        },
        {
          name: "Sharpshooter Program",
          description: "Develop consistent shooting mechanics and game-ready range through progressive drill sequences.",
          level: "Intermediate",
          category: "Shooting",
          duration: "8 weeks",
          status: "published",
          drills: shootingDrills,
          enrolled: 315,
          completionRate: 82,
          reviews: 4.3,
          views: 3600,
        },
      ]);
      console.log("Seeded 2 programs.");
    } else {
      console.log(`Programs already seeded (${progCount}).`);
    }

    // Seed podcasts
    const podcastCount = await Podcast.countDocuments();
    if (podcastCount === 0) {
      await Podcast.insertMany(SAMPLE_PODCASTS);
      console.log(`Seeded ${SAMPLE_PODCASTS.length} podcasts.`);
    } else {
      console.log(`Podcasts already seeded (${podcastCount}).`);
    }

    // Seed coach workout sections (Workout tab) — upsert by name
    const WORKOUT_SECTIONS = [
      {
        name: "Skill Development",
        coach: "Coach Hudson",
        description:
          "Train with expert coaches and explore their drills, sessions, and insights designed to improve your game.",
        level: "Beginner",
        category: "Dribbling",
        duration: "50 mins",
        status: "published",
      },
      {
        name: "College Prep Workout",
        coach: "Luke Westerdale",
        description:
          "College-prep level training: ball screens, wing attacks and finishing packages.",
        level: "Intermediate",
        category: "Shooting",
        duration: "50 mins",
        status: "published",
      },
      {
        name: "High School Prep Workouts",
        coach: "Tristian Thomas",
        description:
          "High-school prep: form shooting, finishing and skill-building workouts.",
        level: "Beginner",
        category: "Shooting",
        duration: "50 mins",
        status: "published",
      },
      {
        name: "Elite Group Workout",
        coach: "Elite Group",
        description:
          "Elite group sessions: finishing, movement shooting and competitive reps.",
        level: "Advanced",
        category: "Fitness",
        duration: "60 mins",
        status: "published",
      },
    ];

    for (const section of WORKOUT_SECTIONS) {
      const existing = await Program.findOne({
        name: { $regex: `^${section.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
      });
      if (existing) {
        if (existing.coach !== section.coach || existing.description !== section.description) {
          existing.coach = section.coach;
          existing.description = section.description;
          existing.level = section.level;
          existing.category = section.category;
          existing.duration = section.duration;
          existing.status = "published";
          await existing.save();
          console.log(`Updated workout section: ${section.name}`);
        }
        continue;
      }
      const publishedDrills = await Drill.find({ status: "published" });
      const drills = publishedDrills.map((d, i) => ({ drill: d._id, order: i + 1 }));
      await Program.create({
        ...section,
        drills,
        enrolled: 0,
        completionRate: 0,
        reviews: 0,
        views: 0,
      });
      console.log(`Seeded workout section: ${section.coach} — ${section.name}`);
    }

    await mongoose.disconnect();
    console.log("Done.");
  } catch (err) {
    console.error("Seed failed:", err.message);
    process.exit(1);
  }
}

seed();