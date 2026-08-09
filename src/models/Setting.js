const mongoose = require("mongoose");

const paletteEntrySchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    hex: { type: String, trim: true },
  },
  { _id: false }
);

const settingSchema = new mongoose.Schema(
  {
    key: { type: String, default: "global", unique: true },
    branding: {
      appName: { type: String, default: "Secret Work", trim: true },
      tagline: { type: String, default: "Train like the pros", trim: true },
      primaryColor: { type: String, default: "#E50914", trim: true },
      accentColor: { type: String, default: "#FF0015", trim: true },
      displayFont: { type: String, default: "Poppins", trim: true },
      bodyFont: { type: String, default: "Inter", trim: true },
      palette: { type: [paletteEntrySchema], default: [] },
    },
    notifications: {
      push: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
      inApp: { type: Boolean, default: true },
      insights: { type: Boolean, default: true },
      failed: { type: Boolean, default: true },
      reports: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

const Setting = mongoose.model("Setting", settingSchema);

module.exports = Setting;
