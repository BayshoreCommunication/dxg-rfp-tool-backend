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
const resend_1 = require("resend");
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const normalizeEnv = (value) => (value || "").trim().replace(/^['"]|['"]$/g, "");
const EMAIL_REGEX = /^\S+@\S+\.\S+$/;
const parseEmailList = (value) => normalizeEnv(value)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => EMAIL_REGEX.test(entry));
// ---------------------------------------------------------------------------
// Resend (HTTP API — works on DigitalOcean, no SMTP ports needed)
// ---------------------------------------------------------------------------
let resendClient = null;
const getResendClient = () => {
    const key = normalizeEnv(process.env.RESEND_API_KEY);
    if (!key)
        return null;
    if (!resendClient)
        resendClient = new resend_1.Resend(key);
    return resendClient;
};
// ---------------------------------------------------------------------------
// Nodemailer SMTP (fallback for local dev — blocked by DigitalOcean)
// ---------------------------------------------------------------------------
let transporter = null;
let transporterInitPromise = null;
const initializeTransporter = async () => {
    const SMTP_HOST = normalizeEnv(process.env.SMTP_HOST);
    const SMTP_PORT = normalizeEnv(process.env.SMTP_PORT);
    const SMTP_MAIL = normalizeEnv(process.env.SMTP_MAIL);
    const SMTP_PASSWORD = normalizeEnv(process.env.SMTP_PASSWORD);
    if (SMTP_HOST && SMTP_PORT && SMTP_MAIL && SMTP_PASSWORD) {
        console.log("Setting up SMTP transporter (local dev fallback)");
        const requestedPort = parseInt(SMTP_PORT, 10);
        // Force port 587 STARTTLS + IPv4 to avoid DO SMTP blocks
        const usePort = requestedPort === 465 ? 587 : requestedPort;
        transporter = nodemailer_1.default.createTransport({
            host: SMTP_HOST,
            port: usePort,
            secure: false,
            family: 4,
            socketTimeout: 30000,
            connectionTimeout: 30000,
            auth: { user: SMTP_MAIL, pass: SMTP_PASSWORD },
        });
    }
    else {
        console.log("No SMTP credentials found, creating Ethereal test account");
        const testAccount = await nodemailer_1.default.createTestAccount();
        transporter = nodemailer_1.default.createTransport({
            host: "smtp.ethereal.email",
            port: 587,
            secure: false,
            auth: { user: testAccount.user, pass: testAccount.pass },
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
    if (!transporterInitPromise) {
        transporterInitPromise = initializeTransporter();
    }
    await transporterInitPromise;
    if (!transporter)
        throw new Error("Email transporter could not be initialized.");
    return transporter;
};
// ---------------------------------------------------------------------------
// Unified send helper
// ---------------------------------------------------------------------------
const getFromAddress = () => {
    const mail = normalizeEnv(process.env.SMTP_MAIL) || "noreply@dxg-agency.com";
    return `"DXG RFP Tool" <${mail}>`;
};
/**
 * Send an email.
 * - Uses Resend HTTP API if RESEND_API_KEY is set (production / DigitalOcean).
 * - Falls back to nodemailer SMTP for local development.
 */
const sendEmail = async (params) => {
    const resend = getResendClient();
    const toList = Array.isArray(params.to) ? params.to : [params.to];
    const bccList = params.bcc
        ? Array.isArray(params.bcc) ? params.bcc : [params.bcc]
        : undefined;
    if (resend) {
        // -----------------------------------------------------------------------
        // Resend — HTTP API, no SMTP ports, works everywhere
        // -----------------------------------------------------------------------
        console.log(`[Resend] Sending email to: ${toList.join(", ")}`);
        const { error } = await resend.emails.send({
            from: getFromAddress(),
            to: toList,
            bcc: bccList,
            subject: params.subject,
            html: params.html,
            text: params.text,
        });
        if (error) {
            console.error("[Resend] Send error:", error);
            throw new Error(`Resend error: ${error.message}`);
        }
        console.log("[Resend] Email sent successfully");
    }
    else {
        // -----------------------------------------------------------------------
        // SMTP fallback (local dev)
        // -----------------------------------------------------------------------
        const activeTransporter = await ensureTransporter();
        const info = await activeTransporter.sendMail({
            from: getFromAddress(),
            to: toList.join(", "),
            bcc: bccList?.join(", "),
            subject: params.subject,
            html: params.html,
            text: params.text,
        });
        console.log("Email sent via SMTP:", info.messageId);
        const previewUrl = nodemailer_1.default.getTestMessageUrl(info);
        if (previewUrl)
            console.log("Preview URL:", previewUrl);
    }
};
// ---------------------------------------------------------------------------
// Public API — matches original function signatures
// ---------------------------------------------------------------------------
function generateOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
}
async function sendSignupOtpEmail(email, otp) {
    console.log(`Sending OTP ${otp} to ${email}`);
    await sendEmail({
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
}
async function sendForgotPasswordOtpEmail(email, otp) {
    await sendEmail({
        to: email,
        subject: "Reset your password - DXG RFP Tool",
        html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px;">
        <h2 style="color:#0f1b57;margin-bottom:8px;">Password Reset</h2>
        <p style="color:#555;margin-bottom:24px;">Use the code below to reset your password. It expires in <strong>10 minutes</strong>.</p>
        <div style="background:#fff;border:2px solid #35bdf2;border-radius:8px;padding:24px;text-align:center;">
          <span style="font-size:40px;font-weight:bold;letter-spacing:12px;color:#0f1b57;">${otp}</span>
        </div>
        <p style="color:#888;font-size:12px;margin-top:24px;">If you did not request a password reset, please ignore this email.</p>
      </div>
    `,
    });
}
async function sendCustomEmail(params) {
    const fixedRecipients = parseEmailList(process.env.SMTP_FIXED_RECIPIENTS || process.env.SMTP_FIXED_RECIPIENT);
    const toRecipients = parseEmailList(params.to);
    const bccRecipients = fixedRecipients.filter((entry) => !toRecipients.includes(entry));
    await sendEmail({
        to: params.to,
        bcc: bccRecipients.length > 0 ? bccRecipients : undefined,
        subject: params.subject,
        html: params.html,
        text: params.text,
    });
    console.log("Email delivery accepted:", {
        to: params.to,
        bcc: bccRecipients,
    });
}
//# sourceMappingURL=emailService.js.map