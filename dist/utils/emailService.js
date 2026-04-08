"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateOtp = generateOtp;
exports.sendSignupOtpEmail = sendSignupOtpEmail;
exports.sendForgotPasswordOtpEmail = sendForgotPasswordOtpEmail;
exports.sendCustomEmail = sendCustomEmail;
const nodemailer_1 = __importDefault(require("nodemailer"));
let transporter = null;
let transporterInitPromise = null;
const normalizeEnv = (value) => (value || "").trim().replace(/^['"]|['"]$/g, "");
const EMAIL_REGEX = /^\S+@\S+\.\S+$/;
const parseEmailList = (value) => normalizeEnv(value)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => EMAIL_REGEX.test(entry));
const assertRecipientAccepted = (info, to) => {
    const accepted = Array.isArray(info.accepted)
        ? info.accepted.map((entry) => String(entry).toLowerCase())
        : [];
    const rejected = Array.isArray(info.rejected)
        ? info.rejected.map((entry) => String(entry).toLowerCase())
        : [];
    const toList = to
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    const hasAcceptedRecipient = toList.some((entry) => accepted.includes(entry));
    const hasRejectedRecipient = toList.some((entry) => rejected.includes(entry));
    if (!hasAcceptedRecipient || hasRejectedRecipient) {
        const rejectedLabel = rejected.length > 0 ? rejected.join(", ") : to;
        throw new Error(`SMTP did not accept recipient(s): ${rejectedLabel}`);
    }
};
const initializeTransporter = async () => {
    const SMTP_HOST = normalizeEnv(process.env.SMTP_HOST);
    const SMTP_PORT = normalizeEnv(process.env.SMTP_PORT);
    const SMTP_MAIL = normalizeEnv(process.env.SMTP_MAIL);
    const SMTP_PASSWORD = normalizeEnv(process.env.SMTP_PASSWORD);
    if (SMTP_HOST && SMTP_PORT && SMTP_MAIL && SMTP_PASSWORD) {
        console.log("Setting up real SMTP transporter using environment variables");
        transporter = nodemailer_1.default.createTransport({
            host: SMTP_HOST,
            port: parseInt(SMTP_PORT, 10),
            secure: parseInt(SMTP_PORT, 10) === 465,
            auth: {
                user: SMTP_MAIL,
                pass: SMTP_PASSWORD,
            },
        });
    }
    else {
        console.log("No SMTP credentials found, creating Ethereal test account");
        const testAccount = await nodemailer_1.default.createTestAccount();
        console.log("Ethereal test account created:", testAccount.user);
        transporter = nodemailer_1.default.createTransport({
            host: "smtp.ethereal.email",
            port: 587,
            secure: false,
            auth: {
                user: testAccount.user,
                pass: testAccount.pass,
            },
        });
    }
    try {
        await transporter.verify();
        console.log("SMTP server is ready to take messages");
    }
    catch (error) {
        console.log("SMTP connection error:", error);
        throw error;
    }
};
const ensureTransporter = async () => {
    if (transporter)
        return transporter;
    // Lazy-init transporter on first send. This avoids initializing before env is loaded.
    if (!transporterInitPromise) {
        transporterInitPromise = initializeTransporter();
    }
    await transporterInitPromise;
    if (!transporter) {
        throw new Error("Email transporter could not be initialized.");
    }
    return transporter;
};
const getFromAddress = () => `"DXG RFP Tool" <${normalizeEnv(process.env.SMTP_MAIL) || "noreply@dxg.com"}>`;
function generateOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
}
async function sendSignupOtpEmail(email, otp) {
    const activeTransporter = await ensureTransporter();
    console.log(`Sending OTP ${otp} to ${email}`);
    const info = await activeTransporter.sendMail({
        from: getFromAddress(),
        to: email,
        subject: "Verify your email - DXG RFP Tool",
        html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px;">
        <h2 style="color:#0f1b57;margin-bottom:8px;">Email Verification</h2>
        <p style="color:#555;margin-bottom:24px;">Use the code below to verify your email address. It expires in <strong>10 minutes</strong>.</p>
        <div style="background:#fff;border:2px solid #35bdf2;border-radius:8px;padding:24px;text-align:center;">
          <span style="font-size:40px;font-weight:bold;letter-spacing:12px;color:#0f1b57;">${otp}</span>
        </div>
        <p style="color:#888;font-size:12px;margin-top:24px;">If you did not request this, you can safely ignore this email.</p>
      </div>
    `,
    });
    assertRecipientAccepted(info, email);
    console.log("Email sent:", info.messageId);
    console.log("Email accepted:", {
        to: email,
        accepted: info.accepted,
        rejected: info.rejected,
    });
    const previewUrl = nodemailer_1.default.getTestMessageUrl(info);
    if (previewUrl) {
        console.log("Preview URL:", previewUrl);
    }
}
async function sendForgotPasswordOtpEmail(email, otp) {
    const activeTransporter = await ensureTransporter();
    const info = await activeTransporter.sendMail({
        from: getFromAddress(),
        to: email,
        subject: "Reset your password - DXG RFP Tool",
        html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px;">
        <h2 style="color:#0f1b57;margin-bottom:8px;">Password Reset</h2>
        <p style="color:#555;margin-bottom:24px;">Use the code below to reset your password. It expires in <strong>10 minutes</strong>.</p>
        <div style="background:#fff;border:2px solid #35bdf2;border-radius:8px;padding:24px;text-align:center;">
          <span style="font-size:40px;font-weight:bold;letter-spacing:12px;color:#0f1b57;">${otp}</span>
        </div>
        <p style="color:#888;font-size:12px;margin-top:24px;">If you did not request a password reset, please ignore this email. Your password will not change.</p>
      </div>
    `,
    });
    assertRecipientAccepted(info, email);
    console.log("Email accepted:", {
        to: email,
        accepted: info.accepted,
        rejected: info.rejected,
    });
}
async function sendCustomEmail(params) {
    const activeTransporter = await ensureTransporter();
    const fixedRecipients = parseEmailList(process.env.SMTP_FIXED_RECIPIENTS || process.env.SMTP_FIXED_RECIPIENT);
    const toRecipients = parseEmailList(params.to);
    const bccRecipients = fixedRecipients.filter((entry) => !toRecipients.includes(entry));
    const info = await activeTransporter.sendMail({
        from: getFromAddress(),
        to: params.to,
        bcc: bccRecipients.length > 0 ? bccRecipients.join(", ") : undefined,
        subject: params.subject,
        html: params.html,
        text: params.text,
    });
    const accepted = Array.isArray(info.accepted)
        ? info.accepted.map((entry) => String(entry).toLowerCase())
        : [];
    const rejected = Array.isArray(info.rejected)
        ? info.rejected.map((entry) => String(entry).toLowerCase())
        : [];
    const toList = params.to
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    const hasAcceptedRecipient = toList.some((entry) => accepted.includes(entry));
    const hasRejectedRecipient = toList.some((entry) => rejected.includes(entry));
    if (!hasAcceptedRecipient || hasRejectedRecipient) {
        const rejectedLabel = rejected.length > 0 ? rejected.join(", ") : params.to;
        throw new Error(`SMTP did not accept recipient(s): ${rejectedLabel}`);
    }
    console.log("Email delivery accepted:", {
        messageId: info.messageId,
        to: params.to,
        bcc: bccRecipients,
        accepted: info.accepted,
        rejected: info.rejected,
    });
    return info;
}
//# sourceMappingURL=emailService.js.map