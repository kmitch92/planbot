import { useState, useEffect, useCallback } from 'react';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface EnvVar {
  key: string;
  value: string;
}

export interface UseEnvResult {
  vars: EnvVar[];
  loading: boolean;
  error: string | null;
  addVar: (key: string, value: string) => Promise<void>;
  updateVar: (key: string, value: string) => Promise<void>;
  removeVar: (key: string) => Promise<void>;
  reload: () => void;
}

interface EnvLine {
  type: 'variable' | 'comment' | 'empty';
  raw: string;
  key?: string;
  value?: string;
}

function parseLine(line: string): EnvLine {
  const trimmed = line.trim();

  if (trimmed === '') {
    return { type: 'empty', raw: line };
  }

  if (trimmed.startsWith('#')) {
    return { type: 'comment', raw: line };
  }

  const eqIndex = line.indexOf('=');
  if (eqIndex === -1) {
    return { type: 'comment', raw: line };
  }

  const key = line.slice(0, eqIndex).trim();
  let value = line.slice(eqIndex + 1).trim();

  // Strip surrounding quotes
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { type: 'variable', raw: line, key, value };
}

function parseEnvContent(content: string): EnvLine[] {
  return content.split('\n').map(parseLine);
}

function serializeLines(lines: EnvLine[]): string {
  return lines.map((l) => {
    if (l.type === 'variable') {
      return `${l.key}=${l.value}`;
    }
    return l.raw;
  }).join('\n');
}

export function useEnv(envPath?: string): UseEnvResult {
  const filePath = envPath ?? join(process.cwd(), '.env');

  const [vars, setVars] = useState<EnvVar[]>([]);
  const [lines, setLines] = useState<EnvLine[]>([]);
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
        const parsed = parseEnvContent(raw);

        if (cancelled) return;

        setLines(parsed);
        setVars(
          parsed
            .filter((l): l is EnvLine & { key: string; value: string } =>
              l.type === 'variable' && l.key !== undefined && l.value !== undefined,
            )
            .map((l) => ({ key: l.key, value: l.value })),
        );
      } catch (err) {
        if (cancelled) return;

        // File not existing is not an error for .env
        if (
          err instanceof Error &&
          'code' in err &&
          (err as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          setLines([]);
          setVars([]);
        } else {
          setError(
            err instanceof Error ? err.message : String(err),
          );
          setLines([]);
          setVars([]);
        }
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

  const addVar = useCallback(
    async (key: string, value: string): Promise<void> => {
      try {
        const raw = await readFile(filePath, 'utf-8').catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return '';
          throw err;
        });

        const currentLines = parseEnvContent(raw);
        const exists = currentLines.some(
          (l) => l.type === 'variable' && l.key === key,
        );

        if (exists) {
          setError(`Variable ${key} already exists. Use updateVar instead.`);
          return;
        }

        const newContent = raw === ''
          ? `${key}=${value}`
          : raw.endsWith('\n')
            ? `${raw}${key}=${value}\n`
            : `${raw}\n${key}=${value}`;

        await writeFile(filePath, newContent, 'utf-8');
        reload();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [filePath, reload],
  );

  const updateVar = useCallback(
    async (key: string, value: string): Promise<void> => {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const currentLines = parseEnvContent(raw);

        let found = false;
        const updated = currentLines.map((l) => {
          if (l.type === 'variable' && l.key === key) {
            found = true;
            return { ...l, value };
          }
          return l;
        });

        if (!found) {
          setError(`Variable ${key} not found. Use addVar instead.`);
          return;
        }

        await writeFile(filePath, serializeLines(updated), 'utf-8');
        reload();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [filePath, reload],
  );

  const removeVar = useCallback(
    async (key: string): Promise<void> => {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const currentLines = parseEnvContent(raw);

        const filtered = currentLines.filter(
          (l) => !(l.type === 'variable' && l.key === key),
        );

        if (filtered.length === currentLines.length) {
          setError(`Variable ${key} not found.`);
          return;
        }

        await writeFile(filePath, serializeLines(filtered), 'utf-8');
        reload();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [filePath, reload],
  );

  return { vars, loading, error, addVar, updateVar, removeVar, reload };
}
