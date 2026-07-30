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

    await mongoose.disconnect();
    console.log("Done.");
  } catch (err) {
    console.error("Seed failed:", err.message);
    process.exit(1);
  }
}

seed();