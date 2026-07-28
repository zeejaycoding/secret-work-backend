/**
 * Seed script — run with: node scripts/seed.js
 * Creates sample drills in MongoDB for admin panel demo
 */

const mongoose = require("mongoose");
require("dotenv").config({ path: __dirname + "/../.env" });

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/secretwork";

const DrillSchema = new mongoose.Schema(
  {
    title: String,
    description: String,
    coach: String,
    category: { type: String, enum: ["Dribbling", "Shooting", "Defence", "Passing", "Fitness"] },
    status: { type: String, enum: ["draft", "published"], default: "published" },
    imageUrl: { type: String, default: "" },
    duration: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    completionRate: { type: Number, default: 0 },
    avgWatchTime: { type: Number, default: 0 },
    viewsHistory: [
      {
        month: Number,
        year: Number,
        views: Number,
      },
    ],
  },
  { timestamps: true }
);

const Drill = mongoose.model("Drill", DrillSchema);

const SAMPLE_DRILLS = [
  {
    title: "Crossover Mastery",
    description: "Learn the basic crossover and develop your handle for driving past defenders.",
    coach: "LeBron James",
    category: "Dribbling",
    status: "published",
    imageUrl: "",
    duration: 12,
    views: 15420,
    likes: 1280,
    completionRate: 88,
    avgWatchTime: 340,
    viewsHistory: [
      { month: 1, year: 2026, views: 2100 },
      { month: 2, year: 2026, views: 3400 },
      { month: 3, year: 2026, views: 4200 },
      { month: 4, year: 2026, views: 5720 },
    ],
  },
  {
    title: "Pull-Up Jumper",
    description: "Develop a reliable mid-range pull-up jumper off the dribble.",
    coach: "Stephen Curry",
    category: "Shooting",
    status: "published",
    imageUrl: "",
    duration: 15,
    views: 23100,
    likes: 2150,
    completionRate: 92,
    avgWatchTime: 420,
    viewsHistory: [
      { month: 1, year: 2026, views: 4500 },
      { month: 2, year: 2026, views: 6200 },
      { month: 3, year: 2026, views: 7100 },
      { month: 4, year: 2026, views: 5300 },
    ],
  },
  {
    title: "Defensive Slide Drill",
    description: "Improve lateral quickness and defensive positioning on the perimeter.",
    coach: "Kawhi Leonard",
    category: "Defence",
    status: "published",
    imageUrl: "",
    duration: 10,
    views: 8900,
    likes: 720,
    completionRate: 75,
    avgWatchTime: 280,
    viewsHistory: [
      { month: 1, year: 2026, views: 1200 },
      { month: 2, year: 2026, views: 2100 },
      { month: 3, year: 2026, views: 2800 },
      { month: 4, year: 2026, views: 2800 },
    ],
  },
  {
    title: "Pocket Pass Workshop",
    description: "Master the pocket pass for finding cutters and open shooters.",
    coach: "Chris Paul",
    category: "Passing",
    status: "published",
    imageUrl: "",
    duration: 8,
    views: 6200,
    likes: 580,
    completionRate: 85,
    avgWatchTime: 220,
    viewsHistory: [
      { month: 1, year: 2026, views: 800 },
      { month: 2, year: 2026, views: 1400 },
      { month: 3, year: 2026, views: 1900 },
      { month: 4, year: 2026, views: 2100 },
    ],
  },
  {
    title: "Suicide Sprint Intervals",
    description: "High-intensity sprint intervals to build game-ready conditioning.",
    coach: "Jimmy Butler",
    category: "Fitness",
    status: "published",
    imageUrl: "",
    duration: 20,
    views: 11300,
    likes: 890,
    completionRate: 62,
    avgWatchTime: 500,
    viewsHistory: [
      { month: 1, year: 2026, views: 1800 },
      { month: 2, year: 2026, views: 2900 },
      { month: 3, year: 2026, views: 3200 },
      { month: 4, year: 2026, views: 3400 },
    ],
  },
  {
    title: "Behind-the-Back Combo",
    description: "Advanced combo move using behind-the-back dribbles to create space.",
    coach: "Kyrie Irving",
    category: "Dribbling",
    status: "draft",
    imageUrl: "",
    duration: 14,
    views: 3200,
    likes: 410,
    completionRate: 70,
    avgWatchTime: 310,
    viewsHistory: [
      { month: 3, year: 2026, views: 1500 },
      { month: 4, year: 2026, views: 1700 },
    ],
  },
  {
    title: "Catch-and-Shoot 3s",
    description: "Simulate game-speed catch-and-shoot three-pointers from various spots.",
    coach: "Klay Thompson",
    category: "Shooting",
    status: "published",
    imageUrl: "",
    duration: 12,
    views: 19800,
    likes: 1840,
    completionRate: 90,
    avgWatchTime: 380,
    viewsHistory: [
      { month: 1, year: 2026, views: 3200 },
      { month: 2, year: 2026, views: 5100 },
      { month: 3, year: 2026, views: 6200 },
      { month: 4, year: 2026, views: 5300 },
    ],
  },
  {
    title: "Closeout Drill",
    description: "Practice contesting shots without fouling using proper closeout technique.",
    coach: "Draymond Green",
    category: "Defence",
    status: "published",
    imageUrl: "",
    duration: 10,
    views: 5400,
    likes: 420,
    completionRate: 80,
    avgWatchTime: 260,
    viewsHistory: [
      { month: 2, year: 2026, views: 1200 },
      { month: 3, year: 2026, views: 1800 },
      { month: 4, year: 2026, views: 2400 },
    ],
  },
];

async function seed() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB");

    const count = await Drill.countDocuments();
    if (count > 0) {
      console.log(`Database already has ${count} drills. Skipping seed.`);
    } else {
      await Drill.insertMany(SAMPLE_DRILLS);
      console.log(`Seeded ${SAMPLE_DRILLS.length} drills successfully.`);
    }

    await mongoose.disconnect();
    console.log("Done.");
  } catch (err) {
    console.error("Seed failed:", err.message);
    process.exit(1);
  }
}

seed();
