import { useEffect, useState } from 'react';

const MAX_LINES = 40;

// Tails /api/instances/:id/logs (SSE) while enabled — used to show real
// install progress instead of a fabricated phase checklist. The backend
// polls Docker on a rolling window, so overlapping/duplicate lines across
// events are expected; this only keeps the most recent MAX_LINES for display.
export function useInstanceLogs(id: string | undefined, enabled: boolean) {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (!id || !enabled) return;
    setLines([]);
    const source = new EventSource(`/api/instances/${id}/logs`);
    source.onmessage = (event) => {
      try {
        const chunk = JSON.parse(event.data) as string;
        const newLines = chunk.split('\n').filter((l) => l.length > 0);
        if (newLines.length === 0) return;
        setLines((prev) => [...prev, ...newLines].slice(-MAX_LINES));
      } catch {
        // ignore malformed frames
      }
    };
    return () => source.close();
  }, [id, enabled]);

  return lines;
}
