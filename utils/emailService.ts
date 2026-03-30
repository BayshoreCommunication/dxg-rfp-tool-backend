import nodemailer from "nodemailer";

let transporter: nodemailer.Transporter | null = null;
let transporterInitPromise: Promise<void> | null = null;

const normalizeEnv = (value?: string): string =>
  (value || "").trim().replace(/^['"]|['"]$/g, "");

const assertRecipientAccepted = (
  info: nodemailer.SentMessageInfo,
  to: string
): void => {
  const accepted = Array.isArray(info.accepted)
    ? info.accepted.map((entry: unknown) => String(entry).toLowerCase())
    : [];
  const rejected = Array.isArray(info.rejected)
    ? info.rejected.map((entry: unknown) => String(entry).toLowerCase())
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

const initializeTransporter = async (): Promise<void> => {
  const SMTP_HOST = normalizeEnv(process.env.SMTP_HOST);
  const SMTP_PORT = normalizeEnv(process.env.SMTP_PORT);
  const SMTP_MAIL = normalizeEnv(process.env.SMTP_MAIL);
  const SMTP_PASSWORD = normalizeEnv(process.env.SMTP_PASSWORD);

  if (SMTP_HOST && SMTP_PORT && SMTP_MAIL && SMTP_PASSWORD) {
    console.log("Setting up real SMTP transporter using environment variables");
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(SMTP_PORT, 10),
      secure: parseInt(SMTP_PORT, 10) === 465,
      auth: {
        user: SMTP_MAIL,
        pass: SMTP_PASSWORD,
      },
    });
  } else {
    console.log("No SMTP credentials found, creating Ethereal test account");
    const testAccount = await nodemailer.createTestAccount();
    console.log("Ethereal test account created:", testAccount.user);

    transporter = nodemailer.createTransport({
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
  } catch (error) {
    console.log("SMTP connection error:", error);
    throw error;
  }
};

const ensureTransporter = async (): Promise<nodemailer.Transporter> => {
  if (transporter) return transporter;

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

const getFromAddress = () =>
  `"DXG RFP Tool" <${normalizeEnv(process.env.SMTP_MAIL) || "noreply@dxg.com"}>`;

export function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function sendSignupOtpEmail(
  email: string,
  otp: string
): Promise<void> {
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
  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    console.log("Preview URL:", previewUrl);
  }
}

export async function sendForgotPasswordOtpEmail(
  email: string,
  otp: string
): Promise<void> {
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

export async function sendCustomEmail(params: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<nodemailer.SentMessageInfo> {
  const activeTransporter = await ensureTransporter();
  const info = await activeTransporter.sendMail({
    from: getFromAddress(),
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
  });

  const accepted = Array.isArray(info.accepted)
    ? info.accepted.map((entry: unknown) => String(entry).toLowerCase())
    : [];
  const rejected = Array.isArray(info.rejected)
    ? info.rejected.map((entry: unknown) => String(entry).toLowerCase())
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
    accepted: info.accepted,
    rejected: info.rejected,
  });

  return info;
}
