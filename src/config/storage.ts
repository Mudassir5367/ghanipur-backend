import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Where uploaded images live.
 *
 * S3 when S3_BUCKET is set (production), local disk otherwise (tests and local
 * dev, so neither needs AWS credentials). Both expose the same put/get/delete
 * over an opaque key, and the API keeps serving images from the same
 * `/uploads/<key>` path either way — so nothing downstream, including the
 * frontend, can tell which backend is in use.
 *
 * The bucket is private. Objects are streamed back through the API rather than
 * linked directly, which keeps images same-origin (matching the proxy design
 * that makes the auth cookie first-party) and means no public bucket and no
 * expiring presigned URLs. At this scale the bandwidth is irrelevant; if it ever
 * stops being, the answer is CloudFront in front of the bucket, not a public one.
 */

export const usingS3 = Boolean(env.S3_BUCKET);

const s3 = usingS3
  ? new S3Client({
      region: env.AWS_REGION,
      // No explicit credentials: the EC2 instance role is resolved by the SDK's
      // default chain, so no long-lived keys live in the environment.
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    })
  : null;

/** Local fallback root, only used when S3_BUCKET is unset. */
export const localUploadDir = path.resolve(process.cwd(), env.UPLOAD_DIR);
if (!usingS3) fs.mkdirSync(localUploadDir, { recursive: true });

const withPrefix = (key: string): string => `${env.S3_PREFIX}${key}`;

/** Rejects keys that could escape the prefix or read arbitrary paths. */
export function isSafeKey(key: string): boolean {
  return /^[A-Za-z0-9._-]{1,200}$/.test(key) && !key.startsWith('.');
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (s3 && env.S3_BUCKET) {
    await s3.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: withPrefix(key),
        Body: body,
        ContentType: contentType,
        // Long cache: keys embed a UUID, so an object never changes under a key.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return;
  }
  await fs.promises.writeFile(path.join(localUploadDir, key), body);
}

export interface StoredObject {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
}

/** Returns null when the object does not exist, so callers can 404 cleanly. */
export async function getObject(key: string): Promise<StoredObject | null> {
  if (s3 && env.S3_BUCKET) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: withPrefix(key) }));
      return {
        stream: res.Body as Readable,
        contentType: res.ContentType,
        contentLength: res.ContentLength,
      };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw err;
    }
  }

  const file = path.join(localUploadDir, key);
  if (!fs.existsSync(file)) return null;
  return { stream: fs.createReadStream(file), contentLength: fs.statSync(file).size };
}

export async function deleteObject(key: string): Promise<void> {
  if (s3 && env.S3_BUCKET) {
    await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: withPrefix(key) }));
    return;
  }
  await fs.promises.rm(path.join(localUploadDir, key), { force: true });
}

export function logStorageMode(): void {
  if (usingS3) logger.info({ bucket: env.S3_BUCKET, prefix: env.S3_PREFIX || '(none)' }, 'Image storage: S3');
  else logger.warn({ dir: localUploadDir }, 'Image storage: local disk — set S3_BUCKET in production');
}
