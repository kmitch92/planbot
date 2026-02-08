import { useState, useEffect, useCallback } from 'react';
import { stateManager, type PlanbotPaths } from '../../core/state.js';
import type { State } from '../../core/schemas.js';

export interface UsePlanbotStateResult {
  state: State | null;
  paths: PlanbotPaths | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function usePlanbotState(projectRoot?: string): UsePlanbotStateResult {
  const root = projectRoot ?? process.cwd();

  const [state, setState] = useState<State | null>(null);
  const [paths, setPaths] = useState<PlanbotPaths | null>(null);
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
        const resolvedPaths = stateManager.getPaths(root);
        const loadedState = await stateManager.load(root);

        if (cancelled) return;

        setPaths(resolvedPaths);
        setState(loadedState);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : String(err),
        );
        setPaths(null);
        setState(null);
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
  }, [root, reloadCount]);

  return { state, paths, loading, error, reload };
}
