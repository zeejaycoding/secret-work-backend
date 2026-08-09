const mongoose = require("mongoose");
const uri = process.env.MONGO_URI;
mongoose.connect(uri).then(async () => {
  const db = mongoose.connection.db;

  const drills = await db.collection("drills").find({}).toArray();
  console.log("=== DRILLS ===");
  for (const d of drills) {
    console.log(`- [${d.status}] "${d.title}" coach="${d.coach}" cat="${d.category}" level="${d.level}" video=${d.videoUrl ? "Y" : "N"} img=${d.imageUrl ? "Y" : "N"}`);
  }

  const pros = await db.collection("pros").find({}).toArray();
  console.log("\n=== PROS ===");
  for (const p of pros) {
    console.log(`- "${p.name}" team="${p.team || ""}" sessions=${p.sessions ?? "?"} image=${p.imageUrl ? "Y" : "N"} banner=${p.homepageBanner ? "Y" : "N"}`);
  }

  const programs = await db.collection("programs").find({}).toArray();
  console.log("\n=== PROGRAMS ===");
  for (const p of programs) {
    console.log(`- [${p.status}] "${p.name}" coach="${p.coach || ""}" category="${p.category}" level="${p.level}" drills=${(p.drills || []).length}`);
  }

  await mongoose.disconnect();
}).catch((e) => { console.error(e.message); process.exit(1); });
