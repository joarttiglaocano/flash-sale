export type SaleStatus = 'upcoming' | 'active' | 'ended';

export interface SaleWindow {
  startsAt: Date;
  endsAt: Date;
}

/**
 * Pure sale-window check. Boundaries: the sale is active from startsAt
 * (inclusive) until endsAt (exclusive).
 */
export function getSaleStatus(now: Date, window: SaleWindow): SaleStatus {
  const t = now.getTime();
  if (t < window.startsAt.getTime()) return 'upcoming';
  if (t < window.endsAt.getTime()) return 'active';
  return 'ended';
}
