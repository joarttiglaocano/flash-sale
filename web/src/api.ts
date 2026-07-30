export type SaleStatus = 'upcoming' | 'active' | 'ended';

export interface SaleStatusResponse {
  status: SaleStatus;
  startsAt: string;
  endsAt: string;
  serverTime: string;
  stockRemaining: number;
  initialStock: number;
  soldOut: boolean;
}

export type PurchaseCode =
  | 'PURCHASED'
  | 'ALREADY_PURCHASED'
  | 'SOLD_OUT'
  | 'SALE_NOT_STARTED'
  | 'SALE_ENDED'
  | 'VALIDATION_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'NETWORK_ERROR';

export interface PurchaseResult {
  code: PurchaseCode;
  message: string;
}

export async function fetchSaleStatus(): Promise<SaleStatusResponse> {
  const res = await fetch('/api/sale/status');
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as SaleStatusResponse;
}

export async function attemptPurchase(userId: string): Promise<PurchaseResult> {
  try {
    const res = await fetch('/api/purchase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    const body = (await res.json()) as Partial<PurchaseResult>;
    if (body.code && body.message) {
      return { code: body.code as PurchaseCode, message: body.message };
    }
    return {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Unexpected response — safe to retry.',
    };
  } catch {
    // Purchases are idempotent server-side, so a lost response is always
    // safe to retry.
    return {
      code: 'NETWORK_ERROR',
      message: 'Network hiccup — your attempt is safe to retry.',
    };
  }
}

export async function fetchHasPurchased(userId: string): Promise<boolean> {
  const res = await fetch(`/api/purchase/${encodeURIComponent(userId)}`);
  if (!res.ok) return false;
  const body = (await res.json()) as { purchased?: boolean };
  return body.purchased === true;
}
