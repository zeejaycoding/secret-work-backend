const mongoose = require("mongoose");
const uri = process.env.MONGO_URI;
mongoose.connect(uri).then(async () => {
  const db = mongoose.connection.db;
  const names = ["Skill Development", "College Prep Workout", "High School Prep Workouts", "Workout"];
  const r = await db.collection("programs").deleteMany({ name: { $in: names } });
  console.log("deleted fabricated workout programs:", r.deletedCount);
  await mongoose.disconnect();
}).catch((e) => { console.error(e.message); process.exit(1); });
