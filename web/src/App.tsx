import { useEffect, useState } from 'react';
import {
  attemptPurchase,
  fetchHasPurchased,
  type PurchaseResult,
} from './api';
import { BuyForm } from './components/BuyForm';
import { ResultBanner } from './components/ResultBanner';
import { SaleStatusCard } from './components/SaleStatusCard';
import { useSaleStatus } from './hooks/useSaleStatus';

const STORAGE_KEY = 'flash-sale:userId';

export default function App() {
  const { data: sale, clockOffsetMs, unreachable } = useSaleStatus();
  const [userId, setUserId] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PurchaseResult | null>(null);

  // Returning user: if this identifier already secured an item, show the
  // success state immediately on load.
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    void fetchHasPurchased(stored).then((purchased) => {
      if (purchased) {
        setResult({
          code: 'ALREADY_PURCHASED',
          message: `Item secured for ${stored}.`,
        });
      }
    });
  }, []);

  async function submit(normalized: string) {
    localStorage.setItem(STORAGE_KEY, normalized);
    setUserId(normalized);
    setBusy(true);
    try {
      const outcome = await attemptPurchase(normalized);
      setResult(
        outcome.code === 'PURCHASED'
          ? { ...outcome, message: `Item secured for ${normalized}.` }
          : outcome,
      );
    } finally {
      setBusy(false);
    }
  }

  const saleActive = sale?.status === 'active' && !sale.soldOut;
  const settled =
    result?.code === 'PURCHASED' || result?.code === 'ALREADY_PURCHASED';

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5 py-10">
      <p className="mb-0.5 text-xs tracking-wide text-neutral-400">
        Flash sale
      </p>
      <h1 className="mb-4 text-xl font-medium">Limited edition drop</h1>

      {sale ? (
        <div className="mb-4">
          <SaleStatusCard sale={sale} clockOffsetMs={clockOffsetMs} />
        </div>
      ) : (
        <div className="mb-4 rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
          <p className="text-sm text-neutral-400">
            {unreachable
              ? 'Cannot reach the sale service — retrying…'
              : 'Loading sale status…'}
          </p>
        </div>
      )}

      {result && (
        <div className="mb-4">
          <ResultBanner
            code={result.code}
            message={result.message}
            onRetry={settled ? undefined : () => setResult(null)}
          />
        </div>
      )}

      {!settled && (
        <BuyForm
          userId={userId}
          onUserIdChange={setUserId}
          onSubmit={(normalized) => void submit(normalized)}
          busy={busy}
          disabled={!saleActive}
        />
      )}

      <p className="mt-4 text-center text-[11px] text-neutral-600">
        One item per customer
      </p>
    </main>
  );
}
