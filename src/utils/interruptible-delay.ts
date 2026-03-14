export type InterruptibleDelayOptions = {
  durationMs: number;
  shouldInterrupt: () => boolean;
  onTick?: (elapsedMs: number, remainingMs: number) => void;
  pollIntervalMs?: number;
};

export type InterruptibleDelayResult = {
  completed: boolean;
  interrupted: boolean;
  elapsedMs: number;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function interruptibleDelay(
  options: InterruptibleDelayOptions,
): Promise<InterruptibleDelayResult> {
  const { durationMs, shouldInterrupt, onTick, pollIntervalMs = 1000 } = options;

  if (durationMs <= 0) {
    return { completed: true, interrupted: false, elapsedMs: 0 };
  }

  const startTime = Date.now();
  let remainingMs = durationMs;

  while (true) {
    await sleep(Math.min(pollIntervalMs, remainingMs));

    const elapsedMs = Date.now() - startTime;
    remainingMs = durationMs - elapsedMs;

    if (shouldInterrupt()) {
      return { completed: false, interrupted: true, elapsedMs };
    }

    onTick?.(elapsedMs, Math.max(0, remainingMs));

    if (remainingMs <= 0) {
      return { completed: true, interrupted: false, elapsedMs };
    }
  }
}
