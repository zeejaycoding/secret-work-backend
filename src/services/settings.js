const Setting = require("../models/Setting");

const DEFAULT_BRANDING = {
  appName: "Secret Work",
  tagline: "Train like the pros",
  primaryColor: "#E50914",
  accentColor: "#FF0015",
  displayFont: "Poppins",
  bodyFont: "Inter",
  palette: [
    { name: "Primary Red", hex: "#E50914" },
    { name: "Accent Red", hex: "#FF0015" },
    { name: "Card Dark", hex: "#111111" },
    { name: "Deep Black", hex: "#0A0A0A" },
    { name: "Text White", hex: "#FFFFFF" },
    { name: "Text Muted", hex: "#929292" },
  ],
};

const DEFAULT_NOTIFICATIONS = {
  push: true,
  email: true,
  inApp: true,
  insights: true,
  failed: true,
  reports: true,
};

async function getSettingsDoc() {
  let doc = await Setting.findOne({ key: "global" });
  if (!doc) {
    doc = await Setting.create({ key: "global" });
  }
  return doc;
}

module.exports = { getSettingsDoc, DEFAULT_BRANDING, DEFAULT_NOTIFICATIONS };
