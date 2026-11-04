import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

// A user's own SMTP sender. The password is stored AES-256-GCM encrypted and never leaves the server.
const emailAccountSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    label: { type: String, trim: true, maxlength: 100, default: "" },
    senderName: { type: String, trim: true, maxlength: 100, default: "" },
    senderEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    replyTo: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    smtpHost: { type: String, required: true, trim: true, lowercase: true, maxlength: 253 },
    smtpPort: { type: Number, required: true },
    smtpSecurity: { type: String, enum: ["ssl", "starttls"], required: true },
    smtpUsername: { type: String, required: true, trim: true, maxlength: 254 },
    passwordEncrypted: { type: String, required: true, select: false },
    // Optional reading of replies and bounces with the same login.
    imapEnabled: { type: Boolean, default: false },
    imapHost: { type: String, trim: true, lowercase: true, maxlength: 253, default: "" },
    imapPort: { type: Number, default: 993 },
    isDefault: { type: Boolean, default: false },
    lastTestAt: { type: Date, default: null },
    lastTestOk: { type: Boolean, default: null },
    lastTestError: { type: String, default: "" },
  },
  { timestamps: true },
);

emailAccountSchema.index({ userId: 1, senderEmail: 1, smtpUsername: 1 }, { unique: true });
emailAccountSchema.index({ userId: 1, isDefault: 1 });
emailAccountSchema.index({ imapEnabled: 1 });

emailAccountSchema.plugin(toJSONPlugin);
emailAccountSchema.set("toJSON", {
  virtuals: false,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.userId;
    delete ret.passwordEncrypted;
    ret.hasPassword = true;
    return ret;
  },
});

export const EmailAccount = mongoose.model("EmailAccount", emailAccountSchema);
