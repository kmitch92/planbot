import { useState, useEffect, useCallback } from 'react';
import { readFile, writeFile } from 'node:fs/promises';
import { parse as parseYaml, parseDocument } from 'yaml';
import { ConfigSchema, type Config } from '../../core/schemas.js';

export interface UseConfigResult {
  config: Config | null;
  loading: boolean;
  error: string | null;
  updateConfig: (updates: Partial<Config>) => Promise<void>;
  reload: () => void;
}

export function useConfig(configPath?: string): UseConfigResult {
  const filePath = configPath ?? 'tickets.yaml';

  const [config, setConfig] = useState<Config | null>(null);
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
        const parsed = parseYaml(raw) as Record<string, unknown>;
        const configSection = parsed['config'] ?? {};
        const result = ConfigSchema.safeParse(configSection);

        if (cancelled) return;

        if (result.success) {
          setConfig(result.data);
        } else {
          const message = result.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
          setError(`Config validation failed: ${message}`);
          setConfig(null);
        }
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : String(err),
        );
        setConfig(null);
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

  const updateConfig = useCallback(
    async (updates: Partial<Config>): Promise<void> => {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const doc = parseDocument(raw);

        let configNode = doc.get('config', true);
        if (!configNode || typeof configNode !== 'object' || !('set' in configNode)) {
          doc.set('config', {});
          configNode = doc.get('config', true);
        }

        const configObj = configNode as { set(key: string, value: unknown): void };

        for (const [key, value] of Object.entries(updates)) {
          configObj.set(key, value);
        }

        // Validate merged result before writing
        const mergedRaw = parseYaml(doc.toString()) as Record<string, unknown>;
        const result = ConfigSchema.safeParse(mergedRaw['config'] ?? {});

        if (!result.success) {
          const message = result.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
          setError(`Config validation failed: ${message}`);
          return;
        }

        await writeFile(filePath, doc.toString(), 'utf-8');
        reload();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [filePath, reload],
  );

  return { config, loading, error, updateConfig, reload };
}
