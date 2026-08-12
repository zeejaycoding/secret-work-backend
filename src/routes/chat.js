const { Router } = require("express");
const { ChatMessage } = require("../models/ChatMessage");
const { authMiddleware } = require("../middleware/auth");

const router = Router();

router.get("/history", authMiddleware, async (req, res) => {
  try {
    const room = `support:${req.auth.userId}`;
    const messages = await ChatMessage.find({ room }).sort({ createdAt: 1 });
    res.json({ messages });
  } catch (err) {
    console.error("Chat history error:", err.message);
    res.status(500).json({ error: "Failed to fetch chat history" });
  }
});

module.exports = router;
