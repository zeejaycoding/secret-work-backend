const mongoose = require("mongoose");

const proSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    team: { type: String, default: "", trim: true },
    sessions: { type: Number, default: 0 },
    imageUrl: { type: String, default: "" },
    featured: { type: Boolean, default: false },
    homepageBanner: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Pro", proSchema);
