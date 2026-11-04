import { NextFunction, Request, Response } from "express";

/* Customers sign up and sign in with email and password (with an emailed code at sign-up), or with
   Google, Microsoft or their company's SSO. PASSWORD_SIGN_IN_ENABLED=false turns the email/password,
   signup-OTP and password-reset endpoints off (410) for an SSO-only deployment.
   Staff (admin) sign-in is separate and unaffected. */
export const passwordSignInEnabled = () => process.env.PASSWORD_SIGN_IN_ENABLED?.trim().toLowerCase() !== "false";

export const requirePasswordSignIn = (_req: Request, res: Response, next: NextFunction): void => {
  if (passwordSignInEnabled()) {
    next();
    return;
  }
  res.status(410).json({
    success: false,
    code: "PASSWORD_SIGN_IN_DISABLED",
    message: "Email and password sign-in is not available. Continue with Google, Microsoft or your company's sign-in.",
  });
};
