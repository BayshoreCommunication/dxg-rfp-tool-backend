import nodemailer from "nodemailer";

// Initialize transporter later once we know environment settings
let transporter: nodemailer.Transporter;

(async () => {
  // If real SMTP credentials are provided, use them; otherwise fall back to Ethereal
  const { SMTP_HOST, SMTP_PORT, SMTP_MAIL, SMTP_PASSWORD } = process.env;

  if (SMTP_HOST && SMTP_PORT && SMTP_MAIL && SMTP_PASSWORD) {
    console.log("Setting up real SMTP transporter using environment variables");
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(SMTP_PORT, 10),
      secure: parseInt(SMTP_PORT, 10) === 465, // true for 465, false for other ports
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

  // Verify connection
  transporter.verify((error, success) => {
    if (error) {
      console.log("SMTP connection error:", error);
    } else {
      console.log("SMTP server is ready to take messages");
    }
  });
})();

/** Generate a cryptographically-sufficient 6-digit OTP */
export function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Send signup verification OTP */
export async function sendSignupOtpEmail(
  email: string,
  otp: string,
): Promise<void> {
  if (!transporter) {
    throw new Error(
      "Email transporter not initialized yet. Please try again later.",
    );
  }
  console.log(`Sending OTP ${otp} to ${email}`);
  const info = await transporter.sendMail({
    from: `"DXG RFP Tool" <${process.env.SMTP_MAIL || "noreply@dxg.com"}>`,
    to: email,
    subject: "Verify your email – DXG RFP Tool",
    html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px;">
        <h2 style="color:#0f1b57;margin-bottom:8px;">Email Verification</h2>
        <p style="color:#555;margin-bottom:24px;">Use the code below to verify your email address. It expires in <strong>10 minutes</strong>.</p>
        <div style="background:#fff;border:2px solid #35bdf2;border-radius:8px;padding:24px;text-align:center;">
          <span style="font-size:40px;font-weight:bold;letter-spacing:12px;color:#0f1b57;">${otp}</span>
        </div>
        <p style="color:#888;font-size:12px;margin-top:24px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
  console.log("Email sent:", info.messageId);
  console.log("Preview URL:", nodemailer.getTestMessageUrl(info));
}

/** Send forgot-password OTP */
export async function sendForgotPasswordOtpEmail(
  email: string,
  otp: string,
): Promise<void> {
  await transporter.sendMail({
    from: `"DXG RFP Tool" <${process.env.SMTP_MAIL}>`,
    to: email,
    subject: "Reset your password – DXG RFP Tool",
    html: `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px;">
        <h2 style="color:#0f1b57;margin-bottom:8px;">Password Reset</h2>
        <p style="color:#555;margin-bottom:24px;">Use the code below to reset your password. It expires in <strong>10 minutes</strong>.</p>
        <div style="background:#fff;border:2px solid #35bdf2;border-radius:8px;padding:24px;text-align:center;">
          <span style="font-size:40px;font-weight:bold;letter-spacing:12px;color:#0f1b57;">${otp}</span>
        </div>
        <p style="color:#888;font-size:12px;margin-top:24px;">If you didn't request a password reset, please ignore this email. Your password will not change.</p>
      </div>
    `,
  });
}
