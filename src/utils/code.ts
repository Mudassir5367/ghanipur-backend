import { customAlphabet } from 'nanoid';

const rand = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 4);

/** Human-friendly document code, e.g. SALE-LXY2-9F3A. Prefixed per document type. */
export function generateCode(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase().slice(-5)}-${rand()}`;
}
