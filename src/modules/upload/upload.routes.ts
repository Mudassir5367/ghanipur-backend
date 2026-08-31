import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { asyncHandler, ok } from '../../utils/http.js';
import { ApiError } from '../../utils/ApiError.js';
import { Permission } from '../../constants/permissions.js';
import { env } from '../../config/env.js';
import * as userRepo from '../../repositories/dynamo/userRepository.js';
import { toPublic } from '../auth/auth.service.js';

export const uploadDir = path.resolve(process.cwd(), env.UPLOAD_DIR);
fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10) || '.img';
    cb(null, `${Date.now()}-${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) return cb(new ApiError(400, 'Only image files are allowed', 'INVALID_FILE_TYPE'));
    cb(null, true);
  },
});

// Product image upload (§8, §40): stored on disk (object-storage-ready), URL saved in DB.
export const uploadRouter = Router();

uploadRouter.post(
  '/',
  authenticate,
  authorize(Permission.PRODUCT_CREATE),
  resolveTenant,
  (req: Request, res: Response, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(ApiError.badRequest('Image is too large', 'FILE_TOO_LARGE'));
      }
      if (err) return next(err);
      next();
    });
  },
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw ApiError.badRequest('No file uploaded', 'NO_FILE');
    // Relative, same-origin URL — loads through the frontend proxy regardless of the
    // host the app is opened on (localhost, 127.0.0.1, LAN IP, …).
    const url = `/uploads/${req.file.filename}`;
    ok(res, { url });
  }),
);

// Profile picture upload — any authenticated user, no shop/product permission needed.
// Saves the URL on the user and returns the refreshed public user.
uploadRouter.post(
  '/avatar',
  authenticate,
  (req: Request, res: Response, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(ApiError.badRequest('Image is too large', 'FILE_TOO_LARGE'));
      }
      if (err) return next(err);
      next();
    });
  },
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw ApiError.badRequest('No file uploaded', 'NO_FILE');
    // Relative, same-origin URL — loads through the frontend proxy regardless of the
    // host the app is opened on (localhost, 127.0.0.1, LAN IP, …).
    const url = `/uploads/${req.file.filename}`;
    const user = await userRepo.findById(req.auth!.userId);
    if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
    await userRepo.update(user.id, { avatarUrl: url });
    ok(res, { avatarUrl: url, user: toPublic({ ...user, avatarUrl: url }) });
  }),
);
