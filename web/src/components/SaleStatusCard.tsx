import type { SaleStatusResponse } from '../api';
import { useCountdown } from '../hooks/useCountdown';

const BADGE: Record<string, { label: string; className: string }> = {
  upcoming: { label: 'UPCOMING', className: 'bg-amber-400/10 text-amber-300' },
  active: { label: 'ACTIVE', className: 'bg-teal-400/10 text-teal-300' },
  ended: { label: 'ENDED', className: 'bg-neutral-400/10 text-neutral-400' },
  soldout: { label: 'SOLD OUT', className: 'bg-red-400/10 text-red-300' },
};

interface Props {
  sale: SaleStatusResponse;
  clockOffsetMs: number;
}

export function SaleStatusCard({ sale, clockOffsetMs }: Props) {
  const soldOut = sale.status === 'active' && sale.soldOut;
  const badge = BADGE[soldOut ? 'soldout' : sale.status] ?? BADGE.ended!;
  const countdownTarget =
    sale.status === 'upcoming'
      ? sale.startsAt
      : sale.status === 'active'
        ? sale.endsAt
        : null;
  const countdown = useCountdown(countdownTarget, clockOffsetMs);

  const total = Math.max(sale.initialStock, sale.stockRemaining, 1);
  const pct = Math.round((sale.stockRemaining / total) * 100);

  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span
          className={`rounded-full px-3 py-1 text-[11px] font-medium tracking-wider ${badge.className}`}
        >
          {badge.label}
        </span>
        {countdownTarget && (
          <span className="text-xs text-neutral-400" aria-live="polite">
            {sale.status === 'upcoming' ? 'starts in ' : 'ends in '}
            <span className="tabular-nums">{countdown}</span>
          </span>
        )}
      </div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-2xl font-medium tabular-nums">
          {sale.stockRemaining.toLocaleString()}
        </span>
        <span className="text-xs text-neutral-400">
          of {total.toLocaleString()} left
        </span>
      </div>
      <div
        className="h-1.5 rounded-full bg-neutral-800"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-1.5 rounded-full bg-teal-400 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
