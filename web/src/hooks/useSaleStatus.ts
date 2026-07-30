import { useEffect, useRef, useState } from 'react';
import { fetchSaleStatus, type SaleStatusResponse } from '../api';

const POLL_MS = 2000;

export interface SaleState {
  data: SaleStatusResponse | null;
  /** serverTime - clientTime, so countdowns follow the server clock. */
  clockOffsetMs: number;
  unreachable: boolean;
}

export function useSaleStatus(): SaleState {
  const [state, setState] = useState<SaleState>({
    data: null,
    clockOffsetMs: 0,
    unreachable: false,
  });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await fetchSaleStatus();
        if (cancelled) return;
        setState({
          data,
          clockOffsetMs: new Date(data.serverTime).getTime() - Date.now(),
          unreachable: false,
        });
      } catch {
        if (cancelled) return;
        setState((prev) => ({ ...prev, unreachable: true }));
      }
    }

    void poll();
    timer.current = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  return state;
}
