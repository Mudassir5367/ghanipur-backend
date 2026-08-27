import { z } from 'zod';

/** Public signup — creates a NORMAL USER only (no shop). Admins are provisioned
 *  through /admin/register, super admins through /super-admin/register (§1). */
export const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  phone: z.string().trim().min(6).max(20).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Provision a SHOP_ADMIN (super-admin only). No shop is created here — the admin
 *  sets up their own shop after logging in (§2, /shops/mine self-onboarding). */
export const adminRegisterSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  phone: z.string().trim().min(6).max(20).optional(),
});
export type AdminRegisterInput = z.infer<typeof adminRegisterSchema>;

/** Provision a SUPER_ADMIN (setup key or existing super admin). */
export const superAdminRegisterSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
});
export type SuperAdminRegisterInput = z.infer<typeof superAdminRegisterSchema>;

// ---- Password reset (OTP flow) ----
export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export const verifyOtpSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  otp: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const resetPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  resetToken: z.string().min(20),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});
