const { Server } = require("socket.io");
const { env } = require("../config/env");
const { ChatMessage } = require("../models/ChatMessage");

let io = null;

function generateBotResponse(text) {
  const lower = (text || "").toLowerCase();
  if (lower.includes("account")) {
    return "You can view and edit your account details from the Edit Profile section in your profile.";
  }
  if (lower.includes("earning")) {
    return "Earnings are updated weekly after your workouts are reviewed. Check your profile for current earnings.";
  }
  if (lower.includes("gift")) {
    return "Gifts are available for Premium members. Browse the Gifts tab to see what's available.";
  }
  if (lower.includes("ban")) {
    return "If your account was restricted, please share more details and we'll investigate right away.";
  }
  if (lower.includes("payment")) {
    return "We accept all major credit/debit cards. Manage your payment method in Settings > Subscription plan.";
  }
  if (lower.includes("membership")) {
    return "You can upgrade or change your membership plan anytime from Settings > Subscription plan.";
  }
  return "Thanks for reaching out! Our support team will get back to you soon.";
}

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: true,
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      next(new Error("Authentication required"));
      return;
    }
    try {
      const jwt = require("jsonwebtoken");
      const decoded = jwt.verify(token, env.jwtSecret);
      socket.userId = decoded.userId;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on("join:user", (userId) => {
      socket.join(`user:${userId}`);
    });

    socket.on("join:support", (room) => {
      socket.join(room);
    });

    socket.on("chat:send", async (payload) => {
      const { room, text } = payload;
      if (!socket.userId || !room || !text || !text.trim()) return;

      try {
        const msg = await ChatMessage.create({
          room,
          from: socket.userId,
          text: text.trim(),
          isAgent: false,
        });

        io.to(room).emit("chat:new", {
          _id: msg._id,
          room,
          from: socket.userId,
          text: msg.text,
          isAgent: false,
          createdAt: msg.createdAt,
        });

        // Only send the bot acknowledgement once, on the user's very first
        // query. Later queries go straight to the support queue instead of
        // repeating the "thanks for reaching out" message.
        const userMessageCount = await ChatMessage.countDocuments({
          room,
          isAgent: false,
        });
        if (userMessageCount > 1) return;

        const botText = generateBotResponse(text.trim());

        setTimeout(async () => {
          const botMsg = await ChatMessage.create({
            room,
            from: null,
            text: botText,
            isAgent: true,
          });

          io.to(room).emit("chat:new", {
            _id: botMsg._id,
            room,
            from: null,
            text: botText,
            isAgent: true,
            createdAt: botMsg.createdAt,
          });
        }, 600);
      } catch (err) {
        console.error("chat:send error:", err.message);
      }
    });

    socket.on("disconnect", () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });

  console.log("Socket.io initialized");
  return io;
}

function getIO() {
  if (!io) {
    throw new Error("Socket.io not initialized");
  }
  return io;
}

module.exports = { initSocket, getIO };
