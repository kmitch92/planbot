import { useState, useEffect, useCallback } from 'react';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import {
  safeParseTicketsFile,
  type Ticket,
  type TicketsFile,
} from '../../core/schemas.js';

export interface UseTicketsResult {
  tickets: Ticket[];
  ticketsFile: TicketsFile | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useTickets(configPath?: string): UseTicketsResult {
  const filePath = configPath ?? 'tickets.yaml';

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketsFile, setTicketsFile] = useState<TicketsFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  const reload = useCallback(() => {
    setReloadCount((c) => c + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      setLoading(true);
      setError(null);

      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed: unknown = parseYaml(raw);
        const result = safeParseTicketsFile(parsed);

        if (cancelled) return;

        if (result.success) {
          setTicketsFile(result.data);
          setTickets(result.data.tickets);
        } else {
          const message = result.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
          setError(`Validation failed: ${message}`);
          setTicketsFile(null);
          setTickets([]);
        }
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : String(err),
        );
        setTicketsFile(null);
        setTickets([]);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [filePath, reloadCount]);

  return { tickets, ticketsFile, loading, error, reload };
}
