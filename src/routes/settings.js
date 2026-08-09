const { Router } = require("express");
const {
  getSettingsDoc,
  DEFAULT_BRANDING,
  DEFAULT_NOTIFICATIONS,
} = require("../services/settings");

const router = Router();

router.get("/branding", async (_req, res) => {
  try {
    const doc = await getSettingsDoc();
    res.json({
      branding: {
        appName: doc.branding?.appName || DEFAULT_BRANDING.appName,
        tagline: doc.branding?.tagline || DEFAULT_BRANDING.tagline,
        primaryColor: doc.branding?.primaryColor || DEFAULT_BRANDING.primaryColor,
        accentColor: doc.branding?.accentColor || DEFAULT_BRANDING.accentColor,
        displayFont: doc.branding?.displayFont || DEFAULT_BRANDING.displayFont,
        bodyFont: doc.branding?.bodyFont || DEFAULT_BRANDING.bodyFont,
      },
      notifications: {
        ...DEFAULT_NOTIFICATIONS,
        ...(doc.notifications || {}),
      },
    });
  } catch (error) {
    console.error("Get public branding error:", error);
    res.status(500).json({ error: "Failed to fetch branding" });
  }
});

module.exports = router;
