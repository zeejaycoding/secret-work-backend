const mongoose = require("mongoose");

const roleSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    label: { type: String, default: "" },
    permissions: { type: Object, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Role", roleSchema);
