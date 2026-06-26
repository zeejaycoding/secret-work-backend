const mongoose = require("mongoose");
const { env } = require("./env");

const uri = env.mongoUri.includes("?")
  ? env.mongoUri
  : `${env.mongoUri}?retryWrites=true&w=majority`;

async function connectDB() {
  try {
    mongoose.connection.on("disconnected", () => {
      console.warn("MongoDB disconnected, retrying in 5s...");
      setTimeout(() => {
        mongoose.connect(uri, {
          serverSelectionTimeoutMS: 5000,
          socketTimeoutMS: 45000,
          heartbeatFrequencyMS: 10000,
        }).catch((err) => console.error("Reconnect failed:", err.message));
      }, 5000);
    });

    mongoose.connection.on("error", (err) => {
      console.error("MongoDB error:", err.message);
    });

    mongoose.connection.on("reconnected", () => {
      console.log("MongoDB reconnected");
    });

    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      heartbeatFrequencyMS: 10000,
    });
    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error("MongoDB connection error:", error.message);
    process.exit(1);
  }
}

module.exports = { connectDB };
