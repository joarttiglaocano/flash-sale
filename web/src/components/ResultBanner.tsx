import type { PurchaseCode } from '../api';

interface Variant {
  title: string;
  tone: string;
  titleColor: string;
  bodyColor: string;
}

const VARIANTS: Record<PurchaseCode, Variant> = {
  PURCHASED: {
    title: 'You got one!',
    tone: 'border-teal-400/40 bg-teal-400/10',
    titleColor: 'text-teal-300',
    bodyColor: 'text-teal-200/80',
  },
  ALREADY_PURCHASED: {
    title: 'Already purchased',
    tone: 'border-sky-400/40 bg-sky-400/10',
    titleColor: 'text-sky-300',
    bodyColor: 'text-sky-200/80',
  },
  SOLD_OUT: {
    title: 'Sold out',
    tone: 'border-amber-400/40 bg-amber-400/10',
    titleColor: 'text-amber-300',
    bodyColor: 'text-amber-200/80',
  },
  SALE_NOT_STARTED: {
    title: "Sale hasn't started",
    tone: 'border-amber-400/40 bg-amber-400/10',
    titleColor: 'text-amber-300',
    bodyColor: 'text-amber-200/80',
  },
  SALE_ENDED: {
    title: 'Sale ended',
    tone: 'border-neutral-700 bg-neutral-800/60',
    titleColor: 'text-neutral-300',
    bodyColor: 'text-neutral-400',
  },
  VALIDATION_ERROR: {
    title: 'Check your identifier',
    tone: 'border-red-400/40 bg-red-400/10',
    titleColor: 'text-red-300',
    bodyColor: 'text-red-200/80',
  },
  SERVICE_UNAVAILABLE: {
    title: 'Temporarily unavailable',
    tone: 'border-red-400/40 bg-red-400/10',
    titleColor: 'text-red-300',
    bodyColor: 'text-red-200/80',
  },
  NETWORK_ERROR: {
    title: 'Connection problem',
    tone: 'border-red-400/40 bg-red-400/10',
    titleColor: 'text-red-300',
    bodyColor: 'text-red-200/80',
  },
};

interface Props {
  code: PurchaseCode;
  message: string;
  onRetry?: (() => void) | undefined;
}

export function ResultBanner({ code, message, onRetry }: Props) {
  const v = VARIANTS[code];
  const retryable = code === 'SERVICE_UNAVAILABLE' || code === 'NETWORK_ERROR';

  return (
    <div className={`rounded-xl border p-3 ${v.tone}`} role="status">
      <p className={`text-sm font-medium ${v.titleColor}`}>{v.title}</p>
      <p className={`mt-0.5 text-xs ${v.bodyColor}`}>{message}</p>
      {retryable && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 w-full rounded-lg border border-neutral-700 py-2 text-sm font-medium text-neutral-200 transition hover:bg-neutral-800"
        >
          Try again
        </button>
      )}
    </div>
  );
}
