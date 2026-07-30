import { useEffect, useState } from 'react';

/** Formats the time remaining until `target` as hh:mm:ss, server-adjusted. */
export function useCountdown(target: string | null, clockOffsetMs: number): string {
  const [display, setDisplay] = useState('--:--:--');

  useEffect(() => {
    if (!target) return;
    const end = new Date(target).getTime();

    function tick() {
      const now = Date.now() + clockOffsetMs;
      const ms = Math.max(0, end - now);
      const s = Math.floor(ms / 1000);
      const days = Math.floor(s / 86400);
      const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      setDisplay(days > 0 ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`);
    }

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target, clockOffsetMs]);

  return display;
}
