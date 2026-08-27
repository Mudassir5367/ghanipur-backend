/**
 * Money is stored as integer minor units (paisa) everywhere (§37). These helpers
 * are the only place rupee<->paisa conversion happens, so rounding is consistent.
 */
export function toMinor(rupees: number): number {
  return Math.round(rupees * 100);
}

export function toMajor(minor: number): number {
  return minor / 100;
}

export function formatPKR(minor: number): string {
  return new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR' }).format(toMajor(minor));
}
