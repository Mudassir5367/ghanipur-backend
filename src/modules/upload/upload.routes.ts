import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { resolveTenant } from '../../middlewares/resolveTenant.js';
import { asyncHandler, ok } from '../../utils/http.js';
import { ApiError } from '../../utils/ApiError.js';
import { Permission } from '../../constants/permissions.js';
import { env } from '../../config/env.js';
import { putObject } from '../../config/storage.js';
import * as userRepo from '../../repositories/dynamo/userRepository.js';
import { toPublic } from '../auth/auth.service.js';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * Files are buffered in memory, not written to disk, because the destination is
 * S3. The size cap (MAX_UPLOAD_BYTES, 5MB by default) is what makes that safe —
 * multer rejects anything larger before it is fully read.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) return cb(new ApiError(400, 'Only image files are allowed', 'INVALID_FILE_TYPE'));
    cb(null, true);
  },
});

/** Shared multer wrapper so the size-limit error becomes a clean 400. */
const single = (req: Request, res: Response, next: (err?: unknown) => void) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(ApiError.badRequest('Image is too large', 'FILE_TOO_LARGE'));
    }
    if (err) return next(err);
    next();
  });
};

/** Opaque, collision-free object key. The UUID is what lets responses be cached forever. */
function makeKey(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase().slice(0, 10).replace(/[^.a-z0-9]/g, '') || '.img';
  return `${Date.now()}-${randomUUID()}${ext}`;
}

async function store(file: Express.Multer.File): Promise<string> {
  const key = makeKey(file.originalname);
  await putObject(key, file.buffer, file.mimetype);
  // Relative, same-origin URL — loads through the frontend proxy regardless of the
  // host the app is opened on, and hides where the bytes actually live.
  return `/uploads/${key}`;
}

// Product image upload (§8, §40): stored in S3, URL saved in the DB.
export const uploadRouter = Router();

uploadRouter.post(
  '/',
  authenticate,
  authorize(Permission.PRODUCT_CREATE),
  resolveTenant,
  single,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw ApiError.badRequest('No file uploaded', 'NO_FILE');
    ok(res, { url: await store(req.file) });
  }),
);

// Profile picture upload — any authenticated user, no shop/product permission needed.
// Saves the URL on the user and returns the refreshed public user.
uploadRouter.post(
  '/avatar',
  authenticate,
  single,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw ApiError.badRequest('No file uploaded', 'NO_FILE');
    const url = await store(req.file);
    const user = await userRepo.findById(req.auth!.userId);
    if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
    await userRepo.update(user.id, { avatarUrl: url });
    ok(res, { avatarUrl: url, user: toPublic({ ...user, avatarUrl: url }) });
  }),
);
