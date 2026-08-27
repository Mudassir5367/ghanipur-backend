import jwt, { type SignOptions } from 'jsonwebtoken';
import argon2 from 'argon2';
import { env } from '../config/env.js';
import type { Role } from '../constants/roles.js';

export interface AccessTokenPayload {
  sub: string; // user id
  role: Role;
  shopId: string | null;
  perms: string[]; // effective permissions computed at login
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

export function signRefreshToken(sub: string): string {
  return jwt.sign({ sub }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.REFRESH_TOKEN_TTL as SignOptions['expiresIn'],
  });
}

export function verifyRefreshToken(token: string): { sub: string } {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as { sub: string };
}

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}

/** Refresh tokens are stored hashed so a DB leak can't reissue sessions. */
export function hashToken(token: string): Promise<string> {
  return argon2.hash(token, { type: argon2.argon2id });
}

export function verifyTokenHash(hash: string, token: string): Promise<boolean> {
  return argon2.verify(hash, token);
}
