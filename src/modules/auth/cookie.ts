import type { Response, CookieOptions } from 'express';
import { env } from '../../config/env.js';

export const REFRESH_COOKIE = 'ghp_rt';

export function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    // Secure + SameSite=None only over TLS; Lax + insecure over http://localhost,
    // otherwise the browser silently drops the cookie and sessions never persist.
    secure: env.cookieSecure,
    sameSite: env.cookieSecure ? 'none' : 'lax',
    domain: env.COOKIE_DOMAIN,
    path: '/api/v1/auth',
    maxAge: env.REFRESH_TOKEN_TTL_MS,
  };
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions());
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
}
