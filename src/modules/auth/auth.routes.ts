import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as controller from './auth.controller.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { loginSchema, registerSchema, forgotPasswordSchema, verifyOtpSchema, resetPasswordSchema } from './auth.validators.js';

// Tight limiter on credential endpoints to blunt brute force (§32).
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
// OTP verification is the brute-force surface (6-digit code) — cap attempts per IP
// on top of the per-code attempt limit enforced in the service.
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

export const authRouter = Router();

authRouter.post('/register', authLimiter, validate({ body: registerSchema }), controller.register);
authRouter.post('/login', authLimiter, validate({ body: loginSchema }), controller.login);
authRouter.post('/refresh', controller.refresh);
authRouter.post('/logout', authenticate, controller.logout);
authRouter.get('/me', authenticate, controller.me);

// Password reset (OTP). Also used for "resend" — same endpoint, cooldown enforced.
authRouter.post('/forgot-password', authLimiter, validate({ body: forgotPasswordSchema }), controller.forgotPassword);
authRouter.post('/verify-otp', otpLimiter, validate({ body: verifyOtpSchema }), controller.verifyResetOtp);
authRouter.post('/reset-password', authLimiter, validate({ body: resetPasswordSchema }), controller.resetPassword);
