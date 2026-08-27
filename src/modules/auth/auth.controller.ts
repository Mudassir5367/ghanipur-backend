import type { Request, Response } from 'express';
import * as authService from './auth.service.js';
import * as passwordReset from './passwordReset.service.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../../services/audit.service.js';
import { REFRESH_COOKIE, setRefreshCookie, clearRefreshCookie } from './cookie.js';

export const register = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.register(req.body);
  setRefreshCookie(res, result.refreshToken);
  await recordAudit({ actorId: result.user.id, actorRole: result.user.role, shopId: result.user.shopId, action: 'AUTH_REGISTER', ip: req.ip });
  created(res, { user: result.user, accessToken: result.accessToken });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.login(req.body);
  setRefreshCookie(res, result.refreshToken);
  await recordAudit({ actorId: result.user.id, actorRole: result.user.role, shopId: result.user.shopId, action: 'AUTH_LOGIN', ip: req.ip });
  ok(res, { user: result.user, accessToken: result.accessToken });
});

// Provision a shop admin (authorized as SUPER_ADMIN upstream). Returns a ready-to-use
// access token for the new admin so no separate login is needed. NOTE: we do NOT set
// the refresh cookie here — that would overwrite the caller's (super admin's) session.
export const registerAdmin = asyncHandler(async (req: Request, res: Response) => {
  const admin = await authService.createAdmin(req.body);
  const { user, accessToken } = await authService.issueTokensForUser(admin.id);
  await recordAudit({ actorId: req.auth?.userId, actorRole: req.auth?.role, shopId: user.shopId, action: 'ADMIN_REGISTER', resource: 'User', resourceId: user.id, ip: req.ip });
  created(res, { user, accessToken });
});

// Provision a super admin (authorized via setup key or existing super admin upstream).
// Also returns an access token for the new super admin (usable immediately).
export const registerSuperAdmin = asyncHandler(async (req: Request, res: Response) => {
  const created0 = await authService.createSuperAdmin(req.body);
  const { user, accessToken } = await authService.issueTokensForUser(created0.id);
  await recordAudit({ actorId: req.auth?.userId ?? null, actorRole: req.auth?.role ?? 'SETUP_KEY', action: 'SUPER_ADMIN_REGISTER', resource: 'User', resourceId: user.id, ip: req.ip });
  created(res, { user, accessToken });
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  const result = await authService.refresh(token);
  setRefreshCookie(res, result.refreshToken);
  ok(res, { user: result.user, accessToken: result.accessToken });
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  if (req.auth) {
    await authService.logout(req.auth.userId);
    await recordAudit({ actorId: req.auth.userId, actorRole: req.auth.role, shopId: req.auth.shopId, action: 'AUTH_LOGOUT', ip: req.ip });
  }
  clearRefreshCookie(res);
  ok(res, { message: 'Logged out' });
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw ApiError.unauthorized();
  const user = await authService.getMe(req.auth.userId);
  ok(res, { user });
});

// ---- Password reset (OTP flow). Works for every user/role. ----

// Step 1: request a code. Generic response ALWAYS, so it can't be used to probe
// which emails have accounts.
export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const { devOtp } = await passwordReset.requestPasswordReset(req.body.email);
  ok(res, {
    message: 'If an account exists for that email, a verification code has been sent to it.',
    ...(devOtp ? { devOtp } : {}),
  });
});

// Step 2: verify the code -> one-time reset token.
export const verifyResetOtp = asyncHandler(async (req: Request, res: Response) => {
  const { resetToken } = await passwordReset.verifyOtp(req.body.email, req.body.otp);
  ok(res, { resetToken, message: 'Code verified. You can now set a new password.' });
});

// Step 3: set the new password with the reset token.
export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  await passwordReset.resetPassword(req.body.email, req.body.resetToken, req.body.password);
  await recordAudit({ action: 'PASSWORD_RESET', resource: 'User', ip: req.ip });
  ok(res, { message: 'Password updated. You can now log in with your new password.' });
});
