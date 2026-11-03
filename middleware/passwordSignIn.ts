import { NextFunction, Request, Response } from "express";

/* Customers sign in with Google, Microsoft or their company's SSO (DXG decision 2026-11-03).
   The email/password, signup-OTP and password-reset endpoints answer 410 unless
   PASSWORD_SIGN_IN_ENABLED=true (kept for local demos and the legacy test suites).
   Staff (admin) sign-in is separate and unaffected. */
export const passwordSignInEnabled = () => process.env.PASSWORD_SIGN_IN_ENABLED?.trim().toLowerCase() === "true";

export const requirePasswordSignIn = (_req: Request, res: Response, next: NextFunction): void => {
  if (passwordSignInEnabled()) {
    next();
    return;
  }
  res.status(410).json({
    success: false,
    code: "PASSWORD_SIGN_IN_DISABLED",
    message: "Email and password sign-in is no longer available. Continue with Google, Microsoft or your company's sign-in.",
  });
};
