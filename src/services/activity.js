const Activity = require("../models/Activity");

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function recordActivity(userId, kind = "session") {
  if (!userId) return;
  try {
    const date = todayKey();
    await Activity.updateOne(
      { userId, date, kind },
      { $inc: { count: 1 } },
      { upsert: true }
    );
  } catch (error) {
    console.error("Record activity error:", error.message || error);
  }
}

module.exports = { recordActivity, todayKey };
