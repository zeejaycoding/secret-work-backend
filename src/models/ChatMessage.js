const mongoose = require("mongoose");

const chatMessageSchema = new mongoose.Schema(
  {
    room: { type: String, required: true, index: true },
    from: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    text: { type: String, required: true, trim: true },
    isAgent: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["new", "replied"],
      default: "new",
      index: true,
    },
  },
  { timestamps: true }
);

const ChatMessage = mongoose.model("ChatMessage", chatMessageSchema);

module.exports = { ChatMessage };
