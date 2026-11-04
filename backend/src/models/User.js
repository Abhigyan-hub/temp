import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    password: { type: String, required: true, select: false },
    profile: {
      senderName: { type: String, trim: true, maxlength: 100, default: "" },
      signature: { type: String, maxlength: 2000, default: "" },
    },
    settings: {
      timezone: { type: String, default: "Asia/Kolkata", maxlength: 64 },
      defaultSendTime: { type: String, default: "09:00", match: /^\d{2}:\d{2}$/ },
      // system = the server's GMAIL_* account; custom = the user's default EmailAccount.
      sendingMode: { type: String, enum: ["system", "custom"], default: "system" },
    },
    // Incremented on logout-everywhere / password change to invalidate issued JWTs.
    tokenVersion: { type: Number, default: 0, select: false },
    contactSeq: { type: Number, default: 0, select: false },
    // The default resume categories are added once; after that the list is entirely the user's.
    resumeCategoriesSeeded: { type: Boolean, default: false, select: false },
    resetPasswordTokenHash: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

userSchema.pre("save", async function () {
  if (this.isModified("password")) {
    this.password = await bcrypt.hash(this.password, 12);
  }
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

userSchema.set("toJSON", {
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.password;
    delete ret.tokenVersion;
    delete ret.contactSeq;
    delete ret.resumeCategoriesSeeded;
    delete ret.resetPasswordTokenHash;
    delete ret.resetPasswordExpires;
    return ret;
  },
});

export const User = mongoose.model("User", userSchema);
